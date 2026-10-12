// Mod tests for /occam-openrouter (run with `claude plugin test plugins/occam`). They drive the built
// hooks/register.js through Claude Code's test kit: no session, sign-in, or network.
import { expect, mock, test } from 'claude-code/testing'

const KEY = 'sk-or-v1-0123456789abcdef0123'
const DIR = '/home/u/.config/occam'
const FILE = `${DIR}/credentials.json`

const PANE = {
  plugin: 'occam',
  component: 'Pane',
  requestId: 'occam-openrouter-setup',
  surface: 'terminal',
  viewport: { columns: 100, rows: 30 },
  props: {
    title: 'Occam: OpenRouter API key',
    isFocused: true,
    bodyColumns: 80,
    placement: 'inline',
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

/** Stubs every mods API call the setup path makes and records file writes and processes in order. */
function stubHost(on, options: { keyStatus: number; chmodExit?: number; files?: Record<string, string> }) {
  const files = new Map(Object.entries(options.files ?? {}))
  const log: string[] = []
  const requests: Array<{ url: string; authorization: string | undefined }> = []
  mock.env(on, { HOME: '/home/u' })
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: undefined }))
  on('ui.open', () => {
    log.push('ui.open')
    return { value: { isPlaced: true } }
  })
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))
  on('fs.read', ($, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.write', ($, e) => {
    log.push(`write ${e.path} ${e.text === '' ? '(empty)' : '(content)'}`)
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('process.run', ($, e) => {
    log.push(e.argv.join(' '))
    const exitCode = options.chmodExit ?? 0
    return { value: { exitCode, stdout: '', stderr: exitCode === 0 ? '' : 'Operation not permitted' } }
  })
  on('http.fetch', ($, e) => {
    const url = e.url
    const headers = e.init?.headers ?? {}
    requests.push({ url, authorization: headers.authorization })
    const ok = !url.endsWith('/key') || options.keyStatus === 200
    const text = url.endsWith('/key')
      ? ok
        ? JSON.stringify({ data: { label: 'occam', limit_remaining: 5, usage_monthly: 0 } })
        : JSON.stringify({ error: { message: 'Missing Authentication header', code: 401 } })
      : JSON.stringify({ data: { endpoints: [{ pricing: { prompt: '0.0000001', completion: '0.0000005' } }] } })
    return { value: { status: ok ? 200 : options.keyStatus, ok, headers: {}, text } }
  })
  return { files, log, requests }
}

test('setup outside an interactive session explains the alternatives and opens nothing', async ($, on) => {
  const host = stubHost(on, { keyStatus: 200 })
  await $.session.start({ surface: 'terminal', isInteractive: false, cwd: '/work' })
  const answer = await $.command.run({ command: 'occam-openrouter', args: 'setup' })
  expect(answer.text).toMatch(/interactive Claude Code session/)
  expect(host.log).toEqual([])
})

test('an accepted key is saved after the file and directory are made owner-only', async ($, on) => {
  const host = stubHost(on, { keyStatus: 200 })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run({ command: 'occam-openrouter', args: 'setup' })
  const ui = await $.ui.mount(PANE)
  await ui.input({ key: 'openrouter-key', text: KEY })

  expect(host.log).toEqual([
    'ui.open',
    `write ${FILE} (empty)`,
    `chmod 700 ${DIR}`,
    `chmod 600 ${FILE}`,
    `write ${FILE} (content)`,
  ])
  expect(JSON.parse(host.files.get(FILE)).openrouter.apiKey).toBe(KEY)
  expect(await ui.find({ type: 'Text', text: /^Saved sk-or-v1-…0123/ })).toBeDefined()
})

test('a key OpenRouter rejects is never written', async ($, on) => {
  const host = stubHost(on, { keyStatus: 401 })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run({ command: 'occam-openrouter', args: 'setup' })
  const ui = await $.ui.mount(PANE)
  await ui.input({ key: 'openrouter-key', text: KEY })

  expect(host.log).toEqual(['ui.open'])
  expect(await ui.find({ type: 'Text', text: /OpenRouter rejected the key .*nothing saved/ })).toBeDefined()
})

test('when chmod fails, the key is never written', async ($, on) => {
  const host = stubHost(on, { keyStatus: 200, chmodExit: 1 })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run({ command: 'occam-openrouter', args: 'setup' })
  const ui = await $.ui.mount(PANE)
  await ui.input({ key: 'openrouter-key', text: KEY })

  expect(host.log).toEqual(['ui.open', `write ${FILE} (empty)`, `chmod 700 ${DIR}`])
  expect(host.files.get(FILE)).toBe('')
  expect(await ui.find({ type: 'Text', text: /nothing saved/ })).toBeDefined()
})

test('the check uses the saved key when the environment has none', async ($, on) => {
  const host = stubHost(on, {
    keyStatus: 200,
    files: { [FILE]: JSON.stringify({ openrouter: { apiKey: KEY } }) },
  })
  await $.session.start({ surface: 'terminal', isInteractive: false, cwd: '/work' })
  const answer = await $.command.run({ command: 'occam-openrouter', args: '' })

  expect(answer.text).toMatch(/key \(from saved credentials\): valid/)
  expect(host.requests.find((r) => r.url.endsWith('/key'))?.authorization).toBe(`Bearer ${KEY}`)
})
