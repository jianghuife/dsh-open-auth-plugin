import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileCredentialStore } from '../src/store.js'

async function fixture(): Promise<FileCredentialStore> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-open-auth-'))
  return new FileCredentialStore(join(directory, 'auth.json'))
}

describe('FileCredentialStore', () => {
  it('stores and lists OAuth credentials without exposing secrets', async () => {
    const store = await fixture()
    await store.modify('openai-codex', async () => ({
      type: 'oauth', refresh: 'refresh', access: 'access', expires: Date.now() + 60_000, accountId: 'acct',
    }))
    expect(await store.list()).toEqual([{ providerId: 'openai-codex', type: 'oauth' }])
    expect(await store.read('openai-codex')).toMatchObject({ type: 'oauth', accountId: 'acct' })
    expect((await stat(store.file)).mode & 0o777).toBe(0o600)
  })

  it('keeps the current value when modify returns undefined', async () => {
    const store = await fixture()
    await store.modify('kimi-coding', async () => ({ type: 'api_key', key: 'one' }))
    const result = await store.modify('kimi-coding', async current => {
      expect(current).toEqual({ type: 'api_key', key: 'one' })
      return undefined
    })
    expect(result).toEqual({ type: 'api_key', key: 'one' })
  })

  it('serializes concurrent updates from different store instances', async () => {
    const first = await fixture()
    const second = new FileCredentialStore(first.file)
    await Promise.all([
      first.modify('openai-codex', async () => ({ type: 'api_key', key: 'openai' })),
      second.modify('kimi-coding', async () => ({ type: 'api_key', key: 'kimi' })),
    ])
    expect(await first.list()).toEqual([
      { providerId: 'kimi-coding', type: 'api_key' },
      { providerId: 'openai-codex', type: 'api_key' },
    ])
  })

  it('deletes one provider and leaves a valid JSON file', async () => {
    const store = await fixture()
    await store.modify('openai-codex', async () => ({ type: 'api_key', key: 'secret' }))
    await store.delete('openai-codex')
    expect(await store.read('openai-codex')).toBeUndefined()
    expect(JSON.parse(await readFile(store.file, 'utf8'))).toEqual({ version: 1, credentials: {} })
  })
})
