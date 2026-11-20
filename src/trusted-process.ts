import { realpathSync } from 'node:fs'
import { join } from 'node:path'

/** Resolve the OS directory from the kernel, never from an inherited variable. */
export function trustedSystemRootOf(): string | undefined {
  if (process.platform !== 'win32') return undefined
  try {
    return realpathSync.native('\\\\?\\GLOBALROOT\\SystemRoot')
  } catch {
    return undefined
  }
}

export function trustedWindowsPowerShell(): string | undefined {
  const systemRoot = trustedSystemRootOf()
  if (systemRoot === undefined) return undefined
  return join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/** Build a PowerShell environment with fixed executable and module search paths. */
export function trustedWindowsChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const systemRoot = trustedSystemRootOf()
  if (systemRoot === undefined) return {}
  const result: NodeJS.ProcessEnv = {}
  for (const name of ['TEMP', 'TMP']) {
    const value = env[name]
    if (value !== undefined && value !== '') result[name] = value
  }
  result.SystemRoot = systemRoot
  result.windir = systemRoot
  if (/^[A-Za-z]:\\/.test(systemRoot)) result.SystemDrive = systemRoot.slice(0, 2)
  result.PATH = join(systemRoot, 'System32')
  result.PSModulePath = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules')
  return result
}
