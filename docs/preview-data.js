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
    unpublishedDeclarations: [],
    modelCap: 64,
    distribution: 'priority',
    showComposerPoints: true,
    autoCheckin: {
      enabled: true,
      hours: [9],
      last: {
        slot: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }) + 'T09',
        claimed: 3,
        at: iso(-0.2),
        travel: { departed: 2, claimed: 2, failed: 0, credit: 18 },
        growth: {
          streak: 1, credit: 128, failed: 0,
          detail: { accounts: 4, makeup: 1, activity: 4, streak: 1, lottery: 2, failed: 0 },
        },
        qoder: { claimed: 1, skipped: 0, failed: 0 },
        trae: { claimed: 1, skipped: 0, failed: 0 },
      },
    },
    // The keep-alive is a duty of its own, reported on its own card: what its
    // last run did and when. It sits beside the check-in in the status document
    // rather than inside it, the same way the panel draws it.
    keepAlive: {
      at: iso(-0.05),
      refreshed: 2,
      fresh: 3,
      failed: 0,
      noToken: 0,
    },
    // A completed growth read, so the centre shows its figures instead of
    // asking the reader to press "read" in a still screenshot.
    growth: {
      readEpoch: 0,
      read: {
        readAt: Date.now(),
        accounts: 5,
        failed: 0,
        rows: [
          { id: 'wb-cn-1', label: 'lin.cn@example.com', region: 'cn', makeupCards: 2, lottery: 1 },
          { id: 'wb-cn-2', label: 'du.cn@example.com', region: 'cn', makeupCards: 0, lottery: 1 },
          { id: 'wb-cn-3', label: 'wu.cn@example.com', region: 'cn', makeupCards: 1, lottery: 0 },
          { id: 'wb-cn-4', label: 'qi.cn@example.com', region: 'cn', makeupCards: 0, lottery: 0, failed: true },
          { id: 'wb-global-1', label: 'lin.ai@example.com', region: 'global', makeupCards: 1, lottery: 0 },
        ],
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
        // Signed in from the panel rather than the desktop app: this is what
        // draws the delete action beside the switch.
        own: true,
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
        expiresAt: iso(6),
        cooling: true,
        cooldownUntil: new Date(Date.now() + 9 * 60000).toISOString(),
        modelCooldowns: [{ modelId: 'deepseek-v4.1-flash', until: new Date(Date.now() + 5 * 60000).toISOString() }],
        rateLimitHits: 4,
        active: false,
        preferred: false,
        disabled: false,
        credits: { total: 980, packages: [{ packageName: 'Top-up', remain: 980, size: 1000, validDays: 30 }] },
        checkin: { active: true, todayCheckedIn: false, streakDays: 3, dailyCredit: 20, todayCredit: 0 },
      },
      {
        id: 'wb-cn-4',
        label: 'qi.cn@example.com',
        region: 'cn',
        // A sign-in the upstream refused. Its own expiry still reads as weeks
        // away: the upstream revokes the session without rewriting the token's
        // expiry, so the refusal stays invisible until a read spends an upstream
        // call on it.
        expiresAt: iso(12),
        cooling: true,
        cooldownUntil: new Date(Date.now() + 6 * 3600 * 1000).toISOString(),
        // What the panel renders the row from: the refused sign-in, and the
        // hold that stops every pass from paying for it again.
        hold: 'session',
        rateLimitHits: 1,
        active: false,
        preferred: false,
        disabled: false,
        // No credits and no check-in state: the reads that would fill them are
        // the ones the hold stands in front of.
      },
      {
        id: 'wb-global-1',
        label: 'lin.intl@example.com',
        region: 'global',
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
        checkin: { active: false, todayCheckedIn: false, streakDays: 0, dailyCredit: 100, todayCredit: 0 },
      },
    ],

    models: [
      {
        id: 'hy4flash-free', name: 'Hy4 Flash Free', region: 'cn', multiplier: 0,
        supportsImages: true, contextWindow: 200000, maxOutputTokens: 128000,
        nativeContextWindow: 200000, nativeMaxOutputTokens: 128000, nativeSupportsImages: true,
        nativeThinkingLevels: ['off', 'low', 'medium', 'high', 'max'], advanced: false,
      },
      {
        id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', region: 'cn', multiplier: 0.15,
        supportsImages: false, contextWindow: 200000, maxOutputTokens: 128000,
        nativeContextWindow: 200000, nativeMaxOutputTokens: 128000, nativeSupportsImages: false,
        nativeThinkingLevels: ['off', 'low', 'medium', 'high', 'max'], advanced: true,
      },
      {
        id: 'kimi-k3.1-pro', name: 'Kimi K3.1 Pro', region: 'cn', multiplier: 0.25,
        supportsImages: true, contextWindow: 256000, maxOutputTokens: 128000,
        nativeContextWindow: 256000, nativeMaxOutputTokens: 128000, nativeSupportsImages: true,
        nativeThinkingLevels: ['off', 'low', 'medium', 'high'], advanced: false,
      },
      {
        id: 'deepseek-v4.1-flash-sg', name: 'DeepSeek V4.1 Flash SG', region: 'global', multiplier: 0.2,
        supportsImages: false, contextWindow: 200000, maxOutputTokens: 128000,
        nativeContextWindow: 200000, nativeMaxOutputTokens: 128000, nativeSupportsImages: false,
        nativeThinkingLevels: ['off', 'low', 'medium', 'high', 'max'], advanced: false,
      },
    ],

    selectionByRegion: {
      cn: {
        enabledModelIds: ['hy4flash-free', 'deepseek-v4.1-flash', 'kimi-k3.1-pro'],
        overrides: {
          'deepseek-v4.1-flash': { defaultThinkingLevel: 'max' },
        },
      },
      global: {
        enabledModelIds: ['deepseek-v4.1-flash-sg'],
        overrides: {},
      },
    },

    trae: {
      distribution: 'round-robin',
      preferred: { cn: '', ai: '' },
      accounts: [
        {
          id: 'trae-cn-1', label: 'Trae CN', region: 'cn', app: 'Trae CN', email: 'lin.cn@example.com',
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
          id: 'trae-ai-1', label: 'Trae International', region: 'ai', app: 'Trae', email: 'lin.intl@example.com',
          expiresAt: ms(8), expired: false,
          usage: { plan: { name: 'Pro', inTrial: false } },
          checkin: { active: false, todayCheckedIn: false, deviceCheckedIn: false },
        },
      ],
      gateways: [
        {
          region: 'cn', port: 42851, models: 1, portFallback: false, lastError: '',
          roster: [
            { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', alias: '', nativeContextWindow: 200000,
              nativeMaxOutputTokens: 128000, nativeSupportsImages: false,
              nativeThinkingLevels: ['off', 'low', 'medium', 'high', 'max'], advanced: true },
          ],
          selection: { enabledModelIds: ['deepseek-v4.1-flash'], overrides: {} },
        },
        {
          region: 'ai', port: 42861, models: 0, portFallback: false, lastError: '',
          roster: [],
          selection: { enabledModelIds: [], overrides: {} },
        },
      ],
    },

    qoder: {
      distribution: 'expiry',
      preferred: { cn: '', global: '' },
      accounts: [
        {
          id: 'qoder-cn-1', label: 'Qoder CN', region: 'cn', expiresAt: ms(11), expired: false,
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
          id: 'qoder-global-1', label: 'Qoder Global', region: 'global', expiresAt: ms(5), expired: false,
          usage: { plan: { name: 'Trial', inTrial: true } },
          checkin: { active: false, todayCheckedIn: false },
        },
      ],
      gateways: [
        {
          region: 'cn', port: 42871, models: 2, portFallback: false, lastError: '',
          roster: [
            { id: 'qmodel_latest', name: 'Qwen 3.8 Max', alias: '', nativeContextWindow: 256000,
              nativeMaxOutputTokens: 128000, nativeSupportsImages: true,
              nativeThinkingLevels: ['off', 'low', 'medium', 'high'], advanced: false },
            { id: 'dfmodel', name: 'DeepSeek Flash', alias: '', nativeContextWindow: 200000,
              nativeMaxOutputTokens: 128000, nativeSupportsImages: false,
              nativeThinkingLevels: ['off', 'low', 'medium', 'high', 'max'], advanced: false },
          ],
          selection: { enabledModelIds: ['qmodel_latest', 'dfmodel'], overrides: {} },
        },
        {
          region: 'global', port: 42881, models: 1, portFallback: false, lastError: '',
          roster: [
            { id: 'dfmodel', name: 'DeepSeek Flash', alias: '', nativeContextWindow: 200000,
              nativeMaxOutputTokens: 128000, nativeSupportsImages: false,
              nativeThinkingLevels: ['off', 'low', 'medium', 'high', 'max'], advanced: false },
          ],
          selection: { enabledModelIds: ['dfmodel'], overrides: {} },
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
      { id: 'source-trae', ok: true, detail: 'enabled; accounts: 2 (cn: 1, ai: 1); models served: cn: 1, ai: 0' },
      { id: 'source-qoder', ok: true, detail: 'enabled; accounts: 2 (cn: 1, global: 1); models served: cn: 2, global: 1' },
      { id: 'accounts', ok: true, detail: 'Accounts found: 5' },
      { id: 'rotation', ok: true, detail: 'Ready accounts: 3/5' },
      { id: 'host-registered-providers', ok: true, detail: 'the host is serving every provider this plugin declares' },
      { id: 'at-rest-key', ok: true, detail: 'no at-rest key failure' },
      { id: 'WTQ Pool (CN): endpoint', ok: true, detail: 'listening on http://127.0.0.1:42831/v1' },
      { id: 'WTQ Pool (CN): models', ok: true, detail: 'Models: 3' },
      { id: 'WTQ Pool (CN): declared', ok: true, detail: 'registered with the running host' },
      { id: 'WTQ Pool (Global): endpoint', ok: true, detail: 'listening on http://127.0.0.1:42841/v1' },
      { id: 'WTQ Pool (Global): models', ok: true, detail: 'Models: 1' },
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

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
  const month = today.slice(0, 7)
  const copy = value => JSON.parse(JSON.stringify(value))
  const growthDetails = {}
  const progress = [16, 9, 3, 0, 8]
  const tiers = [
    { tier: '7d', days: 7, credit: 0, energy: 2 },
    { tier: '14d', days: 14, credit: 50, energy: 3 },
    { tier: '28d', days: 28, credit: 150, energy: 5 },
  ]
  state.growth.read.rows.forEach((row, index) => {
    row.days = progress[index]
    row.tierList = tiers.map(tier => ({ ...tier, status: row.days < tier.days ? 'locked' : index === 0 && tier.days === 7 ? 'claimed' : 'unlocked' }))
    row.tiers = row.tierList.filter(tier => tier.status === 'unlocked').length
    const next = row.tierList.find(tier => tier.days > row.days)
    row.nextTier = next.tier
    row.nextTierRemaining = next.days - row.days
    const domestic = row.region === 'cn'
    const cells = Array.from({ length: Number(today.slice(8)) }, (_, day) => ({
      date: month + '-' + String(day + 1).padStart(2, '0'),
      score: day >= Number(today.slice(8)) - row.days ? 2 : day % 3 === 0 || day === Number(today.slice(8)) - row.days - 1 ? 0 : 2,
    }))
    growthDetails[row.id] = {
      buddy: domestic && !row.failed ? { id: 1, name: '猫猫' } : null,
      heatmap: { today: { date: today, score: 2, is_active: true }, cells },
      travel: domestic ? {
        locations: [{ id: 1, name: '咖啡馆' }, { id: 2, name: '商场店铺' }, { id: 3, name: '健身房' }, { id: 4, name: '古镇客栈' }],
        status: { state: index === 0 ? 'arrived' : index === 1 ? 'idle' : 'traveling',
          location: { id: 4, name: '古镇客栈' }, arrive_at: Math.floor(Date.now() / 1000) + 3600,
          daily_limit_reached: false, reward_credit: 9 },
      } : {},
      lottery: { chances: row.lottery, module: { enabled: domestic } },
      errors: row.failed ? { heatmap: '演示：账号登录已失效' } : {},
    }
    if (row.failed) {
      growthDetails[row.id].heatmap = null
      growthDetails[row.id].travel = {}
    }
  })
  state.growth.read.failed = state.growth.read.rows.filter(row => row.failed).length

  function growthAction({ id, action, value }) {
    const row = state.growth.read.rows.find(item => item.id === id)
    const details = growthDetails[id]
    let result = {}
    switch (action) {
      case 'streak': {
        const tier = row.tierList.find(item => item.tier === value)
        if (tier.status !== 'unlocked') throw new Error('该档位当前不可领取')
        tier.status = 'claimed'
        row.tiers -= 1
        row.makeupCards += 1
        details.lottery.chances += 1
        result = { credit_granted: tier.credit, cards_granted: 1, chances_granted: 1 }
        break
      }
      case 'lottery':
        if (details.lottery.chances <= 0) throw new Error('抽奖次数已达上限')
        details.lottery.chances -= 1
        result = { prize_name: '10 积分', prize_type: 'credit', credit: 10 }
        break
      case 'travelClaim':
        if (details.travel.status.state !== 'arrived') throw new Error('旅行尚未到达')
        details.travel.status.state = 'idle'
        result = { credit: details.travel.status.reward_credit }
        break
      case 'travelDepart':
        details.travel.status = { state: 'traveling', location: details.travel.locations.find(item => item.id === value),
          arrive_at: Math.floor(Date.now() / 1000) + 3600, daily_limit_reached: true }
        break
      case 'makeup': {
        const cell = details.heatmap.cells.find(item => item.date === value)
        if (cell.score > 0 || row.makeupCards === 0) throw new Error('当前日期不可补签')
        cell.score = 1
        row.makeupCards -= 1
        break
      }
      default: throw new Error('不支持的成长操作')
    }
    row.lottery = details.lottery.chances
    const credit = result.credit_granted ?? result.reward_credit ?? result.credit ?? 0
    const account = state.accounts.find(item => item.id === id)
    if (account.credits) account.credits.total += credit
    return result
  }

  async function invokeGrowth(channel, payload) {
    if (channel === 'xd.growthState') {
      state.growth.read.readAt = Date.now()
      return { growth: copy(state.growth.read), readEpoch: state.growth.readEpoch }
    }
    if (channel === 'xd.growthDetails') return { details: copy(growthDetails[payload.id]) }
    if (channel === 'xd.growthAction') return { result: growthAction(payload) }
    if (channel === 'xd.growthRun') {
      const detail = { accounts: 0, makeup: 0, activity: 0, streak: 0, lottery: 0, failed: 0 }
      const travel = { departed: 0, claimed: 0, failed: 0, credit: 0 }
      let credit = 0
      for (const row of state.growth.read.rows.filter(item => !item.failed)) {
        detail.accounts += 1
        for (const tier of row.tierList.filter(item => item.status === 'unlocked')) {
          credit += growthAction({ id: row.id, action: 'streak', value: tier.tier }).credit_granted
          detail.streak += 1
        }
        while (growthDetails[row.id].lottery.module.enabled && row.lottery > 0) {
          credit += growthAction({ id: row.id, action: 'lottery' }).credit
          detail.lottery += 1
        }
        const trip = growthDetails[row.id].travel.status
        if (trip?.state === 'arrived') {
          travel.credit += growthAction({ id: row.id, action: 'travelClaim' }).credit
          travel.claimed += 1
        } else if (trip?.state === 'idle' && !trip.daily_limit_reached) {
          growthAction({ id: row.id, action: 'travelDepart', value: 4 })
          travel.departed += 1
        }
      }
      const growth = { credit: credit + travel.credit, streak: detail.streak, failed: 0, detail, travel }
      state.growth.last = { at: new Date().toISOString(), ...growth }
      return { state: copy(state), growth }
    }
    throw new Error('不支持的成长操作')
  }
  const api = { state, doctor, invokeGrowth }

  if (typeof module !== 'undefined' && module.exports) module.exports = api
  if (typeof window !== 'undefined') window.__previewData = api
})();
