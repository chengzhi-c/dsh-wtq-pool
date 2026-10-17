/**
 * When the daily check-in is due, decided in one time zone.
 *
 * The reward windows are defined in Beijing time, so an hour has to mean the
 * same instant on every machine: reading the host's local hour would make "9
 * o'clock" slip by a day on a laptop set to another zone. Everything here is a
 * pure function of its arguments, which is what lets a check drive the whole
 * decision - the configured hours, the slot id, what is due right now - without
 * a clock to fake or a settings file to write.
 *
 * The two host entries carried their own copy of this, and they had already
 * drifted: one capped the configured hours and the other did not. The cap is
 * defensive rather than load-bearing - the filter below already leaves at most
 * 24 distinct values in 0..23 - but two copies of a rule is two chances to
 * disagree about it, so there is one copy now.
 *
 * @module dsh-wtq-pool/checkin-time
 */

/** The zone the daily check-in hours are read in. */
export const CHECKIN_TIME_ZONE = 'Asia/Shanghai'

/** Collected at 09:00 local campaign time unless the user says otherwise. */
export const DEFAULT_CHECKIN_HOURS: readonly number[] = [9]

/** How often the timer looks for a due slot. A minute is far below one hour. */
export const CHECKIN_POLL_MS = 60_000


/** Calendar day and hour of `date` in the check-in zone, as zero-padded strings. */
export function zonedDayHour(date: Date): { day: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: CHECKIN_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const pick = (type: string): string => {
    const found = parts.find((part) => part.type === type)
    return found === undefined ? '00' : found.value
  }
  return { day: pick('year') + '-' + pick('month') + '-' + pick('day'), hour: Number(pick('hour')) }
}

/**
 * Whole hours only, in order. Anything unreadable is dropped rather than
 * guessed at, and an empty list falls back to the default hour: a switch that
 * is on but never fires would be worse than one that picks a sane time.
 */
export function normaliseCheckinHours(raw: readonly unknown[]): number[] {
  // `Number('')`, `Number(null)` and `Number(false)` are all 0, so a value that
  // carries no time at all used to normalise to midnight and fire a check-in at
  // 00:00. Only a number, or a string with digits in it, can name an hour.
  const hours = [...new Set(raw
    .filter((value) => typeof value === 'number' || (typeof value === 'string' && value.trim() !== ''))
    .map((value) => Math.floor(Number(value))))]
    .filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23)
    .sort((a, b) => a - b)
  return hours.length === 0 ? [...DEFAULT_CHECKIN_HOURS] : hours
}

/** A slot's id: `YYYY-MM-DDTHH` in the check-in zone. */
export function checkinSlotId(day: string, hour: number): string {
  return day + 'T' + String(hour).padStart(2, '0')
}

/**
 * The slot to collect right now, or undefined when nothing is due.
 *
 * An hour is due once its time has passed - catch-up, deliberately: a machine
 * that slept through 09:00 still collects when it wakes instead of waiting for
 * tomorrow. The earliest unconsumed hour wins, so two configured hours still
 * give two passes a day.
 */
export function dueCheckinSlot(
  now: Date,
  hours: readonly number[],
  fired: ReadonlySet<string>,
): string | undefined {
  const { day, hour } = zonedDayHour(now)
  for (const candidate of [...hours].sort((a, b) => a - b)) {
    if (candidate > hour) continue
    const slot = checkinSlotId(day, candidate)
    if (!fired.has(slot)) return slot
  }
  return undefined
}
