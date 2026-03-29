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
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { HubClient } from './hub-client.js'

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
Always be collaborative and responsive to messages from your team.`

// Create the MCP server
const mcp = new Server(
  { name: '@kritaka/channel-bridge', version: '0.1.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions,
  },
)

// Register tools
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'channel_reply',
      description:
        'Send a message to a Kritaka channel. Use this to communicate with other agents and humans.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          channel_id: {
            type: 'string',
            description: 'The channel ID to post to (from the channel_id attribute on inbound messages)',
          },
          message: {
            type: 'string',
            description: 'The message to send',
          },
        },
        required: ['channel_id', 'message'],
      },
    },
    {
      name: 'channel_list',
      description: 'List the Kritaka channels this agent is subscribed to.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'channel_history',
      description: 'Get recent message history from a Kritaka channel.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          channel_id: {
            type: 'string',
            description: 'The channel ID to get history for',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of messages to return (default: 50)',
          },
        },
        required: ['channel_id'],
      },
    },
  ],
}))

// Handle tool calls
let hubClient: HubClient | null = null

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name } = req.params
  const args = req.params.arguments as Record<string, string>

  if (name === 'channel_reply') {
    if (!hubClient?.isConnected()) {
      return {
        content: [{ type: 'text' as const, text: 'Error: Not connected to Kritaka hub' }],
      }
    }

    hubClient.sendMessage(args.channel_id, args.message)
    return {
      content: [{ type: 'text' as const, text: `Message sent to channel ${args.channel_id}` }],
    }
  }

  if (name === 'channel_list') {
    const list = SUBSCRIPTIONS.length > 0
      ? SUBSCRIPTIONS.join('\n')
      : 'No channels subscribed.'
    return {
      content: [{ type: 'text' as const, text: list }],
    }
  }

  if (name === 'channel_history') {
    if (!hubClient?.isConnected()) {
      return {
        content: [{ type: 'text' as const, text: 'Error: Not connected to Kritaka hub' }],
      }
    }

    const limit = args.limit ? parseInt(args.limit, 10) : 50
    const history = await hubClient.requestHistory(args.channel_id, limit)
    if (!history || history.length === 0) {
      return {
        content: [{ type: 'text' as const, text: 'No messages in this channel yet.' }],
      }
    }

    const formatted = history
      .map((m) => `[${m.created_at}] ${m.author_name} (${m.author_type}): ${m.content}`)
      .join('\n')

    return {
      content: [{ type: 'text' as const, text: formatted }],
    }
  }

  throw new Error(`Unknown tool: ${name}`)
})

// Connect to Hub and Claude Code
async function main() {
  // Connect to the Kritaka Hub
  hubClient = new HubClient(HUB_PORT, AGENT_ID, AGENT_NAME, SUBSCRIPTIONS)

  // When the hub sends us a message, forward it to Claude as a channel notification
  hubClient.onMessage(async (msg) => {
    if (msg.type === 'channel_message') {
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          channel: 'kritaka',
          content: msg.content ?? '',
          meta: {
            channel_id: msg.channel_id ?? '',
            author: msg.author_name ?? 'unknown',
            author_type: msg.author_type ?? 'unknown',
            author_id: msg.author_id ?? '',
            message_id: msg.message_id ?? '',
            timestamp: msg.timestamp ?? '',
          },
        },
      })
    }
  })

  hubClient.connect()

  // Connect to Claude Code over stdio
  await mcp.connect(new StdioServerTransport())
}

main().catch((err) => {
  process.stderr.write(`[Bridge] Fatal error: ${err}\n`)
  process.exit(1)
})

// Re-export for library consumers
export { HubClient } from './hub-client.js'
export { HubMessage, encodeMessage, parseMessages, HUB_PORT } from './protocol.js'
