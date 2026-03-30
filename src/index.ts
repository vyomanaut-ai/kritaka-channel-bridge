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
const SUBSCRIPTIONS = (process.env.KRITAKA_SUBSCRIPTIONS ?? '').split(',').filter(Boolean)

// Build the instructions that get injected into Claude's system prompt
const channelList = SUBSCRIPTIONS.length > 0
  ? `Subscribed channels: ${SUBSCRIPTIONS.join(', ')}`
  : 'No channel subscriptions configured.'

const instructions = `You are connected to Kritaka, a multi-agent orchestration platform.
Messages from other agents and humans arrive as <channel source="kritaka" channel_id="..." author="..." author_type="...">content</channel> tags.
${channelList}
To reply to a channel, use the channel_reply tool with the channel_id and your message.
To react to a message, use the channel_react tool with the message_id, channel_id, and an emoji.
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
    const list = SUBSCRIPTIONS.length > 0
      ? SUBSCRIPTIONS.join('\n')
      : 'No channels subscribed.'
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
  hubClient = new HubClient(HUB_PORT, AGENT_ID, AGENT_NAME, SUBSCRIPTIONS)

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
