/**
 * The two names this plugin is identified by.
 *
 * The client half has to key its Plugins-page entries with them, and the host
 * half has to register under the same row id: a keyed slot's key is
 * `<package name>#<loader row id>`, so a mismatch in either half silently costs
 * the plugin its Configure control. Keeping both literals here is what stops the
 * two halves from drifting apart.
 *
 * @module dsh-wtq-pool/ids
 */

/** The npm package name this plugin is published and installed under. */
export const PLUGIN_NAME = 'dsh-wtq-pool'

/**
 * The loader row id this plugin's own patch inserts.
 *
 * `cordis.patch.yml` inserts this id, the host reads it back to key the plugin's
 * row page, and the settings namespace is this same id - so the entry's settings
 * form and its client card address one another by it.
 */
export const ROW_ID = 'llm-dsh-xdpool'
