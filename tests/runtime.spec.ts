import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import * as plugin from '../src/index.js'
import { createOpenAuthRuntime } from '../src/runtime.js'

describe('pi builtin registry', () => {
  it('keeps an omitted provider list distinct from an explicit empty list', () => {
    expect(plugin.Config({}).providers).toBeUndefined()
    expect(plugin.Config({ providers: [] }).providers).toEqual([])
  })

  it('includes the OpenAI Codex and Kimi subscription providers', () => {
    const runtime = createOpenAuthRuntime({ credentialFile: '/tmp/dsh-open-auth-runtime-test.json' })
    const codex = runtime.models.getProvider('openai-codex')
    const kimi = runtime.models.getProvider('kimi-coding')

    expect(codex?.auth.oauth?.isSubscription).toBe(true)
    expect(codex?.getModels().length).toBeGreaterThan(0)
    expect(kimi?.auth.oauth?.isSubscription).toBe(true)
    expect(kimi?.getModels().length).toBeGreaterThan(0)
  })

  it('registers a broad provider set from pi rather than a local allowlist', () => {
    const runtime = createOpenAuthRuntime({ credentialFile: '/tmp/dsh-open-auth-runtime-test.json' })
    expect(runtime.models.getProviders().length).toBeGreaterThanOrEqual(40)
    expect(runtime.models.getProvider('deepseek')).toBeDefined()
    expect(runtime.models.getProvider('github-copilot')).toBeDefined()
    expect(runtime.models.getProvider('openrouter')).toBeDefined()
  })

  it('mounts in a real Cordis LLM runtime', async () => {
    const ctx = new Context()
    const llmFiber = ctx.plugin(LlmRuntime)
    await llmFiber
    const pluginFiber = ctx.plugin(plugin, {
      providers: ['openai-codex', 'kimi-coding'],
      credentialFile: '/tmp/dsh-open-auth-plugin-test/auth.json',
    })
    await pluginFiber
    try {
      expect(ctx.llm.listProviders()).toEqual([
        { id: 'openai-codex', name: 'OpenAI Codex' },
        { id: 'kimi-coding', name: 'Kimi For Coding' },
      ])
      expect((await ctx.llm.listModels('openai-codex')).length).toBeGreaterThan(0)
    } finally {
      await pluginFiber.dispose()
      await llmFiber.dispose()
    }
  })
})
