import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import type { Models } from '@earendil-works/pi-ai'
import { FileCredentialStore, resolveCredentialFile } from './store.js'

export interface OpenAuthRuntimeOptions {
  credentialFile?: string
}

export interface OpenAuthRuntime {
  models: Models
  store: FileCredentialStore
}

/** Create the exact shared pi runtime used by both the DSH plugin and CLI. */
export function createOpenAuthRuntime(options: OpenAuthRuntimeOptions = {}): OpenAuthRuntime {
  const store = new FileCredentialStore(resolveCredentialFile(options.credentialFile))
  return { store, models: builtinModels({ credentials: store }) }
}
