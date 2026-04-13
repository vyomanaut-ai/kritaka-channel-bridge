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
  private connectAttempt = 0
  private ackTimer: ReturnType<typeof setTimeout> | null = null

  private diag(msg: string): void {
    process.stderr.write(`[Bridge ${new Date().toISOString()}] ${msg}\n`)
  }

  constructor(
    private port: number,
    private agentId: string,
    private agentName: string,
    private channelIds: string[],
  ) {}

  connect(): void {
    if (this.socket) return

    this.connectAttempt += 1
    const attempt = this.connectAttempt
    this.diag(`connect attempt #${attempt} → 127.0.0.1:${this.port}`)

    this.socket = net.createConnection({ port: this.port, host: '127.0.0.1' }, () => {
      this.connected = true
      this.diag(`TCP connected (attempt #${attempt}); sending register for agent=${this.agentId} channels=${this.channelIds.length}`)

      // Register with the hub
      const registerWritten = this.socket!.write(
        encodeMessage({
          type: 'register',
          agent_id: this.agentId,
          agent_name: this.agentName,
          channel_ids: this.channelIds,
        }),
      )
      this.diag(`register write returned ${registerWritten} (false = buffered due to backpressure)`)

      // Watchdog: expect an ack within 2s
      if (this.ackTimer) clearTimeout(this.ackTimer)
      this.ackTimer = setTimeout(() => {
        this.diag('WARNING: no ack from hub within 2s of register — hub may not be processing us')
        this.ackTimer = null
      }, 2000)
    })

    this.socket.on('data', (data) => {
      this.buffer += data.toString()
      const { messages, remainder } = parseMessages(this.buffer)
      this.buffer = remainder

      for (const msg of messages) {
        // Handle hub ack of our register
        if (msg.type === 'ack') {
          if (this.ackTimer) {
            clearTimeout(this.ackTimer)
            this.ackTimer = null
          }
          this.diag('register ack received from hub')
          continue
        }

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
      if (this.ackTimer) {
        clearTimeout(this.ackTimer)
        this.ackTimer = null
      }
      this.diag('disconnected from hub, reconnecting in 3s...')
      this.scheduleReconnect()
    })

    this.socket.on('error', (err) => {
      this.diag(`socket error: ${err.message}`)
      this.connected = false
      this.socket?.destroy()
      this.socket = null
      if (this.ackTimer) {
        clearTimeout(this.ackTimer)
        this.ackTimer = null
      }
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
