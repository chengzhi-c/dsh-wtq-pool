/**
 * Panel login: the device-authorization flow the WorkBuddy CLI signs in with.
 *
 * Discovery has always been read-only, because the desktop app signs in
 * interactively and the pool only ever read the files it left behind. An
 * account the user has no desktop install for was therefore out of reach. This
 * runs the same flow the CLI does — ask for a state, open its URL in a browser,
 * poll until that browser has signed in — and writes the answer as one of the
 * plugin's own `.info` files, so a panel-added account is an ordinary pool
 * account rather than a second kind of thing.
 *
 * There is no PKCE: the server issues the state and keeps it, and the browser
 * half of the flow is the vendor's own page.
 *
 * @module dsh-wtq-pool/login
 */

import type { OwnSignIn } from './accounts'
import { regionOf, tokenExpiryMs, type WorkBuddyRegion } from './upstream'

/** The domestic gateway, which serves the domestic login page. */
const CN_BASE = 'https://copilot.tencent.com'
/** The international gateway. */
const GLOBAL_BASE = 'https://www.workbuddy.ai'
/** Billing origin the domestic login page is served from. */
const CN_ORIGIN = 'https://www.codebuddy.cn'
/** The international login page is same-origin with its gateway. */
const GLOBAL_ORIGIN = 'https://www.workbuddy.ai'

/**
 * The CLI's own user agent.
 *
 * The endpoints answer this spelling and turn the plugin's other ones away,
 * and the page it opens belongs to the same client channel — a different
 * spelling there is answered as an unknown platform.
 */
const LOGIN_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'

const REQUEST_TIMEOUT_MS = 30_000

/**
 * Domain stamped on a sign-in whose answer carried none.
 *
 * `regionOf` reads an empty domain as CN, so a global login that arrives
 * without one would be filed under the domestic gateway, which refuses its
 * token at the openresty layer with an HTML 401 instead of a business error.
 */
const DEFAULT_DOMAIN: Record<WorkBuddyRegion, string> = {
  cn: 'www.codebuddy.cn',
  global: 'www.workbuddy.ai',
}

/** Where a login was started: the state that names it and the URL to open. */
export interface DeviceLoginStart {
  state: string
  authUrl: string
}

/**
 * One poll of a started login.
 *
 * `pending` is the ordinary answer until the browser has finished, and it is
 * what an unknown state answers too: the upstream has no separate wording for
 * "no such login", so the caller simply keeps asking until it gives up.
 */
export type DeviceLoginPoll =
  | { status: 'pending' }
  | { status: 'ok'; signIn: OwnSignIn }

function baseFor(realm: WorkBuddyRegion): string {
  return realm === 'global' ? GLOBAL_BASE : CN_BASE
}

function originFor(realm: WorkBuddyRegion): string {
  return realm === 'global' ? GLOBAL_ORIGIN : CN_ORIGIN
}

/** Browser-shaped headers; `Origin` is the one the endpoints check. */
function loginHeaders(origin: string): Record<string, string> {
  return {
    'Accept': 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'Origin': origin,
    'Referer': `${origin}/`,
    'User-Agent': LOGIN_UA,
    'X-Requested-With': 'XMLHttpRequest',
  }
}

/** One `{code, msg, data}` envelope. `code` is 0 on success and non-zero otherwise. */
interface Envelope {
  code: number
  msg: string
  data: Record<string, unknown>
}

