#!/usr/bin/env node
// Browser smoke test against a running dashboard and a real engine.
//
//   node scripts/smoke.mjs                 live engine (Helios) at http://localhost:3000
//   node scripts/smoke.mjs --mode dev      engine started with VERIQ_ROOT_SOURCE=dev-untrusted
//   node scripts/smoke.mjs --base https://eth-g.vercel.app --no-attacks
//   node scripts/smoke.mjs --anon           also: private reads through Nox (needs real Nox + Sepolia)
//
// Opens every page in headless Edge/Chrome over the DevTools protocol (Node >= 22: built-in
// WebSocket, no extra dependencies). Fails on console errors or uncaught exceptions, on
// sample data (the engine was not reached) and on TODO text. Live mode also checks the
// head lag number and the "Helios synced" footer, and, when the demo attacker runs, plays
// every attack mode in the Attack Lab and checks that the attacker was tried and rejected.
// Browser: $BROWSER_BIN, else the usual Edge/Chrome/Chromium install paths.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const BASE = flag('--base', 'http://localhost:3000').replace(/\/$/, '')
const MODE = flag('--mode', 'live')
const ATTACKS = !args.includes('--no-attacks')
const PORT = Number(flag('--port', '9333'))
const ANON = args.includes('--anon')
if (!['live', 'dev'].includes(MODE)) throw new Error('--mode must be live or dev')
// Joining Nox and a proof round trip through the mixnet take longer than a direct read.
const ANON_READY_MS = Number(flag('--anon-ready-ms', '180000'))
const ANON_READ_MS = 120000
// The worker's one direct request: reading the Nox specifier contract from PublicNode.
const BOOTSTRAP_PATTERN = '*ethereum-sepolia-rpc.publicnode.com*'

const PAGES = ['/', '/app', '/app/feed', '/app/providers', '/app/light-client', '/app/attack-lab', '/app/policy', '/app/developers']
// What the Attack Lab's balance read must show for the attacker in each mode: "outage" fails at
// the transport, "code" only alters eth_getCode (balance reads stay honest, so it answers ok),
// every other mode is caught by the proof.
const ATTACK_MODES = { value: 'INVALID_PROOF', proof: 'INVALID_PROOF', wrongblock: 'INVALID_PROOF', outage: 'transport_error', nonce: 'INVALID_PROOF', code: 'ok' }

function findBrowser() {
  const candidates = [
    process.env.BROWSER_BIN,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
  ]
  const found = candidates.find((c) => c && existsSync(c))
  if (!found) throw new Error('no Edge/Chrome/Chromium found: set BROWSER_BIN=/path/to/browser')
  return found
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const profile = mkdtempSync(join(tmpdir(), 'veriq-smoke-'))
const browser = spawn(
  findBrowser(),
  ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-extensions', '--window-size=1440,1000', 'about:blank'],
  { stdio: 'ignore' },
)

async function pageSocket() {
  for (let i = 0; i < 80; i++) {
    try {
      const page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page')
      if (page) return page.webSocketDebuggerUrl
    } catch {
      // not up yet
    }
    await sleep(250)
  }
  throw new Error('browser DevTools did not come up')
}

const ws = new WebSocket(await pageSocket())
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let nextId = 0
const pending = new Map()
let events = []
ws.addEventListener('message', (m) => {
  const msg = JSON.parse(m.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  } else if (msg.method) events.push(msg)
})
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++nextId
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value
const text = () => evaluate('document.body.innerText')

/** Poll `expression` in the page until it is truthy. */
async function waitFor(expression, timeoutMs, what) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (await evaluate(expression)) return true
    await sleep(200)
  }
  throw new Error(`timed out after ${timeoutMs / 1000} s waiting for ${what}`)
}
const hasText = (re) => `(${re}).test(document.body.innerText)`

const failures = []
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}
function pageErrors() {
  const out = []
  for (const e of events) {
    if (e.method === 'Runtime.exceptionThrown') out.push(`exception: ${(e.params.exceptionDetails.exception?.description ?? e.params.exceptionDetails.text).split('\n')[0]}`)
    if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') out.push(`console.error: ${e.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200)}`)
    if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') out.push(`${e.params.entry.source}: ${e.params.entry.text.slice(0, 160)} ${e.params.entry.url ?? ''}`)
  }
  return out
}

