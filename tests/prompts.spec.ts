import { input, password, select } from '@inquirer/prompts'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { promptFor } from '../src/prompts.js'

vi.mock('@inquirer/prompts', () => ({
  input: vi.fn(async () => 'input'),
  password: vi.fn(async () => 'password'),
  select: vi.fn(async () => 'selected'),
}))

describe('pi-ai prompt adapter', () => {
  beforeEach(() => vi.clearAllMocks())

  it('passes manual prompt cancellation as Inquirer context', async () => {
    const controller = new AbortController()
    await expect(promptFor({
      type: 'manual_code',
      message: 'Paste code',
      placeholder: 'http://localhost/callback',
      signal: controller.signal,
    })).resolves.toBe('input')
    expect(input).toHaveBeenCalledWith(
      { message: 'Paste code', default: 'http://localhost/callback' },
      { signal: controller.signal },
    )
  })

  it('keeps secrets masked and forwards select metadata', async () => {
    await expect(promptFor({ type: 'secret', message: 'API key' })).resolves.toBe('password')
    expect(password).toHaveBeenCalledWith({ message: 'API key', mask: '*' }, undefined)

    await expect(promptFor({
      type: 'select',
      message: 'Method',
      options: [{ id: 'browser', label: 'Browser', description: 'Local callback' }],
    })).resolves.toBe('selected')
    expect(select).toHaveBeenCalledWith({
      message: 'Method',
      choices: [{ value: 'browser', name: 'Browser', description: 'Local callback' }],
    }, undefined)
  })
})
