/**
 * The composer credit readout.
 *
 * Sits in the composer's tool row and shows the balance of the account that will
 * serve the next request, but only while the selected model belongs to this
 * plugin. That condition is the point: the row is shared with the shell's own
 * controls, so a plugin that drew there unconditionally would be occupying space
 * the user did not ask it to occupy. The host hands every entry the session's
 * selection through `useProjection('modelSelection')`, which is what the model
 * picker writes and what the next request will use, so the readout cannot
 * disagree with the model actually in effect.
 *
 * Everything shown comes from the plugin's own host half over the panel bridge:
 * this module makes no upstream call of its own and never reads a token.
 *
 * @module dsh-wtq-pool/client/composer
 */

import * as React from 'react'

import { PANEL_BASE } from '../panel-route.ts'

/** What this plugin needs from the composer slot's standard props. */
export interface ComposerProps {
  /** Read one of the host's own projections for this session. */
  useProjection?: ((key: string, selector?: unknown, equal?: unknown) => unknown) | undefined
}

export const composerZh: Record<string, string> = {
  'composer.title': '账号积分',
  'composer.account': '账号',
  'composer.balance': '积分',
  'composer.switching': '切换中…',
  'composer.click': '点击切换账号',
  'composer.refresh': '刷新积分',
  'composer.refreshing': '正在刷新…',
  'composer.refused': '这个账号无法切换，刷新后重试',
  'composer.saved': '已设为优先；积分面板暂不可用，恢复后自动生效',
  'composer.unavailable': '已设为优先，但该账号现在不能服务（冷却或已停用），恢复后自动生效',
  'composer.planQuota': '套餐',
  'composer.addOnQuota': '资源包',
  'composer.never': '不过期',
  'composer.monthly': '月度',
  'composer.days': '天',
}

export const composerEn: Record<string, string> = {
  'composer.title': 'Account credits',
  'composer.account': 'Account',
  'composer.balance': 'Credits',
  'composer.switching': 'Switching…',
  'composer.click': 'Click to switch account',
  'composer.refresh': 'Refresh credits',
  'composer.refreshing': 'Refreshing…',
  'composer.refused': 'That account cannot be switched; refresh and try again',
  'composer.saved': 'Set as preferred; the credits panel is unavailable right now and it takes over once it recovers',
  'composer.unavailable': 'Set as preferred, but that account cannot serve right now (cooling or switched off); it takes over once it recovers',
  'composer.planQuota': 'Plan',
  'composer.addOnQuota': 'Add-on',
  'composer.never': 'never expires',
  'composer.monthly': 'monthly',
  'composer.days': ' days',
}

/**
 * How often the readout re-reads a cached balance, once it has one.
 *
 * A credit balance moves on the scale of model calls, not seconds, and the host
 * answers from the account probe's own cache - so this is a poll of a cached
 * value, not an upstream read per tick. The host half is what guarantees that:
 * `xd.composerPoints` answers from cache, and the only network it can start is
 * the one background refresh that fills a stale cache.
 */
const REFRESH_INTERVAL_MS = 300_000

/**
 * How often the readout asks again while it has no number yet.
 *
 * The host answers `total: null` for an account whose credits it has not read
 * yet - the first seconds after a session starts, while the account probe is
 * still filling its cache. That is "not read yet", not "no credits": treating it
 * as final would leave the readout showing a dash for a full refresh interval,
 * which is the whole of the time the user is looking at it.
 */
const WARMUP_INTERVAL_MS = 5_000

/** How long the faster cadence may run before the readout settles down. */
const WARMUP_WINDOW_MS = 120_000

/**
 * The id the readout registers under.
 *
 * Stable and namespaced so a reload replaces its own entry rather than adding a
 * second one beside it.
 */
export const COMPOSER_SLOT_ID = 'dsh-wtq-pool-composer-points'

/** One account row of the readout's popup. */
interface ComposerAccount {
  id?: string
  label?: string
  active?: boolean
  total?: number
  plan?: string
  packages?: Array<{ packageName?: string; nameKey?: string; remain?: number; validDays?: number; monthly?: boolean; neverExpires?: boolean; roundExpiresAtMs?: number; expiresAtMs?: number }>
}