async function attackLab() {
  const radio = (m) => `[...document.querySelectorAll('[role=radiogroup][aria-label="Attacker mode"] [role=radio]')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(m)}))`
  const receiptHref = `document.querySelector('a[href*="/app/feed?receipt="]')?.getAttribute('href') ?? ''`
  for (const [mode, rejected] of Object.entries(ATTACK_MODES)) {
    try {
      await evaluate(`${radio(mode)}.click()`)
      await waitFor(`${radio(mode)}?.getAttribute('aria-checked') === 'true' && /Breakers reset/.test(document.body.innerText)`, 15000, `mode ${mode} and breaker reset`)
      const before = await evaluate(receiptHref)
      await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Read balance').click()`)
      await waitFor(`(${receiptHref}) !== ${JSON.stringify(before)} && (${receiptHref}) !== ''`, 30000, `a new verified read in mode ${mode}`)
      const t = await text()
      const panel = t.slice(t.indexOf('veriq_readBalance via veriq-client'))
      const proven = /Proven at block #[\d,]+/.exec(panel)?.[0]
      const attackerTried = new RegExp(`attacker\\s*${rejected}`).test(panel)
      check(Boolean(proven) && attackerTried, `attack mode ${mode}`, `${proven ?? 'no proven value'}, attacker ${attackerTried ? rejected : 'not tried'}`)
    } catch (err) {
      check(false, `attack mode ${mode}`, err.message)
    }
  }
  await evaluate(`${radio('off')}.click()`)
}

