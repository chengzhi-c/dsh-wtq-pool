/**
 * The prefix the shared modules' log lines and warnings carry.
 *
 * One constant rather than a literal per call site, because those modules are
 * synced byte for byte between the two builds and a literal is what a sync
 * overwrites. The two host entries are not synced, so they spell their own
 * prefix out; the value is the same either way.
 */
export const LOG_PREFIX = 'dsh-wtq-pool'
