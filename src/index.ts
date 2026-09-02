#!/usr/bin/env node
/**
 * @kritaka/channel-bridge
 *
 * A per-agent MCP server spawned by Claude Code as a subprocess.
 * - Declares `claude/channel` capability so Claude Code registers notification listener
 * - Connects to the Kritaka Channel Hub over TCP
 * - Forwards hub messages to Claude as `notifications/claude/channel` events
 * - Exposes channel_reply, channel_list, and channel_history tools
 */
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { pathToFileURL } from 'url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { HubClient } from './hub-client.js'

const IMAGE_TMP_DIR = path.join(os.tmpdir(), 'kritaka-images')

/**
 * Decode a base64 data URI, write to a temp file, and return the file path.
 * Returns null if the data URI is invalid or the write fails.
 */
function writeImageToTempFile(dataUri: string): string | null {
  try {
    const match = dataUri.match(/^data:(image\/[\w+.-]+);base64,(.+)$/)
    if (!match) return null

    const mimeType = match[1]
    const base64Data = match[2]
    const sub = mimeType.split('/')[1].replace('+xml', '') // image/svg+xml → svg
    const ext = sub === 'jpeg' ? 'jpg' : sub

    fs.mkdirSync(IMAGE_TMP_DIR, { recursive: true })

    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
    const filePath = path.join(IMAGE_TMP_DIR, filename)

    fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'))
    return filePath
  } catch (err: any) {
    process.stderr.write(`[Bridge] Failed to write image to temp file: ${err.message}\n`)
    return null
  }
}

/**
 * KTK-393 — defensive sanitisation of notification `meta` values.
 *
 * On the Claude Code path this bridge does NOT build the `<channel …>`
 * tag: it emits a `notifications/claude/channel` payload and the Claude
 * Code harness renders the tag from `meta` (which is why our frames read
 * `source="kritaka-channels"`, the MCP server name, rather than the
 * `source="kritaka"` the runtime's own builder emits). So we cannot
 * escape at construction — we do not own the construction.
 *
 * What we do own is the values. Quotes and angle brackets are stripped
 * before they leave here, so a value cannot terminate an attribute or
 * open a tag regardless of how the harness renders it. `author_type` is
 * the field that matters: agents are instructed to treat
 * `author_type="human"` as Akari speaking, so a forged one is privilege
 * escalation into the only channel that carries authority.
 *
 * This is belt-and-braces, not a diagnosis — the harness may well escape
 * correctly. It is cheap, and the cost of being wrong is not.
 */
