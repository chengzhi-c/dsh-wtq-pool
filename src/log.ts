/**
 * The prefix the shared modules' log lines and warnings carry.
 *
 * One constant rather than a literal per call site, because those modules are
 * synced byte for byte between the two builds and a literal is what a sync
 * overwrites. Both builds use the same product name, so the host banner and
 * these lines agree.
 */
export const LOG_PREFIX = 'wtq-pool'
