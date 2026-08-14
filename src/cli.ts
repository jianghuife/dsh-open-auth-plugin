#!/usr/bin/env node
import { spawn } from 'node:child_process'
import process from 'node:process'
import { input, password, select } from '@inquirer/prompts'
import type { AuthEvent, AuthInteraction, AuthPrompt, AuthType, Provider } from '@earendil-works/pi-ai'
import { createOpenAuthRuntime } from './runtime.js'

interface ParsedArgs {
  command: string
  values: string[]
  file?: string
  openBrowser: boolean
}

function parseArgs(argv: string[]): ParsedArgs {
  const values: string[] = []
  let file: string | undefined
  let openBrowser = true
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--file') {
      file = argv[index + 1]
      if (file === undefined) throw new Error('--file requires a path')
      index += 1
    } else if (value === '--no-browser') openBrowser = false
    else if (value !== undefined) values.push(value)
  }
  return { command: values.shift() ?? 'help', values, ...(file === undefined ? {} : { file }), openBrowser }
}

function usage(): void {
  console.log(`dsh-open-auth

Usage:
  dsh-open-auth providers [--file PATH]
  dsh-open-auth status [PROVIDER] [--file PATH]
  dsh-open-auth login PROVIDER [oauth|api_key] [--no-browser] [--file PATH]
  dsh-open-auth logout PROVIDER [--file PATH]
  dsh-open-auth models [PROVIDER] [--file PATH]

Examples:
  dsh-open-auth login openai-codex
  dsh-open-auth login kimi-coding oauth
  dsh-open-auth status

DSH_OPEN_AUTH_FILE can be used instead of --file.`)
}

function launchBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  const child = spawn(command, args, { detached: true, stdio: 'ignore' })
  child.on('error', () => undefined)
  child.unref()
}

function authTypes(provider: Provider): AuthType[] {
  const result: AuthType[] = []
  if (provider.auth.oauth !== undefined) result.push('oauth')
  if (provider.auth.apiKey?.login !== undefined) result.push('api_key')
  return result
}

async function promptFor(value: AuthPrompt): Promise<string> {
  const options = { message: value.message, ...(value.signal === undefined ? {} : { signal: value.signal }) }
  switch (value.type) {
    case 'secret': return password({ ...options, mask: '*' })
    case 'select': return select({
      ...options,
      choices: value.options.map(option => ({
        value: option.id,
        name: option.label,
        ...(option.description === undefined ? {} : { description: option.description }),
      })),
    })
    case 'text':
    case 'manual_code': return input({ ...options, ...(value.placeholder === undefined ? {} : { default: value.placeholder }) })
  }
}

function interaction(openBrowser: boolean): AuthInteraction {
  return {
    prompt: promptFor,
    notify(event: AuthEvent): void {
      switch (event.type) {
        case 'info':
          console.log(event.message)
          for (const link of event.links ?? []) console.log(`${link.label ?? 'Link'}: ${link.url}`)
          break
        case 'progress': console.log(event.message); break
        case 'auth_url':
          console.log(event.instructions ?? 'Open this URL to continue:')
          console.log(event.url)
          if (openBrowser) launchBrowser(event.url)
          break
        case 'device_code':
          console.log(`Open: ${event.verificationUri}`)
          console.log(`Code: ${event.userCode}`)
          if (openBrowser) launchBrowser(event.verificationUri)
          break
      }
    },
  }
}

async function selectAuthType(provider: Provider, requested: string | undefined): Promise<AuthType> {
  const types = authTypes(provider)
  if (requested !== undefined) {
    if (requested !== 'oauth' && requested !== 'api_key') throw new Error(`unknown auth type "${requested}"`)
    if (!types.includes(requested)) throw new Error(`provider "${provider.id}" does not support interactive ${requested} login`)
    return requested
  }
  if (types.length === 0) throw new Error(`provider "${provider.id}" uses ambient credentials only; configure its documented environment/files`)
  if (types.length === 1) return types[0]!
  return select({
    message: `Authentication method for ${provider.name}`,
    choices: types.map(type => ({
      value: type,
      name: type === 'oauth' ? (provider.auth.oauth?.loginLabel ?? provider.auth.oauth?.name ?? 'OAuth') : (provider.auth.apiKey?.name ?? 'API key'),
    })),
  })
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.command === 'help' || args.command === '--help' || args.command === '-h') return usage()
  const runtime = createOpenAuthRuntime(args.file === undefined ? {} : { credentialFile: args.file })
  const providers = runtime.models.getProviders()
  const provider = (id: string | undefined): Provider => {
    if (id === undefined) throw new Error(`${args.command} requires PROVIDER`)
    const hit = runtime.models.getProvider(id)
    if (hit === undefined) throw new Error(`unknown provider "${id}"`)
    return hit
  }

  if (args.command === 'providers') {
    for (const item of providers) {
      const types = authTypes(item)
      const ambient = item.auth.apiKey !== undefined && item.auth.apiKey.login === undefined ? ['ambient'] : []
      console.log(`${item.id}\t${item.name}\t${[...types, ...ambient].join(',')}`)
    }
    return
  }
  if (args.command === 'login') {
    const target = provider(args.values[0])
    const type = await selectAuthType(target, args.values[1])
    await runtime.models.login(target.id, type, interaction(args.openBrowser))
    console.log(`Logged in: ${target.id} (${type}); stored in ${runtime.store.file}`)
    return
  }
  if (args.command === 'logout') {
    const target = provider(args.values[0])
    await runtime.models.logout(target.id)
    console.log(`Logged out: ${target.id}`)
    return
  }
  if (args.command === 'status') {
    const selected = args.values[0] === undefined ? providers : [provider(args.values[0])]
    for (const item of selected) {
      try {
        const status = await runtime.models.checkAuth(item.id)
        console.log(`${item.id}\t${status === undefined ? 'not configured' : `${status.type}${status.source ? ` (${status.source})` : ''}`}`)
      } catch (error) {
        console.log(`${item.id}\terror\t${String(error)}`)
      }
    }
    return
  }
  if (args.command === 'models') {
    const selected = args.values[0] === undefined ? providers : [provider(args.values[0])]
    await runtime.models.refresh({ providers: selected.map(item => item.id), allowNetwork: true })
    for (const item of selected) for (const model of runtime.models.getModels(item.id)) console.log(`${item.id}\t${model.id}\t${model.name}`)
    return
  }
  throw new Error(`unknown command "${args.command}"`)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