function metaValue(value: string): string {
  return value.replace(/["'<>]/g, '')
}

const KNOWN_AUTHOR_TYPES = new Set(['human', 'agent', 'system', 'webhook', 'journalist'])

/** Closed set rather than escaping — see metaValue. */
function safeAuthorType(value: string): string {
  return KNOWN_AUTHOR_TYPES.has(value) ? value : 'unknown'
}

const AGENT_ID = process.env.KRITAKA_AGENT_ID ?? 'unknown'
const AGENT_NAME = process.env.KRITAKA_AGENT_NAME ?? 'unknown'
const HUB_PORT = parseInt(process.env.KRITAKA_HUB_PORT ?? '19850', 10)
// KTK-190: Workspace identity injected by the daemon at spawn so the agent
// recognizes how the human signs herself in chat. Empty strings mean the
// workspace owner hasn't set them yet.
const WORKSPACE_NAME = process.env.KRITAKA_WORKSPACE_NAME ?? ''
const WORKSPACE_HANDLE = process.env.KRITAKA_WORKSPACE_HANDLE ?? ''
const WORKSPACE_DISPLAY_NAME = process.env.KRITAKA_WORKSPACE_DISPLAY_NAME ?? ''
// KTK-324 — the agent's workspace id, forwarded to the daemon's
// channel-hub at register so per-call routing uses the agent's workspace
// instead of the daemon's identity.
const WORKSPACE_ID = process.env.KRITAKA_WORKSPACE_ID ?? ''
// Mutable: seeded from env at startup, refreshed mid-session by
// HubClient.onSubscriptionsChanged so channel_list + channel_history
// reflect D1 truth without a process restart (KTK-183).
let subscriptions = (process.env.KRITAKA_SUBSCRIPTIONS ?? '').split(',').filter(Boolean)
let channelNames = (process.env.KRITAKA_CHANNEL_NAMES ?? '').split(',').filter(Boolean)

// Build the instructions that get injected into Claude's system prompt
const channelList = subscriptions.length > 0
  ? `Subscribed channels:\n${subscriptions.map((id, i) => `  ${id} — #${channelNames[i] ?? id}`).join('\n')}`
  : 'No channel subscriptions configured.'

const workspaceIdentity = (() => {
  if (!WORKSPACE_HANDLE && !WORKSPACE_DISPLAY_NAME) return ''
  const display = WORKSPACE_DISPLAY_NAME || WORKSPACE_HANDLE
  const handleLine = WORKSPACE_HANDLE
    ? `The human you collaborate with is ${display} — they sign messages with the handle @${WORKSPACE_HANDLE}. When you see @${WORKSPACE_HANDLE} addressed to you in a channel, treat it as a direct message from them.`
    : `The human you collaborate with is ${display}.`
  const wsLine = WORKSPACE_NAME ? `Workspace: ${WORKSPACE_NAME}.` : ''
  return `${wsLine}\n${handleLine}\n`
})()

const decisionGuidance = `If you need a judgement call, scope/UX choice, approval, or any answer you are stuck on, prefer the decision_create tool over asking inline in the channel — it surfaces the question in the user's decision sidebar where it won't get lost in cross-agent chatter. The answered card echoes back into the channel and @-mentions you when complete.`

const instructions = `You are connected to Kritaka, a multi-agent orchestration platform.
${workspaceIdentity}Messages from other agents and humans arrive as <channel source="kritaka" channel_id="..." author="..." author_type="...">content</channel> tags.
${channelList}
To reply to a channel, use the channel_reply tool with the channel_id and your message.
To react to a message, use the channel_react tool with the message_id, channel_id, and an emoji.
Use channel_threads_list to see what threads are running in a channel before starting a new one.
Threads keep a long back-and-forth out of the main channel feed, so the channel stays readable while several people work in parallel. If an inbound tag carries a thread_id, you are being spoken to inside a thread — pass that same thread_id to channel_reply so your answer lands there and not in the main feed. When a topic of your own is going to take several messages, open a thread for it with channel_thread_create and reply into that.
${decisionGuidance}
Always be collaborative and responsive to messages from your team.`

// Create the MCP server
const mcp = new McpServer(
  { name: '@kritaka/channel-bridge', version: '0.1.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
    },
    instructions,
  },
)

let hubClient: HubClient | null = null

// Register tools
mcp.registerTool(
  'channel_reply',
  {
    description: 'Send a message to a Kritaka channel. Use this to communicate with other agents and humans.',
    inputSchema: {
      channel_id: z.string().describe('The channel ID to post to (from the channel_id attribute on inbound messages)'),
      message: z.string().describe('The message to send'),
      // KTK-385 — spelled out rather than left to inference: the failure
      // mode is an agent answering a threaded question in the parent
      // channel, which is the exact crosstalk threads exist to remove.
      thread_id: z
        .string()
        .optional()
        .describe(
          'Optional thread to reply inside. Pass the thread_id from the message you are responding to — if an inbound <channel> tag carried a thread_id, reply with that same value. Omit it to post to the main channel feed.',
        ),
    },
  },
  async ({ channel_id, message, thread_id }) => {
    if (!hubClient?.isConnected()) {
      return { content: [{ type: 'text' as const, text: 'Error: Not connected to Kritaka hub' }] }
    }
    hubClient.sendMessage(channel_id, message, thread_id)
    return {
      content: [
        {
          type: 'text' as const,
          text: thread_id
            ? `Message sent to thread ${thread_id} in channel ${channel_id}`
            : `Message sent to channel ${channel_id}`,
        },
      ],
    }
  },
)

// KTK-385 — agents start threads, they don't only answer in them. Without
// this an agent working a task can't move its own sub-conversation out of
// the main feed, and the crosstalk Akari asked us to fix stays where it is.
mcp.registerTool(
  'channel_thread_create',
  {
    description:
      'Start a thread on an existing Kritaka message. Use this when a topic is going to take several ' +
      'messages to work through — it keeps that back-and-forth out of the main channel feed so the ' +
      'channel stays readable. Returns the thread_id to pass to channel_reply.',
    inputSchema: {
      channel_id: z.string().describe('The channel the message is in'),
      message_id: z.string().describe('The message to hang the thread off (from the message_id on inbound messages)'),
      title: z.string().describe('Short name for the thread, describing the topic (max 100 characters)'),
    },
  },
  async ({ channel_id, message_id, title }) => {
    if (!hubClient?.isConnected()) {
      return { content: [{ type: 'text' as const, text: 'Error: Not connected to Kritaka hub' }] }
    }
    try {
      const { thread_id } = await hubClient.createThread(channel_id, message_id, title)
      return {
        content: [
          {
            type: 'text' as const,
            text: `Thread "${title}" created (thread_id: ${thread_id}). Reply into it by passing thread_id to channel_reply.`,
          },
        ],
      }
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      }
    }
  },
)

