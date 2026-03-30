// Hub <-> Bridge wire protocol (newline-delimited JSON over TCP)

export interface HubMessage {
  type: 'channel_message' | 'subscribe' | 'unsubscribe' | 'register' | 'ack' | 'history_request' | 'history_response' | 'reaction_add' | 'reaction_remove' | 'reaction_event'
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
  // For register: list of channel IDs this agent subscribes to
  channel_ids?: string[]
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
