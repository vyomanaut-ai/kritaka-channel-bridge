// Hub <-> Bridge wire protocol (newline-delimited JSON over TCP)

// KTK-191: Decision question/choice payloads carried over the bridge ↔ hub
// wire. The bridge mints stable q*/c* ids before sending so the hub doesn't
// have to round-trip them.
export interface DecisionQuestionFrame {
  id: string
  prompt: string
  choices: Array<{ id: string; label: string }>
}

export interface HubMessage {
  type:
    | 'channel_message'
    | 'subscribe'
    | 'unsubscribe'
    | 'register'
    | 'ack'
    | 'history_request'
    | 'history_response'
    | 'reaction_add'
    | 'reaction_remove'
    | 'reaction_event'
    | 'subscriptions_request'
    | 'subscriptions_response'
    | 'decision_create_request'
    | 'decision_create_response'
    | 'decision_cancel_request'
    | 'decision_cancel_response'
  channel_id?: string
  agent_id?: string
  agent_name?: string
  content?: string
  author_type?: 'human' | 'agent' | 'system' | 'webhook' | 'journalist'
  author_id?: string | null
  author_name?: string
  message_id?: string
  metadata?: Record<string, string>
  seq?: number
  timestamp?: string
  // For register + subscriptions_response: channel IDs this agent subscribes to
  channel_ids?: string[]
  // For subscriptions_response: parallel to channel_ids, human-readable names
  channel_names?: string[]
  // For history_request
  limit?: number
  // For history_response
  messages?: Array<{
    author_name: string
    author_type: string
    content: string
    created_at: string
  }>
  // For reaction_add, reaction_remove, reaction_event
  emoji?: string
  action?: 'add' | 'remove'
  // For decision_* request/response. req_id pairs request to response so the
  // bridge can resolve the awaiting Promise.
  req_id?: string
  decision_id?: string
  questions?: DecisionQuestionFrame[]
  error?: string
}

export const HUB_PORT = 19850

export function encodeMessage(msg: HubMessage): string {
  return JSON.stringify(msg) + '\n'
}

export function parseMessages(buffer: string): { messages: HubMessage[]; remainder: string } {
  const messages: HubMessage[] = []
  let remainder = buffer
  let newlineIdx: number

  while ((newlineIdx = remainder.indexOf('\n')) !== -1) {
    const line = remainder.slice(0, newlineIdx).trim()
    remainder = remainder.slice(newlineIdx + 1)
    if (line) {
      try {
        messages.push(JSON.parse(line) as HubMessage)
      } catch {
        // skip malformed lines
      }
    }
  }

  return { messages, remainder }
}
