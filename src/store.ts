import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from '@earendil-works/pi-ai'

const FILE_VERSION = 1
const DEFAULT_LOCK_TIMEOUT_MS = 30_000
const STALE_LOCK_MS = 10 * 60_000

interface CredentialFile {
  version: 1
  credentials: Record<string, Credential>
}

export interface FileCredentialStoreOptions {
  lockTimeoutMs?: number
  staleLockMs?: number
}

function configHome(): string {
  const explicit = process.env['XDG_CONFIG_HOME']
  if (explicit !== undefined && explicit.length > 0) return explicit
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support')
  if (platform() === 'win32') return process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming')
  return join(homedir(), '.config')
}

/** Resolve the shared credential file used by both DSH and the login CLI. */
export function resolveCredentialFile(configured?: string): string {
  const selected = configured ?? process.env['DSH_OPEN_AUTH_FILE']
  return resolve(selected ?? join(configHome(), 'dsh-open-auth', 'auth.json'))
}

function emptyFile(): CredentialFile {
  return { version: FILE_VERSION, credentials: {} }
}

function isCredential(value: unknown): value is Credential {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (record['type'] === 'api_key') {
    return (record['key'] === undefined || typeof record['key'] === 'string')
      && (record['env'] === undefined || (typeof record['env'] === 'object' && record['env'] !== null && !Array.isArray(record['env'])))
  }
  return record['type'] === 'oauth'
    && typeof record['refresh'] === 'string'
    && typeof record['access'] === 'string'
    && typeof record['expires'] === 'number'
    && Number.isFinite(record['expires'])
}

function cloneCredential(value: Credential | undefined): Credential | undefined {
  return value === undefined ? undefined : structuredClone(value)
}

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted()
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((accept, reject) => {
    let timer: NodeJS.Timeout
    const done = (): void => {
      signal?.removeEventListener('abort', abort)
      accept()
    }
    const abort = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(signal?.reason)
    }
    timer = setTimeout(done, ms)
    if (signal === undefined) return
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

/**
 * Durable pi CredentialStore with atomic replacement and a cross-process lock.
 * A single file lock is deliberately stronger than pi's per-provider contract:
 * credentials for different providers cannot lose each other's updates.
 */
export class FileCredentialStore implements CredentialStore {
  readonly file: string
  private readonly lockTimeoutMs: number
  private readonly staleLockMs: number

  constructor(file = resolveCredentialFile(), options: FileCredentialStoreOptions = {}) {
    this.file = resolve(file)
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS
    this.staleLockMs = options.staleLockMs ?? STALE_LOCK_MS
  }

  private async load(): Promise<CredentialFile> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyFile()
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new Error(`dsh-open-auth: credential file is not valid JSON: ${this.file}`, { cause: error })
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`dsh-open-auth: invalid credential file root: ${this.file}`)
    }
    const record = parsed as Record<string, unknown>
    if (record['version'] !== FILE_VERSION
      || typeof record['credentials'] !== 'object'
      || record['credentials'] === null
      || Array.isArray(record['credentials'])) {
      throw new Error(`dsh-open-auth: unsupported credential file format: ${this.file}`)
    }
    const credentials: Record<string, Credential> = {}
    for (const [providerId, credential] of Object.entries(record['credentials'])) {
      if (providerId.length === 0 || !isCredential(credential)) {
        throw new Error(`dsh-open-auth: invalid credential entry for "${providerId}" in ${this.file}`)
      }
      credentials[providerId] = structuredClone(credential)
    }
    return { version: FILE_VERSION, credentials }
  }

  private async save(value: CredentialFile): Promise<void> {
    const directory = dirname(this.file)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporary = join(directory, `.${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, this.file)
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
    }
  }

  private async withLock<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const lock = `${this.file}.lock`
    await mkdir(dirname(lock), { recursive: true, mode: 0o700 })
    const started = Date.now()
    let pause = 15
    while (true) {
      throwIfAborted(signal)
      try {
        await mkdir(lock, { mode: 0o700 })
        await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, createdAt: Date.now() }), {
          encoding: 'utf8',
          mode: 0o600,
        })
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const age = await stat(lock).then(info => Date.now() - info.mtimeMs).catch(() => 0)
        if (age > this.staleLockMs) {
          await unlink(join(lock, 'owner.json')).catch(() => undefined)
          await rmdir(lock).catch(() => undefined)
          continue
        }
        if (Date.now() - started >= this.lockTimeoutMs) {
          throw new Error(`dsh-open-auth: timed out waiting for credential lock: ${lock}`)
        }
        await delay(pause, signal)
        pause = Math.min(Math.ceil(pause * 1.5), 250)
      }
    }
    try {
      return await operation()
    } finally {
      await unlink(join(lock, 'owner.json')).catch(() => undefined)
      await rmdir(lock).catch(() => undefined)
    }
  }

  async read(providerId: string, options: AuthOperationOptions = {}): Promise<Credential | undefined> {
    throwIfAborted(options.signal)
    return cloneCredential((await this.load()).credentials[providerId])
  }

  async list(options: AuthOperationOptions = {}): Promise<readonly CredentialInfo[]> {
    throwIfAborted(options.signal)
    const credentials = (await this.load()).credentials
    return Object.entries(credentials)
      .map(([providerId, credential]) => ({ providerId, type: credential.type }))
      .sort((left, right) => left.providerId.localeCompare(right.providerId))
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options: AuthOperationOptions = {},
  ): Promise<Credential | undefined> {
    if (providerId.length === 0) throw new Error('dsh-open-auth: provider id must not be empty')
    return this.withLock(async () => {
      throwIfAborted(options.signal)
      const file = await this.load()
      const current = cloneCredential(file.credentials[providerId])
      const next = await fn(current)
      throwIfAborted(options.signal)
      if (next === undefined) return current
      if (!isCredential(next)) throw new Error(`dsh-open-auth: invalid credential returned for "${providerId}"`)
      file.credentials[providerId] = structuredClone(next)
      await this.save(file)
      return cloneCredential(next)
    }, options.signal)
  }

  async delete(providerId: string, options: AuthOperationOptions = {}): Promise<void> {
    await this.withLock(async () => {
      throwIfAborted(options.signal)
      const file = await this.load()
      if (!(providerId in file.credentials)) return
      delete file.credentials[providerId]
      await this.save(file)
    }, options.signal)
  }
}
