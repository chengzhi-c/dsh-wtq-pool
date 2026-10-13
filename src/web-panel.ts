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
 * loopback check below is the whole of the panel's access control.
 *
 * @module dsh-wtq-pool/web-panel
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { isIP } from 'node:net'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { PANEL_BASE } from './panel-route.ts'
import { originIsLoopback, redactSecrets } from './loopback.ts'

/** Re-exported for the tests, which build panel URLs against the same base. */
export { PANEL_BASE }

/**
 * The channels the panel bridge serves.
 *
 * Every channel the panel or the composer readout asks for has to appear in one
 * of these, or it is refused. The split is by effect, not by caller: a read-only
 * channel may be polled, a mutating one may not, and the appearance channel the
 * page asks for is answered here without reaching the plugin.
 */
const READ_ONLY_CHANNELS = new Set([
  'xd.state',
  'xd.composerPoints',
])

/** The channels that change state; a polled read cannot reach these. */
const MUTATING_CHANNELS = new Set([
  'xd.composerPrefer',
  'xd.composerRefresh',
  'xd.checkin',
  'xd.checkinAll',
  'xd.doctor',
  'xd.preferAccount',
  'xd.preferSourceAccount',
  'xd.rescan',
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
])

/** Largest panel request body accepted, so a hung or oversized body cannot pin memory. */
const MAX_BODY_BYTES = 65_536

export interface PanelRouteDeps {
  /** This package's root; the panel assets are read from its `renderer/`. */
  pluginRoot: string
  /** Forward one panel channel to the plugin core. */
  invoke(channel: string, payload: Record<string, unknown>): Promise<unknown>
  logger: { warn(...args: unknown[]): void }
  /** Register one disposer to run when the routes are released. */
  effect(callback: () => unknown): unknown
}


function peerIsLoopback(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress
  if (address === undefined) return false
  if (isIP(address) === 4) return address.startsWith('127.')
  if (isIP(address) !== 6) return false
  try {
    // Normalize IPv6, including the hexadecimal tail of IPv4-mapped peers.
    const host = new URL(`http://[${address}]`).hostname
    return host === '[::1]' || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(host)
  } catch {
    return false
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

/**
 * The message as the panel shows it: redacted and bounded.
 *
 * An upstream that echoes the request it was sent puts a live credential in the
 * text its client throws with, and this is the path that text leaves by - the
 * same reason `host.ts` redacts the copy it reports.
 */
function safeMessage(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 500)
}

/** Read a bounded JSON body; an empty or malformed body reads as `{}`. */
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      // The body keeps arriving and is discarded by the `settled` check above,
      // so the cap bounds what is *kept* and the connection stays usable: the
      // answer still has to reach the client over this same socket.
      reject(error)
    }
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        fail(Object.assign(new Error('request body too large'), { code: 'BODY_TOO_LARGE' }))
        return
      }
      chunks.push(chunk)
    })
    req.on('error', fail)
    req.on('end', () => {
      if (settled) return
      settled = true
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim() === '') {
        resolve({})
        return
      }
      try {
        const parsed: unknown = JSON.parse(raw)
        resolve(parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : {})
      } catch {
        resolve({})
      }
    })
  })
}

