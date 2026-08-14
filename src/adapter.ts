import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import {
  attributionHeaders,
  contentHasImage,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import type { Api, Model, Models, ThinkingLevel } from '@earendil-works/pi-ai'
import { toPiContext } from './context.js'
import { toStreamChunks } from './stream.js'

export interface OpenAuthAdapterOptions {
  models: Models
  providers: readonly string[]
  resolveAttachments?: () => AttachmentStore | undefined
  streamIdleTimeoutMs?: number
  requestTimeoutMs?: number
  refreshDynamicModels?: boolean
}

const DEFAULT_IDLE_TIMEOUT = 300_000

export class OpenAuthAdapter extends LlmAdapter {
  private readonly owned: ReadonlySet<string>
  private readonly refreshes = new Map<string, Promise<void>>()

  constructor(private readonly options: OpenAuthAdapterOptions) {
    super()
    this.owned = new Set(options.providers)
  }

  private provider(provider: string) {
    if (!this.owned.has(provider)) throw new LlmError(`dsh-open-auth does not own provider "${provider}"`, 'NO_ADAPTER')
    const resolved = this.options.models.getProvider(provider)
    if (resolved === undefined) throw new LlmError(`unknown pi-ai provider "${provider}"`, 'NO_ADAPTER')
    return resolved
  }

  private async refresh(provider: string, signal?: AbortSignal): Promise<void> {
    if (this.options.refreshDynamicModels === false || this.options.models.getModels(provider).length > 0) return
    const previous = this.refreshes.get(provider)
    if (previous !== undefined) return previous
    const task = this.options.models.refresh({ providers: [provider], allowNetwork: true, ...(signal === undefined ? {} : { signal }) })
      .then((result) => {
        const error = result.errors.get(provider)
        if (error !== undefined) throw error
      })
      .finally(() => this.refreshes.delete(provider))
    this.refreshes.set(provider, task)
    return task
  }

  private async model(provider: string, id: string, signal?: AbortSignal): Promise<Model<Api>> {
    this.provider(provider)
    let model = this.options.models.getModel(provider, id)
    if (model === undefined) {
      await this.refresh(provider, signal)
      model = this.options.models.getModel(provider, id)
    }
    if (model === undefined) throw new LlmError(`pi-ai provider "${provider}" has no model "${id}"`, 'UNKNOWN_MODEL')
    return model
  }

  override providerInfo(provider: string): LlmProviderInfo {
    const resolved = this.provider(provider)
    return { id: provider, name: resolved.name }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    this.provider(provider)
    await this.refresh(provider)
    return this.options.models.getModels(provider).map(model => ({
      provider,
      id: model.id,
      name: model.name,
      inputModalities: [...model.input],
    }))
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const resolved = await this.model(provider, model, signal)
    return {
      provider,
      id: model,
      name: resolved.name,
      inputModalities: [...resolved.input],
      context: { contextWindow: resolved.contextWindow },
      ...(resolved.reasoning ? {
        reasoning: {
          efforts: getSupportedThinkingLevels(resolved).map(level => ({
            id: ReasoningEffortId(level),
            name: `${level.charAt(0).toUpperCase()}${level.slice(1)}`,
          })),
        },
      } : {}),
    }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.stop !== undefined) throw new LlmError('dsh-open-auth does not support GenerateOptions.stop', 'UNSUPPORTED_OPTION')
    const model = await this.model(options.provider, options.model, options.signal)
    let reasoning: ThinkingLevel | undefined
    if (options.reasoningEffort !== undefined) {
      const levels = getSupportedThinkingLevels(model)
      if (!levels.some(level => level === options.reasoningEffort)) {
        throw new LlmError(`model "${model.id}" does not support reasoning effort "${options.reasoningEffort}"`, 'UNSUPPORTED_REASONING_EFFORT')
      }
      reasoning = options.reasoningEffort === 'off' ? undefined : options.reasoningEffort as ThinkingLevel
    }

    const consumer = new AbortController()
    const upstream = options.signal === undefined ? consumer.signal : AbortSignal.any([options.signal, consumer.signal])
    const idleTimeout = this.options.streamIdleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT
    using watchdog = idleWatchdog(upstream, idleTimeout, 'LLM_STREAM_IDLE_TIMEOUT')
    try {
      const containsImage = options.messages.some(message => contentHasImage(message.content))
      if (containsImage && !model.input.includes('image')) throw new LlmError(`model "${model.id}" does not support image input`, 'UNSUPPORTED_CONTENT')
      const attachments = containsImage ? this.options.resolveAttachments?.() : undefined
      if (containsImage && attachments === undefined) throw new LlmError('image input requires the DSH attachment service', 'UNSUPPORTED_CONTENT')
      const context = attachments === undefined ? toPiContext(options) : await toPiContext(options, attachments)
      const events = this.options.models.streamSimple(model, context, {
        ...(reasoning === undefined ? {} : { reasoning }),
        ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
        ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
        ...(options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) }),
        ...(this.options.requestTimeoutMs === undefined ? {} : { timeoutMs: this.options.requestTimeoutMs }),
        maxRetries: 0,
        signal: watchdog.signal,
        headers: attributionHeaders(),
      })
      const iterator = toStreamChunks(events, model.contextWindow)[Symbol.asyncIterator]()
      let exhausted = false
      try {
        while (true) {
          const result = await watchdog.next(iterator)
          const timeout = timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT')
          if (timeout !== undefined) throw timeout
          if (result.done) {
            exhausted = true
            return
          }
          yield result.value
        }
      } finally {
        if (!exhausted) {
          consumer.abort('dsh-open-auth stream consumer stopped')
          try { await iterator.return(undefined) } catch {}
        }
      }
    } catch (error) {
      if (timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT') !== undefined) {
        throw new LlmError(`pi-ai stream idle timeout after ${idleTimeout}ms`, 'TIMEOUT', { cause: error })
      }
      if (options.signal?.aborted) throw new LlmError('pi-ai request aborted by caller', 'ABORTED', { cause: error })
      throw error
    } finally {
      consumer.abort('dsh-open-auth stream consumer stopped')
    }
  }
}