function packageText(pack: NonNullable<ComposerAccount['packages']>[number], t: (key: string) => string): string {
  const name = pack.packageName || t(pack.nameKey === 'credits.planQuota' ? 'composer.planQuota'
    : pack.nameKey === 'credits.addOnQuota' ? 'composer.addOnQuota' : 'composer.balance')
  const at = typeof pack.roundExpiresAtMs === 'number' ? pack.roundExpiresAtMs : pack.expiresAtMs
  let when = ''
  if (typeof at === 'number' && at > Date.now()) {
    const date = new Date(at)
    when = (date.getMonth() + 1) + '/' + date.getDate()
  } else if (pack.neverExpires === true) when = t('composer.never')
  else if (pack.monthly === true) when = t('composer.monthly')
  else if (typeof pack.validDays === 'number') when = pack.validDays + t('composer.days')
  const remain = typeof pack.remain === 'number' ? formatCredits(pack.remain) : '—'
  return name + ' ' + remain + (when === '' ? '' : ' · ' + when)
}

/** The document `xd.composerPoints` answers with. */
interface ComposerDocument {
  show?: boolean
  /**
   * Whether the selected route is this plugin's at all.
   *
   * `show: false` alone cannot say why nothing is shown, and the two reasons
   * want opposite cadences: another plugin's model is nothing to wait for, while
   * one of ours whose roster has not been declared yet is a balance on its way.
   */
  ours?: boolean
  source?: string
  region?: string
  label?: string
  total?: number | null
  accounts?: ComposerAccount[]
  /**
   * The choice was stored, but the named account cannot serve yet: the pool
   * skips a cooling, switched-off or reserve-held one, so the marked row is
   * still another account. Answered instead of refused, because the preference
   * does take effect the moment that account recovers.
   */
  unavailable?: boolean
  /**
   * The preference was stored and is already in force. Sent on every answer
   * past the save, so a missing snapshot (`show: false` because the credits
   * chip was switched off between the popup's read and this click) reports the
   * stored choice instead of contradicting it with a refusal.
   */
  saved?: boolean
}

/** The selected route, out of the host's `modelSelection` projection. */
function selectionOf(projection: unknown): { provider: string; model: string } | undefined {
  if (projection === null || typeof projection !== 'object') return undefined
  const row = (projection as { next?: unknown }).next ?? (projection as { lastUsed?: unknown }).lastUsed
  if (row === null || typeof row !== 'object') return undefined
  const provider = (row as { provider?: unknown }).provider
  const model = (row as { model?: unknown }).model
  if (typeof provider !== 'string' || provider === '') return undefined
  if (typeof model !== 'string' || model === '') return undefined
  return { provider, model }
}

/**
 * How long one panel-channel call may take from the client side.
 *
 * The refresh channel spends up to its own server-side budget re-probing
 * accounts; everything else answers from cache. The figure covers the former
 * with margin, so a cache read never times out while a real pass still fits.
 */
const INVOKE_TIMEOUT_MS = 20000

/**
 * Ask the plugin's own host half one channel, over the panel bridge's route.
 *
 * The fetch carries its own deadline: the host side bounds what a channel may
 * spend, but the panel bridge itself imposes no call-length cap, so a stuck
 * route would otherwise leave the readout's promise pending forever.
 */
async function invoke(channel: string, payload: Record<string, unknown>): Promise<ComposerDocument> {
  const response = await fetch(`${PANEL_BASE}/invoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ channel, payload }),
    signal: AbortSignal.timeout(INVOKE_TIMEOUT_MS),
  })
  const body = await response.json().catch(() => ({})) as { result?: unknown; error?: unknown }
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${response.status}`)
  return (body.result ?? {}) as ComposerDocument
}

