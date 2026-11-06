const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')
const ts = require('typescript')

test('WorkBuddy key retrieval does not inherit host runtime variables', async () => {
  const temporary = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'wtq-child-'))
  const preload = path.join(temporary, 'preload.cjs')
  const marker = path.join(temporary, 'executed')
  fs.writeFileSync(preload, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`)
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^NODE_/i.test(name)))
  env.nOdE_pAtH = temporary
  env.electron_run_as_node = '0'
  env.COR_ENABLE_PROFILING = '1'
  env.COR_PROFILER_PATH = path.join(temporary, 'profiler.dll')
  env.LD_PRELOAD = path.join(temporary, 'preload.so')
  env.DYLD_INSERT_LIBRARIES = path.join(temporary, 'preload.dylib')
  env.SystemRoot = 'C:\\fixture-root'
  env.SYSTEMROOT = 'C:\\injected-root'
  env.windir = 'C:\\fixture-root'
  env.WINDIR = 'C:\\injected-root'
  env.SystemDrive = 'Q:'
  env.SYSTEMDRIVE = 'R:'
  env.PATH = 'C:\\fixture-bin'
  env.Path = 'C:\\injected-bin'
  env.PSModulePath = 'C:\\fixture-modules'
  env.PSMODULEPATH = 'C:\\injected-modules'
  env.WTQ_FIXTURE = 'retained'
  const source = fs.readFileSync(path.join(__dirname, '../src/at-rest.ts'), 'utf8')
  const compiled = ts.transpileModule(`${source}\nexport { fetchAtRestKeyPayload }`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
  }).outputText
  const context = vm.createContext({
    module: { exports: {} }, exports: {}, Buffer,
    process: { platform: process.platform, env },
    require: name => name === 'node:child_process' ? {
      execFile: (_executable, _args, options, callback) => execFile(process.execPath, ['-e',
        'process.stdout.write(JSON.stringify({atRestSecretKey:"fixture",cwd:process.cwd(),environment:Object.keys(process.env).sort(),mode:process.env.ELECTRON_RUN_AS_NODE,systemRoot:process.env.SystemRoot,windir:process.env.windir,path:process.env.PATH,psModulePath:process.env.PSModulePath}))',
      ], options, callback),
    } : require(name),
  })
  context.exports = context.module.exports
  vm.runInContext(compiled, context)
  try {
    for (const name of ['NODE_OPTIONS', 'nOdE_OpTiOnS']) {
      env[name] = `--require=${JSON.stringify(preload)}`
      const payload = JSON.parse(await context.module.exports.fetchAtRestKeyPayload(process.execPath))
      delete env[name]
      assert.equal(payload.atRestSecretKey, 'fixture')
      assert.equal(fs.existsSync(marker), false, 'an inherited preload ran before the key reader')
      assert.equal(payload.mode, '1')
      assert.equal(payload.environment.some(name => /^(NODE_|COR_|LD_PRELOAD$|DYLD_)/i.test(name)), false)
      assert.equal(payload.environment.includes('WTQ_FIXTURE'), false)
      const trustedRoot = process.platform === 'win32' ? fs.realpathSync.native('\\\\?\\GLOBALROOT\\SystemRoot') : undefined
      const trustedDirectory = trustedRoot === undefined ? '/' : path.join(trustedRoot, 'System32')
      assert.equal(payload.cwd.toLowerCase(), trustedDirectory.toLowerCase())
      if (trustedRoot !== undefined) {
        assert.equal(payload.systemRoot, trustedRoot)
        assert.equal(payload.windir, trustedRoot)
        assert.equal(payload.path, path.join(trustedRoot, 'System32'))
        assert.equal(payload.psModulePath, path.join(trustedRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'))
        assert.equal(payload.environment.includes('SYSTEMROOT'), false)
        assert.equal(payload.environment.includes('WINDIR'), false)
        assert.equal(payload.environment.includes('SYSTEMDRIVE'), false)
        assert.equal(payload.environment.includes('Path'), false)
        assert.equal(payload.environment.includes('PSMODULEPATH'), false)
      }
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

test('Qoder DPAPI resets PowerShell module search before loading a type', { skip: process.platform !== 'win32' }, async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/qoder-credentials.ts'), 'utf8')
  const marker = 'const DPAPI_SCRIPT = `'
  const start = source.indexOf(marker)
  const reset = "$env:PSModulePath=[IO.Path]::Combine($env:SystemRoot,'System32\\\\WindowsPowerShell\\\\v1.0\\\\Modules')"
  const resetIndex = source.indexOf(reset, start)
  const addTypeIndex = source.indexOf('Add-Type', start)
  assert.notEqual(start, -1)
  assert.notEqual(resetIndex, -1, 'the script must reset PSModulePath itself')
  assert.equal(resetIndex < addTypeIndex, true, 'the reset must run before Add-Type')

  const scriptEnd = source.indexOf('`', start + marker.length)
  const prefix = source.slice(start + marker.length, resetIndex + reset.length)
  const runtimePrefix = prefix.replaceAll('\\\\', '\\')
  const trustedRoot = fs.realpathSync.native('\\\\?\\GLOBALROOT\\SystemRoot')
  const powershell = path.join(trustedRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const output = await new Promise((resolve, reject) => {
    execFile(powershell, ['-NoProfile', '-NonInteractive', '-Command',
      `${runtimePrefix}\n[Console]::Out.Write($env:PSModulePath)`], {
      env: {
        SystemRoot: trustedRoot,
        windir: trustedRoot,
        PATH: path.join(trustedRoot, 'System32'),
        PSModulePath: path.join(trustedRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
      },
      windowsHide: true,
    }, (error, stdout) => error === null ? resolve(stdout) : reject(error))
  })
  assert.equal(output.trim(), path.join(trustedRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'))
  assert.notEqual(scriptEnd, -1)
})

test('fixed-volume PowerShell pins its module path before invoking cmdlets', { skip: process.platform !== 'win32' }, () => {
  const trustedRoot = fs.realpathSync.native('\\\\?\\GLOBALROOT\\SystemRoot')
  const env = { SystemRoot: trustedRoot, windir: trustedRoot }
  const source = fs.readFileSync(path.join(__dirname, '../src/at-rest.ts'), 'utf8')
  const compiled = ts.transpileModule(`${source}\nexport { fixedWindowsPaths }`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
  }).outputText
  let script = ''
  let calls = 0
  const context = vm.createContext({
    module: { exports: {} }, exports: {}, Buffer,
    process: { platform: 'win32', env },
    require: name => name === 'node:child_process' ? {
      execFileSync: (_executable, args) => {
        calls += 1
        script = args[args.indexOf('-Command') + 1]
        return JSON.stringify([path.parse(trustedRoot).root.toUpperCase()])
      },
    } : require(name),
  })
  context.exports = context.module.exports
  vm.runInContext(compiled, context)

  // A candidate on the system volume needs no volume query at all: the install
  // lives there on virtually every machine, and the host waits on this process.
  const onSystem = path.join(trustedRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  assert.deepEqual(context.module.exports.fixedWindowsPaths([onSystem]), [onSystem])
  assert.equal(calls, 0, 'a system-volume candidate must not cost a PowerShell spawn')

  // One on another drive is what the query exists for, and that script still
  // pins its module path before any cmdlet runs.
  const other = 'Z:\\WorkBuddy.exe'
  assert.deepEqual(context.module.exports.fixedWindowsPaths([other]), [])
  assert.equal(calls, 1, 'only the other volume is asked about')
  const firstCommand = script.split(/\r?\n/u).find(line => line.trim() !== '')
  assert.match(firstCommand, /^\$env:PSModulePath=/u, 'module lookup must be reset before any cmdlet runs')
})
