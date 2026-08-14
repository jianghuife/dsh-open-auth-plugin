import { input, password, select } from '@inquirer/prompts'
import type { AuthPrompt } from '@earendil-works/pi-ai'

/** Adapt pi-ai's prompt contract to Inquirer, including per-prompt cancellation. */
export async function promptFor(value: AuthPrompt): Promise<string> {
  // Inquirer reads cancellation from its second `context` argument, not from
  // the prompt config. pi-ai aborts a manual-code prompt when the local OAuth
  // callback wins; forwarding this exact signal makes browser login finish
  // without waiting for (or accidentally accepting) stale terminal input.
  const context = value.signal === undefined ? undefined : { signal: value.signal }
  const options = { message: value.message }
  switch (value.type) {
    case 'secret': return password({ ...options, mask: '*' }, context)
    case 'select': return select({
      ...options,
      choices: value.options.map(option => ({
        value: option.id,
        name: option.label,
        ...(option.description === undefined ? {} : { description: option.description }),
      })),
    }, context)
    case 'text':
    case 'manual_code': return input({
      ...options,
      ...(value.placeholder === undefined ? {} : { default: value.placeholder }),
    }, context)
  }
}
