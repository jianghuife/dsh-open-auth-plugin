import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { OpenAuthAdapter } from './adapter.js'
import { createOpenAuthRuntime } from './runtime.js'

export { OpenAuthAdapter } from './adapter.js'
export type { OpenAuthAdapterOptions } from './adapter.js'
export { createOpenAuthRuntime } from './runtime.js'
export type { OpenAuthRuntime, OpenAuthRuntimeOptions } from './runtime.js'
export { FileCredentialStore, resolveCredentialFile } from './store.js'
export type { FileCredentialStoreOptions } from './store.js'

export const name = 'dsh-open-auth'
export const inject = ['llm']

export interface Config {
  /** Shared JSON credential file. Also configurable with DSH_OPEN_AUTH_FILE. */
  credentialFile?: string
  /** Provider routes to register. Omit for every builtin pi chat provider. */
  providers?: string[] | null
  /** Maximum idle interval during a streamed response. */
  streamIdleTimeoutMs?: number
  /** Provider SDK request timeout. */
  requestTimeoutMs?: number
  /** Lazily fetch dynamic provider catalogs when their model list is empty. */
  refreshDynamicModels?: boolean
}

export const Config: z<Config> = z.object({
  credentialFile: z.string(),
  // The nullable union preserves omission. A bare Schemastery array
  // materializes an absent field as [], which would disable the default
  // all-provider posture.
  providers: z.union([z.const(null), z.array(z.string())]),
  streamIdleTimeoutMs: z.number().min(1).default(300_000),
  requestTimeoutMs: z.number().min(1),
  refreshDynamicModels: z.boolean().default(true),
})

export function apply(ctx: Context, config: Config = {}): void {
  const runtime = createOpenAuthRuntime(config.credentialFile === undefined ? {} : { credentialFile: config.credentialFile })
  const available = new Set(runtime.models.getProviders().map(provider => provider.id))
  const providers = config.providers ?? [...available]
  const unique = [...new Set(providers)]
  const unknown = unique.filter(provider => !available.has(provider))
  if (unknown.length > 0) throw new Error(`dsh-open-auth: unknown pi-ai providers: ${unknown.join(', ')}`)
  if (unique.length === 0) throw new Error('dsh-open-auth: providers must not be empty')

  const adapter = new OpenAuthAdapter({
    models: runtime.models,
    providers: unique,
    resolveAttachments: () => ctx.get('attachments'),
    ...(config.streamIdleTimeoutMs === undefined ? {} : { streamIdleTimeoutMs: config.streamIdleTimeoutMs }),
    ...(config.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: config.requestTimeoutMs }),
    ...(config.refreshDynamicModels === undefined ? {} : { refreshDynamicModels: config.refreshDynamicModels }),
  })
  ctx.llm.registerAdapter(unique, adapter)
  ctx.logger.info(`dsh-open-auth: registered ${unique.length} pi-ai providers; credentials: ${runtime.store.file}`)
}
