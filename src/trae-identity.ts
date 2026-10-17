/**
 * Trae request identity.
 *
 * The header builder in `trae-upstream.ts` needs a `TraeIdentity`; this is
 * the only thing that produces one. Every field comes from an identifier the
 * Trae apps themselves persist — nothing here fabricates a per-request id, and
 * a machine with no stable identity fails loudly instead of sending an invented
 * one.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { cpus, homedir, hostname, release } from 'node:os'
import { dirname, join } from 'node:path'
import type { TraeEdition, TraeStorageCandidate } from './trae-discovery'
import { traeMacAppName, traeWindowsAppNames } from './trae-discovery'
import type { TraeIdentity } from './trae-upstream'

const TRAE_DEVICE_CENTER_PREFIX = 'iCubeAuthInfo://icube-dc:'
/** Prefix of the "no candidate exists on disk" error; see {@link resolveTraeIdentity}. */
export const TRAE_STORAGE_MISSING_PREFIX = 'Trae storage was not found'

export interface TraeIdentityReadOptions {
  /** Platform override for testing; defaults to process.platform. */
  platform?: NodeJS.Platform
  /** Home-directory override for testing; defaults to homedir(). */
  home?: string
  /** Environment override for testing; defaults to process.env. */
  env?: NodeJS.ProcessEnv
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function osVersionOf(platform: NodeJS.Platform): string {
  return `${platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : platform} ${release()}`
}

function deviceCpuOf(): string | undefined {
  return nonEmpty(cpus()[0]?.model.split(' ')[0])
}

/** `x-device-id` when exactly one device-center id is persisted. */
export function traeDeviceCenterId(storage: Record<string, unknown>): string | undefined {
  const ids = Object.keys(storage)
    .filter(key => key.startsWith(TRAE_DEVICE_CENTER_PREFIX))
    .map(key => key.slice(TRAE_DEVICE_CENTER_PREFIX.length))
    .filter(Boolean)
  return ids.length === 1 ? ids[0] : undefined
}

async function readJsonFile(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

/**
 * `product.json` paths for one edition. On macOS the file sits inside the
 * `.app` bundle; on Windows under `%LOCALAPPDATA%\Programs\<install dir>\
 * resources\app`, where the directory name is the installer's choice — hence
 * the same spelling list the credential scanner uses. Product/version is a
 * display nicety, so every candidate is tried in order and absence is skipped
 * rather than failing identity resolution.
 */
function productJsonPaths(
  edition: TraeEdition,
  options: Required<Pick<TraeIdentityReadOptions, 'platform' | 'home' | 'env'>>,
): string[] {
  const appName = traeMacAppName(edition)
  if (options.platform === 'darwin') {
    return [join('/Applications', `${appName}.app`, 'Contents', 'Resources', 'app', 'product.json')]
  }
  if (options.platform !== 'win32') return []
  const localRoots = [options.env.LOCALAPPDATA, join(options.home, 'AppData', 'Local')]
    .filter((value): value is string => typeof value === 'string' && value !== '')
    .filter((value, index, all) => all.indexOf(value) === index)
  return localRoots.flatMap(root =>
    traeWindowsAppNames(edition).map(spelling =>
      join(root, 'Programs', spelling, 'resources', 'app', 'product.json')))
}

/** Read stable identity from Trae-owned files without generating impersonated IDs. */
export async function readTraeIdentity(
  candidate: TraeStorageCandidate,
  options: TraeIdentityReadOptions = {},
): Promise<TraeIdentity> {
  const resolved = {
    platform: options.platform ?? process.platform,
    home: options.home ?? homedir(),
    env: options.env ?? process.env,
  }
  let storage: Record<string, unknown>
  try {
    const parsed = JSON.parse(await readFile(candidate.path, 'utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not an object')
    }
    storage = parsed as Record<string, unknown>
  } catch (error: unknown) {
    // A truncated or emptied file reads as `null` or a bare value, which used to
    // surface as a TypeError about reading a property of null. A missing file
    // must still pass through as one: the caller tells a machine with no Trae
    // install from a machine whose install will not parse.
    if (isFileMissing(error)) throw error
    throw new Error(`Trae ${candidate.edition} storage is not a JSON object`)
  }
  // storage.json lives at <appRoot>/User/globalStorage/, and `machineid` sits
  // three levels up in the install's own app root.
  const machineFile = nonEmpty(await readFile(join(dirname(dirname(dirname(candidate.path))), 'machineid'), 'utf8').catch(() => ''))
  const telemetryMachine = nonEmpty(storage['telemetry.machineId'])
  const machineId = telemetryMachine ?? machineFile
  if (machineId === undefined) throw new Error(`Trae ${candidate.edition} has no stable machine identity`)
  // The numeric suffix of iCubeAuthInfo://icube-dc:<id> exactly matches the
  // x-device-id the official clients send; telemetry remains the fallback.
  const centerId = traeDeviceCenterId(storage)
  const deviceId = centerId
    ?? nonEmpty(storage['telemetry.devDeviceId'])
    ?? createHash('sha256').update(machineId).digest('hex').slice(0, 32)
  const buildVersion = nonEmpty(storage['iCubeLastVersion'])
  let product: Record<string, unknown> = {}
  for (const path of productJsonPaths(candidate.edition, resolved)) {
    product = await readJsonFile(path) ?? {}
    if (Object.keys(product).length > 0) break
  }
  const appVersion = nonEmpty(product['appVersion'])
  const deviceBrand = resolved.platform === 'darwin' ? nonEmpty(resolved.env['TRAE_DEVICE_BRAND']) : undefined
  const deviceCpu = deviceCpuOf()
  return {
    machineId,
    deviceId,
    ...centerId === undefined ? { deviceIdIsFallback: true } : {},
    ...appVersion === undefined ? {} : { appVersion },
    ...buildVersion === undefined ? {} : { buildVersion },
    ...deviceBrand === undefined ? {} : { deviceBrand },
    ...deviceCpu === undefined ? {} : { deviceCpu },
    osVersion: osVersionOf(resolved.platform),
    platform: resolved.platform,
  }
}

/** Detect a missing storage file (as opposed to a parse/identity error). */
function isFileMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT'
}

/**
 * Try candidates of one edition in order and return the first valid identity;
 * fail only when none work. Mirrors the credential scanner's skip-missing
 * semantics, so a machine with only SOLO (no CN install) resolves instead of
 * pinning the first candidate onto a file that is not there. When every
 * candidate is absent the error says how many were checked - never where they
 * were: this message reaches the panel and the log, and an install path is not
 * the user's business. A candidate that exists but fails to parse surfaces its
 * own error.
 *
 * `edition` is required, not decoration: the candidates arrive as one list for
 * every edition and are ordered CN first, so an unfiltered walk hands an
 * international sign-in the CN install's `machineId`, `deviceId` and
 * `buildVersion`. Those go out as the request identity, which is a different
 * machine as far as the upstream is concerned.
 */
export async function pickTraeStorageIdentity(
  candidates: readonly TraeStorageCandidate[],
  edition: TraeEdition,
  options: TraeIdentityReadOptions = {},
): Promise<TraeIdentity> {
  const mine = candidates.filter(candidate => candidate.edition === edition)
  let lastError: unknown
  let anyPresent = false
  for (const candidate of mine) {
    try {
      return await readTraeIdentity(candidate, options)
    } catch (error) {
      if (!isFileMissing(error)) {
        lastError = error
        anyPresent = true
      }
    }
  }
  // The count, not the paths: see the note above.
  const where = `${edition} desktop location(s)` + (mine.length === 0 ? ' (none scanned)' : `, ${mine.length} checked`)
  if (!anyPresent) throw new Error(`${TRAE_STORAGE_MISSING_PREFIX} (${where})`)
  const code = typeof lastError === 'object' && lastError !== null && 'code' in lastError
    && typeof lastError.code === 'string' ? lastError.code : 'invalid storage'
  throw new Error(`Trae identity could not be resolved (${where}; ${code})`)
}

/** CLI dotfile home per edition; the CLI keeps its own home, not an app-support entry. */
const CLI_HOME_BY_EDITION: Readonly<Record<TraeEdition, string>> = {
  cn: '.trae-cn',
  solo: '.trae-cn',
  sg: '.trae',
  'solo-sg': '.trae',
}

/**
 * Deterministic identity for a machine that only has the Trae CLI.
 *
 * A CLI-only machine has no desktop `storage.json`, yet the headers still need
 * stable machine/device ids. Everything here comes from identifiers the CLI
 * itself persists (never a per-request random value): `argv.json`'s
 * `crash-reporter-id`, `builtin/ide_version.json`'s `version`, and SHA-256 over
 * those plus the host for the 64-char machine id the official clients send.
 * With no CLI home either, it keeps failing loudly — a fabricated identity is
 * worse than a visible "not signed in".
 */
export async function readTraeCliIdentity(
  edition: TraeEdition,
  options: TraeIdentityReadOptions = {},
): Promise<TraeIdentity> {
  const platform = options.platform ?? process.platform
  const home = options.home ?? homedir()
  const env = options.env ?? process.env
  const cliHome = join(home, CLI_HOME_BY_EDITION[edition])
  const argv = await readJsonFile(join(cliHome, 'argv.json'))
  const version = await readJsonFile(join(cliHome, 'builtin', 'ide_version.json'))
  if (argv === undefined && version === undefined) {
    throw new Error('Trae CLI identity was not found (its home holds neither argv.json nor ide_version.json)')
  }
  const crashReporterId = nonEmpty(argv?.['crash-reporter-id'])
  const hostName = nonEmpty(hostname()) ?? 'unknown-host'
  const user = nonEmpty(env['USERNAME']) ?? nonEmpty(env['USER']) ?? 'unknown-user'
  const deviceId = crashReporterId ?? createHash('sha256').update(`trae-cli\0${hostName}\0${user}`).digest('hex').slice(0, 32)
  const machineId = createHash('sha256').update(`trae-cli-machine\0${deviceId}\0${hostName}`).digest('hex')
  const appVersion = nonEmpty(version?.['version'])
  const deviceCpu = deviceCpuOf()
  return {
    machineId,
    deviceId,
    ...appVersion === undefined ? {} : { appVersion },
    ...deviceCpu === undefined ? {} : { deviceCpu },
    osVersion: osVersionOf(platform),
    platform,
  }
}

/**
 * Resolve the request identity for one edition: the desktop storage identity
 * when any desktop install exists, otherwise the CLI home's deterministic
 * identity. This is the seam a CLI-only machine needs — it writes its token to
 * `~/.trae-cn/trae-jwt-token` and no `storage.json` exists anywhere.
 */
export async function resolveTraeIdentity(
  candidates: readonly TraeStorageCandidate[],
  edition: TraeEdition,
  options: TraeIdentityReadOptions = {},
): Promise<TraeIdentity> {
  try {
    return await pickTraeStorageIdentity(candidates, edition, options)
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith(TRAE_STORAGE_MISSING_PREFIX)) throw error
    return readTraeCliIdentity(edition, options)
  }
}