const anonState = `document.querySelector('[data-anon-state]')?.dataset.anonState`
const clickButton = (label) => evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})?.click()`)

/** Load /app with the read mode reset to private (the default), and wait for the badge to leave connecting. */
async function openPrivate(path = '/app') {
  await send('Page.navigate', { url: BASE + path })
  await waitFor(`document.readyState === 'complete'`, 30000, 'the page')
  await evaluate(`sessionStorage.removeItem('veriq.readMode'); true`)
  await send('Page.reload')
  await waitFor(`['ready', 'failed'].includes(${anonState})`, ANON_READY_MS, 'the Anon-RPC badge to settle')
  return evaluate(anonState)
}

/** --anon: the private path end to end, against real Nox, a real engine and Sepolia. */
async function anonChecks() {
  // 1. Nox joins on /app load, and the badge says so.
  let state
  const t0 = Date.now()
  try {
    state = await openPrivate('/app')
    const label = await evaluate(`document.querySelector('[data-anon-state]').textContent.trim()`)
    check(state === 'ready', 'anon: badge ready', `${label} after ${((Date.now() - t0) / 1000).toFixed(1)} s`)
  } catch (err) {
    check(false, 'anon: badge ready', err.message)
    return
  }
  if (state !== 'ready') return

  // 2. Overview: the demo storage slot is read through Nox.
  try {
    await waitFor(`/Fetched via anon-rpc · nox/.test(document.querySelector('[data-testid=storage-transport]')?.textContent ?? '')`, ANON_READ_MS, 'the storage read through Nox')
    check(true, 'anon: Overview storage via anon-rpc · nox')
    const href = await evaluate(`document.querySelector('a[href*="/app/feed?receipt="]')?.getAttribute('href') ?? ''`)
    const id = decodeURIComponent(href.split('receipt=')[1] ?? '')
    await send('Page.navigate', { url: BASE + href })
    await waitFor(`/Transport\\s*anon-rpc \\(nox\\)/.test(document.querySelector('[role=dialog]')?.innerText ?? '')`, 30000, 'the receipt drawer')
    const drawer = await evaluate(`document.querySelector('[role=dialog]').innerText`)
    check(/Transport\s*anon-rpc \(nox\)/.test(drawer), 'anon: receipt drawer "Transport anon-rpc (nox)"')
    check(/\S+@anon-rpc:nox/.test(drawer), 'anon: attempt label provider@anon-rpc:nox', /\S+@anon-rpc:nox/.exec(drawer)?.[0] ?? 'missing')
    // The stored receipt itself, as the engine returns it (same-origin /engine proxy).
    const stored = await evaluate(`fetch('/engine/receipts/' + encodeURIComponent(${JSON.stringify(id)})).then((r) => r.ok ? r.json() : null).catch(() => null)`)
    if (stored?.receipt) {
      check(stored.receipt.privacy?.transport === 'anon-rpc' && stored.receipt.privacy?.mechanism === 'nox', 'anon: stored receipt transport anon-rpc', JSON.stringify(stored.receipt.privacy))
      check(/@anon-rpc:nox$/.test(stored.receipt.routing?.providerLabel ?? ''), 'anon: stored receipt providerLabel', stored.receipt.routing?.providerLabel)
    } else {
      console.log('skip stored receipt check — /engine/receipts is not reachable from this origin')
    }
  } catch (err) {
    check(false, 'anon: Overview storage via anon-rpc · nox', err.message)
  }

  // 3. Policy: a balance read through Nox, with the attempt label in the timeline.
  try {
    await send('Page.navigate', { url: `${BASE}/app/policy` })
    await waitFor(`${anonState} === 'ready'`, ANON_READY_MS, 'Nox on the Policy page')
    await clickButton('Run')
    await waitFor(`/via anon-rpc · nox/.test(document.body.innerText)`, ANON_READ_MS, 'the Policy read through Nox')
    const t = await text()
    check(/@anon-rpc:nox/.test(t), 'anon: Policy timeline shows provider@anon-rpc:nox', /\S+@anon-rpc:nox/.exec(t)?.[0] ?? 'missing')
  } catch (err) {
    check(false, 'anon: Policy balance via anon-rpc · nox', err.message)
  }

  // 4. Failure path: block the bootstrap request; the badge must say failed and direct must still work.
  try {
    await send('Network.enable')
    await send('Network.setBlockedURLs', { urls: [BOOTSTRAP_PATTERN] })
    const failed = await openPrivate('/app')
    const label = await evaluate(`document.querySelector('[data-anon-state]').textContent.trim()`)
    check(failed === 'failed', 'anon: blocked bootstrap → badge failed', label)
    await clickButton('Use direct')
    await waitFor(`${anonState} === 'direct'`, 5000, 'Direct mode')
    await waitFor(`/Fetched via direct/.test(document.querySelector('[data-testid=storage-transport]')?.textContent ?? '')`, 60000, 'a direct storage read')
    check(true, 'anon: direct toggle reads directly after a failed join')
  } catch (err) {
    check(false, 'anon: failure path', err.message)
  } finally {
    await send('Network.setBlockedURLs', { urls: [] })
    await evaluate(`sessionStorage.removeItem('veriq.readMode'); true`)
  }
}

await send('Runtime.enable')
await send('Log.enable')
await send('Page.enable')
console.log(`dashboard smoke: ${BASE} (mode ${MODE}${ANON ? ', anon' : ''})`)

// Without --anon the page checks run on the direct path, exactly as before Anon-RPC existed;
// --anon leaves the app's default (private) on and adds anonChecks() at the end.
if (!ANON) {
  await send('Page.navigate', { url: `${BASE}/` })
  await waitFor(`document.readyState === 'complete'`, 30000, 'the landing page')
  await evaluate(`sessionStorage.setItem('veriq.readMode', 'direct'); true`)
}

for (const path of PAGES) {
  events = []
  await send('Page.navigate', { url: BASE + path })
  try {
    // Wait until the engine status has resolved (not "Checking engine…").
    // The footer and the sidebar say "Checking engine…" until their first /health answer.
    const ready = path === '/' ? hasText(/Helios synced|Engine (online|offline)/) : hasText(/Engine online|Engine offline|DEV MODE/)
    await waitFor(ready, 30000, 'the engine status')
    if (path === '/app/light-client' && MODE === 'live') await waitFor(hasText(/Head lag\s*[\d,]+ blocks/), 20000, 'a numeric head lag')
    await sleep(1500) // let pollers and animations run once
  } catch (err) {
    check(false, `${path} loads`, err.message)
    continue
  }
  const t = await text()
  const problems = []
  if (path !== '/' && /Sample data|Engine offline/.test(t)) problems.push('engine not reached (sample data)')
  if (/\bTODO\b/.test(t)) problems.push('TODO text on the page')
  if (path === '/') {
    if (MODE === 'live' && !/Helios synced/.test(t)) problems.push('footer is not "Helios synced"')
    if (MODE === 'dev' && !/Engine online · unverified \(dev\)/.test(t)) problems.push('footer is not "Engine online · unverified (dev)"')
  } else if (MODE === 'dev' && !/DEV MODE/.test(t)) problems.push('no DEV MODE badge')
  let detail = ''
  if (path === '/app/light-client' && MODE === 'live') detail = /Head lag\s*([\d,]+ blocks[^\n]*)/.exec(t)?.[0].replace(/\s+/g, ' ') ?? ''
  const errors = pageErrors()
  problems.push(...errors)
  check(problems.length === 0, `${path}`, problems.length ? problems.join('; ') : detail || 'no console errors')

  if (path === '/app/attack-lab' && MODE === 'live' && ATTACKS) {
    if (/Attacker not running/.test(t)) console.log('skip attack modes — the demo attacker is not running (start it with pnpm demo)')
    else await attackLab()
  }
}

if (ANON) {
  events = []
  await anonChecks()
}

ws.close()
browser.kill()
await sleep(300)
try {
  rmSync(profile, { recursive: true, force: true })
} catch {
  // the browser may still hold the profile for a moment
}
console.log(failures.length ? `\nFAILED: ${failures.length} check(s): ${failures.join(', ')}` : '\nall checks passed')
process.exit(failures.length ? 1 : 0)
