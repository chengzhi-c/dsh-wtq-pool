/**
 * The prefix the shared modules' log lines and warnings carry.
 *
 * One constant rather than a literal per call site, because those modules are
 * synced byte for byte between the two builds and a literal is what a sync
 * overwrites. The value differs per build on purpose: a log line should name the
 * plugin that wrote it. This file is therefore the one shared module the two
 * builds do not copy.
 */
export const LOG_PREFIX = 'dsh-wtq-pool'