async function callLogin(
  url: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  body?: string,
): Promise<Envelope> {
  const response = await fetchImpl(url, {
    redirect: 'error',
    method: body === undefined ? 'GET' : 'POST',
    headers,
    ...body === undefined ? {} : { body },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const text = await response.text()
  // A 3xx or a gateway page is a failure, not an answer: the state endpoint is
  // the only one that redirects, and it does so to a sign-in page.
  if (!response.ok) throw new Error(`workbuddy login endpoint answered ${response.status}`)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('workbuddy login endpoint did not answer JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('workbuddy login endpoint did not answer an object')
  }
  const document = parsed as Record<string, unknown>
  const data = typeof document['data'] === 'object' && document['data'] !== null
    ? document['data'] as Record<string, unknown>
    : {}
  return {
    code: typeof document['code'] === 'number' ? document['code'] : -1,
    msg: typeof document['msg'] === 'string' ? document['msg'] : '',
    data,
  }
}

function stringField(data: Record<string, unknown>, key: string): string {
  const value = data[key]
  return typeof value === 'string' ? value : ''
}

/**
 * Start a login and answer the URL to open.
 *
 * The state is the only thing that ties the browser half to this one, so the
 * caller keeps it for as long as it polls and drops it afterwards.
 */
export async function startDeviceLogin(
  realm: WorkBuddyRegion,
  fetchImpl: typeof fetch = fetch,
): Promise<DeviceLoginStart> {
  const envelope = await callLogin(
    `${baseFor(realm)}/v2/plugin/auth/state?platform=CLI`,
    loginHeaders(originFor(realm)),
    fetchImpl,
    '{}',
  )
  const state = stringField(envelope.data, 'state')
  const authUrl = stringField(envelope.data, 'authUrl')
  if (state === '' || authUrl === '') {
    throw new Error(`workbuddy login start gave no state or url: ${envelope.msg}`)
  }
  return { state, authUrl }
}

/**
 * Read the account a fresh token belongs to.
 *
 * Best effort by design: the token is already good, so an identity that cannot
 * be read costs the panel a name and the archive a stable key, not the sign-in.
 */
async function readLoginAccount(
  base: string,
  headers: Record<string, string>,
  state: string,
  accessToken: string,
  fetchImpl: typeof fetch,
): Promise<Pick<OwnSignIn, 'uid' | 'uin' | 'enterpriseId' | 'nickname'>> {
  const empty = { uid: '', uin: '', enterpriseId: '', nickname: '' }
  let envelope: Envelope
  try {
    envelope = await callLogin(
      `${base}/v2/plugin/login/account?state=${encodeURIComponent(state)}`,
      { ...headers, 'Authorization': `Bearer ${accessToken}` },
      fetchImpl,
    )
  } catch {
    return empty
  }
  if (envelope.code !== 0) return empty
  return {
    uid: stringField(envelope.data, 'uid'),
    // The CN gateway names the billing identity `uin` and the international one
    // `uid`; either one is what the pool keys an account on.
    uin: stringField(envelope.data, 'uin'),
    enterpriseId: stringField(envelope.data, 'enterpriseId'),
    nickname: stringField(envelope.data, 'nickname'),
  }
}

/**
 * Poll a started login once.
 *
 * The token endpoint is the authority on whether the browser has finished: it
 * answers `code: 0` with the token bundle once it has, and a business error
 * for as long as it has not. A non-2xx or an unreadable answer throws, because
 * neither means "keep waiting".
 */
export async function pollDeviceLogin(
  realm: WorkBuddyRegion,
  state: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DeviceLoginPoll> {
  const base = baseFor(realm)
  const headers = loginHeaders(originFor(realm))
  const token = await callLogin(
    `${base}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`,
    headers,
    fetchImpl,
  )
  const accessToken = stringField(token.data, 'accessToken')
  if (token.code !== 0 || accessToken === '') return { status: 'pending' }
  const domain = stringField(token.data, 'domain')
  const identity = await readLoginAccount(base, headers, state, accessToken, fetchImpl)
  const stamped = domain === '' ? DEFAULT_DOMAIN[realm] : domain
  return {
    status: 'ok',
    signIn: {
      region: regionOf(stamped),
      accessToken,
      refreshToken: stringField(token.data, 'refreshToken'),
      expiresAtMs: tokenExpiryMs(
        typeof token.data['expiresIn'] === 'number' ? token.data['expiresIn'] : undefined,
      ),
      domain: stamped,
      ...identity,
    },
  }
}
