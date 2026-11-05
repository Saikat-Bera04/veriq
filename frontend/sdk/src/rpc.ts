import { CLIENT_CODES, EngineUnreachableError, ERROR_CODES, ProviderTimeoutError, VeriqSchemaError, errorFromRpc } from './errors'
import { formatIssues } from './schema'
import type { z } from 'zod'

export interface RpcContext {
  url: string
  fetch: typeof fetch
  debug: boolean
}

export interface CallOptions {
  timeoutMs: number
  signal?: AbortSignal
}

let nextId = 1

/** URL without query string or fragment, safe to show and log. */
export function safeUrl(url: string): string {
  return url.split(/[?#]/)[0] ?? url
}

function unreachable(ctx: RpcContext, detail: string, cause?: unknown): EngineUnreachableError {
  const at = safeUrl(ctx.url) || '/'
  return new EngineUnreachableError(CLIENT_CODES.ENGINE_UNREACHABLE, `Could not reach the Veriq engine at ${at}: ${detail}`, {
    hint: `No Veriq engine at ${at}. Start it with: cd backend && cargo run -p veriq-server`,
    cause,
  })
}

async function send(ctx: RpcContext, input: string, init: RequestInit, opts: CallOptions, label: string): Promise<unknown> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, opts.timeoutMs)
  const onAbort = () => controller.abort()
  opts.signal?.addEventListener('abort', onAbort, { once: true })
  const started = Date.now()
  try {
    let res: Response
    try {
      res = await ctx.fetch(input, { ...init, signal: controller.signal })
    } catch (err) {
      if (timedOut) {
        throw new ProviderTimeoutError(ERROR_CODES.PROVIDER_TIMEOUT, `No answer from the engine within ${opts.timeoutMs} ms (client-side timeout)`, {
          hint: 'The engine did not answer in time. Raise timeoutMs, or check that the engine is healthy with: veriq health',
          cause: err,
        })
      }
      if (opts.signal?.aborted) throw err
      throw unreachable(ctx, err instanceof Error ? err.message : String(err), err)
    }
    let body: unknown
    try {
      body = await res.json()
    } catch (err) {
      throw unreachable(ctx, `HTTP ${res.status} with a non-JSON body. Is this a Veriq engine?`, err)
    }
    if (!res.ok && !(body && typeof body === 'object' && 'error' in body)) {
      throw unreachable(ctx, `HTTP ${res.status}`)
    }
    return body
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onAbort)
    // Never logs params, addresses or full URLs.
    if (ctx.debug) console.debug(`[veriq] ${label} ${Date.now() - started} ms`)
  }
}

/** A JSON-RPC success: `result`, plus the engine's top-level `veriq` receipt when it sent one. */
export interface RpcEnvelope {
  result: unknown
  /** Unparsed. Standard eth_* reads carry their Trust Receipt here (rpc.rs `success_response`). */
  veriq?: unknown
}

/** One JSON-RPC call. Retries: none. Throws typed VeriqErrors. */
export async function rpcCall(ctx: RpcContext, method: string, params: unknown[], opts: CallOptions): Promise<unknown> {
  return (await rpcEnvelope(ctx, method, params, opts)).result
}

/** Like rpcCall, but keeps the top-level `veriq` member next to `result`. */
export async function rpcEnvelope(ctx: RpcContext, method: string, params: unknown[], opts: CallOptions): Promise<RpcEnvelope> {
  const body = await send(
    ctx,
    ctx.url || '/',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
    },
    opts,
    method,
  )
  if (!body || typeof body !== 'object') throw new VeriqSchemaError([`response: expected a JSON-RPC object, got ${typeof body}`])
  if ('error' in body && body.error && typeof body.error === 'object') {
    const e = body.error as { code?: unknown; message?: unknown; data?: unknown }
    if (typeof e.code === 'number') {
      throw errorFromRpc({ code: e.code, message: typeof e.message === 'string' ? e.message : 'engine error', data: e.data })
    }
  }
  if (!('result' in body)) throw new VeriqSchemaError(['response.result: expected a value, got undefined'])
  return 'veriq' in body && body.veriq != null ? { result: body.result, veriq: body.veriq } : { result: body.result }
}

/** GET a JSON endpoint on the engine (e.g. /health). */
export function httpGet(ctx: RpcContext, path: string, opts: CallOptions): Promise<unknown> {
  return send(ctx, `${ctx.url}${path}`, { method: 'GET' }, opts, `GET ${path.split('?')[0]}`)
}

/** Parse with a Zod schema; a mismatch throws VeriqSchemaError with readable paths. */
export function parseWith<S extends z.ZodTypeAny>(schema: S, input: unknown, root: string): z.output<S> {
  const res = schema.safeParse(input)
  if (!res.success) throw new VeriqSchemaError(formatIssues(res.error, input, root))
  return res.data as z.output<S>
}
