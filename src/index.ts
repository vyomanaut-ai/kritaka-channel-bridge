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

const AGENT_ID = process.env.KRITAKA_AGENT_ID ?? 'unknown'
const AGENT_NAME = process.env.KRITAKA_AGENT_NAME ?? 'unknown'
const HUB_PORT = parseInt(process.env.KRITAKA_HUB_PORT ?? '19850', 10)
// KTK-190: Workspace identity injected by the daemon at spawn so the agent
// recognizes how the human signs herself in chat. Empty strings mean the
// workspace owner hasn't set them yet.
const WORKSPACE_NAME = process.env.KRITAKA_WORKSPACE_NAME ?? ''
const WORKSPACE_HANDLE = process.env.KRITAKA_WORKSPACE_HANDLE ?? ''
const WORKSPACE_DISPLAY_NAME = process.env.KRITAKA_WORKSPACE_DISPLAY_NAME ?? ''
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
    },
  },
  async ({ channel_id, message }) => {
    if (!hubClient?.isConnected()) {
      return { content: [{ type: 'text' as const, text: 'Error: Not connected to Kritaka hub' }] }
    }
    hubClient.sendMessage(channel_id, message)
    return { content: [{ type: 'text' as const, text: `Message sent to channel ${channel_id}` }] }
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
    hubClient.sendReaction(channel_id, message_id, emoji, action)
    return { content: [{ type: 'text' as const, text: `Reaction ${action === 'remove' ? 'removed from' : 'added to'} message ${message_id}` }] }
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
    description: 'Get recent message history from a Kritaka channel.',
    inputSchema: {
      channel_id: z.string().describe('The channel ID to get history for'),
      limit: z.number().optional().describe('Maximum number of messages to return (default: 50)'),
    },
  },
  async ({ channel_id, limit }) => {
    if (!hubClient?.isConnected()) {
      return { content: [{ type: 'text' as const, text: 'Error: Not connected to Kritaka hub' }] }
    }

    const history = await hubClient.requestHistory(channel_id, limit ?? 50)
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
  hubClient = new HubClient(HUB_PORT, AGENT_ID, AGENT_NAME, subscriptions)

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
            channel_id: msg.channel_id ?? '',
            author: msg.author_name ?? 'unknown',
            author_type: msg.author_type ?? 'unknown',
            author_id: msg.author_id ?? '',
            message_id: msg.message_id ?? '',
            timestamp: msg.timestamp ?? '',
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
            channel_id: msg.channel_id ?? '',
            author: msg.author_name ?? 'unknown',
            author_type: msg.author_type ?? 'unknown',
            author_id: msg.author_id ?? '',
            message_id: msg.message_id ?? '',
            emoji: msg.emoji ?? '',
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

main().catch((err) => {
  process.stderr.write(`[Bridge] Fatal error: ${err}\n`)
  process.exit(1)
})

// Re-export for library consumers
export { HubClient } from './hub-client.js'
export { HubMessage, encodeMessage, parseMessages, HUB_PORT } from './protocol.js'