/** Group the digits so a four-figure balance stays readable in a narrow row. */
function formatCredits(value: number): string {
  return Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

/** The one balance the readout shows, or undefined when there is none yet. */
function balanceOf(document: ComposerDocument | null): number | undefined {
  return document !== null && typeof document.total === 'number' ? document.total : undefined
}

/** The margin kept between the popup and the edge of the window. */
const PANEL_MARGIN = 8

/** The popup's own width cap, in px. */
const PANEL_MAX_WIDTH = 360

/** How tall the popup is allowed to get, in px. */
const PANEL_MAX_HEIGHT = 320

/**
 * Where the popup sits, given its trigger's box.
 *
 * Anchored above the trigger and right-aligned to it - the composer row is at
 * the bottom of the window, so above is where the room is. Flipped below when
 * the trigger is near the top and the popup would not fit above it: a fixed
 * position is not scrolled into view by anything, so the rows above the trigger
 * would simply be cut off, and so would the popup's own first rows. The width is
 * capped to the window for the same reason, rather than trusting the viewport
 * to be wider than the stylesheet's own cap.
 */
function positionStyle(rect: DOMRect): React.CSSProperties {
  const width = typeof window === 'undefined'
    ? PANEL_MAX_WIDTH
    : Math.max(0, Math.min(PANEL_MAX_WIDTH, window.innerWidth - PANEL_MARGIN * 2))
  const above = rect.top - PANEL_MARGIN >= PANEL_MAX_HEIGHT
  return {
    width: width + 'px',
    left: Math.max(PANEL_MARGIN, rect.right - width) + 'px',
    top: (above ? rect.top - PANEL_MARGIN : rect.bottom + PANEL_MARGIN) + 'px',
    transform: above ? 'translateY(-100%)' : undefined,
  }
}

const CSS = `
.xd-points{position:relative;display:inline-flex;align-items:center;min-width:0}
.xd-points-btn{border:0;background:transparent;color:inherit;font:inherit;font-size:12px;line-height:1;display:inline-flex;align-items:center;gap:5px;padding:4px 7px;border-radius:999px;cursor:pointer;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.xd-points-btn:hover{background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.12))}
.xd-points-mark{display:inline-block;width:6px;height:6px;flex:0 0 auto;border-radius:50%;background:var(--dsw-alias-state-success-primary,#4f9f7c)}
.xd-points-panel{position:fixed;z-index:40;min-width:240px;max-width:${PANEL_MAX_WIDTH}px;max-height:${PANEL_MAX_HEIGHT}px;overflow:auto;padding:8px;border-radius:12px;background:var(--dsw-alias-bg-layer-2,#1c1d21);color:var(--dsw-alias-label-primary,#e8e8ea);box-shadow:0 8px 28px rgba(0,0,0,.28);border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25))}
.xd-points-table{width:100%;border-collapse:collapse;font-size:12px}
.xd-points-table th{text-align:left;font-weight:600;padding:4px 6px;color:var(--dsw-alias-label-tertiary,#8b8d93)}
.xd-points-table td{padding:4px 6px;vertical-align:top}
.xd-points-row{cursor:pointer}
.xd-points-row:hover{background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.12))}
.xd-points-row.is-active{cursor:default}
.xd-points-dot{display:inline-block;width:6px;height:6px;margin-right:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#4f9f7c);vertical-align:middle}
.xd-points-packs{margin:2px 0 0;padding:0;list-style:none;color:var(--dsw-alias-label-tertiary,#8b8d93)}
.xd-points-bar{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}
.xd-points-refresh{border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#8b8d93);font:inherit;font-size:12px;padding:3px 8px;border-radius:999px;cursor:pointer}
.xd-points-refresh:hover:not(:disabled){background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,#e8e8ea)}
.xd-points-refresh:disabled{opacity:.5;cursor:default}
`

/**
 * Inject the readout's stylesheet once per document.
 *
 * Keyed on the tag's own data attribute so a plugin reload does not stack a
 * second copy, and guarded because the module is evaluated where a document may
 * not exist at all.
 */
function injectStyle(): void {
  if (typeof document === 'undefined') return
  const id = 'dsh-wtq-pool/composer-points.css'
  if (document.querySelector(`style[data-plugin-css="${id}"]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset['plugin'] = 'dsh-wtq-pool'
  tag.dataset['pluginCss'] = id
  tag.textContent = CSS
  document.head.appendChild(tag)
}

injectStyle()

/**
 * The readout.
 *
 * Returns nothing at all - not a hidden node - while the switch is off or the
 * selected model is another plugin's. The row is shared, so the honest state is
 * to be absent from it.
 */
export function ComposerPoints(props: ComposerProps): React.ReactElement | null {
  const t = (key: string): string => {
    const dict = typeof document !== 'undefined' && document.documentElement.lang.toLowerCase().startsWith('en')
      ? composerEn
      : composerZh
    return dict[key] ?? composerEn[key] ?? key
  }

  const useProjection = props.useProjection
  const projection = useProjection === undefined ? undefined : useProjection('modelSelection')
  const selection = selectionOf(projection)
  const provider = selection?.provider ?? ''
  const model = selection?.model ?? ''
  const route = provider + '\n' + model
  const routeRef = React.useRef({ route })
  if (routeRef.current.route !== route) routeRef.current = { route }

  // Named `points`, not `document`: the dismissal effect below reads the DOM's
  // own `document`, and a state variable of that name would shadow it.
  const [points, setPoints] = React.useState<ComposerDocument | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [refreshing, setRefreshing] = React.useState(false)
  const [open, setOpen] = React.useState(false)
  // The account a stored-but-not-serving notice is about. A cooling account
  // recovers on its own, so without this the notice outlived the condition it
  // described and eventually contradicted the active dot beside it.
  const [errorFor, setErrorFor] = React.useState('')
  const [error, setError] = React.useState('')
  const rootRef = React.useRef<HTMLSpanElement | null>(null)
  const panelRef = React.useRef<HTMLDivElement | null>(null)
  const restartPollRef = React.useRef<() => void>(() => {})

  React.useEffect(() => {
    if (provider === '' || model === '') {
      setPoints(null)
      return undefined
    }
    setPoints(null)
    let stopped = false
    let timer = 0
    let startedAt = Date.now()
    // Re-armed rather than fixed-interval: the readout asks again quickly while
    // a balance of ours is still unread, and slowly once it has one - or once
    // the route turns out not to be ours, in which case there is nothing coming
    // and no reason to keep asking.
    const schedule = (current: ComposerDocument | null): void => {
      const ours = current !== null && current.ours === true
      const settled = current !== null && typeof current.total === 'number'
      const warming = ours && Date.now() - startedAt < WARMUP_WINDOW_MS
      window.clearTimeout(timer)
      timer = window.setTimeout(pull, settled || !warming ? REFRESH_INTERVAL_MS : WARMUP_INTERVAL_MS)
    }
    const pull = (): void => {
      invoke('xd.composerPoints', { provider, model })
        .then((next) => {
          if (stopped) return
          const shown = next.show === true ? next : null
          setPoints(shown)
          schedule(next)
        })
        .catch(() => {
          if (stopped) return
          setPoints(null)
          schedule(null)
        })
    }
    restartPollRef.current = () => { window.clearTimeout(timer); startedAt = Date.now(); pull() }
    pull()
    return () => {
      stopped = true
      window.clearTimeout(timer)
      restartPollRef.current = () => {}
    }
  }, [provider, model])
  // Dismissal follows the shell's own convention for an anchored popup: any
  // pointer landing outside both the trigger and the panel closes it, and so
  // does Escape.
  React.useEffect(() => {
    if (!open) return undefined
    const onPointer = (event: PointerEvent): void => {
      const target = event.target as Node | null
      if (target === null) return
      if (rootRef.current?.contains(target) === true) return
      if (panelRef.current?.contains(target) === true) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // A model change invalidates the popup's contents: it listed the accounts of
  // the route that was selected a moment ago.
  React.useEffect(() => {
    setOpen(false)
    setError('')
    setErrorFor('')
    setBusy(false)
    setRefreshing(false)
  }, [provider, model])

  // A cooling account recovers by itself, so the notice that named it has to go
  // when that account starts serving: it described a state that no longer holds,
  // and it is this popup's own marking that says so.
  React.useEffect(() => {
    if (errorFor === '') return
    const row = (points?.accounts ?? []).find((account) => account.id === errorFor)
    if (row?.active === true) {
      setError('')
      setErrorFor('')
    }
  }, [points, errorFor])

  const balance = balanceOf(points)
  if (points === null) return null

  const pick = (account: ComposerAccount): void => {
    if (busy || account.active === true) return
    const requestedRoute = routeRef.current
    setBusy(true)
    setError('')
    invoke('xd.composerPrefer', {
      provider,
      model,
      source: points.source ?? '',
      region: points.region ?? '',
      accountId: account.id ?? '',
      accountLabel: account.label ?? '',
    }).then((next) => {
      if (routeRef.current !== requestedRoute) return
      setBusy(false)
      // `saved` is the host's word for "the preference is stored and already in
      // force", so it is the one thing that separates a refusal from a snapshot
      // that merely went missing between the popup's read and this click.
      if (next.saved !== true) {
        setError(t('composer.refused'))
        setErrorFor('')
        return
      }
      if (next.show !== true) {
        setError(t('composer.saved'))
        setErrorFor(account.id ?? '')
        return
      }
      setPoints(next)
      restartPollRef.current()
      // `unavailable` means the choice was stored but the account cannot serve
      // yet - the pool skips a cooling, switched-off or reserve-held one - so
      // the marked row is still someone else and the click would look ignored
      // if the popup closed on it.
      if (next.unavailable === true) {
        setError(t('composer.unavailable'))
        setErrorFor(account.id ?? '')
        return
      }
      setOpen(false)
    }).catch((failure: unknown) => {
      if (routeRef.current !== requestedRoute) return
      setBusy(false)
      setError(failure instanceof Error ? failure.message : String(failure))
    })
  }

  const refresh = (): void => {
    if (refreshing || busy) return
    const requestedRoute = routeRef.current
    setRefreshing(true)
    setError('')
    invoke('xd.composerRefresh', { provider, model })
      .then((next) => {
        if (routeRef.current !== requestedRoute) return
        setRefreshing(false)
        if (next.show === true) setPoints(next)
      })
      .catch((failure: unknown) => {
        if (routeRef.current !== requestedRoute) return
        setRefreshing(false)
        setError(failure instanceof Error ? failure.message : String(failure))
      })
  }

  const accounts = Array.isArray(points.accounts) ? points.accounts : []
  const rect = open && rootRef.current !== null ? rootRef.current.getBoundingClientRect() : null

  return React.createElement('span', { className: 'xd-points', ref: rootRef },
    React.createElement('button', {
      type: 'button',
      className: 'xd-points-btn',
      title: t('composer.click'),
      'aria-expanded': open,
      onClick: () => setOpen((value) => !value),
    },
      React.createElement('span', { className: 'xd-points-mark', 'aria-hidden': 'true' }),
      balance === undefined ? '—' : formatCredits(balance),
    ),
    open && rect !== null
      ? React.createElement('div', {
          className: 'xd-points-panel',
          ref: panelRef,
          role: 'dialog',
          'aria-label': t('composer.title'),
          style: positionStyle(rect),
        },
          React.createElement('div', { className: 'xd-points-bar' },
            React.createElement('span', null, t('composer.title')),
            React.createElement('button', {
              type: 'button',
              className: 'xd-points-refresh',
              disabled: refreshing || busy,
              onClick: refresh,
            }, refreshing ? t('composer.refreshing') : t('composer.refresh')),
          ),
          error === '' ? null : React.createElement('p', { role: 'alert' }, error),
          busy ? React.createElement('p', null, t('composer.switching')) : null,
          React.createElement('table', { className: 'xd-points-table' },
            React.createElement('thead', null, React.createElement('tr', null,
              React.createElement('th', null, t('composer.account')),
              React.createElement('th', null, t('composer.balance')),
            )),
            React.createElement('tbody', null, accounts.map((account, index) => React.createElement('tr', {
              key: account.id ?? account.label ?? String(index),
              className: 'xd-points-row' + (account.active === true ? ' is-active' : ''),
            },
              React.createElement('td', null,
                account.active === true
                  ? React.createElement('span', { className: 'xd-points-dot', 'aria-hidden': 'true' })
                  : null,
                React.createElement('button', {
                  type: 'button',
                  className: 'xd-points-btn',
                  disabled: account.active === true || busy,
                  onClick: () => pick(account),
                }, account.label ?? '—'),
              ),
              React.createElement('td', null,
                typeof account.total === 'number' ? formatCredits(account.total) : (account.plan ?? '—'),
                points.source === 'qoder' && Array.isArray(account.packages)
                  ? React.createElement('ul', { className: 'xd-points-packs' }, account.packages.map((pack, index) =>
                      React.createElement('li', { key: index }, packageText(pack, t))))
                  : null,
              ),
            ))),
          ),
        )
      : null,
  )
}
