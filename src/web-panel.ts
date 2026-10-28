/**
 * The routes that carry the panel.
 *
 * The panel is the same self-contained page this plugin's UI has always used:
 * plain DOM, no framework, and exactly one host dependency - `window.pluginBridge`.
 * Here that bridge is served back as a `fetch` shim over the routes below, so
 * the page itself needs no knowledge of the host it is embedded in.
 *
 * Every route is registered through `ctx.webServer`, and every registration is
 * released by the caller's effect. Route owners guard their own requests: this
 * host's server carries no authentication or origin policy of its own, so the
 * peer, Host and origin checks below are the whole of the panel's access
 * control, and the document itself carries the content policy that keeps a page
 * on another site from framing the panel's controls.
 *
 * @module dsh-wtq-pool/web-panel
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { BlockList, isIP } from 'node:net'
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { PANEL_BASE } from './panel-route.ts'
import { BodyTooLargeError, answerRequest, hostIsLoopback, isJsonContentType, originIsLoopback, readJsonBody, safeMessage, writeJson } from './loopback.ts'

/** Re-exported for the tests, which build panel URLs against the same base. */
export { PANEL_BASE }

/**
 * The channels the panel bridge serves.
 *
 * Every channel the panel or the composer readout asks for has to appear here,
 * or it is refused. The two groups are admitted identically - the split below
 * is a reading aid for whoever opens this file, not a rule the route enforces -
 * and the appearance channel the page asks for is answered here without
 * reaching the plugin.
 *
 * `xd.doctor` sits in the second group rather than the first because it reports
 * on the pool's own connections instead of reading them, and `xd.state` can
 * spend a network pass of its own when it is asked to wait: a channel's cost is
 * not what the grouping says.
 */
const CHANNELS = new Set([
  // Read-only: the panel's own state and the composer readout.
  'xd.state',
  'xd.composerPoints',
  // Acting on the pool.
  'xd.composerPrefer',
  'xd.composerRefresh',
  'xd.checkin',
  'xd.checkinAll',
  'xd.doctor',
  'xd.preferAccount',
  'xd.preferSourceAccount',
  'xd.rescan',
  'xd.fetchModels',
  'xd.resetCooldowns',
  'xd.runCheckinNow',
  'xd.saveModels',
  'xd.setAccountState',
  'xd.distribution',
  'xd.setAutoCheckin',
  'xd.setComposerPoints',
  'xd.setCreditReserve',
  'xd.setRegionEnabled',
  'xd.setSource',
  'xd.sourceCheckin',
  'xd.sourceDistribution',
  'xd.startLogin',
  'xd.pollLogin',
  // The growth centre's card: one read, one run.
  'xd.growthState',
  'xd.growthRun',
  // The token keep-alive's switch and by-hand run.
  'xd.keepAlive',
])

/** Largest panel request body accepted, so a hung or oversized body cannot pin memory. */
const MAX_BODY_BYTES = 65_536

/**
 * The content policy the panel document is served with.
 *
 * A header rather than the page's own `<meta>`, which {@link panelHtml} strips:
 * one copy serves both embeddings, and a meta that survived the strip would
 * intersect with this header and block the bridge's inline script. The bridge
 * is the only inline script, and it carries a per-request nonce rather than a
 * blanket `unsafe-inline` allowance: anything that could write into this
 * package's `renderer/` would otherwise own script execution on a page whose
 * channels change settings and move credits. `connect-src 'self'` is the fetch
 * the bridge makes, and `frame-ancestors 'self'` is what stops a page on
 * another site from framing the panel's mutating controls - the host card
 * frames it same-origin.
 */
const PANEL_CSP = [
  "default-src 'none'",
  "script-src 'self' 'nonce-__PANEL_NONCE__'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

export interface PanelRouteDeps {
  /** This package's root; the panel assets are read from its `renderer/`. */
  pluginRoot: string
  /** Forward one panel channel to the plugin core. */
  invoke(channel: string, payload: Record<string, unknown>): Promise<unknown>
  logger: { warn(...args: unknown[]): void }
  /** Register one disposer to run when the routes are released. */
  effect(callback: () => unknown): unknown
}

/**
 * The slice of the host's web server this plugin mounts into.
 *
 * Hand-written rather than imported from the host package for the same reason
 * the entry's other seams are: the plugin compiles against the capability it
 * uses, and a host that grows a field does not become a compile error here.
 */
export interface WebServerSeam {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => unknown
  }): () => void
}


const LOOPBACK = new BlockList()
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4')
LOOPBACK.addAddress('::1', 'ipv6')
LOOPBACK.addSubnet('::ffff:127.0.0.0', 104, 'ipv6')

/** Whether the request's peer is this machine. */
function peerIsLoopback(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress
  if (address === undefined) return false
  const family = isIP(address)
  if (family === 4) return LOOPBACK.check(address, 'ipv4')
  if (family === 6) return LOOPBACK.check(address, 'ipv6')
  return false
}

