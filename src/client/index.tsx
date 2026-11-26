/**
 * The card this plugin puts on the Plugins page.
 *
 * The card is deliberately thin: it frames the panel, and the panel itself is
 * the whole surface. A card that re-implemented the pool in React would be a
 * second surface to keep in step with the first, so the card owns text,
 * placement and the state a settings form needs - nothing else.
 *
 * @module dsh-wtq-pool/client
 */

import * as React from 'react'
import type { Context } from '@deepseek-ai/cordis'

import { panelUrl, PANEL_BASE } from './panel-url.ts'
import { ComposerPoints, COMPOSER_SLOT_ID, composerEn, composerZh } from './composer.tsx'
import { PLUGIN_NAME, ROW_ID } from '../ids.ts'

/** The slot registry face the host client runtime augments onto `Context`. */
interface SlotsFace {
  inject(key: string, callback: () => unknown): () => void
  register(options: Record<string, unknown>, component: unknown): () => void
}

/** The locale binder face, from the same augmentation. */
interface LocaleFace {
  register(namespace: string, dictionaries: { zh: unknown; en: unknown }): () => void
  bind(namespace: string): (key: string, params?: Record<string, unknown>) => string
}

/** What this module needs from the host client runtime. */
export type XdPoolClientContext = Context & {
  slots: SlotsFace
  locale: LocaleFace
}

export const inject = ['slots', 'locale']

/** The locale namespace this card's copy lives under. */
const NAMESPACE = 'settings.dsh-wtq-pool'

const zh: Record<string, string> = {
  'row.title': 'WTQ Pool',
  'row.desc': '将本机 WorkBuddy、Trae、Qoder 桌面登录接入统一账号池，并按设置切换账号。',
  'card.title': '账号池',
  'card.open': '重新载入面板',
  'card.fullscreen': '全屏',
  'card.exitFullscreen': '退出全屏',
  'card.frameTitle': '账号池面板',
  'card.missing': '面板资源缺失。重新安装插件可恢复。',
  'card.probeFailed': '面板打开失败：',
  'card.networkError': '网络连接失败',
}

const en: Record<string, string> = {
  'row.title': 'WTQ Pool',
  'row.desc': 'Connects local WorkBuddy, Trae and Qoder desktop sign-ins to one account pool and switches accounts according to its settings.',
  'card.title': 'Account pool',
  'card.open': 'Reload panel',
  'card.fullscreen': 'Full screen',
  'card.exitFullscreen': 'Exit full screen',
  'card.frameTitle': 'Account pool panel',
  'card.missing': 'Panel assets are missing. Reinstall the plugin to restore them.',
  'card.probeFailed': 'The panel did not open:',
  'card.networkError': 'Network error',
}

interface CardProps {
  t: (key: string, params?: Record<string, unknown>) => string
  view?: string
}

/**
 * The embedded panel.
 *
 * The frame keeps the panel's page and the Plugins page apart: the panel was
 * written as a whole page, and the frame is the boundary that lets it stay one.
 *
 * The frame is only mounted for the full page. The row's inline summary is asked
 * for on the list itself, where a 70vh frame would be the wrong control
 * entirely - the host supplies `view` for exactly that distinction.
 */
function PanelCard({ t, view }: CardProps): React.ReactElement | null {
  const card = React.useRef<HTMLElement>(null)
  const [fullscreen, setFullscreen] = React.useState(false)
  const [generation, setGeneration] = React.useState(0)
  const [recoveries, setRecoveries] = React.useState(0)
  const [missing, setMissing] = React.useState(false)
  const [probeFailure, setProbeFailure] = React.useState<string | null>(null)

  React.useEffect(() => {
    const sync = (): void => setFullscreen(document.fullscreenElement === card.current)
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])

  const appearance = React.useMemo(() => {
    const root = document.documentElement
    const dark = root.dataset['base'] === 'dark'
      || (root.dataset['base'] === undefined
        && window.matchMedia('(prefers-color-scheme: dark)').matches)
    return { base: dark ? 'dark' : 'light', lang: root.lang === '' ? 'zh-CN' : root.lang }
  }, [generation])

  // Whether the host half is serving the panel at all.
  //
  // The frame is same-origin, so a build whose host half is not serving shows
  // the route's own JSON error body where the panel should be, and that reads
  // as a broken panel rather than a missing one. One probe per frame generation
  // tells the two apart. `panel.css` is the file to ask for: it is the panel's
  // own, it is already in the frame's critical path, and only a served panel
  // can answer for it.
  //
  // Retried before concluding: a host half that is still loading has not
  // registered its routes yet, and that 404 is a wait rather than a verdict.
  React.useEffect(() => {
    if (view === 'summary') return undefined
    let live = true
    let retry: ReturnType<typeof setTimeout> | undefined
    setMissing(false)
    setProbeFailure(null)
    const attempts = 3
    const probe = (remaining: number): void => {
      fetch(`${PANEL_BASE}/panel.css`)
        .then((response) => {
          if (!live) return
          if (response.ok) {
            if (remaining < attempts) setRecoveries(value => value + 1)
            setMissing(false)
            setProbeFailure(null)
            return
          }
          if (remaining > 1) {
            retry = setTimeout(() => probe(remaining - 1), 500)
            return
          }
          // A 404 is the host half still loading or missing its assets. Every
          // other refusal says why (the loopback or origin guard), and sending
          // those users to reinstall is advice that cannot work.
          if (response.status === 404) {
            setMissing(true)
            setProbeFailure(null)
            return
          }
          void response.text().then((body) => {
            if (!live) return
            let detail = ''
            try {
              const parsed = JSON.parse(body) as { error?: unknown }
              detail = typeof parsed.error === 'string' ? parsed.error : ''
            } catch { /* the status is the diagnosis */ }
            setMissing(true)
            setProbeFailure(detail === '' ? `HTTP ${response.status}` : `HTTP ${response.status}: ${detail}`)
          }).catch(() => {
            if (!live) return
            setMissing(true)
            setProbeFailure(`HTTP ${response.status}`)
          })
        })
        .catch(() => {
          if (!live) return
          if (remaining > 1) {
            retry = setTimeout(() => probe(remaining - 1), 500)
            return
          }
          setMissing(true)
          setProbeFailure(t('card.networkError'))
        })
    }
    probe(attempts)
    return () => {
      live = false
      if (retry !== undefined) clearTimeout(retry)
    }
  }, [view, generation])

  if (view === 'summary') {
    return React.createElement('p', { style: SUMMARY_STYLE }, t('row.desc'))
  }

  return React.createElement('section', {
    ref: card,
    style: fullscreen ? { ...CARD_STYLE, ...FULLSCREEN_STYLE, colorScheme: appearance.base } : CARD_STYLE,
  },
    React.createElement('header', { style: HEAD_STYLE },
      React.createElement('div', null,
        React.createElement('strong', null, t('card.title')),
      ),
      React.createElement('div', { style: ACTIONS_STYLE },
        React.createElement('button', {
          type: 'button',
          style: BUTTON_STYLE,
          onClick: () => {
            // Reload also picks up the host's current theme.
            setGeneration((value) => value + 1)
          },
        }, t('card.open')),
        React.createElement('button', {
          type: 'button',
          style: BUTTON_STYLE,
          onClick: () => fullscreen ? document.exitFullscreen() : card.current!.requestFullscreen(),
        }, t(fullscreen ? 'card.exitFullscreen' : 'card.fullscreen')),
      ),
    ),
    missing
      ? React.createElement('div', { style: MISSING_STYLE },
        probeFailure === null ? t('card.missing') : `${t('card.probeFailed')} ${probeFailure}`)
      : React.createElement('iframe', {
        key: generation + recoveries,
        title: t('card.frameTitle'),
        src: panelUrl(appearance),
        style: FRAME_STYLE,
      }),
  )
}

