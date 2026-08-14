import { LlmError } from '@deepseek-ai/dsh-llm'
import type { Message, ModelMessageSource } from '@deepseek-ai/dsh-llm'
import type { Api, AssistantMessage, Usage as PiUsage } from '@earendil-works/pi-ai'

type ReplayBlock =
  | { type: 'text'; textSignature?: string }
  | { type: 'reasoning'; thinkingSignature?: string; redacted?: boolean }
  | { type: 'tool-call'; thoughtSignature?: string }

export interface PiReplayState {
  kind: 'pi-ai'
  version: 1
  api: Api
  provider: string
  model: string
  responseModel?: string
  responseId?: string
  stopReason: AssistantMessage['stopReason']
  blocks: ReplayBlock[]
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>
  } catch {}
  return {}
}

function emptyUsage(): PiUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

export function toPiReplayState(message: AssistantMessage): PiReplayState {
  return {
    kind: 'pi-ai',
    version: 1,
    api: message.api,
    provider: message.provider,
    model: message.model,
    ...(message.responseModel === undefined ? {} : { responseModel: message.responseModel }),
    ...(message.responseId === undefined ? {} : { responseId: message.responseId }),
    stopReason: message.stopReason,
    blocks: message.content.map((block): ReplayBlock => {
      switch (block.type) {
        case 'text': return { type: 'text', ...(block.textSignature === undefined ? {} : { textSignature: block.textSignature }) }
        case 'thinking': return {
          type: 'reasoning',
          ...(block.thinkingSignature === undefined ? {} : { thinkingSignature: block.thinkingSignature }),
          ...(block.redacted === undefined ? {} : { redacted: block.redacted }),
        }
        case 'toolCall': return { type: 'tool-call', ...(block.thoughtSignature === undefined ? {} : { thoughtSignature: block.thoughtSignature }) }
      }
    }),
  }
}

function invalid(message: string): never {
  throw new LlmError(`invalid pi-ai replay state: ${message}`, 'INVALID_REPLAY_STATE')
}

function readReplay(value: unknown): PiReplayState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid('expected an object')
  const state = value as Record<string, unknown>
  if (state['kind'] !== 'pi-ai' || state['version'] !== 1) return invalid('unsupported kind or version')
  for (const key of ['api', 'provider', 'model'] as const) {
    if (typeof state[key] !== 'string' || state[key].length === 0) return invalid(`${key} must be a non-empty string`)
  }
  if (!['stop', 'length', 'toolUse', 'error', 'aborted'].includes(String(state['stopReason']))) return invalid('unknown stopReason')
  if (state['responseModel'] !== undefined && typeof state['responseModel'] !== 'string') return invalid('responseModel must be a string')
  if (state['responseId'] !== undefined && typeof state['responseId'] !== 'string') return invalid('responseId must be a string')
  if (!Array.isArray(state['blocks'])) return invalid('blocks must be an array')
  for (const [index, value] of state['blocks'].entries()) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid(`block ${index} must be an object`)
    const block = value as Record<string, unknown>
    if (!['text', 'reasoning', 'tool-call'].includes(String(block['type']))) return invalid(`block ${index} has an unknown type`)
  }
  return state as unknown as PiReplayState
}

function foreignAssistant(message: Message): AssistantMessage {
  const source = message.source.kind === 'model' ? message.source : undefined
  const content: AssistantMessage['content'] = []
  for (const block of message.content) {
    switch (block.type) {
      case 'text': content.push({ type: 'text', text: block.text }); break
      case 'reasoning': content.push({ type: 'thinking', thinking: block.text }); break
      case 'tool-call': content.push({ type: 'toolCall', id: block.id, name: block.name, arguments: parseArguments(block.arguments) }); break
      case 'image': throw new LlmError('pi-ai cannot replay assistant image output', 'UNSUPPORTED_CONTENT')
      default: break
    }
  }
  return {
    role: 'assistant',
    content,
    api: 'dsh-foreign',
    provider: source?.provider ?? 'dsh-foreign',
    model: source?.model ?? 'dsh-foreign',
    usage: emptyUsage(),
    stopReason: content.some(block => block.type === 'toolCall') ? 'toolUse' : 'stop',
    timestamp: 0,
  }
}

function replayedAssistant(message: Message, source: ModelMessageSource, raw: unknown): AssistantMessage {
  const state = readReplay(raw)
  if (state.provider !== source.provider || state.model !== source.model) return invalid('provider/model does not match source')
  if (state.blocks.length !== message.content.length) return invalid('block count does not match content')
  const content: AssistantMessage['content'] = message.content.map((block, index) => {
    const replay = state.blocks[index]
    if (replay === undefined || replay.type !== block.type) return invalid(`block ${index} does not match content`)
    switch (block.type) {
      case 'text': return { type: 'text', text: block.text, ...(replay.type === 'text' && replay.textSignature !== undefined ? { textSignature: replay.textSignature } : {}) }
      case 'reasoning': return {
        type: 'thinking',
        thinking: block.text,
        ...(replay.type === 'reasoning' && replay.thinkingSignature !== undefined ? { thinkingSignature: replay.thinkingSignature } : {}),
        ...(replay.type === 'reasoning' && replay.redacted !== undefined ? { redacted: replay.redacted } : {}),
      }
      case 'tool-call': return {
        type: 'toolCall', id: block.id, name: block.name, arguments: parseArguments(block.arguments),
        ...(replay.type === 'tool-call' && replay.thoughtSignature !== undefined ? { thoughtSignature: replay.thoughtSignature } : {}),
      }
      default: return invalid(`unsupported block ${index}`)
    }
  })
  return {
    role: 'assistant',
    content,
    api: state.api,
    provider: state.provider,
    model: state.model,
    ...(state.responseModel === undefined ? {} : { responseModel: state.responseModel }),
    ...(state.responseId === undefined ? {} : { responseId: state.responseId }),
    usage: emptyUsage(),
    stopReason: state.stopReason,
    timestamp: 0,
  }
}

export function toPiAssistant(message: Message): AssistantMessage {
  const source = message.source
  return source.kind !== 'model' || source.replayState === undefined
    ? foreignAssistant(message)
    : replayedAssistant(message, source, source.replayState)
}