/** Answer with one file's bytes, uncached so an edited asset is picked up. */
function sendFile(res: ServerResponse, file: string, type: string): void {
  const body = fs.readFileSync(file)
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
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
 * the host-chrome metas it carried in its previous embedding are dropped, and
 * the bridge that talks to this plugin is injected ahead of its own script. The
 * panel therefore stays one page with one host dependency, and nothing about
 * its markup is duplicated here.
 */
function panelHtml(pluginRoot: string, base: string, lang: string): string | undefined {
  const file = panelAsset(pluginRoot, 'index.html')
  if (file === undefined) return undefined
  const safeBase = base === 'dark' ? 'dark' : 'light'
  const safeLang = lang.toLowerCase().startsWith('en') ? 'en' : 'zh-CN'
  const bridge = `<script>
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
    // The chrome metas describe a host window this page is not embedded in.
    .replace(/\s*<meta name="pi-plugin-chrome"[^>]*>/i, '')
    .replace(/\s*<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/i, '')
    .replace('</head>', `${bridge}\n</head>`)
}

export function registerPanelRoutes(ctx: { webServer: {
  register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => unknown }): () => void
} }, deps: PanelRouteDeps): void {
  try {
    deps.effect(() => {
      const disposers: Array<() => void> = []
      const release = (): void => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch (error: unknown) {
            deps.logger.warn?.('dsh-wtq-pool: a panel route did not release cleanly', error)
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
          handler: (req, res) => {
            if (!peerIsLoopback(req)) return writeJson(res, 403, { error: 'peer-not-loopback' })
            if (req.method !== 'GET') return writeJson(res, 405, { error: 'method not allowed' })
            if (!originIsLoopback(req.headers.origin)) return writeJson(res, 403, { error: 'origin-not-trusted' })
            const url = new URL(req.url ?? '/', 'http://localhost')
            const body = panelHtml(
              deps.pluginRoot,
              url.searchParams.get('base') ?? 'light',
              url.searchParams.get('lang') ?? 'zh-CN',
            )
            if (body === undefined) return writeJson(res, 404, { error: 'missing renderer/index.html' })
            res.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              'Content-Length': Buffer.byteLength(body),
              'Cache-Control': 'no-store',
            })
            res.end(body)
          },
        })
        mount({
          kind: 'exact',
          path: `${PANEL_BASE}/panel.css`,
          handler: (req, res) => {
            if (!peerIsLoopback(req)) return writeJson(res, 403, { error: 'peer-not-loopback' })
            if (req.method !== 'GET') return writeJson(res, 405, { error: 'method not allowed' })
            if (!originIsLoopback(req.headers.origin)) return writeJson(res, 403, { error: 'origin-not-trusted' })
            const file = panelAsset(deps.pluginRoot, 'panel.css')
            if (file === undefined) return writeJson(res, 404, { error: 'missing panel.css' })
            sendFile(res, file, 'text/css; charset=utf-8')
          },
        })
        mount({
          kind: 'exact',
          path: `${PANEL_BASE}/panel.js`,
          handler: (req, res) => {
            if (!peerIsLoopback(req)) return writeJson(res, 403, { error: 'peer-not-loopback' })
            if (req.method !== 'GET') return writeJson(res, 405, { error: 'method not allowed' })
            if (!originIsLoopback(req.headers.origin)) return writeJson(res, 403, { error: 'origin-not-trusted' })
            const file = panelAsset(deps.pluginRoot, 'panel.js')
            if (file === undefined) return writeJson(res, 404, { error: 'missing panel.js' })
            sendFile(res, file, 'text/javascript; charset=utf-8')
          },
        })
        mount({
          kind: 'exact',
          path: `${PANEL_BASE}/invoke`,
          handler: async (req, res) => {
            if (!peerIsLoopback(req)) return writeJson(res, 403, { error: 'peer-not-loopback' })
            if (req.method !== 'POST') return writeJson(res, 405, { error: 'method not allowed' })
            if (!originIsLoopback(req.headers.origin)) return writeJson(res, 403, { error: 'origin-not-trusted' })
            try {
              const body = await readJsonBody(req)
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
              if (!channel.startsWith('xd.')) {
                return writeJson(res, 400, { error: `unsupported channel: ${channel}` })
              }
              if (READ_ONLY_CHANNELS.has(channel) === false
                && MUTATING_CHANNELS.has(channel) === false) {
                return writeJson(res, 400, { error: `unsupported channel: ${channel}` })
              }
              const payload = body['payload'] !== null && typeof body['payload'] === 'object'
                ? body['payload'] as Record<string, unknown>
                : {}
              const result = await deps.invoke(channel, payload)
              writeJson(res, 200, { result: result === undefined ? null : result })
            } catch (error: unknown) {
              // An oversized body is the caller's fault, not a handler failure.
              if ((error as { code?: string }).code === 'BODY_TOO_LARGE') {
                writeJson(res, 413, { error: safeMessage(error) })
                return
              }
              // Any other handler failure is the panel's normal error path: it
              // renders the message, so the text has to survive as-is.
              writeJson(res, 500, { error: safeMessage(error) })
            }
          },
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
    deps.logger.warn?.('dsh-wtq-pool: the panel routes could not be mounted', error)
  }
}
