import { Buffer } from 'node:buffer'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { CallId, contentHasImage, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { Context as PiContext, ImageContent, Message as PiMessage, TextContent, Tool as PiTool } from '@earendil-works/pi-ai'
import { toPiAssistant } from './replay.js'

function flattenText(message: Message): string {
  return message.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

function toolResultText(blocks: readonly ContentBlock[]): string {
  return blocks.map(block => block.type === 'text'
    ? block.text
    : block.type === 'tool-result' ? toolResultText(block.content) : '').join('')
}

async function userContent(blocks: readonly ContentBlock[], attachments: AttachmentStore): Promise<string | (TextContent | ImageContent)[]> {
  const content: (TextContent | ImageContent)[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text': if (block.text.length > 0) content.push({ type: 'text', text: block.text }); break
      case 'image': {
        const stored = await attachments.readImage(block.attachment)
        content.push({ type: 'image', data: Buffer.from(stored.data).toString('base64'), mimeType: stored.ref.mediaType })
        break
      }
      case 'tool-result': {
        const nested = await userContent(block.content, attachments)
        if (typeof nested === 'string') {
          if (nested.length > 0) content.push({ type: 'text', text: nested })
        } else content.push(...nested)
        break
      }
      default: break
    }
  }
  return content.every(block => block.type === 'text') ? content.map(block => block.text).join('') : content
}

function toolsOf(options: GenerateOptions): PiTool[] | undefined {
  return options.tools?.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))
}

function envelope(options: GenerateOptions, messages: PiMessage[]): PiContext {
  const tools = toolsOf(options)
  return {
    ...(options.system === undefined ? {} : { systemPrompt: options.system }),
    messages,
    ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
  }
}

function textContext(options: GenerateOptions): PiContext {
  const toolNames = new Map<CallId, string>()
  const messages: PiMessage[] = []
  for (const message of options.messages) {
    if (contentHasImage(message.content)) throw new LlmError('image input requires the DSH attachment service', 'UNSUPPORTED_CONTENT')
    if (message.role === 'system') {
      messages.push({ role: 'user', content: flattenText(message), timestamp: 0 })
    } else if (message.role === 'assistant') {
      const assistant = toPiAssistant(message)
      for (const block of assistant.content) if (block.type === 'toolCall') toolNames.set(CallId(block.id), block.name)
      messages.push(assistant)
    } else {
      const text = flattenText(message)
      const results = message.content.filter(block => block.type === 'tool-result')
      if (text.length > 0 || results.length === 0) messages.push({ role: 'user', content: text, timestamp: 0 })
      for (const result of results) messages.push({
        role: 'toolResult',
        toolCallId: result.toolCallId,
        toolName: toolNames.get(result.toolCallId) ?? 'unknown',
        content: [{ type: 'text', text: toolResultText(result.content) || '(no output)' }],
        isError: result.isError ?? false,
        timestamp: 0,
      })
    }
  }
  return envelope(options, messages)
}

export function toPiContext(options: GenerateOptions): PiContext
export function toPiContext(options: GenerateOptions, attachments: AttachmentStore): Promise<PiContext>
export function toPiContext(options: GenerateOptions, attachments?: AttachmentStore): PiContext | Promise<PiContext> {
  return attachments === undefined ? textContext(options) : imageContext(options, attachments)
}

async function imageContext(options: GenerateOptions, attachments: AttachmentStore): Promise<PiContext> {
  const toolNames = new Map<CallId, string>()
  const messages: PiMessage[] = []
  for (const message of options.messages) {
    if (message.role === 'system') {
      if (contentHasImage(message.content)) throw new LlmError('pi-ai cannot represent an image in a system history message', 'UNSUPPORTED_CONTENT')
      messages.push({ role: 'user', content: flattenText(message), timestamp: 0 })
    } else if (message.role === 'assistant') {
      const assistant = toPiAssistant(message)
      for (const block of assistant.content) if (block.type === 'toolCall') toolNames.set(CallId(block.id), block.name)
      messages.push(assistant)
    } else {
      const regular = message.content.filter(block => block.type !== 'tool-result')
      const content = await userContent(regular, attachments)
      const results = message.content.filter(block => block.type === 'tool-result')
      if (content.length > 0 || results.length === 0) messages.push({ role: 'user', content, timestamp: 0 })
      for (const result of results) {
        const resultContent = await userContent(result.content, attachments)
        messages.push({
          role: 'toolResult',
          toolCallId: result.toolCallId,
          toolName: toolNames.get(result.toolCallId) ?? 'unknown',
          content: typeof resultContent === 'string' ? [{ type: 'text', text: resultContent || '(no output)' }] : resultContent,
          isError: result.isError ?? false,
          timestamp: 0,
        })
      }
    }
  }
  return envelope(options, messages)
}
