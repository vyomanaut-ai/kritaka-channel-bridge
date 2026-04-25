import * as net from 'net'
import { randomUUID } from 'crypto'
import { encodeMessage, parseMessages } from './protocol.js'
import type { HubMessage, DecisionQuestionFrame } from './protocol.js'

type MessageHandler = (msg: HubMessage) => void

type HistoryEntry = { author_name: string; author_type: string; content: string; created_at: string }

export type SubscriptionsChangedHandler = (ids: string[], names: string[]) => void

// Periodic refresh cadence — KTK-183. Mid-session subscription changes
// (e.g. scout leases) land in D1 + Hub's local cache, but the bridge's
// own channelIds is otherwise set once at `register` time. Poll to catch
// up without needing a session restart.
const SUBSCRIPTIONS_REFRESH_INTERVAL_MS = 30_000

export class HubClient {
  private socket: net.Socket | null = null
  private buffer = ''
  private handlers: MessageHandler[] = []
  private subscriptionsHandlers: SubscriptionsChangedHandler[] = []
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private refreshTimer: ReturnType<typeof setInterval> | null = null
  private connected = false
  private historyResolvers = new Map<string, (entries: HistoryEntry[]) => void>()
  // KTK-191: in-flight decision RPCs keyed by req_id. Resolves with a
  // typed result on response or rejects on `error` / timeout.
  private decisionResolvers = new Map<
    string,
    { resolve: (value: { decision_id?: string; ok?: boolean }) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }
  >()
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

      this.startSubscriptionsRefresh()
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

        if (msg.type === 'subscriptions_response') {
          this.applySubscriptions(msg.channel_ids ?? [], msg.channel_names ?? [])
          continue
        }

        if (
          (msg.type === 'decision_create_response' || msg.type === 'decision_cancel_response') &&
          msg.req_id
        ) {
          const pending = this.decisionResolvers.get(msg.req_id)
          if (pending) {
            this.decisionResolvers.delete(msg.req_id)
            clearTimeout(pending.timer)
            if (msg.error) {
              pending.reject(new Error(msg.error))
            } else if (msg.type === 'decision_create_response') {
              pending.resolve({ decision_id: msg.decision_id })
            } else {
              pending.resolve({ ok: true })
            }
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
      this.stopSubscriptionsRefresh()
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
      this.stopSubscriptionsRefresh()
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

  /**
   * Subscribe to mid-session subscription changes. Fires with the new
   * channel_ids + channel_names after any refresh that produces a diff,
   * so the caller can update derived state (e.g. the MCP `channel_list`
   * tool output).
   */
  onSubscriptionsChanged(handler: SubscriptionsChangedHandler): void {
    this.subscriptionsHandlers.push(handler)
  }

  private startSubscriptionsRefresh(): void {
    this.stopSubscriptionsRefresh()
    this.refreshTimer = setInterval(() => {
      this.requestSubscriptions()
    }, SUBSCRIPTIONS_REFRESH_INTERVAL_MS)
  }

  private stopSubscriptionsRefresh(): void {
    if (!this.refreshTimer) return
    clearInterval(this.refreshTimer)
    this.refreshTimer = null
  }

  private requestSubscriptions(): void {
    if (!this.socket || !this.connected) return
    this.socket.write(
      encodeMessage({ type: 'subscriptions_request', agent_id: this.agentId }),
    )
  }

  private applySubscriptions(nextIds: string[], nextNames: string[]): void {
    const current = new Set(this.channelIds)
    const incoming = new Set(nextIds)

    const added = nextIds.filter((id) => !current.has(id))
    const removed = this.channelIds.filter((id) => !incoming.has(id))

    if (added.length === 0 && removed.length === 0) return

    // Emit subscribe/unsubscribe frames so Hub updates its routing state.
    for (const id of added) {
      this.socket?.write(encodeMessage({ type: 'subscribe', channel_id: id, agent_id: this.agentId }))
    }
    for (const id of removed) {
      this.socket?.write(encodeMessage({ type: 'unsubscribe', channel_id: id, agent_id: this.agentId }))
    }

    this.channelIds = nextIds
    for (const handler of this.subscriptionsHandlers) {
      handler(nextIds, nextNames)
    }
    this.diag(`subscriptions refreshed: +${added.length} -${removed.length} (total ${nextIds.length})`)
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

  // KTK-191: Ask the daemon to create a Decision. The daemon POSTs to Hub
  // REST and responds with the new decision id. Times out at 10s.
  createDecision(channelId: string, questions: DecisionQuestionFrame[]): Promise<{ decision_id: string }> {
    if (!this.socket || !this.connected) {
      return Promise.reject(new Error('Not connected to Kritaka hub'))
    }
    const reqId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.decisionResolvers.delete(reqId)
        reject(new Error('decision_create timed out after 10s'))
      }, 10_000)
      this.decisionResolvers.set(reqId, {
        resolve: (v) => resolve({ decision_id: v.decision_id! }),
        reject,
        timer,
      })
      this.socket!.write(
        encodeMessage({
          type: 'decision_create_request',
          req_id: reqId,
          channel_id: channelId,
          agent_id: this.agentId,
          questions,
        }),
      )
    })
  }

  cancelDecision(decisionId: string): Promise<{ ok: boolean }> {
    if (!this.socket || !this.connected) {
      return Promise.reject(new Error('Not connected to Kritaka hub'))
    }
    const reqId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.decisionResolvers.delete(reqId)
        reject(new Error('decision_cancel timed out after 10s'))
      }, 10_000)
      this.decisionResolvers.set(reqId, {
        resolve: () => resolve({ ok: true }),
        reject,
        timer,
      })
      this.socket!.write(
        encodeMessage({
          type: 'decision_cancel_request',
          req_id: reqId,
          decision_id: decisionId,
          agent_id: this.agentId,
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
    this.stopSubscriptionsRefresh()
    if (this.socket) {
      this.socket.destroy()
      this.socket = null
      this.connected = false
    }
  }
}
