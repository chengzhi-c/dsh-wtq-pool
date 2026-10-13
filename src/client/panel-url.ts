/**
 * The panel's address.
 *
 * The host half serves the panel under {@link PANEL_BASE}; this module is what
 * builds the address the card frames, from the same prefix and the appearance
 * the embedding page is showing.
 *
 * @module dsh-wtq-pool/client/panel-url
 */

export { PANEL_BASE } from '../panel-route.ts'
import { PANEL_BASE } from '../panel-route.ts'

/** The appearance the panel should render itself in. */
export interface PanelAppearance {
  base: string
  lang: string
}

/** The panel's URL, carrying the appearance the embedding page is showing. */
export function panelUrl(appearance: PanelAppearance): string {
  const params = new URLSearchParams({
    base: appearance.base === 'dark' ? 'dark' : 'light',
    lang: appearance.lang.toLowerCase().startsWith('en') ? 'en' : 'zh-CN',
  })
  return `${PANEL_BASE}/panel?${params.toString()}`
}