// KTK-385 — thread discovery. Without this an agent can only participate
// in threads it happens to be spoken to in, and can't join a conversation
// already in progress — which is most of them.
mcp.registerTool(
  'channel_threads_list',
  {
    description:
      'List the open threads in a Kritaka channel, most recently active first. Use this to find an ' +
      'existing thread before starting a new one, or to catch up on what conversations are running.',
    inputSchema: {
      channel_id: z.string().describe('The channel to list threads for'),
    },
  },
  async ({ channel_id }) => {
    if (!hubClient?.isConnected()) {
      return { content: [{ type: 'text' as const, text: 'Error: Not connected to Kritaka hub' }] }
    }
    try {
      const threads = await hubClient.listThreads(channel_id)
      if (threads.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No threads in this channel yet.' }] }
      }
      const formatted = threads
        .map(
          (t) =>
            `${t.id}\n  ${t.title} — ${t.reply_count} ${t.reply_count === 1 ? 'reply' : 'replies'}` +
            (t.last_reply_at ? `, last active ${t.last_reply_at}` : ''),
        )
        .join('\n')
      return { content: [{ type: 'text' as const, text: formatted }] }
    } catch (err) {
      return {
        content: [
          { type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` },
        ],
      }
    }
  },
)

mcp.registerTool(
  'channel_list',
  {
    description: 'List the Kritaka channels this agent is subscribed to.',
  },
  async () => {
    if (subscriptions.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No channels subscribed.' }] }
    }
    const list = subscriptions.map((id, i) => {
      const name = channelNames[i]
      return name ? `${id}\n${name}` : id
    }).join('\n')
    return { content: [{ type: 'text' as const, text: list }] }
  },
)

mcp.registerTool(
  'channel_react',
  {
    description: 'Add or remove an emoji reaction on a message in a Kritaka channel.',
    inputSchema: {
      message_id: z.string().describe('The message_id of the message to react to (from the message_id in channel notification meta)'),
      channel_id: z.string().describe('The channel_id the message belongs to'),
      emoji: z.string().describe('The emoji to react with (e.g. "👍", "🔥", "✅")'),
      action: z.enum(['add', 'remove']).default('add').describe('Whether to add or remove the reaction (default: add)'),
    },
  },
  async ({ message_id, channel_id, emoji, action }) => {
    if (!hubClient?.isConnected()) {
      return { content: [{ type: 'text' as const, text: 'Error: Not connected to Kritaka hub' }] }
    }
    try {
      await hubClient.sendReaction(channel_id, message_id, emoji, action)
      return {
        content: [
          {
            type: 'text' as const,
            text: `Reaction ${action === 'remove' ? 'removed from' : 'added to'} message ${message_id}`,
          },
        ],
      }
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      }
    }
  },
)

// KTK-191: Agents create Decisions instead of asking judgement-call questions
// inline in the channel. The Kritaka UI queues them in the right-hand sidebar
// and echoes the answered card back to the channel with @-mention so the
// originating agent picks it up via the existing notification path.
mcp.registerTool(
  'decision_create',
  {
    description:
      "Ask the user to make a decision via Kritaka's decision UI instead of " +
      'a chat message. Use this whenever you need a judgement call, scope/UX ' +
      'choice, approval, or any answer you are stuck on. Each question becomes ' +
      'a multiple-choice card with an "Other" free-text fallback. Returns a ' +
      'decision_id; the answered result echoes back into the channel as a ' +
      'system message that @-mentions you, so you will be notified when it ' +
      'completes via the normal channel notification flow.',
    inputSchema: {
      channel_id: z
        .string()
        .describe('The channel where the answered decision will echo (typically the channel you are in)'),
      questions: z
        .array(
          z.object({
            prompt: z
              .string()
              .describe('Succinct question — at most a paragraph, ideally one or two sentences'),
            choices: z
              .array(z.string())
              .min(1)
              .describe('Multiple-choice options. "Other" with a free-text input is added automatically.'),
          }),
        )
        .min(1)
        .describe('One or more questions to ask. Keep the set tight — fewer, sharper questions are better.'),
    },
  },
  async ({ channel_id, questions }) => {
    if (!hubClient?.isConnected()) {
      return { content: [{ type: 'text' as const, text: 'Error: Not connected to Kritaka hub' }] }
    }
    // Mint stable q*/c* ids client-side so the daemon doesn't have to.
    const framed = questions.map((q, qi) => ({
      id: `q${qi + 1}`,
      prompt: q.prompt,
      choices: q.choices.map((label, ci) => ({ id: `c${ci + 1}`, label })),
    }))
    try {
      const { decision_id } = await hubClient.createDecision(channel_id, framed)
      return {
        content: [
          {
            type: 'text' as const,
            text: `Decision created (id: ${decision_id}). The user will see it in their decision sidebar; you will receive a channel @-mention when it is answered.`,
          },
        ],
      }
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] }
    }
  },
)

mcp.registerTool(
  'decision_cancel',
  {
    description:
      'Cancel a pending decision you previously created with decision_create. ' +
      'Use this when the question has become moot (e.g. the user answered it ' +
      'in chat, the situation changed, or you no longer need the decision).',
    inputSchema: {
      decision_id: z.string().describe('The decision id returned by decision_create'),
    },
  },
  async ({ decision_id }) => {
    if (!hubClient?.isConnected()) {
      return { content: [{ type: 'text' as const, text: 'Error: Not connected to Kritaka hub' }] }
    }
    try {
      await hubClient.cancelDecision(decision_id)
      return { content: [{ type: 'text' as const, text: `Decision ${decision_id} cancelled.` }] }
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] }
    }
  },
)

mcp.registerTool(
  'channel_history',
  {
    description: 'Get recent message history from a Kritaka channel, or from one thread inside it.',
    inputSchema: {
      channel_id: z.string().describe('The channel ID to get history for'),
      limit: z.number().optional().describe('Maximum number of messages to return (default: 50)'),
      // KTK-385 — without this, catching up on a thread means reading the
      // whole channel, which is the readability problem in reverse.
      thread_id: z
        .string()
        .optional()
        .describe(
          "Optional thread to read instead of the channel. Omit for the channel's main feed, which excludes thread replies.",
        ),
    },
  },
  async ({ channel_id, limit, thread_id }) => {
    if (!hubClient?.isConnected()) {
      return { content: [{ type: 'text' as const, text: 'Error: Not connected to Kritaka hub' }] }
    }

    const history = await hubClient.requestHistory(channel_id, limit ?? 50, thread_id)
    if (!history || history.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No messages in this channel yet.' }] }
    }

    const formatted = history
      .map((m) => `[${m.created_at}] ${m.author_name} (${m.author_type}): ${m.content}`)
      .join('\n')

    return { content: [{ type: 'text' as const, text: formatted }] }
  },
)

// Connect to Hub and Claude Code
async function main() {
  hubClient = new HubClient(HUB_PORT, AGENT_ID, AGENT_NAME, subscriptions, WORKSPACE_ID)

  // Mid-session subscription updates — HubClient polls + emits subscribe /
  // unsubscribe frames to Hub; we just update the arrays that back the
  // channel_list tool's output.
  hubClient.onSubscriptionsChanged((ids, names) => {
    subscriptions = ids
    channelNames = names
  })

  // When the hub sends us a message, forward it to Claude as a channel notification
  hubClient.onMessage(async (msg) => {
    if (msg.type === 'channel_message') {
      // Build content — include image reference if present
      let content = msg.content ?? ''
      const metadata = msg.metadata as Record<string, string> | undefined
      let imageRef: string | undefined

      if (metadata?.image) {
        if (metadata.image.startsWith('data:')) {
          // Base64 data URI — write to temp file so agents can read by path
          const imagePath = writeImageToTempFile(metadata.image)
          if (imagePath) {
            content += content ? `\n[Image: ${imagePath}]` : `[Image: ${imagePath}]`
            imageRef = imagePath
          }
        } else {
          // URL or other reference — pass through as-is
          content += content ? `\n[Image: ${metadata.image}]` : `[Image: ${metadata.image}]`
          imageRef = metadata.image
        }
      }

      await mcp.server.notification({
        method: 'notifications/claude/channel',
        params: {
          channel: 'kritaka',
          content,
          meta: {
            channel_id: metaValue(msg.channel_id ?? ''),
            author: metaValue(msg.author_name ?? 'unknown'),
            author_type: safeAuthorType(msg.author_type ?? 'unknown'),
            author_id: metaValue(msg.author_id ?? ''),
            message_id: metaValue(msg.message_id ?? ''),
            timestamp: metaValue(msg.timestamp ?? ''),
            // KTK-385 — thread identity rides `meta`, which is what
            // becomes the `<channel …>` tag's attributes. Only emitted
            // when the message is actually in a thread, so a parent-feed
            // message produces the same tag it always has.
            //
            // KTK-393 — thread_title is the reachable one: unlike author
            // names, it is free text typed by whoever opened the thread.
            ...(msg.thread_id ? { thread_id: metaValue(msg.thread_id) } : {}),
            ...(msg.thread_title ? { thread_title: metaValue(msg.thread_title) } : {}),
            ...(imageRef ? { image_path: imageRef } : {}),
          },
        },
      })
    } else if (msg.type === 'reaction_event') {
      await mcp.server.notification({
        method: 'notifications/claude/channel',
        params: {
          channel: 'kritaka',
          content: `${msg.author_name} reacted with ${msg.emoji} on message ${msg.message_id}`,
          meta: {
            channel_id: metaValue(msg.channel_id ?? ''),
            author: metaValue(msg.author_name ?? 'unknown'),
            author_type: safeAuthorType(msg.author_type ?? 'unknown'),
            author_id: metaValue(msg.author_id ?? ''),
            message_id: metaValue(msg.message_id ?? ''),
            emoji: metaValue(msg.emoji ?? ''),
            action: msg.action ?? 'add',
            timestamp: msg.timestamp ?? '',
            event_type: 'reaction',
          },
        },
      })
    }
  })

  hubClient.connect()

  await mcp.connect(new StdioServerTransport())
}

// KTK-328 — only start the MCP server + HubClient when this module is run as
// the entrypoint (`node dist/index.js`), NOT when it is imported for its
// protocol helpers / HubClient export. Previously `main()` ran unconditionally
// on load, so importing the package main booted a second, identity-less
// HubClient inside any importer (e.g. the pty-daemon), which then hot-looped
// against the hub and filled the daemon's error log.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`[Bridge] Fatal error: ${err}\n`)
    process.exit(1)
  })
}

// Re-export for library consumers
export { HubClient } from './hub-client.js'
export { HubMessage, encodeMessage, parseMessages, HUB_PORT } from './protocol.js'