/**
 * Whether the request's own headers say the page asking is this origin.
 *
 * A browser sends no `Origin` at all on a top-level GET into an iframe, so the
 * loopback Origin check alone cannot see a page on another site framing the
 * panel - `Sec-Fetch-Site` is the header that names the asker. A client that is
 * not a browser sends neither header and passes.
 */
function askerIsThisOrigin(req: IncomingMessage): boolean {
  if (!originIsLoopback(req.headers.origin)) return false
  const site = req.headers['sec-fetch-site']
  return typeof site !== 'string' || site === 'same-origin' || site === 'none'
}

/**
 * Answer one panel route behind the guards every route answers with.
 *
 * The four checks are the whole of the panel's access control - this host's
 * server carries no authentication or origin policy of its own - and each route
 * owes the same four in the same order: the peer, the Host the asker named, the
 * method, and the origin. The loopback bind and the peer check between them
 * admit a DNS-rebinding page, because a browser aimed at
 * `http://127.0.0.1:<port>` sends the Host that page chose, and only the Host
 * check refuses it. A refusal is answered here and returns, so `handle` runs
 * only once all four have passed.
 *
 * The panel routes write the response themselves rather than going through a
 * gateway, so they also owe the guard the gateways get from `answerRequest`: a
 * socket with no `error` listener turns a client that hung up mid-answer into an
 * uncaught exception, and `/invoke` can run for the best part of twenty seconds
 * before it answers anything at all. That is why the guards run inside
 * `answerPanel` rather than ahead of it.
 */
function guarded(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  handle: () => void | Promise<void>,
  log?: { warn(...args: unknown[]): void },
): Promise<void> {
  return answerPanel(res, () => {
    if (!peerIsLoopback(req)) return writeJson(res, 403, { error: 'peer-not-loopback' })
    if (!hostIsLoopback(req.headers.host)) return writeJson(res, 403, { error: 'host-not-loopback' })
    if (req.method !== method) return writeJson(res, 405, { error: 'method not allowed' })
    if (!askerIsThisOrigin(req)) return writeJson(res, 403, { error: 'origin-not-trusted' })
    return handle()
  }, log)
}

/**
 * Answer a panel route, writing a failure in the panel's own JSON shape.
 *
 * The socket sink, the failure log and the write guard all belong to
 * `answerRequest`; only the shape of the answer is the panel's.
 *
 * A body past the cap is the client's problem to fix, so it is answered as the
 * 413 it is rather than a 500 that reads as a bug in this plugin.
 */
function answerPanel(
  res: ServerResponse,
  handle: () => void | Promise<void>,
  log?: { warn(...args: unknown[]): void },
): Promise<void> {
  return answerRequest(res, handle, log, (target, error) => {
    if (error instanceof BodyTooLargeError) writeJson(target, 413, { error: safeMessage(error) })
    else writeJson(target, 500, { error: safeMessage(error) })
  })
}

/** Answer with the panel document: its content policy, uncached, and never sniffed. */
function writeHtml(res: ServerResponse, body: string, nonce: string): void {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Content-Security-Policy': PANEL_CSP.replace('__PANEL_NONCE__', nonce),
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(body)
}

/** Answer with one file's bytes, uncached so an edited asset is picked up. */
function sendFile(res: ServerResponse, file: string, type: string): void {
  const body = fs.readFileSync(file)
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(body)
}

/**
 * Resolve one panel asset inside this package.
 *
 * The resolved path is proved to stay under `renderer/`, so a crafted request
 * cannot read a file elsewhere in the package or on disk.
 */
function panelAsset(pluginRoot: string, name: string): string | undefined {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return undefined
  const dir = path.join(pluginRoot, 'renderer')
  const full = path.join(dir, name)
  if (!full.startsWith(dir + path.sep)) return undefined
  return fs.existsSync(full) ? full : undefined
}
/**
 * The panel page.
 *
 * The markup is this package's own `renderer/index.html`, with two changes:
 * the host-chrome metas it carried in its previous embedding are dropped - the
 * content-policy one because the response header is now authoritative - and
 * the bridge that talks to this plugin is injected ahead of its own script. The
 * panel therefore stays one page with one host dependency, and nothing about
 * its markup is duplicated here.
 *
 * `nonce` is minted per request and has to be the value the response's content
 * policy names, or the policy refuses the one script the page needs.
 */