const SUMMARY_STYLE: React.CSSProperties = {
  margin: 0,
  opacity: 0.75,
  fontSize: 13,
}

const CARD_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  height: '90dvh',
}

const FULLSCREEN_STYLE: React.CSSProperties = {
  height: '100dvh',
  padding: 12,
  boxSizing: 'border-box',
  background: 'var(--dsw-alias-bg-layer-1, Canvas)',
  color: 'var(--dsw-alias-label-primary, CanvasText)',
}

const HEAD_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  flexShrink: 0,
  gap: 12,
}

const ACTIONS_STYLE: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  justifyContent: 'flex-end',
  gap: 8,
}

const BUTTON_STYLE: React.CSSProperties = {
  flex: '0 0 auto',
  cursor: 'pointer',
}

// Dialogs center in the iframe viewport, so it must stay within one screen.
const FRAME_STYLE: React.CSSProperties = {
  display: 'block',
  width: '100%',
  flex: '1 1 0',
  minHeight: 0,
  border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.25))',
  borderRadius: 10,
  background: 'transparent',
  boxSizing: 'border-box',
}

/* The frame's box, standing in for the panel the host half did not serve.
 *
 * The box stays so the card keeps the height the panel would have given it: a
 * card that collapsed to two lines reads as the whole plugin having failed,
 * which is a different and worse story than the one being told. */
const MISSING_STYLE: React.CSSProperties = {
  ...FRAME_STYLE,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  margin: 0,
  padding: '0 16px',
  opacity: 0.75,
  fontSize: 13,
  textAlign: 'center',
}

/**
 * Register the card on the Plugins page.
 *
 * Two seats, because the host keys them differently and shows them in different
 * places: the bundle page (opened from the plugin's own card) keys on the
 * package name, and the row page (the "Configure" control beside the plugin's
 * loader row) keys on `<package name>#<row id>`. Registering both is what puts
 * the panel where the plugin is configured rather than in the generic settings
 * list.
 *
 * Every step is guarded: a slot this host line does not declare must cost the
 * card, not the provider. The host services keep serving either way.
 */
export function apply(ctx: XdPoolClientContext): void {
  // The copy is registered first and on its own: a locale that will not bind
  // must cost the labels, not the seats. PanelCard is given the host's binder.
  try {
    ctx.effect(
      () => ctx.locale.register(NAMESPACE, {
        zh: { ...zh, ...composerZh },
        en: { ...en, ...composerEn },
      }),
      'dsh-wtq-pool: copy',
    )
  } catch (error: unknown) {
    console.error('[dsh-wtq-pool] the copy did not register (the labels fall back to their keys):', error)
  }

  const seat = (slotName: string, key: string): void => {
    try {
      ctx.slots.inject(slotName, () => ctx.slots.register({
        name: slotName,
        key,
        locale: NAMESPACE,
      }, PanelCard))
    } catch (error: unknown) {
      console.error(`[dsh-wtq-pool] the card did not mount into ${slotName} (the providers are unaffected):`, error)
    }
  }

  seat('plugins.bundle.config', PLUGIN_NAME)
  seat('plugins.row.config', `${PLUGIN_NAME}#${ROW_ID}`)

  // The credit readout. Registered unconditionally: its gate reads the host's
  // own selection projection and renders nothing for every other provider, so
  // it neither competes for the composer row nor starts a poll until one of
  // this plugin's models is selected.
  try {
    ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
      name: 'conversation.input.left',
      id: COMPOSER_SLOT_ID,
      order: 4,
    }, ComposerPoints))
  } catch (error: unknown) {
    console.error('[dsh-wtq-pool] the composer readout did not mount (the providers are unaffected):', error)
  }
}
