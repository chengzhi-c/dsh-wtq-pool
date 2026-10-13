/**
 * The panel's route prefix.
 *
 * Both halves of this plugin need the same location: the host half mounts the
 * panel's routes under it, and the settings card frames that same address.
 * Sharing the one literal is what stops the two from drifting into a frame that
 * points at nothing.
 *
 * @module dsh-wtq-pool/panel-route
 */

/** The route prefix every panel route sits under. */
export const PANEL_BASE = '/plugins/dsh-wtq-pool'