function panelHtml(pluginRoot: string, base: string, lang: string, nonce: string): string | undefined {
  const file = panelAsset(pluginRoot, 'index.html')
  if (file === undefined) return undefined
  const safeBase = base === 'dark' ? 'dark' : 'light'
  const safeLang = lang.toLowerCase().startsWith('en') ? 'en' : 'zh-CN'
  const bridge = `<script nonce="${nonce}">
/*
 * The panel's one host dependency. Every channel it asks for is answered by
 * this plugin's own core over the same origin, so the page needs no host API
 * of its own and works unchanged in either embedding.
 */
document.documentElement.dataset.base = ${JSON.stringify(safeBase)};
window.pluginBridge = {
  invoke: function (channel, payload) {
    return fetch(${JSON.stringify(PANEL_BASE + '/invoke')}, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        channel: channel,
        payload: payload || {},
        base: ${JSON.stringify(safeBase)},
        lang: ${JSON.stringify(safeLang)}
      })
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (body) {
        if (response.ok) return body && 'result' in body ? body.result : body;
        throw new Error((body && body.error) || ('HTTP ' + response.status));
      });
    });
  },
  // This host gives the page no event channel; the panel's own poll keeps it
  // current, which is why this listener is an accepted no-op.
  on: function () { return function () {}; }
};
</script>`
  return fs.readFileSync(file, 'utf8')
    // Any attribute order, any quoting, any spacing around the `=`: the page's
    // own policy is a file this plugin does not control the formatting of, and
    // a copy that survived the strip would intersect with the header and block
    // the bridge below. A regex that missed one spelling used to leave exactly
    // that: a panel that loaded with its bridge refused.
    .replace(/\s*<meta\b[^>]*\bhttp-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/i, '')
    .replace('</head>', `${bridge}\n</head>`)
}

export function registerPanelRoutes(ctx: { webServer: WebServerSeam }, deps: PanelRouteDeps): void {
  try {
    deps.effect(() => {
      const disposers: Array<() => void> = []
      const release = (): void => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch (error: unknown) {
            deps.logger.warn('dsh-wtq-pool: a panel route did not release cleanly', error)
          }
        }
      }
      const mount = (route: Parameters<typeof ctx.webServer.register>[0]): void => {
        disposers.push(ctx.webServer.register(route))
      }
      try {
        mount({
          kind: 'exact',
          path: `${PANEL_BASE}/panel`,
          handler: (req, res) => guarded(req, res, 'GET', () => {
            const url = new URL(req.url ?? '/', 'http://localhost')
            // One nonce per answer, named by the policy that answer carries:
            // the bridge is the only inline script, and this is what keeps it
            // the only one.
            const nonce = randomBytes(16).toString('base64')
            const body = panelHtml(
              deps.pluginRoot,
              url.searchParams.get('base') ?? 'light',
              url.searchParams.get('lang') ?? 'zh-CN',
              nonce,
            )
            if (body === undefined) return writeJson(res, 404, { error: 'missing renderer/index.html' })
            writeHtml(res, body, nonce)
          }, deps.logger),
        })
        mount({
          kind: 'exact',
          path: `${PANEL_BASE}/panel.css`,
          handler: (req, res) => guarded(req, res, 'GET', () => {
            const file = panelAsset(deps.pluginRoot, 'panel.css')
            if (file === undefined) return writeJson(res, 404, { error: 'missing panel.css' })
            sendFile(res, file, 'text/css; charset=utf-8')
          }, deps.logger),
        })
        mount({
          kind: 'exact',
          path: `${PANEL_BASE}/panel.js`,
          handler: (req, res) => guarded(req, res, 'GET', () => {
            const file = panelAsset(deps.pluginRoot, 'panel.js')
            if (file === undefined) return writeJson(res, 404, { error: 'missing panel.js' })
            sendFile(res, file, 'text/javascript; charset=utf-8')
          }, deps.logger),
        })
        mount({
          kind: 'exact',
          path: `${PANEL_BASE}/invoke`,
          handler: (req, res) => guarded(req, res, 'POST', async () => {
            if (!isJsonContentType(req)) return writeJson(res, 415, { error: 'Content-Type must be application/json' })
            const body = await readJsonBody(req, MAX_BODY_BYTES)
            const channel = typeof body['channel'] === 'string' ? body['channel'] : ''
            if (channel === '') return writeJson(res, 400, { error: 'channel is required' })
            // The two channels the panel reads before anything is served: the
            // host's own appearance, answered from what the page asked for.
            if (channel === 'app.getAppearance') {
              return writeJson(res, 200, {
                result: {
                  base: body['base'] === 'dark' ? 'dark' : 'light',
                  locale: typeof body['lang'] === 'string' ? body['lang'] : 'zh-CN',
                },
              })
            }
            if (channel.startsWith('xd.') === false || CHANNELS.has(channel) === false) {
              return writeJson(res, 400, { error: `unsupported channel: ${channel}` })
            }
            const payload = body['payload'] !== null && typeof body['payload'] === 'object'
              ? body['payload'] as Record<string, unknown>
              : {}
            const result = await deps.invoke(channel, payload)
            writeJson(res, 200, { result: result === undefined ? null : result })
          }, deps.logger),
        })
      } catch (error: unknown) {
        // A route that failed to mount leaves the panel half mounted, so release
        // what did register instead of leaving dead routes in the server table.
        release()
        throw error
      }
      return release
    })
  } catch (error: unknown) {
    deps.logger.warn('dsh-wtq-pool: the panel routes could not be mounted', error)
  }
}
