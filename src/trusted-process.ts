import { realpathSync } from 'node:fs'
import { join } from 'node:path'

interface TrustedEnvironmentOptions {
  inheritTemp?: boolean
  includeSystemDrive?: boolean
}

/** Resolve the OS directory without trusting inherited Windows environment variables. */
export function trustedSystemRootOf(env: NodeJS.ProcessEnv): string | undefined {
  if (process.platform === 'win32') {
    try {
      return realpathSync.native('\\\\?\\GLOBALROOT\\SystemRoot')
    } catch {
      return undefined
    }
  }
  const value = env['SystemRoot']?.trim() || env['windir']?.trim()
  return value === undefined || value === '' ? undefined : value
}

export function trustedWindowsPowerShell(env: NodeJS.ProcessEnv): string | undefined {
  const systemRoot = trustedSystemRootOf(env)
  if (systemRoot === undefined) return undefined
  return join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/** Build a PowerShell environment with fixed executable and module search paths. */
export function trustedWindowsChildEnv(
  env: NodeJS.ProcessEnv,
  options: TrustedEnvironmentOptions = {},
): NodeJS.ProcessEnv {
  const systemRoot = trustedSystemRootOf(env)
  if (systemRoot === undefined) return {}
  const result: NodeJS.ProcessEnv = {}
  if (options.inheritTemp === true) {
    for (const name of ['TEMP', 'TMP']) {
      const value = env[name]
      if (value !== undefined && value !== '') result[name] = value
    }
  }
  result.SystemRoot = systemRoot
  result.windir = systemRoot
  if (options.includeSystemDrive === true && /^[A-Za-z]:\\/.test(systemRoot)) {
    result.SystemDrive = systemRoot.slice(0, 2)
  }
  result.PATH = join(systemRoot, 'System32')
  result.PSModulePath = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules')
  return result
}
