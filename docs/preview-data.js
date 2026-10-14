/*
 * Demo data for the panel preview page (docs/index.html).
 *
 * Synthetic only - accounts, credits and model ids here are illustrative and
 * belong to nobody. The shapes follow what renderer/panel.js actually reads, so
 * the preview exercises the real component.
 */
(function () {
  const iso = (days) => new Date(Date.now() + days * 86400000).toISOString()
  const ms = (days) => Date.now() + days * 86400000

  const state = {
    sources: { workbuddy: true, trae: true, qoder: true },
    disabledRegions: [],
    pluginVersion: '1.0.2',
    unpublishedDeclarations: [],
    modelCap: 64,
    distribution: 'priority',
    showComposerPoints: true,
    autoCheckin: {
      enabled: true,
      hours: [9],
      last: {
        slot: '2026-10-10T09',
        claimed: 3,
        at: iso(-0.2),
        travel: { departed: 2, claimed: 2, adopted: 1 },
        growth: { streak: 1, tasks: 2, credit: 400, failed: 0 },
        qoder: { claimed: 1, skipped: 0, failed: 0 },
        trae: { claimed: 1, skipped: 0, failed: 0 },
      },
    },
    preferredAccountIds: { cn: 'wb-cn-1', global: '' },
    removedAccounts: [],
    declaration: { ok: true, changed: false, providerCount: 6 },
    addressDrift: false,
    shims: {
      cn: { running: true, baseUrl: 'http://127.0.0.1:42831/v1' },
      global: { running: true, baseUrl: 'http://127.0.0.1:42841/v1' },
    },
    warnings: {},
    staleSelectionRegions: [],
    refreshing: false,

    accounts: [
      {
        id: 'wb-cn-1',
        label: 'lin.cn@example.com',
        region: 'cn',
        domain: 'codebuddy.cn',
        expiresAt: iso(0.02),
        cooling: false,
        rateLimitHits: 0,
        active: true,
        preferred: true,
        disabled: false,
        creditReserve: 2000,
        credits: {
          total: 18320,
          expiringSoon: 1200,
          nearestExpiryMs: ms(2),
          packages: [
            { nameKey: 'credits.planQuota', remain: 14200, size: 20000, monthly: true, refreshAtMs: ms(21) },
            { nameKey: 'credits.addOnQuota', remain: 3200, size: 3200, roundExpiresAtMs: ms(2) },
          ],
        },
        checkin: {
          active: true,
          todayCheckedIn: false,
          streakDays: 12,
          dailyCredit: 20,
          todayCredit: 0,
          isStreakDay: false,
          nextStreakDay: 14,
          streakBonusCredit: 100,
        },
      },
      {
        id: 'wb-cn-2',
        label: 'du.cn@example.com',
        region: 'cn',
        domain: 'codebuddy.cn',
        expiresAt: iso(4),
        cooling: false,
        rateLimitHits: 1,
        active: false,
        preferred: false,
        disabled: false,
        credits: {
          total: 4100,
          packages: [
            { nameKey: 'credits.planQuota', remain: 4100, size: 8000, monthly: true, refreshAtMs: ms(12) },
          ],
        },
        checkin: { active: true, todayCheckedIn: true, todayCredit: 20, streakDays: 5, dailyCredit: 20 },
      },
      {
        id: 'wb-cn-3',
        label: 'wu.cn@example.com',
        region: 'cn',
        domain: 'codebuddy.cn',
        expiresAt: iso(6),
        cooling: true,
        cooldownUntil: new Date(Date.now() + 9 * 60000).toISOString(),
        modelCooldowns: [{ modelId: 'claude-sonnet-4.5', until: new Date(Date.now() + 5 * 60000).toISOString() }],
        rateLimitHits: 4,
        active: false,
        preferred: false,
        disabled: false,
        credits: { total: 980, packages: [{ packageName: 'Top-up', remain: 980, size: 1000, validDays: 30 }] },
        checkin: { active: true, todayCheckedIn: false, streakDays: 3, dailyCredit: 20, todayCredit: 0 },
      },
      {
        id: 'wb-global-1',
        label: 'lin.intl@example.com',
        region: 'global',
        domain: 'workbuddy.ai',
        expiresAt: iso(9),
        cooling: false,
        rateLimitHits: 0,
        active: true,
        preferred: false,
        disabled: false,
        credits: {
          total: 6400,
          packages: [{ nameKey: 'credits.planQuota', remain: 6400, size: 10000, monthly: true, refreshAtMs: ms(17) }],
        },
        checkin: { active: true, todayCheckedIn: false, streakDays: 2, dailyCredit: 20, todayCredit: 0 },
      },
    ],

    models: [
      {
        id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5', alias: 'sonnet', region: 'cn', multiplier: 1,
        supportsImages: true, contextWindow: 200000, maxOutputTokens: 32000,
        nativeContextWindow: 200000, nativeMaxOutputTokens: 32000, nativeSupportsImages: true,
        nativeThinkingLevels: ['off', 'low', 'medium', 'high'], advanced: true,
      },
      {
        id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', alias: 'gemini', region: 'cn', multiplier: 0.5,
        supportsImages: true, contextWindow: 1000000, maxOutputTokens: 64000,
        nativeContextWindow: 1000000, nativeMaxOutputTokens: 64000, nativeSupportsImages: true,
        nativeThinkingLevels: ['off', 'low', 'medium', 'high'], advanced: false,
      },
      {
        id: 'gpt-5.1-codex', name: 'GPT-5.1 Codex', region: 'cn', multiplier: 0,
        promo: { kind: 'night', untilHour: 6 },
        supportsImages: false, contextWindow: 400000, maxOutputTokens: 128000,
        nativeContextWindow: 400000, nativeMaxOutputTokens: 128000, nativeSupportsImages: false,
        nativeThinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'], advanced: false,
      },
      {
        id: 'kimi-k2-thinking', name: 'Kimi K2 Thinking', alias: 'kimi', region: 'cn', multiplier: 0.2,
        supportsImages: false, contextWindow: 256000, maxOutputTokens: 32000,
        nativeContextWindow: 256000, nativeMaxOutputTokens: 32000, nativeSupportsImages: false,
        nativeThinkingLevels: ['off', 'low', 'medium', 'high'], advanced: true,
      },
      {
        id: 'deepseek-v3.2', name: 'DeepSeek V3.2', region: 'cn', multiplier: 0.15,
        supportsImages: false, contextWindow: 128000, maxOutputTokens: 16000,
        nativeContextWindow: 128000, nativeMaxOutputTokens: 16000, nativeSupportsImages: false,
        nativeThinkingLevels: [], advanced: false,
      },
      {
        id: 'glm-4.6', name: 'GLM-4.6', region: 'cn', multiplier: 0,
        promo: { kind: 'night-later', nextHour: 22 },
        supportsImages: true, contextWindow: 200000, maxOutputTokens: 32000,
        nativeContextWindow: 200000, nativeMaxOutputTokens: 32000, nativeSupportsImages: true,
        nativeThinkingLevels: ['off', 'low', 'medium', 'high'], advanced: false,
      },
      {
        id: 'claude-opus-4.1', name: 'Claude Opus 4.1', region: 'global', multiplier: 3,
        supportsImages: true, contextWindow: 200000, maxOutputTokens: 32000,
        nativeContextWindow: 200000, nativeMaxOutputTokens: 32000, nativeSupportsImages: true,
        nativeThinkingLevels: ['off', 'low', 'medium', 'high'], advanced: false,
      },
      {
        id: 'gpt-5.1', name: 'GPT-5.1', alias: 'gpt', region: 'global', multiplier: 1,
        supportsImages: true, contextWindow: 400000, maxOutputTokens: 128000,
        nativeContextWindow: 400000, nativeMaxOutputTokens: 128000, nativeSupportsImages: true,
        nativeThinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'], advanced: false,
      },
    ],

    selectionByRegion: {
      cn: {
        enabledModelIds: ['claude-sonnet-4.5', 'gemini-2.5-pro', 'gpt-5.1-codex', 'kimi-k2-thinking', 'glm-4.6'],
        overrides: {
          'claude-sonnet-4.5': {
            alias: 'sonnet', contextWindow: 312000, maxOutputTokens: 32000, supportsImages: true,
            thinkingLevels: ['off', 'medium', 'high'], defaultThinkingLevel: 'medium',
          },
          'gemini-2.5-pro': { alias: 'gemini' },
        },
      },
      global: {
        enabledModelIds: ['gpt-5.1'],
        overrides: {},
      },
    },

    trae: {
      distribution: 'round-robin',
      preferred: { cn: '', ai: '' },
      accounts: [
        {
          label: 'Trae CN', region: 'cn', app: 'Trae CN', email: 'lin.cn@example.com',
          expiresAt: ms(3), expired: false,
          usage: {
            credits: {
              total: 1200, nearestExpiryMs: ms(2),
              packages: [
                { packageName: 'daily', remain: 200, size: 200, roundExpiresAtMs: ms(2) },
                { packageName: 'monthly', remain: 1000, size: 5000, monthly: true, refreshAtMs: ms(15) },
              ],
            },
          },
          checkin: { active: true, todayCheckedIn: false, deviceCheckedIn: false, amount: 100, unit: 'credits' },
        },
        {
          label: 'Trae International', region: 'ai', app: 'Trae', email: 'lin.intl@example.com',
          expiresAt: ms(8), expired: false,
          usage: { plan: { name: 'Pro', inTrial: false } },
          checkin: { active: false, todayCheckedIn: false, deviceCheckedIn: false },
        },
      ],
      gateways: [
        {
          region: 'cn', port: 42851, models: 2, portFallback: false, lastError: '',
          roster: [
            { id: 'deepseek-v3.2', name: 'DeepSeek V3.2', alias: '', nativeContextWindow: 128000,
              nativeMaxOutputTokens: 16000, nativeSupportsImages: false, nativeThinkingLevels: [], advanced: false },
            { id: 'doubao-seed-1.6', name: 'Doubao Seed 1.6', alias: 'doubao', nativeContextWindow: 256000,
              nativeMaxOutputTokens: 32000, nativeSupportsImages: true, nativeThinkingLevels: ['off', 'low', 'medium', 'high'], advanced: true },
            { id: 'kimi-k2-thinking', name: 'Kimi K2 Thinking', alias: '', nativeContextWindow: 256000,
              nativeMaxOutputTokens: 32000, nativeSupportsImages: false, nativeThinkingLevels: ['off', 'low', 'medium', 'high'], advanced: false },
          ],
          selection: { enabledModelIds: ['deepseek-v3.2', 'doubao-seed-1.6'], overrides: { 'doubao-seed-1.6': { alias: 'doubao' } } },
        },
        {
          region: 'ai', port: 42861, models: 1, portFallback: false, lastError: '',
          roster: [
            { id: 'gpt-5.1', name: 'GPT-5.1', alias: '', nativeContextWindow: 400000,
              nativeMaxOutputTokens: 128000, nativeSupportsImages: true, nativeThinkingLevels: [], advanced: false },
          ],
          selection: { enabledModelIds: ['gpt-5.1'], overrides: {} },
        },
      ],
    },

    qoder: {
      distribution: 'expiry',
      preferred: { cn: '', global: '' },
      accounts: [
        {
          label: 'Qoder CN', region: 'cn', expiresAt: ms(11), expired: false,
          usage: {
            credits: {
              total: 500,
              packages: [
                { nameKey: 'credits.planQuota', remain: 500, size: 500, neverExpires: true },
                { nameKey: 'credits.addOnQuota', remain: 0, size: 0, validDays: 30 },
              ],
            },
          },
          checkin: { active: true, todayCheckedIn: true, amount: 50, unit: 'credits' },
        },
        {
          label: 'Qoder Global', region: 'global', expiresAt: ms(5), expired: false,
          usage: { plan: { name: 'Trial', inTrial: true } },
          checkin: { active: true, todayCheckedIn: false, opensAtHour: 10, amount: 50, unit: 'credits' },
        },
      ],
      gateways: [
        {
          region: 'cn', port: 42871, models: 1, portFallback: false, lastError: '',
          roster: [
            { id: 'qwen3-coder-plus', name: 'Qwen3 Coder Plus', alias: '', nativeContextWindow: 128000,
              nativeMaxOutputTokens: 32000, nativeSupportsImages: false, nativeThinkingLevels: [], advanced: false },
            { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5', alias: '', nativeContextWindow: 200000,
              nativeMaxOutputTokens: 32000, nativeSupportsImages: true, nativeThinkingLevels: ['off', 'low', 'medium', 'high'], advanced: false },
          ],
          selection: { enabledModelIds: ['qwen3-coder-plus'], overrides: {} },
        },
        {
          region: 'global', port: 42881, models: 1, portFallback: false, lastError: '',
          roster: [
            { id: 'gpt-5.1', name: 'GPT-5.1', alias: '', nativeContextWindow: 400000,
              nativeMaxOutputTokens: 128000, nativeSupportsImages: true, nativeThinkingLevels: [], advanced: false },
          ],
          selection: { enabledModelIds: ['gpt-5.1'], overrides: {} },
        },
      ],
    },
  }

  // The check view fills only from `xd.doctor`, never from `xd.state`.
  const doctor = {
    ok: true,
    // Every id and detail below is the shape `doctor()` emits: the provider
    // label comes from PROVIDER_NAME_BY_REGION, and each count is the number
    // this file's own `models`/`selection` data would actually declare.
    findings: [
      { id: 'plugin-enabled', ok: true, detail: 'enabled' },
      { id: 'source-workbuddy', ok: true, detail: 'on' },
      { id: 'source-trae', ok: true, detail: 'on; 2 account(s) (cn x1, ai x1); serving cn: 2 model(s), ai: 1 model(s)' },
      { id: 'source-qoder', ok: true, detail: 'on; 2 account(s) (cn x1, global x1); serving cn: 1 model(s), global: 1 model(s)' },
      { id: 'accounts', ok: true, detail: '4 account(s): lin.cn@example.com, du.cn@example.com, wu.cn@example.com, lin.intl@example.com' },
      { id: 'rotation', ok: true, detail: '3 of 4 account(s) can serve a request now' },
      { id: 'host-registered-providers', ok: true, detail: 'the host is serving every provider this plugin declares' },
      { id: 'WTQ Pool (CN): endpoint', ok: true, detail: 'listening on http://127.0.0.1:42831/v1' },
      { id: 'WTQ Pool (CN): models', ok: true, detail: '6 model(s) in the catalog' },
      { id: 'WTQ Pool (CN): declared', ok: true, detail: 'registered with the running host' },
      { id: 'WTQ Pool (Global): endpoint', ok: true, detail: 'listening on http://127.0.0.1:42841/v1' },
      { id: 'WTQ Pool (Global): models', ok: true, detail: '2 model(s) in the catalog' },
      { id: 'WTQ Pool (Global): declared', ok: true, detail: 'registered with the running host' },
      { id: 'WTQ Pool (CN): published address', ok: true, detail: 'matches the endpoint this gateway bound (http://127.0.0.1:42831/v1)' },
      { id: 'WTQ Pool (Global): published address', ok: true, detail: 'matches the endpoint this gateway bound (http://127.0.0.1:42841/v1)' },
      { id: 'WTQ Pool Trae (CN): published address', ok: true, detail: 'matches the endpoint this gateway bound (http://127.0.0.1:42851/v1)' },
      { id: 'WTQ Pool Trae (Global): published address', ok: true, detail: 'matches the endpoint this gateway bound (http://127.0.0.1:42861/v1)' },
      { id: 'WTQ Pool Qoder (CN): published address', ok: true, detail: 'matches the endpoint this gateway bound (http://127.0.0.1:42871/v1)' },
      { id: 'WTQ Pool Qoder (Global): published address', ok: true, detail: 'matches the endpoint this gateway bound (http://127.0.0.1:42881/v1)' },
      { id: 'declaration-written', ok: true, detail: 'up to date' },
    ],
  }

  doctor.report = [
    'WTQ Pool doctor',
    new Date().toISOString(),
    'overall: PASS',
    '',
    ...doctor.findings.map((f) => (f.ok ? 'PASS  ' : 'FAIL  ') + f.id + ' - ' + f.detail),
    '',
  ].join('\n')

  const api = { state, doctor }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  if (typeof window !== 'undefined') window.__previewData = api
})();
