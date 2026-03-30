import * as net from 'net'
import { encodeMessage, parseMessages } from './protocol.js'
import type { HubMessage } from './protocol.js'

type MessageHandler = (msg: HubMessage) => void

type HistoryEntry = { author_name: string; author_type: string; content: string; created_at: string }

export class HubClient {
  private socket: net.Socket | null = null
  private buffer = ''
  private handlers: MessageHandler[] = []
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private connected = false
  private historyResolvers = new Map<string, (entries: HistoryEntry[]) => void>()

  constructor(
    private port: number,
    private agentId: string,
    private agentName: string,
    private channelIds: string[],
  ) {}

  connect(): void {
    if (this.socket) return

    this.socket = net.createConnection({ port: this.port, host: '127.0.0.1' }, () => {
      this.connected = true
      process.stderr.write(`[Bridge] Connected to hub on port ${this.port}\n`)

      // Register with the hub
      this.socket!.write(
        encodeMessage({
          type: 'register',
          agent_id: this.agentId,
          agent_name: this.agentName,
          channel_ids: this.channelIds,
        }),
      )
    })

    this.socket.on('data', (data) => {
      this.buffer += data.toString()
      const { messages, remainder } = parseMessages(this.buffer)
      this.buffer = remainder

      for (const msg of messages) {
        // Handle history responses via promise resolver
        if (msg.type === 'history_response' && msg.channel_id) {
          const resolver = this.historyResolvers.get(msg.channel_id)
          if (resolver) {
            this.historyResolvers.delete(msg.channel_id)
            resolver((msg.messages as HistoryEntry[]) ?? [])
          }
          continue
        }

        for (const handler of this.handlers) {
          handler(msg)
        }
      }
    })

    this.socket.on('close', () => {
      this.connected = false
      this.socket = null
      process.stderr.write('[Bridge] Disconnected from hub, reconnecting in 3s...\n')
      this.scheduleReconnect()
    })

    this.socket.on('error', (err) => {
      process.stderr.write(`[Bridge] Socket error: ${err.message}\n`)
      this.connected = false
      this.socket?.destroy()
      this.socket = null
      this.scheduleReconnect()
    })
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, 3000)
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler)
  }

  sendMessage(channelId: string, content: string): void {
    if (!this.socket || !this.connected) return
    this.socket.write(
      encodeMessage({
        type: 'channel_message',
        channel_id: channelId,
        content,
        agent_id: this.agentId,
        author_name: this.agentName,
        author_type: 'agent',
      }),
    )
  }

  sendReaction(channelId: string, messageId: string, emoji: string, action: 'add' | 'remove'): void {
    if (!this.socket || !this.connected) return
    this.socket.write(
      encodeMessage({
        type: action === 'remove' ? 'reaction_remove' : 'reaction_add',
        channel_id: channelId,
        message_id: messageId,
        emoji,
        agent_id: this.agentId,
        author_name: this.agentName,
        author_type: 'agent',
      }),
    )
  }

  requestHistory(channelId: string, limit: number): Promise<HistoryEntry[]> {
    if (!this.socket || !this.connected) return Promise.resolve([])

    return new Promise((resolve) => {
      // Timeout after 5s
      const timer = setTimeout(() => {
        this.historyResolvers.delete(channelId)
        resolve([])
      }, 5000)

      this.historyResolvers.set(channelId, (entries) => {
        clearTimeout(timer)
        resolve(entries)
      })

      this.socket!.write(
        encodeMessage({
          type: 'history_request',
          channel_id: channelId,
          limit,
        }),
      )
    })
  }

  isConnected(): boolean {
    return this.connected
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.socket) {
      this.socket.destroy()
      this.socket = null
      this.connected = false
    }
  }
}
