import { defineConfig } from 'tsdown'

const PLUGIN_ID = 'dsh-wtq-pool'

/**
 * Browser-only packages the host supplies at runtime through
 * `window.__ModuleLoader__`. The client bundle must never bundle these: the
 * loader `require`s them against the host's own registry, and bundling
 * `react`/`react-dom` would inline a build that opens with a `process.env`
 * check and throws at module-evaluation time in the browser.
 */
const CLIENT_EXTERNALS = [
  'react',
  'react-dom',
  'react/jsx-runtime',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-locale/client',
  '@deepseek-ai/dsh-client-ui-settings/client',
  '@deepseek-ai/dsh-client-ui-settings-plugins/client',
  '@deepseek-ai/dsh-client-ui-primitives',
] as const

/** Host-side packages the running harness provides; never bundle these. */
const HOST_EXTERNALS = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-llm-pi-ai',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/schemastery',
  '@earendil-works/pi-ai',
] as const

export default defineConfig([
  {
    // The host half: one Cordis entry the loader mounts.
    entry: ['src/index.ts'],
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'node22',
    dts: true,
    outExtensions: () => ({ js: '.js' }),
    clean: true,
    sourcemap: false,
    deps: { neverBundle: [...HOST_EXTERNALS] },
  },
  {
    // The browser half: a CJS bundle that registers itself with the host's
    // module loader. `platform: 'neutral'` fits that loader's context, which
    // assumes no particular runtime globals beyond `window`.
    entry: ['src/client/index.tsx'],
    outDir: 'lib',
    format: 'cjs',
    platform: 'neutral',
    dts: false,
    clean: false,
    outExtensions: () => ({ js: '.js' }),
    sourcemap: false,
    deps: { neverBundle: [...CLIENT_EXTERNALS] },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
