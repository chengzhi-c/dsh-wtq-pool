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

import { panelUrl } from './panel-url.ts'
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
  'row.desc': '把本机 WorkBuddy、Trae、Qoder 的桌面登录合并成一个会自动换号的模型池。',
  'card.title': '账号池',
  'card.hint': '下方是完整面板：账号、模型选择、签到与连接检查都在这一页里。',
  'card.open': '重新载入面板',
  'card.frameTitle': '账号池面板',
  'card.missing': '面板资源没有装好，重新安装这个插件即可。',
}

const en: Record<string, string> = {
  'row.title': 'WTQ Pool',
  'row.desc': 'Merges this machine’s WorkBuddy, Trae and Qoder desktop sign-ins into one model pool that fails over on its own.',
  'card.title': 'Account pool',
  'card.hint': 'The full panel sits below: accounts, model selection, check-in and the connection check are all on this page.',
  'card.open': 'Reload panel',
  'card.frameTitle': 'Account pool panel',
  'card.missing': 'The panel assets are missing; reinstalling this plugin restores them.',
}

interface CardProps {
  t: (key: string, params?: Record<string, unknown>) => string
  view?: string
}

/**
 * The embedded panel.
 *
 * of the Plugins page and the Plugins page's out of the panel: the panel was
 * written as a whole page, and the frame is the boundary that lets it stay one.
 *
 * The frame is only mounted for the full page. The row's inline summary is asked
 * for on the list itself, where a 70vh frame would be the wrong control
 * entirely - the host supplies `view` for exactly that distinction.
 */
function PanelCard({ t, view }: CardProps): React.ReactElement | null {
  const [generation, setGeneration] = React.useState(0)
  const frameRef = React.useRef<HTMLIFrameElement | null>(null)

  const appearance = React.useMemo(() => {
    if (typeof document === 'undefined') return { base: 'light', lang: 'zh-CN' }
    const root = document.documentElement
    const dark = root.dataset['base'] === 'dark'
      || (root.dataset['base'] === undefined
        && typeof window !== 'undefined'
        && window.matchMedia?.('(prefers-color-scheme: dark)').matches === true)
    return { base: dark ? 'dark' : 'light', lang: root.lang === '' ? 'zh-CN' : root.lang }
  }, [generation])

  if (view === 'summary') {
    return React.createElement('p', { style: SUMMARY_STYLE }, t('row.desc'))
  }

  return React.createElement('section', { style: CARD_STYLE },
    React.createElement('header', { style: HEAD_STYLE },
      React.createElement('div', null,
        React.createElement('strong', null, t('card.title')),
        React.createElement('p', { style: HINT_STYLE }, t('card.hint')),
      ),
      React.createElement('button', {
        type: 'button',
        style: BUTTON_STYLE,
        onClick: () => {
          // Reloading is the action here: it is also how the panel picks up a
          // theme that changed while it was on screen.
          setGeneration((value) => value + 1)
          const frame = frameRef.current
          if (frame !== null) frame.src = panelUrl(appearance)
        },
      }, t('card.open')),
    ),
    React.createElement('iframe', {
      key: generation,
      ref: frameRef,
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
}

const HEAD_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 12,
}

const HINT_STYLE: React.CSSProperties = {
  margin: '4px 0 0',
  opacity: 0.7,
  fontSize: 12,
}

const BUTTON_STYLE: React.CSSProperties = {
  flex: '0 0 auto',
  cursor: 'pointer',
}

const FRAME_STYLE: React.CSSProperties = {
  width: '100%',
  height: '72vh',
  minHeight: 460,
  border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.25))',
  borderRadius: 10,
  background: 'transparent',
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
  // must cost the labels, not the seats. Everything below still mounts, and
  // `t` falls back to the key so the panel keeps working with bare strings.
  let t = (key: string): string => key
  try {
    ctx.effect(
      () => ctx.locale.register(NAMESPACE, {
        zh: { ...zh, ...composerZh },
        en: { ...en, ...composerEn },
      }),
      'dsh-wtq-pool: copy',
    )
    // Bound inside the same guard as the registration it reads from: a binder
    // that throws here would otherwise take down the seats below with it, which
    // is the opposite of what this block is for.
    t = ctx.locale.bind(NAMESPACE)
  } catch (error: unknown) {
    console.error('[dsh-wtq-pool] the copy did not register (the labels fall back to their keys):', error)
  }

  try {
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
  } catch (error: unknown) {
    console.error('[dsh-wtq-pool] the cards did not mount (the providers are unaffected):', error)
  }
}
