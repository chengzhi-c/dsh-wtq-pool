import { createHash } from 'node:crypto'

/**
 * The prefix the shared modules' log lines and warnings carry.
 *
 * One constant rather than a literal per call site, because those modules are
 * synced byte for byte between the two builds and a literal is what a sync
 * overwrites. Both builds use the same product name, so the host banner and
 * these lines agree.
 */
export const LOG_PREFIX = 'wtq-pool'

/**
 * A stable, non-identifying tag for one account in a log line.
 *
 * The panel shows the label because the user needs to tell accounts apart. A
 * log is copied into bug reports far more often than the panel is, and an email
 * address or nickname there is personal data; a short digest still lets two
 * lines about the same account be correlated without carrying the label.
 */
export function accountLogTag(label: string | undefined): string {
  return 'acct-' + createHash('sha256').update(String(label ?? '')).digest('hex').slice(0, 8)
}
