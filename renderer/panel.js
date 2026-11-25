"use strict";

/**
 * dsh-wtq-pool - panel logic.
 *
 * The panel owns no data and makes no network request: everything it shows
 * comes from the plugin's main process through `window.pluginBridge.invoke`,
 * and every channel name matches a case in `onPanelInvoke` (src/host.ts).
 *
 * All API-derived text is written with textContent / createElement, never
 * innerHTML, so a model id or an upstream error can never inject markup.
 */

// ------------------------------------------------------------------ bridge

var bridge = window.pluginBridge || null;

function invoke(channel, payload) {
  if (!bridge || typeof bridge.invoke !== "function") {
    return Promise.reject(new Error("panel bridge unavailable"));
  }
  return bridge.invoke(channel, payload || {});
}

// ------------------------------------------------------------------ locale

var EN = {
  "tab.pool": "Pool",
  "tab.models": "Models",
  "tab.check": "Connection check",
  "tab.growth": "Growth centre",
  "tabs.sources": "Account source",
  "tabs.views": "Plugin views",
  "tabs.regions": "Account region",
  "activity.title": "Recent results",
  "risk.title": "Account usage",
  "risk.note": "Unofficial clients may trigger account restrictions. Follow each vendor's terms of service.",
  "host.missing": "Unsynced model groups: {count}. Reload the plugin.",
  "btn.rescan": "Detect accounts again",
  "btn.reset": "Clear all cooldowns",
  "btn.refresh": "Refresh",
  "btn.checkin": "Check in",
  "btn.checkinDone": "Checked in today",
  "btn.save": "Save",
  "btn.discard": "Discard changes",
  "btn.doctor": "Run connection check",
  "btn.copy": "Copy report",
  "copy.ok": "Copied",
  "copy.failedSelected": "Copy failed. The report is selected; press Ctrl+C.",
  "copy.failed": "Copy failed",
  "region.cn": "China",
  "region.park": "Disable {region}",
  "region.unpark": "Enable {region}",
  "region.parked": "{region} disabled",
  "region.parkedShort": "Disabled",
  "region.global": "Global",
  "region.cnShort": "CN",
  "pool.summary": "Accounts: {count} · Cooling: {cooling}",
  "pool.allCooling": "All accounts are rate-limited. Requests wait until an account leaves cooldown.",
  "pool.refused": "Re-authentication required: {count}",
  "pool.allRefused": "The upstream rejected every account sign-in. Select Add account to sign in again and restore service.",
  "pool.restricted": "Restricted accounts: {count}",
  "pool.allRestricted": "The upstream restricted all accounts. Appeal in the WorkBuddy console or add another account.",
  "pool.allSwitchedOff": "All accounts are disabled. Enable at least one account to serve requests.",
  "pool.checkinAll": "Check in every account",
  "pool.checkinAllHint": "Collect daily check-in rewards for this source",
  "pool.checkinAllBusy": "Checking in…",
  "pool.checkinAllDone": "Checked in: {count} accounts",
  "pool.checkinAllNone": "Every account is already checked in today",
  "pool.checkinAllFailed": "Checked in {count}, {failed} failed",
  "pool.emptyRegion": "No account is signed in for {region}.",
  "pool.emptyHint": "Sign in to that edition in the WorkBuddy desktop app, then select Detect accounts again.",
  "pool.sourceOff": "The WorkBuddy source is switched off in plugin settings.",
  "login.add": "Add account",
  "login.addHint": "Sign in to WorkBuddy in the browser. The account is added after sign-in completes.",
  "login.openAgain": "Open sign-in link",
  "login.waiting": "Complete sign-in in the browser. The panel will add the account automatically.",
  "login.timeout": "Sign-in did not complete. Request a new sign-in link.",
  "login.noLink": "The plugin did not return a sign-in link.",
  "login.added": "Added {name}",
  "login.addedNoName": "Account added",
  "trae.title": "Trae",
  "trae.off": "The Trae source is switched off in plugin settings.",
  "qoder.title": "Qoder",
  "qoder.off": "The Qoder source is switched off in plugin settings.",
  "source.enable": "Enable {source}",
  "source.disable": "Disable {source}",
  "source.noAccounts": "no local sign-in found",
  "source.traeSlots": "Domestic Trae has two sign-in slots: Trae CN and TRAE SOLO CN. Signing in to either slot replaces its current account.",
  "source.qoderSlots": "Each installation stores one sign-in. Signing in to another account replaces the current account.",
  "source.traeCheckin": "A device can claim one daily check-in. After one account claims, other accounts show “Checked in on this device”.",
  "source.expired": "token expired",
  "workbuddy.title": "WorkBuddy",
  "models.noGateway": "This source has no active gateway.",
  "models.noDirectory": "Unable to load this source's model list.",
  "source.accountCount": "Accounts: {count}",
  "source.checkinDone": "Reward collected",
  "source.checkinSkipped": "Claimed today",
  "source.planTitle": "Plan",
  "source.planTrial": "trial",
  "source.quotaUnknown": "usage unavailable",
  "source.checkedIn": "Checked in today",
  "source.claimable": "Available today",
  "source.campaignUnknown": "Unable to load check-in state",
  "source.claimableAt": "Can claim after {time} Beijing time",
  "source.deviceCheckedIn": "This device checked in today",
  "badge.next": "next up",
  "badge.cooling": "cooling",
  "badge.revoked": "Sign-in required",
  "badge.healthy": "healthy",
  "acct.token": "token {time}",
  "acct.tokenExpiring": "token expires in {min} min",
  "time.minutes": "{count} min",
  "time.hours": "{count} h",
  "time.days": "{count} d",
  "acct.noExpiry": "no token expiry reported",
  "acct.coolUntil": "cooling until {time}",
  "acct.holdUntil": "held until {time}",
  "acct.restrictedUntil": "restricted by the upstream until {time}",
  "acct.restrictedHint": "The upstream restricted this account (11140: unusual activity). The pool retries every six hours. Submit an appeal in the WorkBuddy console.",
  "badge.restricted": "restricted",
  "acct.signInRefused": "Sign in again using Add account.",
  "acct.hits": "Rate limits: {hits}",
  "acct.choose": "Use credits from",
  "acct.automatic": "Automatic (follow account usage)",
  "acct.unavailable": "Selected account unavailable (automatic fallback)",
  "acct.expired": "sign-in expired",
  "acct.archivedHint": "The desktop app no longer has a sign-in file for this account. The pool uses the saved token until it expires. Sign in again in WorkBuddy to renew it.",
  "acct.choiceCredits": "{label} · {credits} credits",
  "badge.preferred": "selected",
  "acct.off": "Switched off",
  "acct.switchOn": "Use this account again",
  "acct.inPool": "In the rotation",
  "acct.switchOff": "Keep this account out of the pool for now",
  "acct.remove": "Remove",
  "acct.removeHint": "Removes the account from the pool. Restore it under “Removed accounts”.",
  "acct.delete": "Delete",
  "acct.deleteHint": "Removes the account from the pool and deletes the plugin's saved sign-in information and archive. Sign in again to restore it.",
  "acct.deleteConfirm": "Delete {name}? This removes it from the pool and deletes the plugin's saved sign-in information and archive. A rescan will not restore it. Sign in again to restore the account.",
  "acct.deleteConfirmAgain": "Click Delete again to confirm",
  "acct.stateError": "Could not change this account: {message}",
  "pool.switchedOff": "Disabled: {count}",
  "removed.title": "Removed accounts",
  "removed.restore": "Restore",
  "acct.modelCool": "{model} cooling until {time}",
  "credits.title": "Credits",
  "credits.unavailable": "Unable to load credits",
  "credits.package": "{remain} / {size}",
  "credits.monthly": "monthly",
  "credits.refreshAt": "refreshes {time}",
  "credits.expiresAt": "expires {date}",
  "credits.validDays": "valid {days} days after claiming",
  "credits.roundExpires": "this round expires {date}",
  "credits.noExpiry": "No expiry",
  "credits.expiringSoon": "{amount} credits expire within 3 days",
  "credits.planQuota": "Plan credits",
  "credits.addOnQuota": "Add-on credits",
  "credits.expand": "Expand",
  "credits.collapse": "Collapse",
  "credits.keepAtLeast": "Keep at least",
  "credits.keepUnit": "credits",
  "credits.keepSave": "Save",
  "credits.keepHint": "The pool stops using this account when its balance reaches this value.",
  "credits.keepBadge": "Keep ≥ {credits}",
  "checkin.title": "Daily check-in",
  "checkin.streak": "{days}-day streak",
  "checkin.daily": "+{credit} credits/day",
  "checkin.bonus": "Day {days} bonus: +{credit} credits",
  "checkin.claimed": "claimed +{credit} credits",
  "checkin.claiming": "Checking in…",
  "models.serviceModels": "Models for this service",
  "models.fetchModelList": "Fetch list",
  "models.modelsLoading": "Fetching model list…",
  "models.searchModel": "Search models…",
  "models.selectAll": "Select all",
  "models.deselectAll": "Deselect all",
  "models.modelConfigurations": "Model settings",
  "models.searchChosen": "Search added models…",
  "models.noModelsChosen": "Select at least one model.",
  "models.noChosenMatch": "No added model matches.",
  "models.removeModel": "Remove model",
  "models.advanced": "Advanced",
  "models.alias": "Alias",
  "models.aliasPlaceholder": "Example: fast",
  "models.aliasHelp": "Used in the model list. Requests continue to use the model ID.",
  "models.window": "Context window",
  "models.windowFollows": "Follows the catalogue until you enter a custom value.",
  "models.maxOutput": "Max output",
  "models.outputHelp": "Maximum length of a single model reply.",
  // The ceiling is the model's own figure. The host sizes its context budget and
  // compaction threshold from the declared number, so a larger value made it
  // wait for room the upstream never had.
  "models.overCeiling": "The model accepts at most {limit}. The larger value was ignored.",
  "models.levels": "Thinking levels",
  "models.defaultLevel": "Default thinking level",
  "models.capabilities": "Attachments",
  "models.imageInput": "Images",
  "models.empty": "No models in the catalogue.",
  "models.noMatch": "No models match the filter.",
  "models.capped": "Not published",
  "models.cappedHint": "Each provider publishes up to {count} models. Additional selections are not included in the model picker.",
  "models.zeroEnabled": "Enable at least one model before saving.",
  "models.dirty": "Unsaved changes",
  "models.saving": "Saving…",
  "models.saved": "Model selection saved",
  "models.saveError": "Could not save: {message}",
  "models.reload": "The model list changed. Reload the plugin to synchronize it.",
  "models.addressDrift": "The published address differs from the address bound in this run. Reload the plugin.",
  "dist.title": "Account usage",
  "dist.priority": "Priority",
  "dist.roundRobin": "Round-robin",
  "dist.sticky": "Per conversation",
  "dist.expiry": "Expiring credits first",
  "dist.hintPriority": "Use one account until its credits are exhausted, then switch.",
  "dist.hintRoundRobin": "Distribute requests across all accounts.",
  "dist.hintSticky": "Keep each conversation on one account. New conversations use the next account.",
  "dist.hintExpiry": "Use credits near expiry first.",
  "dist.hintSourcePriority": "Keep using one account. A selected account remains in use.",
  "dist.hintSourceRoundRobin": "Distribute each request across accounts. A selected account takes priority.",
  "dist.hintSourceExpiry": "Use credits near expiry first. A selected account takes priority.",
  "auto.title": "Daily check-in",
  "auto.on": "On",
  "auto.off": "Off",
  "auto.hours": "Beijing time",
  "auto.hoursHint": "9,21",
  "auto.badHours": "Enter whole hours from 0 to 23, for example 9 or 9,21.",
  "auto.hoursSave": "Save",
  "auto.runNow": "Run now",
  "auto.runNowHint": "Run the same tasks as the scheduled check-in.",
  "auto.running": "Running…",
  "auto.lastManual": "Last manual run at {slot} · Accounts: {count}",
  "auto.lastAuto": "Last run at {slot} · Accounts: {count}",
  "auto.lastFailedAt": "Last run at {slot} failed: {message}",
  "auto.neverRun": "No runs yet",
  "auto.rowWorkbuddy": "WorkBuddy",
  "auto.rowTravel": "Travel",
  "auto.rowQoder": "Qoder",
  "auto.rowTrae": "Trae",
  "auto.rowCounts": "{label}: collected {claimed} · skipped {skipped} · failed {failed}",
  "auto.rowGrowth": "Growth: streak tiers {streak} · draws {lottery} · failed {failed}",
  "auto.rowKeepAlive": "Token keep-alive {when}: {refreshed} refreshed · {fresh} already fresh · {failed} failed · {noToken} with no refresh token",
  "auto.rowTravelCounts": "{label}: {departed} sent · {claimed} claimed",
  "auto.hint": "Collects WorkBuddy, Trae and Qoder check-in rewards and WorkBuddy streak rewards. Streak rewards may consume make-up cards and lottery draws. Cat travel is available for domestic accounts only. Claimed slots are skipped; missed slots are collected during a later run that day.",
  "keepAlive.runNow": "Refresh now",
  "keepAlive.running": "Refreshing…",
  "keepAlive.label": "Refresh sign-ins",
  "keepAlive.hint": "Renews plugin-managed sign-ins. The desktop app renews sign-ins it manages.",
  "growth.claim": "Claim",
  "growth.calendar": "This month",
  "growth.loggedIn": "Logged in",
  "growth.notLoggedIn": "Not logged in",
  "growth.futureDay": "Upcoming",
  "growth.makeup": "Make-up for this day",
  "growth.makeupConfirm": "Spend one make-up card on {date}?",
  "growth.destination": "Destination",
  "growth.depart": "Dispatch",
  "growth.travelSent": "Travel dispatched",
  "growth.makeupDone": "Day made up",
  "growth.departConfirm": "Dispatch to {place}? This uses one daily trip.",
  "growth.travelClaim": "Claim travel credits",
  "growth.travelLimit": "Daily travel limit reached",
  "growth.travelArrived": "Arrived",
  "growth.travelReady": "Ready to dispatch",
  "growth.traveling": "Traveling · {place} · arrives {time}",
  "growth.draw": "Draw · {count} remaining",
  "growth.drawConfirm": "Spend one lottery chance?",
  "growth.confirmTitle": "Confirm action",
  "growth.confirm": "Confirm",
  "growth.cancel": "Cancel",
  "growth.actionDone": "Completed · +{credit} credits",
  "growth.physicalPrize": "Add a delivery address in the official Growth Centre.",
  "growth.runConfirm": "Run travel and growth rewards for enabled accounts? This may use a daily trip, make-up cards and all lottery chances.",
  "auto.enableConfirm": "Enable scheduled rewards? WorkBuddy runs may send a trip, use make-up cards and use all lottery chances.",
  "auto.runConfirm": "Run check-in and rewards now? WorkBuddy may send a trip, use make-up cards and use all lottery chances.",
  "growth.title": "Growth centre",
  "growth.running": "Running…",
  "growth.read": "Read state",
  "growth.reading": "Reading…",
  "growth.readHint": "Refresh streak tiers and available rewards",
  "growth.detailsFailed": "Unable to load some details",
  "growth.run": "Run now",
  "growth.runHint": "Run travel and collect growth rewards",
  "growth.stateNone": "State not read",
  "growth.stateStale": "State is outdated after the last run. Read it again.",
  "growth.stateSummary": "Accounts: {accounts} · Redeemable tiers: {tiers} · Make-up cards: {cards} · Draws: {chances}",
  "growth.groupCount": "Accounts: {count}",
  "growth.stateFailed": "Accounts with load errors: {failed}",
  "growth.rowDays": "Streak: {days} days",
  "growth.rowSummary": "Streak: {days} days · Next tier in {remaining} days",
  "growth.rowHold": "Redeemable tiers: {tiers} · Make-up cards: {cards} · Draws: {chances}",
  "growth.rowHoldNoLottery": "Redeemable tiers: {tiers} · Make-up cards: {cards}",
  "growth.rowTiers": "Streak tiers",
  "growth.tierDays": "{days} days",
  "growth.rowTier": "Day {days} · +{credit} credits +{energy} energy",
  "growth.tierClaimed": "Claimed",
  "growth.tierLocked": "Locked",
  "growth.rowNothing": "No rewards available",
  "growth.rowFailed": "Unable to load this account",
  "growth.onlyWorkbuddy": "The growth centre applies to WorkBuddy accounts.",
  "growth.runNone": "No rewards collected",
  "growth.runLine": "{when} · +{credit} credits · make-up {makeup} · streak {streak} · draws {lottery}",
  "growth.runFailed": "{when}: failed steps {failed}",
  "growth.busy": "A check-in task is running. Try again when it finishes.",
  "composer.title": "Composer credits",
  "composer.hint": "Shows the active account's credits on the left while a model from this plugin is selected. Click the readout to change accounts.",
  "composer.show": "Show credits",
  "composer.hide": "Hide credits",
  "check.title": "Connection check",
  "check.details": "Details",
  "check.empty": "Run the check to test connectivity to WorkBuddy, Trae and Qoder.",
  "check.pass": "PASS",
  "check.fail": "FAIL",
  "foot.shim": "Endpoint",
  "foot.shimOff": "Not listening",
  "foot.rosterStale": "{region} needs attention: {detail}",
  "foot.npm": "npm",
  "foot.github": "GitHub",
  "foot.docs": "Docs",
  "foot.license": "License",
  "err.bridge": "The panel connection is unavailable.",
  "err.busy": "Another panel operation is running. Try again after it finishes.",
  "err.stale": "The plugin was reloaded. Refresh to load the current state.",
  "tag.free": "Free",
  "tag.rate": "x{rate}",
  "state.loading": "Loading…",
  "state.refreshing": "Checking…",
  "probe.pending": "Reading…",
  "btn.refreshing": "Refreshing…",
  "models.staleSelection": "{region} contains selected models that are no longer available. The full model list is shown; select models and save again.",
};

var ZH = {
  "tab.pool": "账号池",
  "tab.models": "模型",
  "tab.check": "连接检查",
  "tab.growth": "成长中心",
  "tabs.sources": "账号来源",
  "tabs.views": "插件页面",
  "tabs.regions": "账号区域",
  "activity.title": "最近结果",
  "risk.title": "账号使用说明",
  "risk.note": "非官方客户端可能触发账号风控，请遵守厂商服务条款。",
  "host.missing": "未同步的模型组：{count}。请重新加载插件。",
  "btn.rescan": "重新检测账号",
  "btn.reset": "清除所有冷却",
  "btn.refresh": "刷新",
  "btn.checkin": "签到",
  "btn.checkinDone": "今日已签到",
  "btn.save": "保存",
  "btn.discard": "放弃修改",
  "btn.doctor": "运行连接检查",
  "btn.copy": "复制报告",
  "copy.ok": "已复制",
  "copy.failedSelected": "复制失败。报告已选中，请按 Ctrl+C。",
  "copy.failed": "复制失败",
  "region.cn": "国内版",
  "region.park": "停用{region}",
  "region.unpark": "启用{region}",
  "region.parked": "已停用{region}",
  "region.parkedShort": "已停用",
  "region.global": "国际版",
  "region.cnShort": "国内版",
  "pool.summary": "{count} 个账号 · {cooling} 个冷却中",
  "pool.allCooling": "所有账号均已限流。请求将在有账号退出冷却后继续。",
  "pool.refused": "{count} 个需重新登录",
  "pool.allRefused": "上游已拒绝所有账号的登录。请点击「添加账号」重新登录，以恢复服务。",
  "pool.restricted": "{count} 个被上游限制",
  "pool.allRestricted": "上游已限制所有账号。请在 WorkBuddy 官方后台申诉，或添加其他账号。",
  "pool.allSwitchedOff": "所有账号均已停用。请至少启用一个账号以继续提供服务。",
  "pool.checkinAll": "全部签到",
  "pool.checkinAllHint": "领取当前来源的每日签到奖励",
  "pool.checkinAllBusy": "签到中…",
  "pool.checkinAllDone": "已签到 {count} 个账号",
  "pool.checkinAllNone": "所有账号今天都已签到",
  "pool.checkinAllFailed": "已签到 {count} 个，{failed} 个失败",
  "pool.emptyRegion": "{region} 暂无登录账号。",
  "pool.emptyHint": "请在该版本的 WorkBuddy 桌面应用中登录，然后点击「重新检测账号」。",
  "pool.sourceOff": "WorkBuddy 来源已在插件设置中停用。",
  "login.add": "添加账号",
  "login.addHint": "在浏览器中登录 WorkBuddy。登录完成后，账号将自动加入账号池。",
  "login.openAgain": "打开登录链接",
  "login.waiting": "请在浏览器中完成登录。面板将自动添加该账号。",
  "login.timeout": "登录未完成。请重新获取登录链接。",
  "login.noLink": "未获取到登录链接。",
  "login.added": "已添加 {name}",
  "login.addedNoName": "账号已添加",
  "trae.title": "Trae",
  "trae.off": "Trae 来源已在插件设置中停用。",
  "qoder.title": "Qoder",
  "qoder.off": "Qoder 来源已在插件设置中停用。",
  "source.enable": "启用{source}",
  "source.disable": "停用{source}",
  "source.traeSlots": "国内版 Trae 提供 Trae CN 和 TRAE SOLO CN 两个登录位。在同一登录位登录其他账号会替换当前账号。",
  "source.qoderSlots": "每个安装仅保存一个登录。登录其他账号会替换当前账号。",
  "source.traeCheckin": "每台设备每天只能领取一次签到奖励。一个账号领取后，其他账号将显示「本机今日已签到」。",
  "source.expired": "令牌已过期",
  "workbuddy.title": "WorkBuddy",
  "models.noGateway": "该来源没有可用网关。",
  "models.noDirectory": "无法读取该来源的模型列表。",
  "source.accountCount": "{count} 个账号",
  "source.checkinDone": "已领取今日奖励",
  "source.planTitle": "套餐",
  "source.planTrial": "试用中",
  "source.checkinSkipped": "今日已领取",
  "source.quotaUnknown": "额度数据不可用",
  "source.checkedIn": "今日已签到",
  "source.claimable": "今日可签到",
  "source.noAccounts": "未找到本机登录",
  "source.campaignUnknown": "无法读取签到状态",
  "source.deviceCheckedIn": "本机今日已签到",
  "badge.next": "下一个",
  "source.claimableAt": "北京时间 {time} 后可签到",
  "badge.cooling": "冷却中",
  "badge.revoked": "需重新登录",
  "badge.healthy": "可用",
  "acct.token": "令牌 {time}",
  "acct.tokenExpiring": "令牌将在 {min} 分钟后过期",
  "time.minutes": "{count} 分钟",
  "time.hours": "{count} 小时",
  "time.days": "{count} 天",
  "acct.noExpiry": "令牌没有报告有效期",
  "acct.coolUntil": "冷却至 {time}",
  "acct.holdUntil": "暂停至 {time}",
  "acct.restrictedUntil": "被上游限制，直至 {time}",
  "acct.restrictedHint": "上游已限制此账号（11140：账号异常）。账号池每六小时重试一次。请前往 WorkBuddy 官方后台提交申诉。",
  "badge.restricted": "已限制",
  "acct.signInRefused": "请通过「添加账号」重新登录。",
  "acct.hits": "已触发 {hits} 次限流",
  "acct.choose": "使用哪个账号的额度",
  "acct.automatic": "自动选择（按使用方式）",
  "acct.unavailable": "所选账号暂不可用（自动切换）",
  "acct.expired": "登录已过期",
  "acct.archivedHint": "桌面应用已无此账号的登录文件。账号池将使用已保存的令牌，直至令牌过期。可在 WorkBuddy 中重新登录以续期。",
  "acct.choiceCredits": "{label} · {credits} 积分",
  "badge.preferred": "已选",
  "acct.off": "已停用",
  "acct.switchOn": "重新使用该账号",
  "acct.inPool": "参与轮换",
  "acct.switchOff": "暂时不使用该账号",
  "acct.remove": "移除",
  "acct.removeHint": "将账号移出账号池；可在「已移除的账号」中恢复。",
  "acct.delete": "删除",
  "acct.deleteHint": "将账号移出账号池，并删除插件保存的登录信息与归档。重新登录该账号即可恢复。",
  "acct.deleteConfirm": "删除 {name}？该账号将移出账号池，插件保存的登录信息与归档也会删除。重新扫描不会恢复该账号；重新登录后可恢复。",
  "acct.deleteConfirmAgain": "再次点击「删除」以确认",
  "acct.stateError": "账号设置失败：{message}",
  "pool.switchedOff": "{count} 个已停用",
  "removed.title": "已移除的账号",
  "removed.restore": "恢复",
  "acct.modelCool": "{model} 冷却至 {time}",
  "credits.title": "积分",
  "credits.unavailable": "无法读取积分",
  "credits.package": "{remain} / {size}",
  "credits.monthly": "月包",
  "credits.refreshAt": "{time} 刷新",
  "credits.expiresAt": "{date} 过期",
  "credits.validDays": "领取后 {days} 天有效",
  "credits.roundExpires": "本轮 {date} 过期",
  "credits.noExpiry": "不过期",
  "credits.expiringSoon": "{amount} 积分将在 3 天内过期",
  "credits.planQuota": "套餐内积分",
  "credits.addOnQuota": "资源包积分",
  "credits.expand": "展开",
  "credits.collapse": "收起",
  "credits.keepAtLeast": "至少保留",
  "credits.keepUnit": "积分",
  "credits.keepSave": "保存",
  "credits.keepHint": "余额达到此值后，账号池将停止使用该账号。",
  "credits.keepBadge": "最低保留 {credits}",
  "checkin.title": "每日签到",
  "checkin.streak": "连签 {days} 天",
  "checkin.daily": "每天 +{credit} 积分",
  "checkin.bonus": "第 {days} 天额外 +{credit}",
  "checkin.claimed": "已领取 +{credit} 积分",
  "checkin.claiming": "签到中…",
  "models.serviceModels": "该服务的模型",
  "models.fetchModelList": "获取列表",
  "models.modelsLoading": "正在获取模型列表…",
  "models.searchModel": "搜索模型…",
  "models.selectAll": "全选",
  "models.deselectAll": "取消全选",
  "models.modelConfigurations": "模型设置",
  "models.searchChosen": "搜索已添加模型…",
  "models.noModelsChosen": "请至少选择一个模型。",
  "models.noChosenMatch": "没有匹配的已选模型。",
  "models.removeModel": "移除模型",
  "models.advanced": "高级",
  "models.alias": "别名",
  "models.aliasPlaceholder": "例如：fast",
  "models.aliasHelp": "用于模型列表显示；请求仍使用模型 ID。",
  "models.window": "上下文窗口",
  "models.windowFollows": "默认跟随模型目录；输入自定义值后固定为该值。",
  "models.maxOutput": "最大输出",
  "models.outputHelp": "单次模型回复的最大长度。",
  "models.overCeiling": "该模型最多接受 {limit}。较大的数值已忽略。",
  "models.levels": "思考等级",
  "models.defaultLevel": "默认思考等级",
  "models.capabilities": "附件",
  "models.imageInput": "图片",
  "models.empty": "模型目录中没有模型。",
  "models.noMatch": "没有匹配的模型。",
  "models.capped": "未发布",
  "models.cappedHint": "每个提供商最多发布 {count} 个模型。超出部分不会出现在模型选择器中。",
  "models.zeroEnabled": "至少启用一个模型才能保存。",
  "models.dirty": "有未保存的修改",
  "models.saving": "保存中…",
  "models.saved": "模型选择已保存",
  "models.saveError": "保存失败：{message}",
  "models.reload": "模型列表已变化。请重新加载插件以同步。",
  "models.addressDrift": "对外公布的地址与本次运行绑定的地址不一致。请重新加载插件。",
  "dist.title": "账号使用方式",
  "dist.priority": "优先使用",
  "dist.roundRobin": "轮流使用",
  "dist.sticky": "同一对话固定",
  "dist.expiry": "优先使用临期积分",
  "dist.hintPriority": "优先耗尽单个账号积分，再切换账号。",
  "dist.hintRoundRobin": "将请求分配到各个账号。",
  "dist.hintSticky": "同一对话固定使用一个账号；新对话使用下一个账号。",
  "dist.hintExpiry": "优先消耗即将到期的一次性积分。",
  "dist.hintSourcePriority": "持续使用同一账号；已选账号优先。",
  "dist.hintSourceRoundRobin": "将请求分配到各账号；已选账号优先。",
  "dist.hintSourceExpiry": "优先使用临期积分；已选账号优先。",
  "auto.title": "自动签到",
  "auto.on": "开启",
  "auto.off": "关闭",
  "composer.title": "输入框积分",
  "composer.hint": "选中本插件模型时，输入框左侧显示当前账号积分。点击读数后可以更换账号。",
  "composer.show": "显示积分",
  "composer.hide": "隐藏积分",
  "auto.hours": "北京时间",
  "auto.hoursHint": "9,21",
  "auto.hoursSave": "保存时间",
  "auto.runNow": "立即运行",
  "auto.runNowHint": "执行与定时签到相同的任务。",
  "auto.running": "运行中…",
  "auto.lastManual": "上次手动运行（{slot}） · {count} 个账号",
  "auto.lastAuto": "上次运行（{slot}） · {count} 个账号",
  "auto.lastFailedAt": "上次运行（{slot}）失败：{message}",
  "auto.neverRun": "暂无运行记录",
  "auto.rowWorkbuddy": "WorkBuddy",
  "auto.rowTravel": "猫猫旅行",
  "auto.rowQoder": "Qoder",
  "auto.rowTrae": "Trae",
  "auto.rowCounts": "{label}：领取 {claimed} · 跳过 {skipped} · 失败 {failed}",
  "auto.rowGrowth": "成长：连登 {streak} 档 · 抽奖 {lottery} 次 · 失败 {failed} 次",
  "auto.rowTravelCounts": "{label}：派出 {departed} · 领奖 {claimed}",
  "auto.hint": "按设定时间领取 WorkBuddy、Trae、Qoder 签到奖励及 WorkBuddy 连登奖励。连登奖励可能消耗补签卡和抽奖次数；猫猫旅行仅限国内账号。已领取的时段会跳过，遗漏的时段将在当天后续运行中补领。",
  "auto.rowKeepAlive": "令牌保活 {when}：刷新 {refreshed} 个 · 已是最新 {fresh} 个 · 失败 {failed} 个 · 无刷新令牌 {noToken} 个",
  "keepAlive.runNow": "立即刷新",
  "keepAlive.running": "刷新中…",
  "keepAlive.label": "登录续期",
  "keepAlive.hint": "续期插件管理的登录。桌面应用管理的登录由原应用续期。",
  "growth.claim": "领取",
  "growth.calendar": "本月登录",
  "growth.loggedIn": "已登录",
  "growth.notLoggedIn": "未登录",
  "growth.futureDay": "尚未到来",
  "growth.makeup": "补签此日",
  "growth.makeupConfirm": "消耗 1 张补签卡，补签 {date}？",
  "growth.destination": "旅行地点",
  "growth.depart": "派遣旅行",
  "growth.travelSent": "已派遣旅行",
  "growth.makeupDone": "补签完成",
  "growth.departConfirm": "派往「{place}」？将使用 1 次今日旅行机会。",
  "growth.travelClaim": "领取旅行积分",
  "growth.travelLimit": "今日旅行次数已达上限",
  "growth.travelArrived": "已到达",
  "growth.travelReady": "待出发",
  "growth.traveling": "旅行中 · {place} · {time} 到达",
  "growth.draw": "抽奖 · 剩余 {count} 次",
  "growth.drawConfirm": "将消耗 1 次抽奖机会，确认抽奖？",
  "growth.confirmTitle": "确认操作",
  "growth.confirm": "确认",
  "growth.cancel": "取消",
  "growth.actionDone": "操作完成 · +{credit} 积分",
  "growth.physicalPrize": "请在官方成长中心填写收货地址。",
  "growth.runConfirm": "为启用的账号执行旅行和成长奖励？可能消耗当日旅行次数、补签卡和全部抽奖次数。",
  "auto.enableConfirm": "开启定时领取？启用 WorkBuddy 时，每轮可能派遣旅行、消耗补签卡并耗尽全部抽奖次数。",
  "auto.runConfirm": "立即签到并领奖？WorkBuddy 可能派遣旅行、消耗补签卡并耗尽全部抽奖次数。",
  "growth.title": "成长中心",
  "growth.running": "运行中…",
  "growth.read": "读取状态",
  "growth.reading": "读取中…",
  "growth.readHint": "刷新连登档位和可领取奖励",
  "growth.detailsFailed": "部分详情读取失败",
  "growth.run": "立即执行",
  "growth.runHint": "执行猫猫旅行和成长奖励",
  "growth.stateNone": "尚未读取状态",
  "growth.stateStale": "上次运行后状态已过期。请重新读取。",
  "growth.stateSummary": "{accounts} 个账号 · 可兑换 {tiers} 档 · 补签卡 {cards} 张 · 抽奖 {chances} 次",
  "growth.groupCount": "{count} 个账号",
  "growth.stateFailed": "{failed} 个账号的数据无法读取",
  "growth.rowDays": "连登 {days} 天",
  "growth.rowSummary": "连登 {days} 天 · 距下一档还差 {remaining} 天",
  "growth.rowHold": "可兑换 {tiers} 档 · 补签卡 {cards} 张 · 抽奖 {chances} 次",
  "growth.rowHoldNoLottery": "可兑换 {tiers} 档 · 补签卡 {cards} 张",
  "growth.rowTiers": "连登档位",
  "growth.tierDays": "{days} 天",
  "growth.rowTier": "{days} 天 · +{credit} 积分 +{energy} 能量",
  "growth.tierClaimed": "已领取",
  "growth.tierLocked": "未解锁",
  "growth.rowNothing": "暂无可领取项",
  "growth.rowFailed": "无法读取此账号",
  "growth.onlyWorkbuddy": "成长中心仅适用于 WorkBuddy 账号。",
  "growth.runNone": "本次运行未领取到奖励",
  "growth.runLine": "{when} · +{credit} 积分 · 补签 {makeup} · 连登 {streak} · 抽奖 {lottery}",
  "growth.runFailed": "{when}：{failed} 个步骤失败",
  "growth.busy": "签到任务正在运行，请等待完成。",
  "auto.badHours": "请输入 0–23 的整数小时，例如 9 或 9,21。",
  "check.title": "连接检查",
  "check.details": "详细信息",
  "check.empty": "运行连接检查，验证 WorkBuddy、Trae 和 Qoder 的连接。",
  "check.pass": "通过",
  "check.fail": "未通过",
  "foot.shim": "端点",
  "foot.shimOff": "未监听",
  "foot.rosterStale": "{region} 状态异常：{detail}",
  "foot.npm": "npm",
  "foot.github": "GitHub",
  "foot.docs": "文档",
  "foot.license": "许可",
  "err.bridge": "面板连接不可用。",
  "err.busy": "面板正在执行其他操作。请等待完成。",
  "err.stale": "插件已重新加载。请刷新以获取当前数据。",
  "tag.free": "免费",
  "tag.rate": "x{rate}",
  "state.loading": "加载中…",
  "state.refreshing": "检测中…",
  "probe.pending": "读取中…",
  "btn.refreshing": "刷新中…",
  "models.staleSelection": "{region} 的已选模型包含已下线项。当前显示完整模型列表，请重新选择并保存。",
};

var locale = String(document.documentElement.lang || navigator.language || "zh-CN");
var TABLE = locale.toLowerCase().indexOf("zh") === 0 ? ZH : EN;
function t(key, vars) {
  var text = TABLE[key] !== undefined ? TABLE[key] : (EN[key] !== undefined ? EN[key] : key);
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, function (match, name) {
    return vars[name] === undefined ? match : String(vars[name]);
  });
}

// ---------------------------------------------------------------- helpers

function $(id) { return document.getElementById(id); }

function el(tag, className, text) {
  var node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function iconLabel(node, label) {
  node.textContent = "";
  node.className += node.className.includes("icon-only") ? "" : " icon-only";
  node.appendChild(el("span", "sr-only", label));
  node.title = label;
}

function helpNote(label, text) {
  var details = el("details", "help-note");
  var trigger = el("summary", "ic-info");
  iconLabel(trigger, label);
  details.appendChild(trigger);
  details.appendChild(el("p", "help-content", text));
  return details;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function show(node, visible) { node.hidden = !visible; }

function num(value, fallback) {
  var n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function formatStamp(iso) {
  if (!iso) return "";
  var d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

function formatRelative(iso) {
  if (!iso) return "";
  var d = new Date(iso).getTime();
  if (!Number.isFinite(d)) return "";
  var ms = d - Date.now();
  if (!Number.isFinite(ms)) return "";
  // Through the tables: a bare "42 min" inside a translated sentence read as two
  // languages in one line. The caller handles the past case itself, so this is
  // only ever asked about a future instant.
  var mins = Math.ceil(ms / 60000);
  var hours = Math.round(mins / 60);
  if (hours < 1) return t("time.minutes", { count: mins });
  if (hours < 48) return t("time.hours", { count: hours });
  return t("time.days", { count: Math.round(hours / 24) });
}

function formatDayStamp(ms) {
  var d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  // A pool can be good for a year or more, and "10-21" alone reads as this
  // year; the year shows up only when it is not the one on screen now.
  var now = new Date();
  var text = String(d.getMonth() + 1) + "-" + String(d.getDate());
  return d.getFullYear() === now.getFullYear() ? text : d.getFullYear() + "-" + text;
}

function minutesUntil(iso) {
  if (!iso) return null;
  var d = new Date(iso).getTime();
  if (!Number.isFinite(d)) return null;
  return Math.round((d - Date.now()) / 60000);
}

/**
 * The token line under an account's name.
 *
 * An expiry already in the past is not "expires in 0 min" — the token is dead,
 * and saying it will expire in no time at all sends the user looking for a
 * countdown that never arrives. Clamping the sign away is what produced that
 * wording, so a past date gets its own branch.
 */
function tokenChip(iso) {
  var mins = minutesUntil(iso);
  if (mins === null) return el("span", null, t("acct.noExpiry"));
  if (mins < 0) return el("span", "finding-fail", t("source.expired"));
  if (mins <= 10) return el("span", "finding-fail", t("acct.tokenExpiring", { min: mins }));
  return el("span", null, t("acct.token", { time: formatRelative(iso) }));
}

/**
 * The chips one roster row carries.
 *
 * `tone` picks the colour; the caller renders each one as a badge.
 */
function tagOf(model) {
  var out = [];
  if (model.multiplier === 0) out.push({ text: t("tag.free"), tone: "free" });
  else if (typeof model.multiplier === "number") {
    out.push({ text: t("tag.rate", { rate: model.multiplier.toFixed(2) }), tone: "" });
  }
  return out;
}

/** "08:00" for a clock hour, which is how a window edge reads to a person. */
function clockHour(hour) {
  var value = Math.round(Number(hour));
  if (!Number.isFinite(value)) return "";
  // 24 is a valid end-of-day edge.
  value = Math.max(0, Math.min(24, value));
  return (value < 10 ? "0" : "") + value + ":00";
}

/**
 * The banner text currently shown, so a later pass can tell its own message
 * from one another action put up (or cleared).
 */
var bannerText = "";

/**
 * Show the banner. A failure reaching the panel arrives wrapped in whatever
 * envelope the bridge used; the reason itself is what the user needs, so the
 * envelope is stripped here once instead of at every call site.
 */
function note(message, kind) {
  var banner = $("banner");
  if (!message) { show(banner, false); banner.textContent = ""; bannerText = ""; return; }
  banner.textContent = String(message)
    .replace(/^Error invoking remote method '[^']*':\s*/, "")
    .replace(/^Error:\s*/, "");
  bannerText = banner.textContent;
  banner.className = kind === "warn" ? "banner warn" : kind === "success" ? "banner success" : "banner";
  show(banner, true);
}

function announce(message) {
  var live = $("live");
  live.textContent = "";
  window.setTimeout(function () { live.textContent = message; }, 20);
}

// ------------------------------------------------------------------- state

var state = null;
var activeRegion = "cn";
/** Trae's and Qoder's own region rows; WorkBuddy's stays in `activeRegion`. */
var activeSourceRegion = { trae: "cn", qoder: "cn" };

/** The region one source's page currently shows. */
function activeRegionOf(source) {
  return source === "workbuddy" ? activeRegion : (activeSourceRegion[source] || "cn");
}

/** Remember one source's region; the draft follows it (see renderModels). */
function setActiveRegion(source, region) {
  if (source === "workbuddy") activeRegion = region;
  else activeSourceRegion[source] = region;
}
/**
 * Unsaved model edits, one per page (source + region).
 *
 * A single slot threw the edits away the moment the user looked at another page:
/**
 * The growth centre's last read, and whether one is in flight.
 *
 * The host keeps the result and hands it back with the status document, so a
 * repaint or a fresh panel paints the figures it already has; a *read* is only
 * issued when those figures are gone or old. Holding the read only here meant
 * every panel reload asked the user to go press a button to see what had just
 * been on screen.
 */
var growthState = null;
var growthReading = false;
/** The account whose delete button is armed, and the timer that disarms it. */
var pendingDelete = null;
var deleteTimer = 0;
var growthReadEpoch = 0;
/** How long a read stays current before entering the page refreshes it. */
var GROWTH_STALE_MS = 2 * 60 * 1000;

/** True when the figures on this card are gone, old, or older than the last run. */
function growthStale() {
  if (growthState === null) return true;
  var readAt = typeof growthState.readAt === "number" ? growthState.readAt : null;
  if (readAt === null) return true;
  // A run since the read spent what the rows describe, so they are stale even
  // when they are only a moment old. The scheduled pass records its growth half
  // inside `autoCheckin.last.growth`, so the run time comes from the same place
  // the log line does - reading only `growth.last` missed it and kept showing
  // the figures from before the pass that just spent them.
  var last = growthLastRun();
  var ranAt = last ? Date.parse(last.at) : NaN;
  if (Number.isFinite(ranAt) && ranAt > readAt) return true;
  // A read stamped in the future is a clock that moved, not a fresh read: it
  // would otherwise never age, and the card would keep a stale figure forever.
  if (readAt > Date.now() + GROWTH_STALE_MS) return true;
  return Date.now() - readAt > GROWTH_STALE_MS;
}
/** Which growth rows are expanded, keyed by account id. */
var openGrowth = {};
var growthDestinations = new Map();
// Keep the acting account row at the same viewport offset while its details reload.
var growthScrollReturn = null;
var growthScrollVersion = 0;

/**
 * The model sheet's draft: the edits of the models ticked on the roster.
 *
 * Held in a slot rather than in one object, because the draft is rebuilt from
 * the saved selection whenever the key changes, so the ticks were gone on the
 * way back and nothing said so. Inside a slot the key is still the id set the
 * draft was built from, so a catalog that gains or loses a model rebuilds it
 * rather than reusing a shape it knows nothing about.
 */
var drafts = {};
/** model id -> { enabled, alias, window, output, images, levels, defaultLevel, open } */
var draft = null;
/** The page `draft` belongs to, so discarding drops that page's edits alone. */
var draftSlot = null;
var busy = null;           // id of the control awaiting a response
var checkinBusy = null;
// Set when the host answers "still running" to a batch claim. The polling loop
// clears the banner once the pass lands, so it does not say "checking in" for
// the rest of the session.
var checkinBusyNote = false;
/** Set while a panel login is waiting on the browser, so its button reads as busy. */
var loginBusy = false;
/** The URL of the login in flight, so the button can offer it again. */
var loginUrl = "";
/** Timer id of the poll loop; cleared when a login ends or the page goes away. */
var loginTimer = 0;
var doctorResult = null;
/** Hours text typed but not yet saved, so a poll cannot overwrite it. */
var autoHoursDraft = null;
/** Account ids whose credit package list the user opened. Absent = collapsed. */
var openCredits = {};
/** The warning the header banner is currently showing, so it can be cleared. */
var headerWarning = "";
var reserveDrafts = {};

// ----------------------------------------------------------------- render

function regionLabel(region, short) {
  if (region === "global") return t("region.global");
  return t(short ? "region.cnShort" : "region.cn");
}

function accountsOf(region) {
  return (state && state.accounts ? state.accounts : []).filter(function (a) { return a.region === region; });
}

/**
 * A rate limit, as opposed to a hold the pool decided on its own.
 *
 * `cooling` is set for all three states, so a summary that counts it directly
 * tells the user to wait out a window that does not exist: a refused sign-in
 * needs a fresh login and a vendor restriction needs an appeal. Three summary
 * lines counted it directly and each read "cooling" over a parked account.
 */
function isCooling(account) {
  return account.cooling === true && account.hold !== "session" && account.hold !== "restricted";
}



function modelsOf(region) {
  return (state && state.models ? state.models : []).filter(function (m) { return m.region === region; });
}

function renderHeader() {
  var accounts = state ? state.accounts || [] : [];
  // A held sign-in is not a rate limit: counting it as cooling understated how
  // many accounts the pool had actually lost, and the summary read "0 cooling"
  // over a pool where half the rows could not answer.
  // Three states, three counts: a refused sign-in, a vendor restriction and a
  // rate limit all read as `cooling` upstream, and lumping them together told
  // the user to wait out a window that does not exist.
  var cooling = accounts.filter(isCooling).length;
  var refused = accounts.filter(function (a) { return a.hold === "session"; }).length;
  var restricted = accounts.filter(function (a) { return a.hold === "restricted"; }).length;
  // A pool whose every account is refused, restricted or switched off has
  // nobody to serve a turn, so the dot must not read healthy just because none
  // of them is cooling.
  var healthy = accounts.some(function (a) {
    return a.disabled !== true && !isCooling(a) && a.hold !== "session" && a.hold !== "restricted";
  });
  var refreshing = state !== null && state.refreshing === true;
  var dot = $("healthDot");
  dot.className = "dot " + (state === null ? "idle" : (healthy ? "ok" : "idle")) + (refreshing ? " busy" : "");
  // The progress line hangs off the fixed header, so the poll loop never
  // restarts its animation — the class only comes and goes.
  $("topBar").classList.toggle("refreshing", refreshing);

  $("barTitle").textContent = "WTQ Pool";
  var sub = state === null
    ? t("state.loading")
    : t("pool.summary", { count: accounts.length, cooling: cooling })
      + (refused > 0 ? " · " + t("pool.refused", { count: refused }) : "")
      + (restricted > 0 ? " · " + t("pool.restricted", { count: restricted }) : "");
  // The first paint comes from cache while detection runs behind it, so say so
  // instead of leaving the user to wonder why the numbers are not final yet.
  if (state && state.refreshing === true) sub = sub + " · " + t("state.refreshing");
  $("barSub").textContent = sub;

  iconLabel($("rescanBtn"), t("btn.rescan"));
  iconLabel($("resetBtn"), t("btn.reset"));
  iconLabel($("refreshBtn"), busy === "refresh" ? t("btn.refreshing") : t("btn.refresh"));
  $("rescanBtn").disabled = busy !== null;
  $("resetBtn").disabled = busy !== null;
  $("refreshBtn").disabled = busy !== null;
  // The host discovers a provider's models from this plugin's endpoint, so a
  // changed list usually lands by itself; the banner still fires when the
  // declaration could not be written at all, or when the saved selection no
  // longer matches the live roster (which is why a save can look ignored).
  //
  // Address drift outranks both: it is the state that surfaces to the user as
  // net::ERR_CONNECTION_REFUSED, and a model issue is invisible until it is
  // fixed anyway.
  var stale = state && state.staleSelectionRegions ? state.staleSelectionRegions : [];
  var warning = state && state.addressDrift === true ? t("models.addressDrift")
    : state && state.declaration && state.declaration.ok === false ? t("models.reload")
      : stale.length > 0 ? t("models.staleSelection", { region: regionLabel(stale[0], false) })
        : "";
  // Cleared, not just set: these conditions are all fixed from outside the panel
  // - a restart, a re-save - so a banner left standing after one of them goes
  // away would keep naming a problem the state document no longer reports. Only
  // the banner this pass itself last showed is cleared, so a message another
  // action put up is not wiped by the poll landing behind it.
  if (warning !== headerWarning || (warning !== "" && bannerText === "")) {
    headerWarning = warning;
    note(warning === "" ? null : warning, "warn");
  }
}

/** Whether one source is switched on in the document; an absent flag means off. */
function sourceOn(source) {
  return state !== null && (state.sources || {})[source] === true;
}
/** The selected source: the top-level tab, one page of every view at a time. */
var activeSource = "workbuddy";
/** Which view page is on screen; the growth tab is hidden off WorkBuddy. */
var activeTab = "pool";

/**
 * Mirror the source tabs onto everything that is per source: the pool's three
 * groups and the one model page. The model page reads the selected source
 * itself (see modelPage), so switching a tab only has to name it.
 */
function renderSourceTabs() {
  var tabs = document.querySelectorAll("#sourceTabs .tab");
  for (var i = 0; i < tabs.length; i += 1) {
    var on = tabs[i].getAttribute("data-source") === activeSource;
    tabs[i].classList.toggle("active", on);
    tabs[i].setAttribute("aria-pressed", on ? "true" : "false");
  }
  var groups = document.querySelectorAll("#poolView .source-group");
  for (var j = 0; j < groups.length; j += 1) {
    groups[j].hidden = groups[j].getAttribute("data-source") !== activeSource;
  }
  // The keep-alive renews WorkBuddy sign-ins only; leaving the card on Trae or
  // Qoder made it look as if "Refresh now" would touch that source's tokens.
  var keepAliveCard = $("keepAliveCard");
  if (keepAliveCard) keepAliveCard.hidden = activeSource !== "workbuddy";
  // The source tab owns the models view too, and a source tab click does not
  // run the whole render, so the model page and the footer - which names the
  // endpoint of the source on screen - are repainted from here.
  renderModelRegionTabs();
  renderModels();
  renderFooter();
  // The growth page is WorkBuddy's, so leaving that source has to take its tab
  // with it and drop back to the pool rather than leave a selected tab whose
  // view is the one just hidden.
  labelTabs();
  if (activeSource !== "workbuddy" && activeTab === "growth") selectTab("pool");
}

/**
 * Every region a source can have. The document lists only the active ones, and
 * a parked region has to stay visible - otherwise its own switch is the only
 * way back and it would have disappeared with the region.
 */
var SOURCE_REGIONS = { workbuddy: ["cn", "global"], trae: ["cn", "ai"], qoder: ["cn", "global"] };

/** Each source's display name, so its switch says which source it turns off. */
var SOURCE_TITLES = {
  workbuddy: "workbuddy.title",
  trae: "trae.title",
  qoder: "qoder.title",
};

/** Whether the user parked one region (国内版 / 国际版) of one source. */
function regionParked(source, region) {
  var parked = state && state.disabledRegions ? state.disabledRegions : [];
  return parked.indexOf(source + ":" + region) >= 0;
}

/** Park or unpark one source region; the plugin stops or starts that gateway. */
function setRegionEnabled(source, region, enabled) {
  return runBusy("region", function () {
    return invoke("xd.setRegionEnabled", { source: source, region: region, enabled: enabled });
  }).catch(function () {});
}

/** The 停用 / 启用 button a region carries at the bottom right of its content. */
function regionToggle(source, region) {
  var parked = regionParked(source, region);
  var name = sourceRegionLabel(region);
  var button = el("button", "small " + (parked ? "primary" : "park"),
    parked ? t("region.unpark", { region: name }) : t("region.park", { region: name }));
  button.type = "button";
  button.disabled = busy !== null;
  button.addEventListener("click", function () { setRegionEnabled(source, region, parked); });
  return button;
}

/**
 * A parked region's notice and its switch.
 *
 * The tag is a parameter rather than fixed because this block lands in two kinds
 * of container: the accounts column is a `div`, while the model roster is a
 * `ul` and only accepts list items.
 */
function parkedRegionBlock(source, region, tag) {
  var block = el(tag || "div", "empty");
  block.appendChild(el("p", null, t("region.parked", { region: sourceRegionLabel(region) })));
  block.appendChild(regionToggle(source, region));
  return block;
}

/** The bottom of one region's content: the switch that parks it. */
function regionFoot(source, region) {
  var foot = el("div", "region-foot");
  foot.appendChild(regionToggle(source, region));
  return foot;
}

/**
 * The bottom of one source's content: the switch that turns the whole source
 * off. It sits with the region switch rather than beside the title, where one
 * stray click switched three sources' worth of gateways off.
 */
function sourceFoot(source) {
  var foot = el("div", "source-switch");
  foot.appendChild(sourceToggle(source, state !== null && (state.sources || {})[source] === true));
  return foot;
}

/**
 * The region pills of one source: one entry per active region, with that
 * region's account count. Clicking one shows that region's accounts (and, for
 * WorkBuddy, that region's model roster).
 */
function fillRegionNav(nav, source, regions, accounts, active) {
  clear(nav);
  nav.setAttribute("role", "group");
  nav.setAttribute("aria-label", t("tabs.regions"));
  regions.forEach(function (region) {
    var on = region === active;
    var button = el("button", on ? "active" : "");
    button.type = "button";
    button.disabled = busy !== null;
    button.setAttribute("aria-pressed", on ? "true" : "false");
    button.textContent = sourceRegionLabel(region);
    if (regionParked(source, region)) button.appendChild(el("span", "muted", " " + t("region.parkedShort")));
    var count = accounts.filter(function (account) { return account.region === region; }).length;
    button.appendChild(el("span", "muted", " " + count));
    button.addEventListener("click", function () {
      setActiveRegion(source, region);
      render();
    });
    nav.appendChild(button);
  });
  return nav;
}

/** A fresh region row for a page that is rebuilt on every render. */
function sourceRegionNav(source, regions, accounts) {
  return fillRegionNav(el("div", "regions"), source, regions, accounts, activeRegionOf(source));
}

/**
 * Which of this source region's accounts serves its requests.
 *
 * Same shape as the pool's own picker: automatic, or one named account. The
 * gateways re-read their credentials per request, so the choice applies from
 * the next request on, without a reload.
 */
function sourcePreferredPicker(source, region, accounts) {
  var card = el("div", "card");
  var id = "sourceAccountChoice-" + source + "-" + region;
  var label = el("label", "field-label", t("acct.choose"));
  label.htmlFor = id;
  var picker = el("select", "text-input");
  picker.id = id;
  picker.setAttribute("aria-label", t("acct.choose"));
  var automatic = el("option", null, t("acct.automatic"));
  automatic.value = "";
  picker.appendChild(automatic);
  accounts.forEach(function (account) {
    var option = el("option", null, account.label);
    option.value = account.label;
    // Listed but not selectable: the host refuses an expired account as the
    // preferred one, so offering it turned a click into an error.
    if (account.expired === true) {
      option.disabled = true;
      option.textContent = account.label + " · " + t("acct.expired");
    }
    picker.appendChild(option);
  });
  var preferred = ((state[source] || {}).preferred || {})[region] || "";
  if (preferred !== "" && !accounts.some(function (account) { return account.label === preferred; })) {
    var missing = el("option", null, t("acct.unavailable"));
    missing.value = preferred;
    picker.appendChild(missing);
  }
  picker.value = preferred;
  picker.disabled = busy !== null || accounts.length === 0;
  picker.addEventListener("change", function () { setPreferredSourceAccount(source, region, picker.value); });
  card.appendChild(label);
  card.appendChild(picker);
  card.appendChild(distributionControl(source));
  return card;
}

/** Remember which account serves one source region; "" means automatic. */
function setPreferredSourceAccount(source, region, label) {
  return runBusy("source-account", function () {
    return invoke("xd.preferSourceAccount", { source: source, region: region, label: label });
  }).catch(function () {});
}
function sourceRegionLabel(region) {
  return region === "cn" ? t("region.cn") : t("region.global");
}

/** WorkBuddy's region row, in the pool page's own markup. */
function renderRegionTabs() {
  // Every region the source has, not only the running ones: a parked region has
  // to keep its own pill, or its switch would be unreachable.
  var regions = sourceOn("workbuddy") ? SOURCE_REGIONS.workbuddy : [];
  if (regions.length === 0) { activeRegion = ""; clear($("regionTabs")); return; }
  if (regions.indexOf(activeRegion) < 0) activeRegion = regions[0];
  fillRegionNav($("regionTabs"), "workbuddy", regions, (state && state.accounts) || [], activeRegion);
}

/**
 * The selected source's region row, on the model page.
 *
 * The editor works on one region's roster, so the region has to be switchable
 * where the roster is read, not only on the pool page - and it is the selected
 * source's row, because the page now serves all three.
 */
function renderModelRegionTabs() {
  if (!sourceOn(activeSource)) { clear($("modelRegionTabs")); return; }
  var source = activeSource;
  var accounts = source === "workbuddy"
    ? ((state && state.accounts) || [])
    : (((state || {})[source] || {}).accounts || []);
  fillRegionNav($("modelRegionTabs"), source, SOURCE_REGIONS[source], accounts, activeRegionOf(source));
}
function renderWorkbuddyHead() {
  var host = $("workbuddyHead");
  clear(host);
  if (state === null) return;
  var accounts = state.accounts || [];
  host.appendChild(el("strong", null, t("workbuddy.title")));
  host.appendChild(el("span", "muted", t("source.accountCount", { count: accounts.length })));

  // Collecting every reward is the reason a multi-account pool exists, so it is
  // one button rather than a click per account card. It acts on the whole pool,
  // so it stays while any region still has a campaign and goes when none does.
  var offerCheckin = accounts.some(function (account) {
    return account.checkin && (account.checkin.active === true || account.checkin.todayCheckedIn === true);
  });
  var claimable = accounts.filter(function (account) {
    return account.disabled !== true && account.checkin && account.checkin.active === true
      && account.checkin.todayCheckedIn !== true;
  }).length;
  if (offerCheckin) {
    var allButton = el("button", "ghost small checkin-all ic-calendar" + (checkinBusy === "all" ? " is-busy" : ""),
      checkinBusy === "all" ? t("pool.checkinAllBusy") : t("pool.checkinAll"));
    allButton.type = "button";
    allButton.title = t("pool.checkinAllHint");
    allButton.disabled = busy !== null || checkinBusy !== null || claimable === 0;
    allButton.addEventListener("click", claimAllCheckins);
    host.appendChild(allButton);
  }

  // Adding an account from here, rather than only from the desktop app: a user
  // with no WorkBuddy install on this machine had no way into the pool at all.
  // It sits beside the check-in button because it is the other action that
  // concerns every account rather than one. While a login is waiting it offers
  // the link again — the browser tab is the easiest thing to lose, and a login
  // whose URL is gone looks broken rather than unfinished.
  var addButton = el("button", "ghost small ic-plus" + (loginBusy ? " is-busy" : ""),
    loginBusy ? t("login.openAgain") : t("login.add"));
  addButton.type = "button";
  addButton.id = "loginAddBtn";
  addButton.title = t("login.addHint");
  addButton.disabled = busy !== null || checkinBusy !== null;
  addButton.addEventListener("click", loginBusy ? reopenLogin : startLogin);
  host.appendChild(addButton);
}

/** The pool's health line, minus the head row's summary and check-in button. */
function renderPoolStrip() {
  var strip = $("poolStrip");
  clear(strip);
  var accounts = accountsOf(activeRegion);
  var refused = accounts.filter(function (a) { return a.hold === "session"; }).length;
  var restricted = accounts.filter(function (a) { return a.hold === "restricted"; }).length;
  var off = accounts.filter(function (a) { return a.disabled === true; }).length;
  // Only the accounts that can serve a turn right now are counted. A
  // switched-off account is not rate-limited, and a refused sign-in is parked,
  // so counting either would read "every account is rate-limited" over a row
  // that also said "1 switched off". A pool whose serving accounts are all
  // cooling really does pause, and one with nothing switched on says so on the
  // line below rather than here.
  var usable = accounts.filter(function (a) { return a.disabled !== true && !a.cooling; }).length;
  var noteText = accounts.length === 0
    ? ""
    : off === accounts.length
      ? t("pool.allSwitchedOff")
      : usable <= 0
        ? (restricted > 0 && refused === 0 ? t("pool.allRestricted") : refused > 0 ? t("pool.allRefused") : t("pool.allCooling"))
        : "";
  if (noteText) strip.appendChild(el("span", "muted", noteText));
  if (refused > 0) strip.appendChild(el("span", "finding-fail", t("pool.refused", { count: refused })));
  if (restricted > 0) strip.appendChild(el("span", "finding-fail", t("pool.restricted", { count: restricted })));
  if (off > 0) strip.appendChild(el("span", "muted", t("pool.switchedOff", { count: off })));
}

/**
 * The button that turns a whole source off.
 *
 * It sits at the bottom of that source's content rather than beside the title,
 * where a stray click cannot switch the gateways off, and it names the source so
 * it cannot be read as a region's switch.
 */
function sourceToggle(source, on) {
  var label = t(on ? "source.disable" : "source.enable", { source: t(SOURCE_TITLES[source]) });
  var button = el("button", "small " + (on ? "park" : "primary"), label);
  button.type = "button";
  button.setAttribute("aria-pressed", on ? "true" : "false");
  button.disabled = busy !== null;
  button.addEventListener("click", function () { setSource(source, !on); });
  return button;
}

/** Shared head row for one non-pool source: its name and its own check-in pool. */
function sourceGroupHead(source, titleKey, count, claimable, busyHere, offerCheckin) {
  var head = el("div", "source-head");
  head.appendChild(el("strong", null, t(titleKey)));
  head.appendChild(el("span", "muted", t("source.accountCount", { count: count })));
  var allButton = el("button", "ghost small checkin-all ic-calendar" + (busyHere ? " is-busy" : ""),
    busyHere ? t("pool.checkinAllBusy") : t("pool.checkinAll"));
  allButton.type = "button";
  allButton.title = t("pool.checkinAllHint");
  allButton.disabled = busy !== null || checkinBusy !== null || claimable === 0
    || (state.sources || {})[source] !== true;
  allButton.addEventListener("click", function () { claimSourceCheckins(source); });
  if (offerCheckin !== false) head.appendChild(allButton);
  return head;
}

/**
 * Whether an account has a check-in surface worth drawing.
 *
 * An account whose upstream answer carries no round and no opening hour has
 * nothing to show: a disabled button and a "no check-in" line read as a broken
 * control, so the card has no check-in at all. `campaignsUnavailable` keeps the
 * surface for a failed read, which is a state to report rather than to hide.
 */
function checkinOffered(checkin) {
  return checkin !== undefined && checkin !== null
    && (checkin.active === true || checkin.todayCheckedIn === true
      || typeof checkin.opensAtHour === "number" || checkin.campaignsUnavailable === true);
}

/** One non-pool account card: its own quota figure and today's check-in. */
function sourceAccountCard(account, kind) {
  var card = el("div", "card account" + (account.expired ? " card-off" : ""));

  var head = el("div", "card-head");
  head.appendChild(el("span", "acct-label", account.label));
  if (account.email) head.appendChild(el("span", "muted", account.email));
  // Which app this sign-in came from: one Trae account keeps a copy in every
  // app it was signed into, and the scanner folds them into a single row.
  if (account.app && account.app !== account.label) head.appendChild(el("span", "muted", account.app));
  head.appendChild(el("span", "region-tag", kind === "trae"
    ? (account.region === "ai" ? t("region.global") : t("region.cn"))
    : (account.region === "global" ? t("region.global") : t("region.cn"))));
  head.appendChild(el("span", "badge " + (account.expired ? "off" : "ok"),
    account.expired ? t("source.expired") : t("badge.healthy")));
  card.appendChild(head);

  var meta = el("div", "model-meta");
  // Not beside a badge that already says the token is expired.
  if (account.expired !== true) meta.appendChild(tokenChip(account.expiresAt));
  card.appendChild(meta);

  // Quota reads like the pool's own card and is drawn by the same code: every
  // credit pool is a row with its own expiry, which is the only place the
  // check-in reward's date exists. Trae's international region bills by plan
  // rather than by credits, so its card shows the plan name instead.
  var usage = account.usage || {};
  if (usage.credits) {
    // `keepEmpty`: a source account shows every pool the route named — Qoder's
    // 0/0 plan included, because that row is the one that says it never
    // expires. The expansion is the same one the pool's cards have.
    card.appendChild(creditsBlock(usage.credits, sourceCheckinKey(kind, account), { keepEmpty: true }));
  } else {
    var plan = usage.plan || null;
    var quota = el("div", "credits");
    var quotaHead = el("div", "credits-head static");
    quotaHead.appendChild(el("span", "card-title", t("source.planTitle")));
    if (plan && plan.name) {
      quotaHead.appendChild(el("span", "credit-total", plan.name));
      if (plan.inTrial) quotaHead.appendChild(el("span", "badge free", t("source.planTrial")));
    } else {
      quotaHead.appendChild(el("span", "muted", t("source.quotaUnknown")));
    }
    quota.appendChild(quotaHead);
    card.appendChild(quota);
  }

  var checkin = account.checkin;
  if (checkinOffered(checkin)) {
    var row = el("div", "checkin");
    row.appendChild(el("span", "card-title", t("checkin.title")));
    // Trae allows one check-in per device per day, so an account can be unclaimed
    // while this machine's turn is already spent: the badge and the button then
    // say so instead of offering a click the upstream will refuse (9095).
    var doneToday = checkin.todayCheckedIn === true;
    var deviceDone = doneToday !== true && checkin.deviceCheckedIn === true;
    // The opening hour comes from the campaign list's own start, so the card
    // names it rather than claiming there is no check-in at all.
    var opensLabel = doneToday || deviceDone || typeof checkin.opensAtHour !== "number"
      ? ""
      : t("source.claimableAt", { time: clockHour(checkin.opensAtHour) });
    var badgeClass = "badge " + (doneToday ? "free" : deviceDone || opensLabel !== "" ? "next" : checkin.active ? "next" : "off");
    row.appendChild(el("span", badgeClass, doneToday
      ? t("source.checkedIn")
      : deviceDone ? t("source.deviceCheckedIn")
        : opensLabel !== "" ? opensLabel
          : checkin.campaignsUnavailable === true ? t("source.campaignUnknown")
            : t("source.claimable")));
    if (!doneToday && checkin.active && checkin.amount > 0) {
      row.appendChild(el("span", "muted", checkin.amount + " "
        + (checkin.unit === undefined || checkin.unit === "credits" ? t("credits.keepUnit") : checkin.unit)));
    }
    // The per-account claim the pool's own cards have; the source-wide button in
    // the head stays the one-click path for every account of this source.
    var busyHere = checkinBusy === sourceCheckinKey(kind, account);
    var idleLabel = doneToday ? t("btn.checkinDone")
      : deviceDone ? t("source.deviceCheckedIn")
        : opensLabel !== "" ? opensLabel
          : t("btn.checkin");
    var checkedIn = doneToday || deviceDone;
    var claim = el("button", "small " + (checkedIn ? "ic-check" : "primary ic-calendar") + (busyHere ? " is-busy" : ""),
      busyHere ? t("checkin.claiming") : idleLabel);
    if (checkedIn) iconLabel(claim, idleLabel);
    claim.type = "button";
    claim.setAttribute("aria-label", (busyHere ? t("checkin.claiming") : idleLabel) + ": " + account.label);
    claim.disabled = busyHere || checkinBusy !== null || busy !== null
      || checkin.active !== true || doneToday || deviceDone || opensLabel !== ""
      || account.expired === true;
    claim.addEventListener("click", function () { claimSourceCheckin(kind, account); });
    row.appendChild(claim);
    card.appendChild(row);
  }
  return card;
}

/** One Trae/Qoder gateway row flattened for the model pickers. */
function traeQoderGatewayRows() {
  var out = [];
  var trae = (state && state.trae) || {};
  var qoder = (state && state.qoder) || {};
  (Array.isArray(trae.gateways) ? trae.gateways : []).forEach(function (gateway) {
    out.push({ source: "trae", key: "trae:" + gateway.region, region: gateway.region, port: gateway.port,
      roster: Array.isArray(gateway.roster) ? gateway.roster : [], selection: gateway.selection || null, lastError: gateway.lastError });
  });
  (Array.isArray(qoder.gateways) ? qoder.gateways : []).forEach(function (gateway) {
    out.push({ source: "qoder", key: "qoder:" + gateway.region, region: gateway.region, port: gateway.port,
      roster: Array.isArray(gateway.roster) ? gateway.roster : [], selection: gateway.selection || null, lastError: gateway.lastError });
  });
  return out;
}

/** The one gateway row serving a source's region; null when it has none. */
function sourceGatewayRow(source, region) {
  var rows = traeQoderGatewayRows().filter(function (row) {
    return row.source === source && row.region === region;
  });
  return rows.length > 0 ? rows[0] : null;
}

/** One gateway's column title: its region, then the port it serves on. */
function gatewayLabel(row) {
  var region = row.source === "trae"
    ? (row.region === "ai" ? t("region.global") : t("region.cn"))
    : (row.region === "global" ? t("region.global") : t("region.cn"));
  return region + " · " + row.port;
}

/**
 * What the model page is editing: the selected source's selected region.
 *
 * One page serves all three sources, so everything that differs between them
 * is answered here rather than inside the renderers - which roster the left
 * column lists, what is stored for it, which key the save writes - and Trae
 * and Qoder get the pool's own editor instead of a second copy of it.
 */
function modelPage() {
  var source = activeSource;
  // The plugin reports how many models one provider may declare, so the panel
  // never keeps a number of its own that a later change could disagree with.
  var cap = Number(state && state.modelCap) > 0 ? Number(state.modelCap) : 0;
  if (source === "workbuddy") {
    return {
      source: source,
      region: activeRegion,
      label: t("models.serviceModels"),
      list: modelsOf(activeRegion),
      selection: ((state || {}).selectionByRegion || {})[activeRegion] || {},
      key: activeRegion,
      error: "",
      cap: cap,
    };
  }
  var row = sourceGatewayRow(source, activeRegionOf(source));
  if (row === null) {
    return { source: source, region: activeRegionOf(source), label: "", list: [], selection: {}, key: "", error: "", cap: cap };
  }
  return {
    source: source,
    region: row.region,
    label: gatewayLabel(row),
    list: row.roster,
    selection: row.selection || {},
    key: row.key,
    error: row.lastError || "",
    cap: cap,
  };
}

/**
 * Per-source strings and rules for the two non-pool sections.
 *
 * Trae and Qoder differ only in their wording and in which regions have a daily
 * check-in, so they share one renderer instead of two copies kept in step.
 */
var SOURCE_SECTIONS = {
  trae: { title: "trae.title", off: "trae.off", checkinRegions: ["cn"],
    note: "source.traeSlots", checkinNote: "source.traeCheckin" },
  qoder: { title: "qoder.title", off: "qoder.off", checkinRegions: ["cn", "global"],
    note: "source.qoderSlots" },
};

/**
 * One non-pool source's section: its region row, that region's account cards
 * with their own quota and check-in, then that region's gateway, and at the
 * bottom the switches - the region's own, and the source's.
 */
function renderSourceStrip(source) {
  var host = $(source + "Strip");
  clear(host);
  if (state === null) return;
  var section = SOURCE_SECTIONS[source];
  var info = state[source] || {};
  var accounts = Array.isArray(info.accounts) ? info.accounts : [];
  var regions = SOURCE_REGIONS[source];
  var on = sourceOn(source);
  var claimable = accounts.filter(function (account) {
    return !account.expired && section.checkinRegions.indexOf(account.region) >= 0 && account.checkin
      && account.checkin.active === true && account.checkin.todayCheckedIn !== true
      // A device that already claimed today leaves the other accounts nothing
      // to collect, so they must not be counted here either - the single
      // account rows grey their button out for the same reason.
      && account.checkin.deviceCheckedIn !== true;
  }).length;
  if (regions.indexOf(activeRegionOf(source)) < 0) setActiveRegion(source, regions[0]);
  var region = activeRegionOf(source);
  // The source-wide button follows the accounts of the region on screen: it
  // appears where one of them has a check-in surface, and stays off a region
  // whose accounts carry none, where it would read as an action on nothing.
  var offerCheckin = accounts.some(function (account) {
    return account.region === region && checkinOffered(account.checkin);
  });
  host.appendChild(sourceGroupHead(source, section.title, accounts.length, on ? claimable : 0,
    checkinBusy === source, offerCheckin));
  if (!on) {
    host.appendChild(el("p", "hint", t(section.off)));
    // The switch stays here while the source is off, because that is the only
    // state in which it is needed.
    host.appendChild(sourceFoot(source));
    return;
  }
  host.appendChild(sourceRegionNav(source, regions, accounts));
  var rules = section.note ? t(section.note) : "";
  if (section.checkinNote && section.checkinRegions.indexOf(region) >= 0) rules += "\n" + t(section.checkinNote);
  if (rules) host.firstChild.appendChild(helpNote(t(section.title), rules));
  if (regionParked(source, region)) {
    host.appendChild(parkedRegionBlock(source, region));
    host.appendChild(sourceFoot(source));
    return;
  }

  var mine = accounts.filter(function (account) { return account.region === region; });
  // Which account serves this region: the pool has the same control, so a source
  // with more than one sign-in in a region is not stuck with the first one.
  host.appendChild(sourcePreferredPicker(source, region, mine));
  if (mine.length === 0) host.appendChild(el("p", "hint muted", t("source.noAccounts")));
  if (mine.length > 0) {
    var list = el("div", "source-accounts");
    mine.forEach(function (account) { list.appendChild(sourceAccountCard(account, source)); });
    host.appendChild(list);
  }

  // The region's own switch sits at the bottom of its content.
  host.appendChild(regionFoot(source, region));
  host.appendChild(sourceFoot(source));
}

/** Collect today's reward for just one source's pool. */
function claimSourceCheckins(source) {
  if (busy !== null || checkinBusy !== null) return Promise.resolve();
  checkinBusy = source;
  render();
  return invoke("xd.checkinAll", { source: source }).then(function (payload) {
    checkinBusy = null;
    if (payload && payload.state) adopt(payload.state);
    note(null);
    render();
    if (payload && payload.running === true) {
      // The pass outlived the plugin's answer and is still collecting. Say so
      // on the visible page; the rows follow when it lands. If the pass never
      // started (another pass owns the accounts), the poll below clears the
      // banner immediately rather than leaving it up for the session.
      checkinBusyNote = true;
      note(t("pool.checkinAllBusy"));
      pollCheckinLog(0);
      return;
    }
    var counts = payload ? payload[source] : null;
    var claimed = counts && typeof counts.claimed === "number" ? counts.claimed : 0;
    var failed = counts && typeof counts.failed === "number" ? counts.failed : 0;
    // A failed round must not read as "every account is already checked in
    // today": the counts carry `failed` (and the reason), but a source whose
    // round threw carries none of its own. The missing number is a failure, not
    // "nothing to collect". The same answer has to be visible, not only announced.
    if (failed > 0) note(checkinFailureText(claimed, failed, counts && counts.reason), "warn");
    else if (claimed === 0) note(t("pool.checkinAllNone"));
    else announce(t("pool.checkinAllDone", { count: claimed }));
  }).catch(function (error) {
    checkinBusy = null;
    note(String(error && error.message ? error.message : error));
    render();
  });
}

/** How often a started login is polled while the browser has not finished. */
var LOGIN_POLL_MS = 3000;
/** How long the panel keeps polling before it tells the user to start again. */
var LOGIN_GIVE_UP_MS = 15 * 60 * 1000;

/**
 * Add a WorkBuddy account by signing in through the browser.
 *
 * The region is the one on screen: the pool is split by gateway, so an account
 * added here belongs to the region the user is looking at rather than to
 * whichever one the login page happens to default to.
 */
function startLogin() {
  if (busy !== null || checkinBusy !== null || loginBusy) return;
  var realm = activeRegion === "global" ? "global" : "cn";
  loginBusy = true;
  render();
  invoke("xd.startLogin", { realm: realm }).then(function (answer) {
    loginUrl = answer && typeof answer.authUrl === "string" ? answer.authUrl : "";
    if (loginUrl === "") throw new Error(t("login.noLink"));
    // This page is a real browser tab, so the link opens the way its own footer
    // links do: a new tab, leaving the panel where it is.
    window.open(loginUrl, "_blank", "noopener,noreferrer");
  }).then(function () {
    note(t("login.waiting"));
    pollLogin(realm, Date.now() + LOGIN_GIVE_UP_MS);
  }).catch(function (error) {
    loginBusy = false;
    note(String(error && error.message ? error.message : error));
    render();
  });
}

/**
 * Ask the plugin whether the browser has finished, and again shortly if not.
 *
 * The loop is the panel's own: the plugin holds no timer, so a page that is
 * closed stops asking instead of leaving a poll running against a state nobody
 * is watching.
 */
function pollLogin(realm, giveUpAt) {
  window.clearTimeout(loginTimer);
  loginTimer = window.setTimeout(function () {
    if (!loginBusy) return;
    if (Date.now() > giveUpAt) {
      loginBusy = false;
      note(t("login.timeout"));
      render();
      return;
    }
    invoke("xd.pollLogin", { realm: realm }).then(function (answer) {
      if (!loginBusy) return;
      if (answer && answer.status === "ok") {
        loginBusy = false;
        note(null);
        adopt(answer.state);
        render();
        announce(answer.nickname
          ? t("login.added", { name: answer.nickname })
          : t("login.addedNoName"));
        return;
      }
      pollLogin(realm, giveUpAt);
    }).catch(function (error) {
      loginBusy = false;
      note(String(error && error.message ? error.message : error));
      render();
    });
  }, LOGIN_POLL_MS);
}

/**
 * Offer the login link again.
 *
 * The browser tab is the easiest thing to lose — closed, or the click never
 * landed — and a login whose URL is gone looks broken rather than unfinished.
 */
function reopenLogin() {
  if (loginUrl === "") return;
  window.open(loginUrl, "_blank", "noopener,noreferrer");
}

/**
 * What to say when a check-in round reports failures.
 *
 * The counts alone cannot name the cause, and the upstream's own words are
 * worth more than "failed": the reason is appended when the host has one.
 */
function checkinFailureText(claimed, failed, reason) {
  var text = t("pool.checkinAllFailed", { count: claimed, failed: failed });
  return typeof reason === "string" && reason !== "" ? text + " · " + reason : text;
}

/** The busy key of one source account row: source, region and label together. */
function sourceCheckinKey(source, account) {
  return source + ":" + account.region + ":" + account.label;
}

/**
 * Collect one Trae/Qoder account's reward.
 *
 * The row names the account (source, region, label); the plugin re-reads the
 * account's own status before claiming, so a second click cannot collect twice.
 */
function claimSourceCheckin(source, account) {
  if (busy !== null || checkinBusy !== null) return Promise.resolve();
  checkinBusy = sourceCheckinKey(source, account);
  render();
  return invoke("xd.sourceCheckin", { source: source, label: account.label, region: account.region })
    .then(function (payload) {
      checkinBusy = null;
      if (payload && payload.state) adopt(payload.state);
      note(null);
      var result = payload && payload.result ? payload.result : {};
      // A skipped claim can carry the upstream's own reason (Trae answers 9095
      // "this device already checked in today"), which is worth reading. It is
      // shown on the visible page, not only announced to the screen reader, so
      // the button does not look inert.
      //
      // A click can also land on a row the automatic pass has already collected:
      // the host answers `skipped` with `todayCheckedIn`. The account is in the
      // state the click asked for, so that is a success here, not the "already
      // collected" wording that made the click look like it did nothing.
      if (result.outcome === "claimed" || result.todayCheckedIn === true) note(t("source.checkinDone"));
      else if (result.deviceCheckedIn === true) note(t("source.deviceCheckedIn"));
      else note(result.reason || t("source.checkinSkipped"));
      render();
    }).catch(function (error) {
      checkinBusy = null;
      note(String(error && error.message ? error.message : error));
      render();
    });
}

/**
 * The account-usage control of one source, built into that source's account
 * picker so the two choices sit together: which account serves this region,
 * and how requests spread while that choice is automatic.
 *
 * WorkBuddy's pool offers four modes; a Trae/Qoder gateway only reads an
 * ordered credential list, so those two offer the modes their ordering can
 * honour.
 */
function distributionControl(source) {
  var block = el("div", "dist-inline");
  block.appendChild(el("div", "field-label", t("dist.title")));
  var workbuddy = source === "workbuddy";
  var modes = workbuddy
    ? [["priority", "dist.priority"], ["round-robin", "dist.roundRobin"], ["expiry", "dist.expiry"], ["sticky", "dist.sticky"]]
    : [["priority", "dist.priority"], ["round-robin", "dist.roundRobin"], ["expiry", "dist.expiry"]];
  var current = (workbuddy
    ? (state && state.distribution)
    : (state && state[source] && state[source].distribution)) || "priority";
  var hintKeys = workbuddy
    ? { "round-robin": "dist.hintRoundRobin", expiry: "dist.hintExpiry", sticky: "dist.hintSticky" }
    : { "round-robin": "dist.hintSourceRoundRobin", expiry: "dist.hintSourceExpiry" };
  var seg = el("div", "seg");
  modes.forEach(function (pair) {
    var button = el("button", current === pair[0] ? "active" : "", t(pair[1]));
    button.type = "button";
    button.title = t(hintKeys[pair[0]] || (workbuddy ? "dist.hintPriority" : "dist.hintSourcePriority"));
    button.id = "distribution-" + source + "-" + pair[0];
    button.setAttribute("aria-pressed", current === pair[0] ? "true" : "false");
    button.disabled = busy !== null;
    button.addEventListener("click", function () { setDistribution(source, pair[0]); });
    seg.appendChild(button);
  });
  block.appendChild(seg);

  return block;
}


/**
 * The daily automatic check-in: one switch, one list of hours, one status line.
 *
 * The hours box is left alone while it has focus, so a state refresh (the panel
 * polls while a background pass runs) never eats what is being typed.
 *
 * The on/off buttons are static nodes for a sharper reason: rebuilt on every
 * render, a button destroyed while it holds focus loses it, and the browser then
 * scrolls the replacement into view — the shake every click produced. So they are
 * painted once here and only their state is updated.
 */
function renderAutoCheckin() {
  $("autoTitle").textContent = t("auto.title");
  var auto = (state && state.autoCheckin) || { enabled: false, hours: [9] };
  var host = $("autoControl");
  // Built once; afterwards only the state moves.
  if (host.childElementCount === 0) {
    [[true, "auto.on"], [false, "auto.off"]].forEach(function (pair) {
      var button = el("button", "", t(pair[1]));
      button.type = "button";
      button.setAttribute("data-auto", String(pair[0]));
      button.addEventListener("click", async function () {
        if (pair[0] && button.getAttribute("aria-pressed") !== "true" && !await confirmGrowth(t("auto.enableConfirm"))) return;
        setAutoCheckin(pair[0], parseCheckinHours($("autoHours").value));
      });
      host.appendChild(button);
    });
  }
  Array.prototype.forEach.call(host.children, function (button) {
    var on = button.getAttribute("data-auto") === "true";
    // The wording is repainted here rather than only at creation: these nodes
    // survive a language switch, and text set once would stay in the old one.
    button.textContent = t(on ? "auto.on" : "auto.off");
    button.className = auto.enabled === on ? "active" : "";
    button.setAttribute("aria-pressed", auto.enabled === on ? "true" : "false");
    button.disabled = busy !== null;
  });

  $("autoHoursLabel").textContent = t("auto.hours");
  var input = $("autoHours");
  input.placeholder = t("auto.hoursHint");
  if (document.activeElement !== input) {
    input.value = autoHoursDraft !== null ? autoHoursDraft : (auto.hours || []).join(",");
  }
  var save = $("autoHoursSave");
  iconLabel(save, t("auto.hoursSave"));
  save.disabled = busy !== null;
  // Not bound here: this button is a static node, so a listener added on every
  // render would outlive it and stack up - one click firing one request per
  // render the panel had ever drawn. The handler reads the hours field when it
  // runs, so binding it once in `bind` is enough.
  var run = $("autoRunNow");
  var pending = auto.last !== undefined && auto.last !== null && auto.last.pending === true;
  var passRunning = state !== null && state.growth !== undefined && state.growth !== null && state.growth.running === true;
  run.textContent = busy === "checkin" || pending || passRunning ? t("auto.running") : t("auto.runNow");
  run.title = t("auto.runNowHint");
  run.disabled = busy !== null || checkinBusy !== null || pending || passRunning;

  // The keep-alive row: one button, run by hand. It is a static node, so the
  // handler lives in `bind`. Its own card, its own log: it renews tokens rather
  // than collecting rewards and has no hour to set, so it shares nothing with
  // the schedule beside the accounts both walk. The head carries no second
  // reading of the last run - the row below already says when, and two labels
  // for one fact is how one of them ends up stale.
  var keepAliveRun = $("tokenKeepAliveRun");
  keepAliveRun.textContent = busy === "keepAlive" ? t("keepAlive.running") : t("keepAlive.runNow");
  keepAliveRun.disabled = busy !== null;
  $("keepAliveTitle").textContent = t("keepAlive.label");
  $("keepAliveHint").textContent = t("keepAlive.hint");
  $("autoHint").textContent = t("auto.hint");
  paintAutoNote($("autoNote"), { last: auto.last });
  paintKeepAliveNote($("keepAliveNote"), state && state.keepAlive);
}

/**
 * The composer readout switch, on its own card.
 *
 * A button rather than a checkbox: the button names the action it performs, so
 * "显示积分" while it is off and "隐藏积分" while it is on — which says both
 * what pressing it will do and which way it currently stands, and leaves no
 * second label in the card head saying the same thing again.
 *
 * Only painted here. The click handler lives in `bind`, because the button is a
 * static node: a listener added on every render would outlive the render that
 * added it and stack up, one request per pass the panel had ever drawn.
 */
function renderComposerPoints() {
  var on = state !== null && state.showComposerPoints === true;
  $("composerTitle").textContent = t("composer.title");
  var button = $("showComposerPoints");
  button.textContent = t(on ? "composer.hide" : "composer.show");
  button.className = "small ic-eye" + (on ? " on" : "");
  button.setAttribute("aria-pressed", on ? "true" : "false");
  button.disabled = busy !== null;
  $("composerPointsHint").textContent = t("composer.hint");
}

/**
 * The check-in log: one row per source, each with a state dot.
 *
 * A single line with separators was unreadable once three sources reported, so
 * each source gets its own row. The dot carries the outcome at a glance — green
 * when something was collected, amber when it was skipped, red when it failed —
 * and the numbers stay on the row for anyone who wants them.
 *
 * A manual run is marked as one: the scheduled pass fires at an hour nobody is
 * watching, so the row says which kind of run it is describing.
 */
function autoNoteRows(auto) {
  var last = auto.last;
  if (!last) return [{ text: t("auto.neverRun"), tone: "" }];
  // Opening stub: sources have not answered yet. A finished "0 accounts" row
  // here is what "run now" painted and then never replaced.
  if (last.pending === true && last.travel == null && last.qoder == null && last.trae == null) {
    return [{ text: t("auto.running"), tone: "" }];
  }
  var slot = String(last.slot).replace("T", " ");
  if (last.error) return [{ text: t("auto.lastFailedAt", { slot: slot, message: last.error }), tone: "fail" }];
  var rows = [];
  if (last.pending === true) rows.push({ text: t("auto.running"), tone: "" });
  // The head count is every source's claimed accounts, matching the rows
  // below; `last.claimed` alone is WorkBuddy's share and read as a total.
  var claimedTotal = (Number(last.claimed) || 0)
    + (last.qoder ? Number(last.qoder.claimed) || 0 : 0)
    + (last.trae ? Number(last.trae.claimed) || 0 : 0);
  rows.push({
    text: t(last.manual === true ? "auto.lastManual" : "auto.lastAuto",
      { slot: slot, count: claimedTotal }),
    tone: last.pending === true ? "" : "ok",
  });
  var push = function (label, counts) {
    if (!counts) return;
    var claimed = Number(counts.claimed) || 0;
    var failed = Number(counts.failed) || 0;
    var skipped = Number(counts.skipped) || 0;
    rows.push({
      text: t("auto.rowCounts", {
        label: label,
        claimed: claimed,
        skipped: skipped,
        failed: failed,
      }),
      tone: failed > 0 ? "fail" : claimed > 0 ? "ok" : skipped > 0 ? "skip" : "",
    });
  };
  var pushTravel = function (counts) {
    if (!counts) return;
    var claimed = Number(counts.claimed) || 0;
    rows.push({
      text: t("auto.rowTravelCounts", {
        label: t("auto.rowTravel"),
        departed: Number(counts.departed) || 0,
        claimed: claimed,
      }),
      tone: claimed > 0 ? "ok" : "",
    });
  };
  if (last.workbuddy !== false
    && (last.claimed !== undefined || last.skipped !== undefined || last.failed !== undefined)) {
    push(t("auto.rowWorkbuddy"), { claimed: last.claimed, skipped: last.skipped, failed: last.failed });
  }
  pushTravel(last.travel);
  if (last.growth) {
    var growth = last.growth;
    var detail = growth.detail || {};
    var streakTiers = Number(growth.streak) || 0;
    var lottery = num(detail.lottery, 0);
    var failed = num(detail.failed, 0) > 0 ? num(detail.failed, 0) : num(growth.failed, 0);
    rows.push({
      text: t("auto.rowGrowth", {
        streak: streakTiers,
        lottery: lottery,
        failed: failed,
      }),
      tone: failed > 0 ? "fail" : streakTiers > 0 || lottery > 0 ? "ok" : "",
    });
  }
  push(t("auto.rowQoder"), last.qoder);
  push(t("auto.rowTrae"), last.trae);
  return rows;
}

/**
 * The keep-alive's own line: what its last run did, and when.
 *
 * A duty of its own rather than a stage of the check-in pass, so it reports on
 * its own card and says when it last ran - on every path, including the ones
 * that have nothing to say about a check-in pass. Its record is the only proof
 * the button did anything, and a restart clears the pass log without touching
 * it.
 */
function keepAliveNoteRow(keepAlive) {
  if (!keepAlive) return null;
  return {
    text: t("auto.rowKeepAlive", {
      when: formatStamp(keepAlive.at),
      refreshed: Number(keepAlive.refreshed) || 0,
      fresh: Number(keepAlive.fresh) || 0,
      failed: Number(keepAlive.failed) || 0,
      noToken: Number(keepAlive.noToken) || 0,
    }),
    tone: Number(keepAlive.failed) > 0 || Number(keepAlive.noToken) > 0 ? "fail"
      : Number(keepAlive.refreshed) > 0 ? "ok" : "",
  };
}

/** Paint the keep-alive log as rows, so the caller does not build markup inline. */
function paintKeepAliveNote(host, keepAlive) {
  var atBottom = host.scrollTop + host.clientHeight >= host.scrollHeight - 4;
  var rowCount = host.childElementCount;
  clear(host);
  var row = keepAliveNoteRow(keepAlive);
  // No run yet leaves the box out of the card rather than drawing an empty
  // frame: the card head already says it has not run, and an empty bordered box
  // reads as a log that failed to load.
  host.hidden = row === null;
  if (row !== null) {
    var line = el("div", "log-line" + (row.tone ? " " + row.tone : ""));
    line.appendChild(el("span", "log-dot"));
    line.appendChild(el("span", "log-text", row.text));
    host.appendChild(line);
  }
  if (host.childElementCount !== rowCount || atBottom) host.scrollTop = host.scrollHeight;
}

/** Paint the check-in log as rows, so the caller does not build markup inline. */
function paintAutoNote(host, auto) {
  // A user who scrolled up to read an older line must not be pulled back to the
  // bottom by every 2 s poll; only a new pass (row count change) or a box that
  // was already at the bottom follows the tail.
  var atBottom = host.scrollTop + host.clientHeight >= host.scrollHeight - 4;
  var rowCount = host.childElementCount;
  clear(host);
  autoNoteRows(auto).forEach(function (row) {
    var line = el("div", "log-line" + (row.tone ? " " + row.tone : ""));
    line.appendChild(el("span", "log-dot"));
    line.appendChild(el("span", "log-text", row.text));
    host.appendChild(line);
  });
  if (host.childElementCount !== rowCount || atBottom) host.scrollTop = host.scrollHeight;
}

/** The tier status word, from the flat field the upstream reports it in. */
var STATUS_KEY = { claimed: "growth.tierClaimed", locked: "growth.tierLocked" };

/**
 * The growth centre, on its own page beside the pool and the models.
 *
 * Two buttons, because the two halves answer different questions: what the
 * centre holds right now (a read, safe to press any time) and what a pass
 * would collect (which spends a make-up card and a draw). Collapsing them into
 * one button would spend those two without showing them first.
 */
function renderGrowth() {
  $("growthTitle").textContent = t("growth.title");
  var growth = (state && state.growth) || {};
  var running = growth.running === true;
  $("growthState").textContent = running ? t("growth.running") : "";
  var read = $("growthRead");
  iconLabel(read, growthReading ? t("growth.reading") : t("growth.read"));
  read.title = t("growth.readHint");
  read.disabled = busy !== null || running || growthReading;
  var run = $("growthRun");
  run.textContent = busy === "growth" ? t("growth.running") : t("growth.run");
  run.title = t("growth.runHint");
  run.disabled = busy !== null || running || growthReading;
  if (running) pollGrowthRun();
  else stopGrowthPoll();
  $("growthText").textContent = growthStateText();
  var accounts = $("growthAccounts");
  var keep = placeOf(accounts);
  paintGrowthAccounts(accounts);
  restorePlace(accounts, keep);
  paintGrowthNote($("growthNote"));
}

/** The totals line above the rows, summed from the rows the read returned. */
function growthStateText() {
  // A run since the last read leaves the rows holding figures from before it, so
  // the stale wording names what to do rather than claiming nothing was read.
  if (growthState === null) {
    return t(growthLastRun() !== null ? "growth.stateStale" : "growth.stateNone");
  }
  // The scheduled pass records its growth half inside the pass it belongs to, so
  // the run time comes from the same place the log line does. Requiring
  // `state.growth.last` as well kept the stale wording off exactly that case: a
  // scheduled pass leaves no `growth.last` behind, so the card kept presenting
  // figures the pass had already spent as current.
  if (growthStale() && growthLastRun() !== null) return t("growth.stateStale");
  var rows = (growthState.rows || []).filter(function (row) { return row.failed !== true; });
  var sum = function (key) {
    return rows.reduce(function (total, row) { return total + num(row[key], 0); }, 0);
  };
  var parts = [t("growth.stateSummary", {
    accounts: num(growthState.accounts, 0),
    tiers: sum("tiers"),
    cards: sum("makeupCards"),
    chances: rows.some(function (row) { return row.lotteryError !== undefined; }) ? "—" : sum("lottery"),
  })];
  if (num(growthState.failed, 0) > 0) {
    parts.push(t("growth.stateFailed", { failed: num(growthState.failed, 0) }));
  }
  return parts.join(" · ");
}
/**
 * One account's row: a head carrying the account's own state and what it
 * holds, and a body with the tiers a run would collect.
 *
 * The expand/collapse is the credits block's own shape, reused rather than
 * restyled: a head button, a caret, and a body shown in place. Toggling in
 * place matters here too — a rebuild would drop the button that was clicked
 * and forget where the page was scrolled to.
 */
function growthRow(row) {
  var key = "growth:" + row.id;
  var open = openGrowth[key] === true;
  var wrap = el("div", "credits" + (open ? " open" : ""));

  var head = el("button", "credits-head");
  head.type = "button";
  head.id = "growth-row-" + row.id;
  head.setAttribute("aria-expanded", open ? "true" : "false");
  head.title = open ? t("credits.collapse") : t("credits.expand");
  // The realm is the group heading above the row, so the head opens with the
  // account's own state instead: unread, holding something a run would
  // collect, or holding nothing left.
  head.appendChild(el("span", "growth-dot" + growthRowTone(row)));
  head.appendChild(el("span", "card-title", row.label));
  var hasLottery = row.region === "cn";
  var lottery = row.lotteryError === undefined ? num(row.lottery, 0) : "—";
  var held = hasLottery
    ? t("growth.rowHold", { tiers: num(row.tiers, 0), cards: num(row.makeupCards, 0), chances: lottery })
    : t("growth.rowHoldNoLottery", { tiers: num(row.tiers, 0), cards: num(row.makeupCards, 0) });
  if (row.lotteryError !== undefined) held += " · " + row.lotteryError;
  var metrics = el("span", "growth-metrics");
  metrics.title = held;
  metrics.appendChild(el("span", "sr-only", held));
  var heldMetrics = [["gift", num(row.tiers, 0)], ["calendar", num(row.makeupCards, 0)]];
  if (hasLottery) heldMetrics.push(["dice", lottery]);
  heldMetrics.forEach(function (item) {
    var metric = el("span", "metric ic-" + item[0], String(item[1]));
    metric.setAttribute("aria-hidden", "true");
    metrics.appendChild(metric);
  });
  head.appendChild(metrics);
  head.appendChild(el("span", "caret", "›"));
  wrap.appendChild(head);

  var body = el("div", "credits-body");
  body.hidden = !open;
  if (row.failed === true) {
    body.appendChild(el("p", "hint warn", t("growth.rowFailed")));
  } else {
    if (num(row.days, 0) > 0 || row.nextTier) {
      body.appendChild(el("span", "growth-status growth-streak ic-activity", t(row.nextTier ? "growth.rowSummary" : "growth.rowDays", {
        days: num(row.days, 0),
        remaining: num(row.nextTierRemaining, 0),
      })));
    }
    body.appendChild(el("p", "field-label", t("growth.rowTiers")));
    var tiers = row.tierList || [];
    if (tiers.length === 0) {
      body.appendChild(el("p", "hint", t("growth.rowNothing")));
    }
    tiers.forEach(function (tier) {
      // A tier that can be redeemed now is the one line worth reading at a
      // glance, so it takes the log line's own dot and full-strength text.
      var ready = tier.status === "unlocked";
      var line = el("div", "growth-tier" + (ready ? " ok" : ""));
      var tierText = t("growth.rowTier", {
        days: num(tier.days, 0),
        credit: num(tier.credit, 0),
        energy: num(tier.energy, 0),
      });
      line.appendChild(el("strong", "", t("growth.tierDays", { days: num(tier.days, 0) })));
      var rewards = el("span", "growth-metrics");
      rewards.title = tierText;
      rewards.appendChild(el("span", "sr-only", tierText));
      [["coins", tier.credit], ["activity", tier.energy]].forEach(function (item) {
        if (num(item[1], 0) === 0) return;
        var metric = el("span", "metric ic-" + item[0], "+" + item[1]);
        metric.setAttribute("aria-hidden", "true");
        rewards.appendChild(metric);
      });
      line.appendChild(rewards);
      if (!ready) {
        var status = t(STATUS_KEY[tier.status] || "growth.tierLocked");
        var mark = el("span", "tier-state metric ic-" + (tier.status === "claimed" ? "check" : "lock"));
        mark.title = status;
        mark.appendChild(el("span", "sr-only", status));
        line.appendChild(mark);
      }
      if (ready) {
        var claim = growthButton(row, t("growth.claim"), "streak", tier.tier);
        claim.className += " tier-claim";
        claim.setAttribute("aria-label", t("growth.claim") + " · " + tierText + " · " + row.label);
        line.appendChild(claim);
      }
      body.appendChild(line);
    });
  }
  paintGrowthExtras(body, row);
  wrap.appendChild(body);

  head.addEventListener("click", function () {
    var shown = openGrowth[key] !== true;
    openGrowth[key] = shown;
    wrap.className = "credits" + (shown ? " open" : "");
    head.setAttribute("aria-expanded", shown ? "true" : "false");
    head.title = shown ? t("credits.collapse") : t("credits.expand");
    body.hidden = !shown;
    if (shown) {
      if (!row.details) loadGrowthDetails(row);
      render();
    }
  });
  return wrap;
}

/**
 * The row head's state, as a class suffix: a read that failed, a holding a
 * run would collect something from, or nothing left to collect.
 */
function growthRowTone(row) {
  if (row.failed === true) return " fail";
  var held = num(row.tiers, 0) + num(row.makeupCards, 0) + num(row.lottery, 0);
  return held > 0 ? " ok" : "";
}

/**
 * The account rows, grouped by realm, or the note that says the centre is not
 * this source's.
 *
 * The two editions claim on different schedules and hold different cards, so
 * they are split under their own heading rather than mixed into one list
 * where the realm was a badge on each row.
 */
function paintGrowthAccounts(host) {
  clear(host);
  if (activeSource !== "workbuddy") {
    host.appendChild(el("p", "hint", t("growth.onlyWorkbuddy")));
    return;
  }
  if (growthState === null) return;
  var rows = growthState.rows || [];
  if (rows.length === 0) {
    host.appendChild(el("p", "hint", t("source.noAccounts")));
    return;
  }
  var order = SOURCE_REGIONS.workbuddy.slice();
  rows.forEach(function (row) {
    if (order.indexOf(row.region) < 0) order.push(row.region);
  });
  order.forEach(function (region) {
    var group = rows.filter(function (row) { return row.region === region; });
    if (group.length === 0) return;
    var head = el("p", "growth-group", regionLabel(region));
    head.appendChild(el("span", "muted", t("growth.groupCount", { count: group.length })));
    host.appendChild(head);
    group.forEach(function (row) { host.appendChild(growthRow(row)); });
  });
}

/** The last growth run, whichever entry point started it. */
function growthLastRun() {
  var growth = (state && state.growth) || {};
  var auto = (state && state.autoCheckin) || {};
  var scheduled = auto.last && auto.last.growth ? { at: auto.last.at, ...auto.last.growth, travel: auto.last.travel } : null;
  if (!growth.last) return scheduled;
  if (!scheduled) return growth.last;
  // The scheduled pass and a manual run both leave a record. Taking
  // `growth.last` unconditionally showed the older one after a pass.
  var manualAt = Date.parse(growth.last.at);
  var scheduledAt = Date.parse(scheduled.at);
  if (!Number.isFinite(scheduledAt)) return growth.last;
  if (!Number.isFinite(manualAt)) return scheduled;
  return scheduledAt > manualAt ? scheduled : growth.last;
}

/** Paint the growth log as rows, the way the check-in log above it is painted. */
function paintGrowthNote(host) {
  var atBottom = host.scrollTop + host.clientHeight >= host.scrollHeight - 4;
  var rowCount = host.childElementCount;
  clear(host);
  var run = growthLastRun();
  if (run === null) return;
  var detail = run.detail || {};
  var when = formatStamp(run.at);
  var credit = num(run.credit, 0);
  var rows = [];
  if (credit > 0 || num(detail.makeup, 0) + num(detail.streak, 0) + num(detail.lottery, 0) > 0) {
    rows.push({
      text: t("growth.runLine", {
        when: when,
        credit: credit,
        makeup: num(detail.makeup, 0),
        streak: num(detail.streak, 0),
        lottery: num(detail.lottery, 0),
      }),
      tone: "ok",
    });
  }
  var travel = run.travel || {};
  var departed = num(travel.departed, 0);
  var claimed = num(travel.claimed, 0);
  if (departed > 0 || claimed > 0) {
    rows.push({ text: t("auto.rowTravelCounts", { label: t("auto.rowTravel"), departed: departed, claimed: claimed }), tone: "ok" });
  }
  var failed = (num(detail.failed, 0) || num(run.failed, 0)) + num(travel.failed, 0);
  if (failed > 0) {
    rows.push({ text: t("growth.runFailed", { when: when, failed: failed }), tone: "fail" });
  }
  if (rows.length === 0) rows.push({ text: t("growth.runNone"), tone: "" });
  rows.forEach(function (row) {
    var line = el("div", "log-line" + (row.tone ? " " + row.tone : ""));
    line.appendChild(el("span", "log-dot"));
    line.appendChild(el("span", "log-text", row.text));
    host.appendChild(line);
  });
  if (host.childElementCount !== rowCount || atBottom) host.scrollTop = host.scrollHeight;
}

/** Ask the host what the growth centre holds, claiming nothing. */
function growthButton(row, label, action, value, confirmText) {
  var icon = { streak: "check", travelClaim: "gift", lottery: "dice" }[action];
  var button = el("button", (["streak", "travelClaim"].includes(action) ? "small primary" : "small") + (icon ? " ic-" + icon : ""), label);
  button.type = "button";
  button.disabled = busy !== null || growthReading || !!(state && state.growth && state.growth.running);
  button.setAttribute("aria-label", label + " · " + row.label);
  button.addEventListener("click", function () { runGrowthAction(row, action, value, confirmText); });
  return button;
}

async function runGrowthAction(row, action, value, confirmText) {
  if (busy !== null || growthReading) return;
  if (confirmText && !await confirmGrowth(confirmText)) return;
  var rowHead = document.getElementById("growth-row-" + row.id);
  var growthReturnY = rowHead ? rowHead.getBoundingClientRect().top : 0;
  growthScrollVersion += 1;
  var growthReturn = { id: row.id, y: growthReturnY, version: growthScrollVersion };
  growthScrollReturn = growthReturn;
  var message;
  await runBusy("growth-action", async function () {
    try {
      var answer = await invoke("xd.growthAction", { id: row.id, action: action, value: value });
      var receipt = answer.result;
      var credit = Number(receipt.credit_granted ?? receipt.reward_credit ?? receipt.credit ?? 0);
      message = receipt.prize_name || t("growth.actionDone", { credit: credit });
      if (action === "travelDepart") message = t("growth.travelSent");
      if (action === "makeup") message = t("growth.makeupDone");
      if (receipt.prize_type === "physical") message += " · " + t("growth.physicalPrize");
    } finally {
      growthState = null;
      await readGrowth();
    }
  }).then(function () {
    note(message, "success");
    announce(message);
    restoreGrowthScroll(growthReturn);
  }).catch(function (error) {
    note(String(error.message || error));
    if (growthScrollReturn && growthScrollReturn.id === row.id) {
      restoreGrowthScroll(growthScrollReturn);
      growthScrollReturn = null;
    }
  });
}

function confirmGrowth(message) {
  return new Promise(function (resolve) {
    var dialog = el("dialog", "growth-confirm");
    dialog.setAttribute("aria-label", t("growth.confirmTitle"));
    dialog.appendChild(el("h2", "", t("growth.confirmTitle")));
    dialog.appendChild(el("p", "", message));
    var form = el("form", "growth-actions");
    form.method = "dialog";
    var cancel = el("button", "ghost", t("growth.cancel"));
    cancel.value = "cancel";
    cancel.autofocus = true;
    var accept = el("button", "", t("growth.confirm"));
    accept.value = "accept";
    form.append(cancel, accept);
    dialog.appendChild(form);
    dialog.addEventListener("close", function () {
      var accepted = dialog.returnValue === "accept";
      dialog.remove();
      resolve(accepted);
    }, { once: true });
    document.body.appendChild(dialog);
    dialog.showModal();
  });
}

function loadGrowthDetails(row) {
  if (row.detailsLoading) return;
  row.detailsLoading = true;
  var returnVersion = growthScrollReturn && growthScrollReturn.id === row.id
    ? growthScrollReturn.version : null;
  invoke("xd.growthDetails", { id: row.id }).then(function (answer) {
    row.details = answer.details;
  }).catch(function (error) {
    row.details = { errors: { details: String(error.message || error) } };
  }).finally(function () {
    row.detailsLoading = false;
    if (growthState && growthState.rows.includes(row)) render();
    if (returnVersion !== null && growthScrollReturn
      && growthScrollReturn.id === row.id && growthScrollReturn.version === returnVersion) {
      restoreGrowthScroll(growthScrollReturn);
      growthScrollReturn = null;
    }
  });
}

function paintGrowthExtras(body, row) {
  if (!openGrowth["growth:" + row.id]) return;
  if (!row.details) {
    body.appendChild(el("p", "hint", t("growth.reading")));
    loadGrowthDetails(row);
    return;
  }
  var details = row.details;
  var errors = details.errors || {};
  var heading = el("div", "growth-section-head");
  heading.appendChild(el("h3", "", t("growth.calendar")));
  var refresh = el("button", "small ghost ic-refresh");
  iconLabel(refresh, t("growth.read"));
  refresh.type = "button";
  refresh.disabled = row.detailsLoading;
  refresh.addEventListener("click", function () { loadGrowthDetails(row); });
  heading.appendChild(refresh);
  body.appendChild(heading);
  if (details.heatmap) paintGrowthCalendar(body, row, details.heatmap);

  var travel = details.travel || {};
  var trip = travel.status;
  if (trip && details.buddy) {
    var section = el("div", "growth-section");
    var travelHead = el("div", "growth-section-head");
    travelHead.appendChild(el("h3", "", t("auto.rowTravel")));
    if (trip.state === "traveling") {
      travelHead.appendChild(el("span", "growth-status traveling ic-route", t("growth.traveling", {
        place: trip.location && trip.location.name || "",
        time: trip.arrive_at ? formatStamp(new Date(Number(trip.arrive_at) * 1000).toISOString()) : "—",
      })));
    } else if (trip.state === "arrived") {
      travelHead.appendChild(el("span", "growth-status arrived ic-check", t("growth.travelArrived")));
    } else if (trip.state === "idle") {
      if (trip.daily_limit_reached) {
        travelHead.appendChild(el("span", "growth-status limit ic-calendar", t("growth.travelLimit")));
      } else {
        travelHead.appendChild(el("span", "growth-status ready ic-route", t("growth.travelReady")));
      }
    }
    section.appendChild(travelHead);
    if (trip.state === "arrived") {
      var claim = el("div", "growth-actions growth-travel-actions");
      claim.appendChild(growthButton(row, t("growth.travelClaim"), "travelClaim"));
      section.appendChild(claim);
    } else if (trip.state === "idle" && !trip.daily_limit_reached
      && Array.isArray(travel.locations) && travel.locations.length) {
      var controls = el("div", "growth-travel-controls");
      var label = el("label", "growth-destination ic-pin");
      var select = el("select", "");
      select.id = "growth-destination-" + row.id;
      label.htmlFor = select.id;
      label.appendChild(el("span", "sr-only", t("growth.destination")));
      var destination = growthDestinations.get(row.id);
      travel.locations.forEach(function (location) {
        var option = el("option", "", location.name);
        option.value = location.id;
        if (option.value === destination) option.selected = true;
        select.appendChild(option);
      });
      select.addEventListener("change", function () { growthDestinations.set(row.id, select.value); });
      var depart = el("button", "ic-send growth-depart", t("growth.depart"));
      depart.type = "button";
      depart.disabled = busy !== null || growthReading || !!(state && state.growth && state.growth.running);
      depart.addEventListener("click", function () {
        runGrowthAction(row, "travelDepart", Number(select.value),
          t("growth.departConfirm", { place: select.selectedOptions[0].textContent }));
      });
      label.appendChild(select);
      controls.append(label, depart);
      section.appendChild(controls);
    }
    body.appendChild(section);
  }
  if (details.lottery && details.lottery.module && details.lottery.module.enabled && Number(details.lottery.chances) > 0) {
    var actions = el("div", "growth-actions");
    actions.appendChild(growthButton(row, t("growth.draw", { count: details.lottery.chances }), "lottery", undefined, t("growth.drawConfirm")));
    body.appendChild(actions);
  }
  if (Object.keys(errors).length > 0) body.appendChild(el("p", "hint warn", t("growth.detailsFailed")));
}

function paintGrowthCalendar(host, row, heatmap) {
  var today = heatmap.today && heatmap.today.date || new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
  var month = today.slice(0, 7);
  var cells = new Map((heatmap.cells || []).map(function (cell) { return [cell.date.slice(0, 10), cell]; }));
  var days = new Date(Number(month.slice(0, 4)), Number(month.slice(5)), 0).getDate();
  var grid = el("div", "growth-calendar");
  for (var index = 1; index <= days; index++) {
    var date = month + "-" + String(index).padStart(2, "0");
    var cell = cells.get(date);
    var active = !!cell && Number(cell.score) > 0;
    var canMakeup = !active && date < today && row.makeupCards > 0;
    var day = canMakeup ? growthButton(row, "", "makeup", date, t("growth.makeupConfirm", { date: date })) : el("span", "");
    day.className = "growth-day" + (active ? " logged-in" : "");
    var status = t(active ? "growth.loggedIn" : date > today ? "growth.futureDay" : "growth.notLoggedIn");
    day.title = date + " · " + status + (canMakeup ? " · " + t("growth.makeup") : "");
    if (canMakeup) day.setAttribute("aria-label", day.title);
    else day.appendChild(el("span", "sr-only", day.title));
    grid.appendChild(day);
  }
  host.appendChild(grid);
}


function readGrowth() {
  // `growthReading` alone, not the panel-wide `busy`: a finished run re-reads
  // its own rows from inside `runBusy`, while `busy` still says "growth".
  if (growthReading) return Promise.resolve();
  growthReading = true;
  render();
  return invoke("xd.growthState").then(function (answer) {
    growthReading = false;
    if (answer.readEpoch >= growthReadEpoch) {
      growthReadEpoch = answer.readEpoch;
      growthState = answer.growth;
    }
    render();
  }).catch(function (error) {
    growthReading = false;
    note(String(error && error.message ? error.message : error));
    render();
  });
}

/** Run the growth centre on its own. */
function runGrowth() {
  if (busy !== null || growthReading) return Promise.resolve();
  growthPollFailures = 0;
  return runBusy("growth", function () {
    return invoke("xd.growthRun").then(function (payload) {
      // The run answers with the document beside its own counts, and this card
      // is its only reader: `runBusy` adopts a bare document, which this answer
      // is not. Adopting it here keeps the pool, the models and the check-in
      // card following the pass like every other run.
      if (payload && payload.state) adopt(payload.state);
      if (payload && payload.running === true) {
        // The pass outran the answer and is still going: the card follows it
        // through the document, exactly like the check-in pass.
        announce(t("growth.running"));
        return payload;
      }
      // The pass just spent whatever the state line was describing, so the
      // rows are read again rather than left showing what is now collected.
      return readGrowth();
    });
  }).catch(function (error) {
    var message = String(error && error.message ? error.message : error);
    note(/BUSY|already running/i.test(message) ? t("growth.busy") : message);
  });
}
function renderAccounts() {
  var host = $("accounts");
  // Every control in here repaints this column, and the column has no scroller
  // of its own — it rides in the document. Without recording the offset first,
  // expanding a credits detail near the bottom of a long list flings the page
  // back to the first card. Same record-and-restore the roster pane uses.
  var keep = placeOf(host);
  paintAccounts(host);
  restorePlace(host, keep);
}

function paintAccounts(host) {
  clear(host);
  // The first paint has no document yet. Answering with nothing left the column
  // blank below the header, which read the same as a source with no accounts.
  if (state === null) {
    host.appendChild(el("div", "empty", t("state.loading")));
    host.firstChild.setAttribute("aria-busy", "true");
    return;
  }
  var accounts = accountsOf(activeRegion);
  // A parked region has no accounts to show: it says so, and offers its switch.
  if (activeRegion !== "" && regionParked("workbuddy", activeRegion)) {
    host.appendChild(parkedRegionBlock("workbuddy", activeRegion));
    host.appendChild(sourceFoot("workbuddy"));
    return;
  }
  var preferred = (state && state.preferredAccountIds && state.preferredAccountIds[activeRegion]) || "";
  var choice = el("div", "card");
  var label = el("label", "field-label", t("acct.choose"));
  label.htmlFor = "accountChoice";
  var picker = el("select", "text-input");
  picker.id = "accountChoice";
  picker.setAttribute("aria-label", t("acct.choose"));
  var automatic = el("option", null, t("acct.automatic"));
  automatic.value = "";
  picker.appendChild(automatic);
  // A switched-off account cannot be the preferred one: the pool would keep
  // asking for an id it is not allowed to hand out.
  var selectable = accounts.filter(function (account) { return account.disabled !== true; });
  selectable.forEach(function (account) {
    var title = account.label;
    if (account.credits && Number.isFinite(account.credits.total)) {
      title = t("acct.choiceCredits", { label: title, credits: account.credits.total.toLocaleString() });
    }
    var option = el("option", null, title);
    option.value = account.id;
    picker.appendChild(option);
  });
  if (preferred && !selectable.some(function (account) { return account.id === preferred; })) {
    var missing = el("option", null, t("acct.unavailable"));
    missing.value = preferred;
    picker.appendChild(missing);
  }
  picker.value = preferred;
  picker.disabled = busy !== null || (selectable.length === 0 && preferred === "");
  picker.addEventListener("change", function () { setPreferredAccount(picker.value); });
  choice.appendChild(label);
  choice.appendChild(picker);
  choice.appendChild(distributionControl("workbuddy"));
  host.appendChild(choice);
  if (accounts.length === 0) {
    var empty = el("div", "empty");
    if (!sourceOn("workbuddy")) {
      empty.appendChild(el("p", null, t("pool.sourceOff")));
    } else {
      empty.appendChild(el("p", null, t("pool.emptyRegion", { region: regionLabel(activeRegion, false) })));
      empty.appendChild(el("p", "hint", t("pool.emptyHint")));
    }
    host.appendChild(empty);
    renderRemoved(host);
    if (activeRegion !== "") host.appendChild(regionFoot("workbuddy", activeRegion));
    host.appendChild(sourceFoot("workbuddy"));
    return;
  }
  accounts.forEach(function (account) { host.appendChild(accountCard(account)); });
  renderRemoved(host);
  // The region's own switch sits at the bottom of its content.
  if (activeRegion !== "") host.appendChild(regionFoot("workbuddy", activeRegion));
  host.appendChild(sourceFoot("workbuddy"));
}

/**
 * Accounts the user removed, each with a button that brings it back.
 *
 * Shown because "remove" would otherwise be a one-way door: the account stops
 * being scanned, so there is nothing left in the account list to click.
 */
function renderRemoved(host) {
  var removed = (state && state.removedAccounts ? state.removedAccounts : []).filter(function (entry) {
    return entry.region === activeRegion;
  });
  if (removed.length === 0) return;
  var card = el("div", "card removed");
  var head = el("div", "card-head");
  head.appendChild(el("span", "card-title", t("removed.title")));
  head.appendChild(el("span", "count-chip", String(removed.length)));
  card.appendChild(head);
  removed.forEach(function (entry) {
    var row = el("div", "removed-row");
    row.appendChild(el("span", "removed-label", entry.label));
    var restore = el("button", "pane-action ic-rewind", t("removed.restore"));
    restore.type = "button";
    restore.disabled = busy !== null;
    restore.addEventListener("click", function () { setAccountState(entry.id, "restored"); });
    row.appendChild(restore);
    card.appendChild(row);
  });
  host.appendChild(card);
}

function accountCard(account) {
  var off = account.disabled === true;
  // The upstream refused this sign-in and a forced refresh could not save it.
  // The row says so in its own words: the account is not waiting out a window,
  // and only a new sign-in brings it back.
  var refused = account.hold === "session";
  var restricted = account.hold === "restricted";

  // Listed but out of rotation: the app overwrote this account's sign-in with
  // the next one, so the card stays readable but says why it is not picked.
  var archived = account.archived === true;
  var card = el("div", "card account" + (off ? " card-off" : ""));

  var head = el("div", "card-head");
  head.appendChild(el("span", "acct-label", account.label));
  head.appendChild(el("span", "region-tag", regionLabel(account.region, true)));
  if (account.active) {
    head.appendChild(el("span", "badge next", t("badge.next")));
  }
  if (account.preferred && !account.active) head.appendChild(el("span", "badge next", t("badge.preferred")));
  // An archived account keeps serving, so its badge reports the same health as
  // any other; the note below the head says where its sign-in now comes from.
  head.appendChild(el("span", "badge " + (off ? "off" : refused ? "dead" : restricted || account.cooling ? "cool" : "ok"),
    off ? t("acct.off") : refused ? t("badge.revoked") : restricted ? t("badge.restricted") : account.cooling ? t("badge.cooling") : t("badge.healthy")));

  // "Not right now" and "not mine any more" are different decisions, so they
  // stay separate controls: a switch the user flips, and a plain remove button.
  var controls = el("div", "acct-controls");
  // Greys only while an action is actually touching an account. Following the
  // whole-panel `busy` would grey every row during a refresh or a doctor pass
  // and drop the labels to a contrast the muted text could not carry.
  // Any action in flight, not just the account ones: `setAccountState` answers a
  // press made while another control is busy with "nothing" - it returns without
  // even raising the busy banner - so a row that stayed enabled was a press that
  // did nothing and said nothing, on the delete button of all places.
  var rowBusy = busy !== null;
  // A row control carries its own id because the focus hand-back has nothing else
  // to go on: the labels are the same on every row ("remove" four times over),
  // and the fallback that matches by label put the ring on the first row's button
  // when the user had pressed the fifth. See `locateControl`.
  var rowKey = "acct-" + account.id;
  var toggle = el("button", "acct-toggle" + (off ? "" : " on"));
  toggle.id = rowKey + "-toggle";
  toggle.type = "button";
  toggle.setAttribute("role", "switch");
  toggle.setAttribute("aria-checked", off ? "false" : "true");
  // The name a switch carries is the property it controls and does not change
  // with its state; the visible label already says which state it is in.
  toggle.setAttribute("aria-label", t("acct.inPool") + ": " + account.label);
  toggle.title = off ? t("acct.switchOn") : t("acct.switchOff");
  toggle.disabled = rowBusy;
  toggle.appendChild(el("span", "acct-toggle-dot"));
  toggle.addEventListener("click", function () { setAccountState(account.id, off ? "enabled" : "disabled"); });
  controls.appendChild(toggle);

  var removeBtn = el("button", "acct-remove ic-minus");
  iconLabel(removeBtn, t("acct.remove"));
  removeBtn.id = rowKey + "-remove";
  removeBtn.type = "button";
  removeBtn.setAttribute("aria-label", t("acct.remove") + ": " + account.label);
  removeBtn.title = t("acct.removeHint");
  removeBtn.disabled = rowBusy;
  removeBtn.addEventListener("click", function () { setAccountState(account.id, "removed"); });
  controls.appendChild(removeBtn);
  // Only a sign-in this plugin wrote can be deleted. A desktop app's own file
  // is never offered this: removing it would sign the user out of that app, so
  // the pool-level "remove" above is as far as it goes.
  if (account.own === true) {
    // Irreversible, and unlike "remove" there is no list to restore from, so the
    // second press is what confirms it. `window.confirm` cannot be used here: the
    // panel runs in a sandboxed page, where Electron answers a script dialog by
    // returning false without showing anything - the button looked live and
    // deleted nothing, every time.
    //
    // The armed state lives here rather than on the button: a poll repaint rebuilds
    // the row every 1.2-2 s, and a flag written onto the node was gone before the
    // second press arrived, so every press re-armed instead of deleting.
    var armed = pendingDelete === account.id;
    var deleteBtn = el("button", armed ? "acct-delete confirming ic-trash" : "acct-delete ic-trash", t("acct.deleteConfirmAgain"));
    if (!armed) iconLabel(deleteBtn, t("acct.delete"));
    deleteBtn.id = rowKey + "-delete";
    deleteBtn.type = "button";
    deleteBtn.setAttribute("aria-label", t(armed ? "acct.deleteConfirmAgain" : "acct.delete") + ": " + account.label);
    deleteBtn.title = t("acct.deleteHint");
    deleteBtn.disabled = rowBusy;
    deleteBtn.setAttribute("aria-pressed", armed ? "true" : "false");
    deleteBtn.addEventListener("click", function () {
      if (pendingDelete !== account.id) {
        pendingDelete = account.id;
        note(t("acct.deleteConfirm", { name: account.label }), "warn");
        // Repaint the list, not just the account picker: the label has to change
        // to say what the next press does, or the second press looks like the
        // first one failing.
        renderAccounts();
        // A press that is never followed up must not arm the row forever.
        if (deleteTimer !== 0) clearTimeout(deleteTimer);
        deleteTimer = setTimeout(function () {
          deleteTimer = 0;
          if (pendingDelete !== account.id) return;
          pendingDelete = null;
          // The banner still names the account that is no longer armed, so it
          // reads as "the next press deletes this" beside a button that has gone
          // back to its first-press label. Cleared only while it is still that
          // prompt: anything the user has done since is not this timer's to erase.
          if (bannerText === t("acct.deleteConfirm", { name: account.label })) note("");
          renderAccounts();
        }, 8000);
        return;
      }
      // Checked before the arming is consumed: `setAccountState` answers a busy
      // panel by returning without a word, so clearing the arming first would turn
      // this press into "did nothing, said nothing" - the exact symptom the two-press
      // shape exists to remove. The row is disabled while busy anyway; this is the
      // press that slips in between the click and the repaint.
      if (busy !== null) {
        note(t("err.busy"), "warn");
        return;
      }
      if (deleteTimer !== 0) { clearTimeout(deleteTimer); deleteTimer = 0; }
      pendingDelete = null;
      setAccountState(account.id, "deleted");
    });
    controls.appendChild(deleteBtn);
  }
  head.appendChild(controls);
  card.appendChild(head);

  if (archived) head.appendChild(helpNote(t("risk.title"), t("acct.archivedHint")));
  if (refused) card.appendChild(el("div", "acct-alert hint finding-fail", t("acct.signInRefused")));
  if (restricted) card.appendChild(el("div", "acct-alert hint finding-fail", t("acct.restrictedHint")));

  var meta = el("div", "model-meta");
  // Not beside a badge that already says the token is expired.
  if (account.expired !== true) meta.appendChild(tokenChip(account.expiresAt));
  if (account.cooling && account.cooldownUntil) {
    // A hold is not a rate limit: it names the moment the pool stops waiting,
    // not a window the upstream set.
    meta.appendChild(el("span", "finding-fail", t(refused ? "acct.holdUntil" : restricted ? "acct.restrictedUntil" : "acct.coolUntil", { time: formatStamp(account.cooldownUntil) })));
  }
  if (num(account.rateLimitHits, 0) > 0 && !refused && !restricted) {
    meta.appendChild(el("span", null, t("acct.hits", { hits: account.rateLimitHits })));
  }
  if (!account.cooling) {
    (account.modelCooldowns || []).forEach(function (mc) {
      meta.appendChild(el("span", "finding-fail", t("acct.modelCool", { model: mc.modelId, time: formatStamp(mc.until) })));
    });
  }
  card.appendChild(meta);

  // A cold cache on the fast path: the main process has not read this
  // account's billing data yet, so say so instead of showing nothing.
  if (account.probePending === true) {
    card.appendChild(el("div", "hint muted", t("probe.pending")));
  } else if (refused) {
    // No read was spent on this account, so there is no credits figure and no
    // upstream error to show: the hold above is the whole story.
  } else if (account.creditsError) {
    card.appendChild(el("div", "hint finding-fail", t("credits.unavailable") + ": " + account.creditsError));
  } else if (account.credits) {
    card.appendChild(creditsBlock(account.credits, account.id, { floor: account }));
  }

  var checkinCard = checkinBlock(account);
  if (checkinCard) card.appendChild(checkinCard);
  return card;
}

/**
 * One account's credits: a head that keeps the total, a body that lists every
 * pool with its own expiry, collapsed until asked for.
 *
 * A pool usually holds several accounts and each one carries a handful of
 * packages, so an always-open list pushes the second account off the screen for
 * numbers nobody reads twice. The header keeps what the eye wants — the total —
 * and the rest waits behind it. The open set lives in `openCredits`, keyed by
 * whatever identifies the account: a pool's id, or a source row's own key.
 *
 * A pool account and a source account read the same, so both come through here.
 * Two differences are passed in rather than branched on: the floor input is a
 * pool setting a source account does not have, and a pool hides a pack that has
 * nothing left in it while a source account shows every pool the route named —
 * Qoder's plan on a free account is 0/0, and that row is the one that says it
 * never expires.
 */
function creditsBlock(credits, key, options) {
  var settings = options || {};
  var open = openCredits[key] === true;
  var wrap = el("div", "credits" + (open ? " open" : ""));

  // Same rule as the upstream parser: a pack with nothing left in it is not
  // shown and not counted. `remain`, not `size` — a drained 50-credit month has
  // a size of 50 and would otherwise survive this filter as an empty row.
  var packages = (credits.packages || []).filter(function (pack) {
    return settings.keepEmpty === true || !(typeof pack.remain === "number" && pack.remain <= 0);
  });

  var head = el("button", "credits-head");
  head.type = "button";
  head.setAttribute("aria-expanded", open ? "true" : "false");
  head.title = open ? t("credits.collapse") : t("credits.expand");
  head.appendChild(el("span", "card-title", t("credits.title")));
  if (typeof credits.total === "number") {
    head.appendChild(el("span", "credit-total", formatCredits(credits.total)));
  }
  var nearestExpiry = typeof credits.nearestExpiryMs === "number" && credits.nearestExpiryMs > Date.now()
    ? credits.nearestExpiryMs
    : null;
  for (var packageIndex = 0; packageIndex < packages.length; packageIndex += 1) {
    var pack = packages[packageIndex];
    var packExpiry = [pack.roundExpiresAtMs, pack.expiresAtMs].find(function (value) {
      return typeof value === "number" && value > Date.now();
    });
    if (packExpiry && (nearestExpiry === null || packExpiry < nearestExpiry)) nearestExpiry = packExpiry;
  }
  if (nearestExpiry !== null) {
    var expirySoon = nearestExpiry - Date.now() < PACK_SOON_MS;
    head.appendChild(el("span", "credit-expiry ic-calendar" + (expirySoon ? " soon" : ""),
      t("credits.expiresAt", { date: formatDayStamp(nearestExpiry) })));
  }
  if (packages.length > 0) {
    head.appendChild(el("span", "count-chip ic-coins", String(packages.length)));
  }
  if (settings.floor) {
    var reserve = num(settings.floor.creditReserve, 0);
    if (reserve > 0) {
      head.appendChild(el("span", "badge keep", t("credits.keepBadge", { credits: reserve.toLocaleString() })));
    }
  }
  head.appendChild(el("span", "caret", "›"));
  wrap.appendChild(head);

  head.addEventListener("click", function () {
    // Toggled in place, not repainted: a rebuild removes the very button the
    // click used, and the page then forgets where it was scrolled to — the
    // accounts column has no scroller of its own. The state is read back on
    // every click, because this handler outlives the render that built it.
    var shown = openCredits[key] !== true;
    openCredits[key] = shown;
    wrap.className = "credits" + (shown ? " open" : "");
    head.setAttribute("aria-expanded", shown ? "true" : "false");
    head.title = shown ? t("credits.collapse") : t("credits.expand");
    body.hidden = !shown;
  });
  var body = el("div", "credits-body");
  body.hidden = !open;
  packages.forEach(function (pack) { body.appendChild(packRow(pack)); });
  if (typeof credits.expiringSoon === "number" && credits.expiringSoon > 0) {
    body.appendChild(el("div", "hint warn",
      t("credits.expiringSoon", { amount: credits.expiringSoon.toLocaleString() })));
  }
  // The floor is an account setting, not a package detail, so it stays available
  // even when the billing read came back empty.
  if (settings.floor) body.appendChild(reserveRow(settings.floor));
  wrap.appendChild(body);
  return wrap;
}

/**
 * The credit floor for one account: an explicit save, not a blur side effect.
 *
 * The field is a draft; Save only lights up once the number differs from what
 * the host last reported, and the outcome is shown next to the button instead of
 * being written silently.
 */
function reserveRow(account) {
  var saved = num(account.creditReserve, 0);
  var wrap = el("div", "reserve");
  var label = el("label", "reserve-label", t("credits.keepAtLeast"));
  var input = document.createElement("input");
  input.type = "number";
  input.min = "0";
  input.step = "1";
  input.className = "reserve-input";
  input.id = "reserve-" + account.id;
  input.value = reserveDrafts[account.id] === undefined ? String(saved) : reserveDrafts[account.id];
  input.setAttribute("aria-label", t("credits.keepAtLeast"));
  input.disabled = busy !== null;
  var unit = el("span", "reserve-unit", t("credits.keepUnit"));
  var button = el("button", "reserve-save ic-check");
  iconLabel(button, t("credits.keepSave"));
  button.type = "button";
  button.id = "reserve-save-" + account.id;

  var parsed = Number(input.value);
  var next = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
  var dirty = next !== saved;
  button.disabled = busy !== null || !dirty;
  input.addEventListener("input", function () {
    reserveDrafts[account.id] = input.value;
    var value = Number(input.value);
    next = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
    button.disabled = busy !== null || next === saved;
  });
  button.addEventListener("click", function () { setCreditReserve(account.id, next); });
  input.addEventListener("keydown", function (event) {
    if (event.key === "Enter" && !button.disabled) setCreditReserve(account.id, next);
  });

  wrap.appendChild(label);
  wrap.appendChild(input);
  wrap.appendChild(unit);
  wrap.appendChild(button);
  wrap.appendChild(helpNote(t("credits.keepAtLeast"), t("credits.keepHint")));
  return wrap;
}

/** One package line: name, remaining/size, and when it refreshes or expires. */
function packRow(pack) {
  var row = el("div", "pack");
  // A pool the upstream does not name arrives as a locale key instead of a
  // name, so the row still reads in the reader's language.
  row.appendChild(el("span", "pack-name", pack.nameKey === undefined ? (pack.packageName || "—") : t(pack.nameKey)));
  var remain = pack.remain === undefined ? "?" : String(pack.remain);
  var size = pack.size === undefined ? "?" : String(pack.size);
  row.appendChild(el("span", "pack-num", t("credits.package", { remain: remain, size: size })));
  row.appendChild(packWhen(pack));
  return row;
}

/**
 * The window an expiry is worth flagging, shared by a pack's own date and the
 * account-wide one so both light up together.
 */
var PACK_SOON_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * The deadline that matters for one package.
 *
 * A monthly pack never expires — it refills — so its cycle rollover is the
 * date worth showing; a one-off pack gets its expiry, flagged while it is
 * inside the three-day window the summary counts. Some pools state a rule
 * instead of a date ("valid N days after the claim"), and one says it never
 * expires at all; both are answers, so neither renders as a blank.
 *
 * A pool the upstream only reports as a sum still gets a date when the newest
 * round that fed it states one: the check-in pool is a pile of rounds, each
 * living a fixed number of days from its own claim, and the latest round's
 * date is the only one the API answers for. It is labelled as that round's, so
 * the row never claims the whole pool dies on that day.
 */
function packWhen(pack) {
  if (typeof pack.roundExpiresAtMs === "number" && pack.roundExpiresAtMs > 0) {
    // Only a round that is still live can be "soon". Without the lower bound an
    // expiry already in the past rendered as expiring, permanently, so a row
    // nobody can spend kept its warning badge.
    var roundSoon = pack.roundExpiresAtMs > Date.now()
      && pack.roundExpiresAtMs - Date.now() < PACK_SOON_MS;
    return el("span", roundSoon ? "pack-when pack-soon" : "pack-when",
      t("credits.roundExpires", { date: formatDayStamp(pack.roundExpiresAtMs) }));
  }
  if (typeof pack.validDays === "number" && pack.validDays > 0) {
    return el("span", "pack-when", t("credits.validDays", { days: pack.validDays }));
  }
  if (pack.monthly === true) {
    if (typeof pack.refreshAtMs !== "number" || pack.refreshAtMs <= 0) {
      return el("span", "pack-when", t("credits.monthly"));
    }
    return el("span", "pack-when", t("credits.refreshAt", { time: formatDayStamp(pack.refreshAtMs) }));
  }
  if (pack.neverExpires === true) return el("span", "pack-when", t("credits.noExpiry"));
  if (typeof pack.expiresAtMs !== "number" || pack.expiresAtMs <= 0) return el("span", "pack-when", "");
  // Same lower bound as the round above: an expiry already in the past is not
  // "soon", it is spent, and without this a stale row kept its warning badge.
  var soon = pack.expiresAtMs > Date.now() && pack.expiresAtMs - Date.now() < PACK_SOON_MS;
  return el("span", soon ? "pack-when pack-soon" : "pack-when", t("credits.expiresAt", {
    date: formatDayStamp(pack.expiresAtMs),
  }));
}

function checkinBlock(account) {
  // A held sign-in is not read at all, so an error here would be the previous
  // read's; the account card already carries the hold and its remedy.
  if (account.checkinError && account.hold !== "session") {
    var failed = el("div", "checkin");
    failed.appendChild(el("span", "card-title", t("checkin.title")));
    failed.appendChild(el("span", "hint finding-fail", account.checkinError));
    return failed;
  }
  var checkin = account.checkin;
  // A region without a daily campaign reports no active check-in. Drawing the
  // title, a "no check-in" line and a disabled button for it only makes the
  // card look broken, so the whole block stays away.
  if (!checkin || (checkin.active !== true && checkin.todayCheckedIn !== true)) return null;

  var wrap = el("div", "checkin");
  wrap.appendChild(el("span", "card-title", t("checkin.title")));

  if (checkin.streakDays > 0) wrap.appendChild(el("span", "muted", t("checkin.streak", { days: checkin.streakDays })));
  if (!checkin.todayCheckedIn && checkin.dailyCredit > 0) wrap.appendChild(el("span", "muted", t("checkin.daily", { credit: checkin.dailyCredit })));
  // The milestone line names the day the bonus lands on, which is what upstream
  // reports as `nextStreakDay`; the bonus is granted when that day arrives.
  if (checkin.isStreakDay && checkin.streakBonusCredit > 0) {
    var milestone = checkin.nextStreakDay > 0 ? checkin.nextStreakDay : checkin.streakDays;
    wrap.appendChild(el("span", "badge free", t("checkin.bonus", { days: milestone, credit: checkin.streakBonusCredit })));
  }

  var busyHere = checkinBusy === account.id;
  // Upstream ships the button's own label when the campaign renames it.
  var idleLabel = checkin.todayCheckedIn ? t("btn.checkinDone") : t("btn.checkin");
  var button = el("button", "small " + (checkin.todayCheckedIn ? "ic-check" : "primary ic-calendar") + (busyHere ? " is-busy" : ""), busyHere ? t("checkin.claiming") : idleLabel);
  if (checkin.todayCheckedIn) iconLabel(button, idleLabel);
  button.type = "button";
  button.setAttribute("aria-label", (busyHere ? t("checkin.claiming") : idleLabel) + ": " + account.label);
  // A whole-pool claim is in flight: this account is covered by it, so the
  // per-account button must not fire a second claim.
  button.disabled = checkin.todayCheckedIn || busyHere || busy !== null || checkinBusy !== null;
  button.addEventListener("click", function () { claimCheckin(account.id); });
  wrap.appendChild(button);

  if (checkin.todayCheckedIn && checkin.todayCredit > 0) {
    wrap.appendChild(el("span", "muted", t("checkin.claimed", { credit: checkin.todayCredit })));
  }
  return wrap;
}

/**
 * Where a control sat, and what would identify it after a rebuild.
 *
 * Rebuilding a column replaces every control in it — including the one a click
 * just focused. Chromium answers that removal by dropping the column's scroll
 * to the top and focus to <body>, so ticking a row near the end of a long
 * roster flings the pane back to the first row. Record the scroller offset and
 * where focus sat, then look both up again once the host is repopulated. A
 * column with no scroller of its own (the accounts one) rides along in the
 * document, and that offset travels with it too.
 */
function placeOf(host) {
  var active = document.activeElement;
  var keep = { line: host.scrollTop, page: pageScroll(), place: null };
  if (!active || !host.contains(active)) return keep;
  keep.place = controlRecord(active, host);
  return keep;
}

/**
 * The record that finds `node` again inside `host` after a rebuild.
 *
 * By identity where the control has an id, by position where the population is
 * unchanged, and by label otherwise — most controls here are built fresh on
 * every render and never carry an id, so the label is the only handle a later
 * pass has on the one the user actually pressed. Null for a control that is
 * none of the three kinds this panel focuses.
 */
function controlRecord(node, host) {
  var kind = node.tagName === "INPUT" ? "input"
    : node.tagName === "SELECT" ? "select"
      : node.tagName === "BUTTON" ? "button" : null;
  if (!kind) return null;
  var group = host.querySelectorAll(kind);
  // A whole-panel render changes how many buttons exist, so an index recorded
  // before it can point at a different control afterwards — the focus would land
  // on the wrong button, which reads as the panel jumping somewhere the user
  // never clicked. The id, and failing that the label, is what survives that.
  var id = typeof node.id === "string" && node.id !== "" ? node.id : "";
  return {
    kind: kind,
    at: Array.prototype.indexOf.call(group, node),
    total: group.length,
    id: id,
    label: id === "" ? (node.textContent || "").trim() : "",
  };
}

/**
 * The control a record names, or null when this pass did not rebuild it.
 *
 * The id is matched by scanning the group rather than by building a `#id`
 * selector: the ids here are derived from account ids, and one holding a
 * character CSS reads specially would make the selector throw mid-render.
 */
function locateControl(host, place) {
  if (!place) return null;
  var group = host.querySelectorAll(place.kind);
  if (place.id !== "") {
    for (var at = 0; at < group.length; at += 1) {
      if (group[at].id === place.id) return group[at];
    }
  }
  if (group.length === place.total) return group[place.at] || null;
  if (place.label === "") return null;
  for (var i = 0; i < group.length; i += 1) {
    if ((group[i].textContent || "").trim() === place.label) return group[i];
  }
  return null;
}

function restorePlace(host, keep) {
  host.scrollTop = keep.line;
  pageScrollTo(keep.page);
  if (!keep.place) return;
  var again = locateControl(host, keep.place);
  if (!again || !again.focus) return;
  // A control disabled by the very render pass that just ran cannot take focus:
  // the browser refuses it, the focus falls to the body, and the panel reads as
  // having jumped. There is no synchronous way around it — clearing `disabled`
  // for the focus call does not make the element focusable, and neither does a
  // temporary `tabindex` — so the focus is simply left where it is in that case.
  // The shake itself is still gone, because the scroll position is restored
  // above; what is lost is the focus ring on a control the user just pressed and
  // which is now inert anyway.
  if (again.disabled === true) return;
  again.focus({ preventScroll: true });
}

/**
 * The button, input or select an event landed on.
 *
 * Both the pointer and the keyboard path need the same answer: most controls are
 * rebuilt on every render, so the element itself cannot be the memory.
 */
function controlUnder(node) {
  while (node && node !== document.body) {
    if (node.tagName === "BUTTON" || node.tagName === "INPUT" || node.tagName === "SELECT") return node;
    node = node.parentNode;
  }
  return null;
}

/**
 * The control the user last pressed, so a render pass that disabled it can hand
 * the focus back once it is live again. See `render`.
 */
var lastPressed = null;

/**
 * Record a press, for the focus hand-back in `render`.
 *
 * The whole locator is kept, not just the id: most controls here are built
 * fresh on every render and never carry one, so an id-only memory silently
 * skipped exactly the buttons the hand-back exists for.
 */
function notePress(node) {
  var body = document.body;
  lastPressed = node && body && body.contains(node) ? controlRecord(node, body) : null;
}

/** The document's own offset: a column with no scroller rides along in it. */
function pageScroll() {
  var root = document.scrollingElement || document.documentElement || document.body;
  return root && typeof root.scrollTop === "number" ? root.scrollTop : 0;
}

function pageScrollTo(top) {
  var root = document.scrollingElement || document.documentElement || document.body;
  if (root) root.scrollTop = top;
}

function restoreGrowthScroll(anchor) {
  if (!anchor) return;
  function restore() {
    var head = document.getElementById("growth-row-" + anchor.id);
    if (head) pageScrollTo(pageScroll() + head.getBoundingClientRect().top - anchor.y);
  }
  restore();
  requestAnimationFrame(restore);
}

/**
 * The roster view: one checkbox per model, the host's own layout.
 *
 * The heading carries a select-all box (indeterminate while only some rows are
 * ticked), the fetch button - the pool only, because a scan is what re-reads
 * its catalog - and a search restricted to id / name / alias.
 */
function renderModels() {
  var page = modelPage();
  var list = page.list;
  // The draft is keyed on the gateway and the exact set of ids it was built
  // from: the first render runs before any state has arrived, and a catalog
  // that gains or loses a model has to rebuild it, while a plain refresh of
  // the same list leaves the user's unsaved edits alone. Each page keeps its
  // own slot, so looking at another region and coming back returns to the ticks
  // that were left there rather than to the saved selection.
  var key = page.source + "\u0000" + page.key + "\u0000"
    + list.map(function (model) { return model.id; }).sort().join("\u0000");
  var slot = page.source + "\u0000" + page.key;
  if (drafts[slot] === undefined) {
    drafts[slot] = { key: key, draft: draftFor(list, page.selection) };
  } else if (drafts[slot].key !== key) {
    // The roster changed under an open draft (a catalog refresh, a fetch): keep
    // the user's unsaved ticks and overrides for every id that survived, and
    // start newly listed ids from the saved selection. Replacing the whole
    // draft silently discarded edits the savebar was still offering to save.
    var fresh = draftFor(list, page.selection);
    Object.keys(fresh).forEach(function (id) {
      if (Object.prototype.hasOwnProperty.call(drafts[slot].draft, id)) fresh[id] = drafts[slot].draft[id];
    });
    drafts[slot] = { key: key, draft: fresh };
  }
  draft = drafts[slot].draft;
  draftSlot = slot;
  // Every render, not only a key change: the ceilings can shrink while the model
  // ids stay the same - one directory function failing is enough - and a draft is
  // allowed to outlive that. Idempotent, and it keeps what the field shows equal to
  // what the host would accept.
  list.forEach(function (model) {
    if (draft[model.id] !== undefined) reclampEntry(draft[model.id], model);
  });

  $("modelListTitle").textContent = page.label;
  show($("modelFetchBtn"), page.source === "workbuddy");
  iconLabel($("modelFetchBtn"), busy === "fetch" ? t("models.modelsLoading") : t("models.fetchModelList"));
  $("modelFetchBtn").disabled = busy !== null;
  $("modelSearch").placeholder = t("models.searchModel");
  // A placeholder is not an accessible name: it disappears as soon as the box
  // has text in it, so the field announced itself as an unlabelled search.
  $("modelSearch").setAttribute("aria-label", t("models.searchModel"));
  var filter = $("modelSearch").value.trim().toLowerCase();
  var host = $("models");
  var keep = placeOf(host);
  clear(host);
  var published = publishedModels(list, page.cap);
  paintPageHint(page, published);

  if (list.length === 0) {
    // A <ul> whose only child is a <div> is an empty list to a screen reader,
    // and the empty state sits 40px in because the list indentation applies to
    // it too. The roster's own rows are list items, so this is one as well.
    host.appendChild(regionParked(page.source, page.region)
      ? parkedRegionBlock(page.source, page.region, "li")
      : el("li", "empty", state === null ? t("state.loading") : emptyRosterText(page)));
    $("modelSelectAll").checked = false;
    $("modelSelectAll").indeterminate = false;
    $("modelSelectAll").disabled = true;
    restorePlace(host, keep);
    renderChosen();
    return;
  }

  var shown = list.filter(function (model) {
    if (!filter) return true;
    return String(model.id).toLowerCase().indexOf(filter) >= 0
      || String(model.name).toLowerCase().indexOf(filter) >= 0
      || String(model.alias || "").toLowerCase().indexOf(filter) >= 0;
  });
  if (shown.length === 0) host.appendChild(el("li", "empty", t("models.noMatch")));

  // The header box reflects the visible rows, matching the host: clearing the
  // search and ticking the box selects everything, filtering narrows it.
  var shownEnabled = shown.filter(function (model) { return draft[model.id] && draft[model.id].enabled; }).length;
  var selectAll = $("modelSelectAll");
  selectAll.disabled = busy !== null;
  selectAll.checked = shown.length > 0 && shownEnabled === shown.length;
  selectAll.indeterminate = shownEnabled > 0 && shownEnabled < shown.length;
  selectAll.title = selectAll.checked ? t("models.deselectAll") : t("models.selectAll");
  selectAll.setAttribute("aria-label", selectAll.title);

  shown.forEach(function (model) { host.appendChild(modelListRow(model, published)); });
  restorePlace(host, keep);
  renderChosen();
}

/** What an empty roster says, which is not the same for all three sources. */
function emptyRosterText(page) {
  if (!sourceOn(page.source)) {
  return t(page.source === "workbuddy" ? "pool.sourceOff" : SOURCE_SECTIONS[page.source].off);
  }
  if (page.source === "workbuddy") return t("models.empty");
  // An empty roster that carries a directory error is a failed read, not a
  // missing gateway: the two need opposite remedies, so they get their own
  // sentences instead of sharing one that is always half wrong.
  return page.error !== "" ? t("models.noDirectory") : t("models.noGateway");
}

/**
 * The line under the columns: a gateway's own last error, or the note that
 * says how many models one provider may declare. Empty for a healthy pool.
 */
function paintPageHint(page, published) {
  var hint = $("modelPageHint");
  if (page.error !== "") {
    hint.className = "hint warn";
    hint.textContent = page.error;
  } else if (page.cap > 0 && Object.keys(published).length >= page.cap) {
    hint.className = "hint";
    hint.textContent = t("models.cappedHint", { count: page.cap });
  } else {
    hint.className = "hint";
    hint.textContent = "";
  }
}

/** The ids the desktop will really list: the ticked ones, in roster order, capped. */
function publishedModels(list, cap) {
  var out = Object.create(null);
  var count = 0;
  for (var i = 0; i < list.length && (cap <= 0 || count < cap); i += 1) {
    var entry = draft[list[i].id];
    if (entry && entry.enabled) {
      out[list[i].id] = true;
      count += 1;
    }
  }
  return out;
}

/** One row of the roster: a checkbox, the model's own name, its id and limits. */
function modelListRow(model, published) {
  var entry = draft[model.id];
  var row = el("li", "row");
  // The sheet opens on the right-hand column, and nothing on the roster said
  // which model it belonged to: the row washes only for "ticked", so the one
  // being edited looked like every other. The marker reads the same `entry.open`
  // the right column expands on, so the two cannot disagree. This paints it on
  // the rebuild; `paintEditingRow` repaints it in place when the sheet is toggled
  // from the right column, which needs the id on the element.
  row.setAttribute("data-model-id", model.id);
  if (entry && entry.open === true) row.classList.add("is-editing");
  var label = el("label", "row-label");

  var box = document.createElement("input");
  box.type = "checkbox";
  box.className = "row-check";
  box.checked = entry.enabled;
  box.disabled = busy !== null;
  box.addEventListener("change", function () {
    entry.enabled = box.checked;
    // An unticked model has no sheet, so the open state goes with the tick, the
    // way the × control drops both: left behind, the roster kept marking a row
    // that had nothing open, and a rebuild put the sheet back on a model the user
    // had just taken out of the selection.
    if (!entry.enabled) closeSheetOf(model.id);
    renderModels();
  });
  label.appendChild(box);

  var copy = el("span", "row-copy");
  // The name only. Qoder's ids are internal codes (`qmodel_38max`) and the
  // others repeat the name, so a second column of text never told the user
  // anything the row did not already say.
  var lead = el("span", "row-id", modelDisplay(model) || model.id);
  lead.title = modelDisplay(model) || model.id;
  copy.appendChild(lead);
  label.appendChild(copy);

  var limits = el("span", "row-limits",
    formatTokens(effectiveWindow(model, entry)) + " · " + formatTokens(effectiveOutput(model, entry)));
  label.appendChild(limits);

  var chips = tagOf(model);
  // A tick the desktop will never show is still a tick, so the row names the
  // reason instead of letting it look like a model that was dropped. An
  // unticked row is unpublished because it is unticked, not because of the cap.
  if (entry.enabled && published[model.id] !== true) chips.push({ text: t("models.capped"), tone: "" });
  if (chips.length > 0) {
    var chipHost = el("span", "row-tags");
    chips.forEach(function (chip) {
      chipHost.appendChild(el("span", "badge " + chip.tone, chip.text));
    });
    label.appendChild(chipHost);
  }

  // Only an enabled model has a sheet to open, which is what the second view is.
  if (entry.enabled) {
    label.appendChild(el("span", "row-open-hint", "›"));
    label.addEventListener("click", function (event) {
      if (event.target instanceof HTMLInputElement) return;
      // The row is a <label>, whose default activation would also flip the
      // checkbox: opening the sheet must not simultaneously disable the model.
      event.preventDefault();
      openModelSheet(model.id);
    });
  }

  row.appendChild(label);
  return row;
}

/**
 * Take one model out of the open state, leaving any other sheet alone.
 *
 * The roster's mark is read from `entry.open` and the record a rebuilt draft
 * restores from is `selectedSheet`, so the two are always written together: a
 * gesture that cleared one and not the other left a row marked as being edited
 * while its sheet was already gone.
 */
function closeSheetOf(id) {
  var entry = draft[id];
  if (!entry) return;
  entry.open = false;
  if (sheetIsOpen(id)) selectedSheet = null;
}

/**
 * Open one model's sheet and close the rest.
 *
 * One at a time: the roster's mark means "this is the model whose editor is open",
 * and two marked rows cannot both be that.
 */
function openSheetOf(id) {
  var entry = draft[id];
  if (!entry) return;
  Object.keys(draft).forEach(closeSheetOf);
  entry.open = true;
  selectedSheet = { key: currentModelKey(), id: id };
}

/**
 * Open or close one model's sheet from the right-hand column.
 *
 * The roster marker is repainted in place rather than by rebuilding the list: a
 * rebuild is what `openModelSheet` costs from the left, and doing that here would
 * throw away the roster's scroll offset and the focus inside the sheet every time
 * the sheet is collapsed.
 */
function toggleModelSheet(id) {
  var entry = draft[id];
  if (!entry) return;
  if (entry.open === true) closeSheetOf(id);
  else openSheetOf(id);
  renderChosen();
  paintEditingRow();
}

/**
 * Bring the roster's editing marker in step with the draft.
 *
 * One model has a sheet open, and that id can change from either column, so the
 * mark is repainted for every row rather than added to one: a row left marked
 * after the sheet moved read as the model being edited when it was not.
 */
function paintEditingRow() {
  var rows = $("models").querySelectorAll("[data-model-id]");
  for (var index = 0; index < rows.length; index += 1) {
    var entry = draft[rows[index].getAttribute("data-model-id")];
    if (entry && entry.open === true) rows[index].classList.add("is-editing");
    else rows[index].classList.remove("is-editing");
  }
}

/**
 * Open one model's sheet.
 *
 * Both columns stay on screen, so this only marks which model is expanded and
 * scrolls its row into view; nothing is hidden.
 */
function openModelSheet(id) {
  var entry = draft[id];
  if (!entry || !entry.enabled) return;
  openSheetOf(id);
  // Both columns: the left one is what draws the editing marker.
  renderModels();
  // The expanded row, not `#chosen`: that element is the scroller itself, and
  // `scrollIntoView` on it moves its ancestors, so a sheet below the fold opened
  // without coming into view. The rows sit inside the list, and are matched
  // through the attribute rather than a selector because a model id is not a CSS
  // identifier.
  var rows = $("chosen").querySelectorAll("[data-model-id]");
  for (var index = 0; index < rows.length; index += 1) {
    if (rows[index].getAttribute("data-model-id") !== id) continue;
    if (rows[index].scrollIntoView) rows[index].scrollIntoView({ block: "nearest" });
    break;
  }
}

/** The sheet view: every enabled model's editor, the selected one expanded. */
function renderChosen() {
  $("modelEditTitle").textContent = t("models.modelConfigurations");
  $("chosenSearch").placeholder = t("models.searchChosen");
  $("chosenSearch").setAttribute("aria-label", t("models.searchChosen"));

  var page = modelPage();
  var list = page.list;
  renderSaveBar(isDirty(list, page.selection));
  var chosen = list.filter(function (model) { return draft[model.id] && draft[model.id].enabled; });
  $("modelEditCount").textContent = String(chosen.length);

  var host = $("chosen");
  var keep = placeOf(host);
  clear(host);
  if (chosen.length === 0) {
    host.appendChild(el("div", "empty", t("models.noModelsChosen")));
    restorePlace(host, keep);
    return;
  }

  var filter = $("chosenSearch").value.trim().toLowerCase();
  var shown = chosen.filter(function (model) {
    if (!filter) return true;
    return String(model.id).toLowerCase().indexOf(filter) >= 0
      || String(modelDisplay(model)).toLowerCase().indexOf(filter) >= 0;
  });
  if (shown.length === 0) {
    host.appendChild(el("div", "empty", t("models.noChosenMatch")));
    restorePlace(host, keep);
    return;
  }

  var host_ul = el("ul", "chosen-list");
  shown.forEach(function (model) { host_ul.appendChild(modelSheetRow(model)); });
  host.appendChild(host_ul);
  if (busy !== null) {
    host.querySelectorAll("input, select, button").forEach(function (control) { control.disabled = true; });
  }
  restorePlace(host, keep);
}

/** The name a model shows everywhere: the user's alias when set, else the catalog's. */
function modelDisplay(model) {
  var alias = typeof model.alias === "string" ? model.alias.trim() : "";
  return alias !== "" ? alias : model.name;
}

/** One model's sheet row: summary line plus the collapsible field body. */
function modelSheetRow(model) {
  var entry = draft[model.id];
  var expanded = entry.open === true;
  var row = el("li", "chosen-row");
  row.setAttribute("data-model-id", model.id);

  var head = el("div", "chosen-head");
  // The name, the same as the roster row: the id it is filed under is not shown
  // anywhere in the panel, and the limits after it carry the settings.
  var display = modelDisplay(model) || model.id;
  var headId = el("span", "chosen-id", display);
  headId.title = display;
  head.appendChild(headId);
  head.appendChild(el("span", "chosen-limits",
    formatTokens(effectiveWindow(model, entry)) + " · " + formatTokens(effectiveOutput(model, entry))));

  var advanced = el("button", expanded ? "chosen-advanced on" : "chosen-advanced", t("models.advanced"));
  advanced.type = "button";
  advanced.setAttribute("aria-expanded", expanded ? "true" : "false");
  advanced.addEventListener("click", function () {
    toggleModelSheet(model.id);
  });
  head.appendChild(advanced);

  var remove = el("button", "chosen-remove", "×");
  remove.type = "button";
  remove.title = t("models.removeModel");
  remove.setAttribute("aria-label", t("models.removeModel"));
  remove.addEventListener("click", function () {
    entry.enabled = false;
    // Removing the model being edited returns to the roster.
    closeSheetOf(model.id);
    renderModels();
  });
  head.appendChild(remove);
  row.appendChild(head);

  if (!expanded) return row;
  row.appendChild(modelSheetBody(model, entry));
  return row;
}

/**
 * The open model sheet: the gateway key it belongs to and the model id.
 *
 * Both, because model ids repeat across providers - `deepseek-v4.1-flash` is in
 * all three rosters - so an id alone carried the open sheet from WorkBuddy into
 * Trae's roster of the same name, pre-expanding a model the user never opened.
 */
var selectedSheet = null;

/** Whether the sheet for this gateway key and model id is the open one. */
function sheetIsOpen(modelId) {
  return selectedSheet !== null && selectedSheet.key === currentModelKey() && selectedSheet.id === modelId;
}

/** The gateway a model edit applies to: the source and the region it is showing. */
function currentModelKey() {
  return activeSource + ":" + activeRegionOf(activeSource);
}

/**
 * The presets the host's own model editor offers, so a value picked here lands
 * on the same ladder. Kept in this order: the chips render left to right.
 */
var CONTEXT_WINDOW_PRESETS = [
  { label: "128k", tokens: 128000 },
  { label: "256k", tokens: 256000 },
  { label: "312k", tokens: 312000 },
  { label: "500k", tokens: 500000 },
  { label: "1M", tokens: 1000000 },
];
var MAX_OUTPUT_PRESETS = [
  { label: "4k", tokens: 4000 },
  { label: "8k", tokens: 8000 },
  { label: "16k", tokens: 16000 },
  { label: "32k", tokens: 32000 },
  { label: "128k", tokens: 128000 },
];
/** Every level the host's reasoning menu can carry, in its own order. */
var THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** A fresh editable draft built from the server's document for one region. */
/**
 * A saved limit, kept inside the ceiling the row shows.
 *
 * The host sizes its budget from what the declaration says, and `src/host.ts`
 * clamps an override to the catalog's figure before publishing — so an override
 * stored above it (the catalog shrank after it was saved) is not what the model
 * runs at. Showing it verbatim puts a number in the field that the field's own
 * `max` then refuses to accept, and the panel reads as if the model has more
 * room than it has.
 */
function withinCeiling(saved, ceiling) {
  if (typeof saved !== "number") return null;
  if (typeof ceiling !== "number" || ceiling <= 0) return saved;
  return Math.min(saved, ceiling);
}

/** A fresh editable draft built from the server's document for one region. */
function draftFor(list, selection) {
  var enabled = selection.enabledModelIds;
  var overrides = selection.overrides || {};
  var out = Object.create(null);
  list.forEach(function (model) {
    var saved = overrides[model.id] || {};
    out[model.id] = {
      enabled: enabled === undefined || enabled.indexOf(model.id) >= 0,
      // An absent field means "follow the catalog", which the editor shows as
      // the untouched state rather than a value of its own.
      alias: typeof saved.alias === "string" ? saved.alias : "",
      window: withinCeiling(saved.contextWindow, windowCeiling(model)),
      output: withinCeiling(saved.maxOutputTokens, outputCeilingFor(model, withinCeiling(saved.contextWindow, windowCeiling(model)))),
      // Nothing is on hold in a draft built from what is stored: the stored figure
      // is already the ceiling the host kept, so there is no wider number to
      // replay.
      windowHeld: null,
      outputHeld: null,
      images: typeof saved.supportsImages === "boolean" ? saved.supportsImages : null,
      levels: Array.isArray(saved.thinkingLevels) ? saved.thinkingLevels.slice() : null,
      defaultLevel: typeof saved.defaultThinkingLevel === "string" ? saved.defaultThinkingLevel : null,
      open: false,
    };
  });
  // The sheet reopens on whatever it was showing, when that model still exists
  // and still belongs to this gateway.
  if (selectedSheet !== null && selectedSheet.key === currentModelKey() && out[selectedSheet.id]) {
    out[selectedSheet.id].open = true;
  }
  return out;
}

/**
 * Bring one draft entry back inside the ceilings its model states now.
 *
 * A draft outlives a roster refresh, and a refresh is allowed to lose a Max tier:
 * a window that was legal when the user typed it is then above the field's own
 * `max`, which reads as an edit nobody made and lights the save bar.
 */
function reclampEntry(entry, model) {
  var ceiling = windowCeiling(model);
  // A window the ceiling no longer reaches is set aside rather than dropped, for
  // the same reason `clampOutput` holds the output: a directory read that loses a
  // Max tier is ordinary, and the window coming back must not need the user to
  // retype it. The held figure is only replayed while the ceiling still allows it.
  var windowBefore = entry.window;
  entry.window = withinCeiling(entry.window, ceiling);
  if (entry.window !== windowBefore) {
    if (typeof entry.windowHeld !== "number") entry.windowHeld = windowBefore;
  } else if (typeof entry.windowHeld === "number" && entry.windowHeld <= ceiling) {
    entry.window = entry.windowHeld;
    entry.windowHeld = null;
  }
  // `null` means "follow the catalog", which is the model's DEFAULT window - not
  // the ceiling. Handing the ceiling over would clamp the output to the Max tier's
  // smaller budget while the field is still showing the default window.
  //
  // Through `clampOutput` rather than a bare `withinCeiling`, so the output is
  // held the same way: a refresh that lowers the ceiling must not cut the draft's
  // budget with no user action, which would read as an unsaved edit against the
  // stored figure and let one unrelated save write the smaller number down.
  clampOutput(model, entry);
  // Half-typed text does not survive a ceiling that no longer admits it. Left in
  // place it became the field's value beside a `max` that now refuses it - the one
  // state the clamp above exists to prevent.
  var outputLimit = outputCeilingFor(model, entry.window);
  if (entry.windowText != null && !(Number(entry.windowText) > 0 && Number(entry.windowText) <= ceiling)) entry.windowText = null;
  if (entry.outputText != null && !(Number(entry.outputText) > 0 && Number(entry.outputText) <= outputLimit)) entry.outputText = null;
  return entry;
}

/** Say why a token figure was refused, naming the ceiling that applied. */
function overCeilingNotice(limit) {
  note(t("models.overCeiling", { limit: String(limit) }));
}

/**
 * The highest window a model accepts.
 *
 * Trae sells Max as a second, larger tier, so a model's default window is not its
 * ceiling. The Max figure is published beside the default; a model without one has
 * only the default, which is then its ceiling.
 */
function windowCeiling(model) {
  var max = model.maxContextWindow;
  var dev = model.nativeContextWindow;
  return typeof max === "number" && max > 0 && (typeof dev !== "number" || max > dev) ? max : dev;
}

/** The highest output budget the model grants at the window the draft is using. */
function outputCeilingFor(model, window) {
  // A model that states a smaller budget through the function serving its Max
  // tier only grants it there, so a draft reaching above the default window has
  // to measure against that one instead of the default tier's figure.
  var at = model.maxOutputAtCeiling;
  var dev = model.nativeContextWindow;
  var ceiling = windowCeiling(model);
  var wanted = typeof window === "number" ? window : dev;
  if (typeof at === "number" && at > 0 && typeof dev === "number" && typeof ceiling === "number" && wanted > dev) {
    return Math.min(at, model.nativeMaxOutputTokens);
  }
  return model.nativeMaxOutputTokens;
}

function outputCeiling(model, entry) {
  return outputCeilingFor(model, effectiveWindow(model, entry));
}

/**
 * Keep the draft's output inside the ceiling its window allows.
 *
 * A window change can lower that ceiling (the Max-tier function states a smaller
 * budget), and a field left holding a bigger number would show a value its own
 * `max` refuses - the declaration would then be clamped silently instead of the
 * editor saying so.
 *
 * The figure the clamp replaced is held rather than dropped. Reaching for the Max
 * tier and coming back is one gesture each way, and without the hold the return
 * leg kept the narrower figure: saving then wrote it down, permanently cutting the
 * model's default budget in half over a trip the user had undone. `outputHeld` is
 * cleared the moment the user states an output of their own, which is what makes
 * the restore safe - it only ever replays a number the user chose at a window that
 * still grants it.
 */
function clampOutput(model, entry) {
  var ceiling = outputCeilingFor(model, entry.window === null ? model.nativeContextWindow : entry.window);
  if (typeof entry.output === "number") {
    if (entry.output > ceiling) {
      if (typeof entry.outputHeld !== "number") entry.outputHeld = entry.output;
      entry.output = ceiling;
    } else if (typeof entry.outputHeld === "number" && entry.outputHeld <= ceiling) {
      entry.output = entry.outputHeld;
      entry.outputHeld = null;
    }
  }
  return ceiling;
}

/** The window a model currently advertises, override first. */
function effectiveWindow(model, entry) {
  return entry.window === null ? model.nativeContextWindow : entry.window;
}
function effectiveOutput(model, entry) {
  // Never above the ceiling the chosen window allows: a model whose Max-tier
  // function states a smaller budget must not show the default tier's figure in
  // a field whose own `max` is already that smaller one.
  var value = entry.output === null ? model.nativeMaxOutputTokens : entry.output;
  return Math.min(value, outputCeilingFor(model, effectiveWindow(model, entry)));
}
function effectiveImages(model, entry) {
  return entry.images === null ? model.nativeSupportsImages === true : entry.images;
}
/** The levels a model offers: the user's set, else the catalog's. */
function effectiveLevels(model, entry) {
  if (entry.levels !== null) return entry.levels;
  return Array.isArray(model.nativeThinkingLevels) ? model.nativeThinkingLevels : [];
}

/** True when the draft differs from what the main process last reported. */
function isDirty(list, selection) {
  var enabled = selection.enabledModelIds;
  var overrides = selection.overrides || {};
  for (var i = 0; i < list.length; i += 1) {
    var model = list[i];
    var entry = draft[model.id];
    if (!entry) continue;
    if (entry.enabled !== (enabled === undefined || enabled.indexOf(model.id) >= 0)) return true;
    var saved = overrides[model.id] || {};
    if (entry.alias !== (typeof saved.alias === "string" ? saved.alias : "")) return true;
    // Compared through the same clamp the draft was built with: a stored figure
    // above the catalog's is not something the editor can show, so it must not
    // read as an edit waiting to be saved either.
    if (entry.window !== withinCeiling(saved.contextWindow, windowCeiling(model))) return true;
    if (entry.output !== withinCeiling(saved.maxOutputTokens, outputCeilingFor(model, entry.window === null ? model.nativeContextWindow : entry.window))) return true;
    if (entry.images !== (typeof saved.supportsImages === "boolean" ? saved.supportsImages : null)) return true;
    if ((entry.levels === null ? null : entry.levels.join(","))
      !== (Array.isArray(saved.thinkingLevels) ? saved.thinkingLevels.join(",") : null)) return true;
    if (entry.defaultLevel !== (typeof saved.defaultThinkingLevel === "string" ? saved.defaultThinkingLevel : null)) return true;
  }
  return false;
}

/**
 * A preset chip row: the chip matching the current value is highlighted.
 *
 * `ceiling` drops the presets the model cannot take, so a chip can never offer a
 * figure the input beside it would reject. `defaultWindow` is the model's own
 * default tier, added alongside the ceiling: the fixed ladder has no rung at 200k
 * or 116k, so without these a model whose window sits between two rungs showed a
 * single chip well under what it accepts, which read as the pool holding the
 * model back. Both of a Max-capable model's windows end up offered.
 */
function presetRow(presets, value, onPick, ceiling, defaultWindow) {
  var wrap = el("div", "preset-row");
  var limit = typeof ceiling === "number" && ceiling > 0 ? ceiling : Infinity;
  var chips = presets.filter(function (preset) { return preset.tokens <= limit; });
  var has = function (tokens) { return chips.some(function (chip) { return chip.tokens === tokens; }); };
  // Lowercase the K to sit with the ladder's own labels; the M stays as is.
  var label = function (tokens) { return formatTokens(tokens).replace(/K$/, "k"); };
  // The model's own windows come first: its default tier, then its Max tier.
  [defaultWindow, limit].forEach(function (tokens) {
    if (!Number.isFinite(tokens) || tokens <= 0 || has(tokens)) return;
    chips.push({ label: label(tokens), tokens: tokens });
  });
  chips.sort(function (a, b) { return a.tokens - b.tokens; });
  chips.forEach(function (preset) {
    var chip = el("button", preset.tokens === value ? "preset active" : "preset", preset.label);
    chip.type = "button";
    chip.setAttribute("aria-pressed", preset.tokens === value ? "true" : "false");
    chip.addEventListener("click", function () { onPick(preset.tokens); });
    wrap.appendChild(chip);
  });
  return wrap;
}

/** A labelled field with optional help available by pointer or keyboard. */
function field(labelKey, helpKey, control) {
  var wrap = el("div", "field");
  var head = el("div", "field-head");
  head.appendChild(el("span", "field-label", t(labelKey)));
  // The label is a span beside the control, not a <label>, so the accessible
  // name has to be carried by the control itself.
  control.setAttribute("aria-label", t(labelKey));
  if (helpKey) {
    head.appendChild(helpNote(t(labelKey), t(helpKey)));
  }
  wrap.appendChild(head);
  wrap.appendChild(control);
  return wrap;
}

/** A checkbox row: one box, its label, and a change handler. */
function checkRow(labelKey, checked, onChange) {
  var label = el("label", "check");
  var box = document.createElement("input");
  box.type = "checkbox";
  box.checked = checked;
  box.addEventListener("change", function () { onChange(box.checked); });
  label.appendChild(box);
  label.appendChild(el("span", null, t(labelKey)));

  return label;
}

/**
 * The editable fields of one model, as the host's sheet lays them out.
 *
 * Nothing here writes through: every control mutates the draft, and Save sends
 * the whole set. That is what makes the save bar meaningful and lets a field be
 * put back to "follow the catalog" by clearing it.
 */
function modelSheetBody(model, entry) {
  var body = el("div", "sheet-body");

  // Alias
  var aliasInput = document.createElement("input");
  aliasInput.type = "text";
  aliasInput.className = "text-input";
  aliasInput.value = entry.alias;
  aliasInput.placeholder = t("models.aliasPlaceholder");
  // `main.js` parseOverride() rejects a longer alias outright, and one bad
  // alias voids the WHOLE selection — so cap the field here, where the user can
  // see it, instead of letting them lose every model's edits at Save.
  aliasInput.maxLength = 120;
  // The save bar tracks the draft, so typing an alias has to refresh it: an
  // edit that never reveals Save would look like it was not recorded.
  aliasInput.addEventListener("input", function () {
    entry.alias = aliasInput.value;
    paintSaveBar();
  });
  body.appendChild(field("models.alias", "models.aliasHelp", aliasInput));

  // Context window and max output, side by side on a wide enough panel.
  // The ceiling is the model's own figure: the host sizes its context budget
  // from whatever is declared, so a larger window claimed room the upstream does
  // not have and the reply was compacted early.
  var windowInput = numberInput(entry.windowText == null ? effectiveWindow(model, entry) : entry.windowText, function (next) {
    // A value equal to the catalog's is stored as "no override", so the row
    // keeps following the catalog instead of pinning today's number.
    entry.window = next === model.nativeContextWindow ? null : next;
    entry.windowText = null;
    // The hold is what a clamp set aside; a number the user typed is the choice to
    // keep, so replaying the hold on the next catalog refresh would replace it.
    entry.windowHeld = null;
    // Reaching for a wider window can lower the output ceiling, so a half-typed
    // output is dropped rather than left showing a figure the new window refuses.
    entry.outputText = null;
    clampOutput(model, entry);
    renderChosen();
  }, windowCeiling(model), overCeilingNotice, function (text) { entry.windowText = text; }, effectiveWindow(model, entry));
  var windowCol = field("models.window", "models.windowFollows", windowInput);
  windowCol.insertBefore(presetRow(
    CONTEXT_WINDOW_PRESETS,
    effectiveWindow(model, entry),
    function (tokens) {
      entry.window = tokens === model.nativeContextWindow ? null : tokens;
      entry.windowText = null;
      entry.outputText = null;
      // A number the user picked is the one to keep: replaying a hold from an
      // earlier clamp would replace it on the next catalog refresh.
      entry.windowHeld = null;
      clampOutput(model, entry);
      renderChosen();
    },
    windowCeiling(model),
    model.nativeContextWindow,
  ), windowInput);

  // The output field's ceiling follows the window this draft asks for: a model
  // whose Max function states a smaller budget only grants it above the default.
  var outputCap = outputCeiling(model, entry);
  var outputInput = numberInput(entry.outputText == null ? effectiveOutput(model, entry) : entry.outputText, function (next) {
    // Matching the ceiling at this window is stored as "no override", the same
    // rule the window field follows, so the row keeps tracking the catalog. A
    // number of the user's own also ends any hold from an earlier clamp: this is
    // the choice to replay, not the one the clamp set aside.
    entry.outputHeld = null;
    entry.output = next === outputCap ? null : next;
    renderChosen();
  }, outputCap, overCeilingNotice, function (text) { entry.outputText = text; }, effectiveOutput(model, entry));
  var outputCol = field("models.maxOutput", "models.outputHelp", outputInput);
  outputCol.insertBefore(presetRow(
    MAX_OUTPUT_PRESETS,
    effectiveOutput(model, entry),
    function (tokens) {
      entry.outputHeld = null;
      entry.outputText = null;
      entry.output = tokens === outputCap ? null : tokens;
      renderChosen();
    },
    outputCap,
  ), outputInput);

  var pair = el("div", "field-pair");
  pair.appendChild(windowCol);
  pair.appendChild(outputCol);
  body.appendChild(pair);

  // Thinking levels: only a model whose catalog offers a reason menu gets the
  // control. WorkBuddy reports its own table, and Trae and Qoder advertise
  // theirs through the gateway, so the menu appears wherever the upstream
  // actually offers levels and the save reaches the declaration.
  var levels = effectiveLevels(model, entry);
  if (levels.length > 0) {
    var levelsWrap = el("div", "field");
    var levelsHead = el("div", "field-head");
    levelsHead.appendChild(el("span", "field-label", t("models.levels")));

    var defaultWrap = el("span", "default-level");
    defaultWrap.appendChild(el("span", "field-label", t("models.defaultLevel")));
    var defaultSelect = document.createElement("select");
    defaultSelect.className = "select";
    defaultSelect.setAttribute("aria-label", t("models.defaultLevel"));
    THINKING_LEVELS.forEach(function (level) {
      if (levels.indexOf(level) < 0) return;
      var option = document.createElement("option");
      option.value = level;
      option.textContent = level;
      defaultSelect.appendChild(option);
    });
    var chosenDefault = entry.defaultLevel !== null ? entry.defaultLevel : (levels[0] || "off");
    if (levels.indexOf(chosenDefault) < 0) chosenDefault = levels[0] || "off";
    defaultSelect.value = chosenDefault;
    defaultSelect.addEventListener("change", function () {
      entry.defaultLevel = defaultSelect.value;
      paintSaveBar();
    });
    defaultWrap.appendChild(defaultSelect);
    levelsHead.appendChild(defaultWrap);
    levelsWrap.appendChild(levelsHead);

    var levelRow = el("div", "level-row");
    THINKING_LEVELS.forEach(function (level) {
      var on = levels.indexOf(level) >= 0;
      var chip = el("button", on ? "level active" : "level", level);
      chip.type = "button";
      chip.setAttribute("aria-pressed", on ? "true" : "false");
      chip.addEventListener("click", function () {
        var next = levels.slice();
        var at = next.indexOf(level);
        if (at >= 0) next.splice(at, 1);
        else next.push(level);
        next = THINKING_LEVELS.filter(function (candidate) { return next.indexOf(candidate) >= 0; });
        // An empty set would mean "no reason menu", which the host cannot
        // express, so clearing every chip restores the catalog's own set.
        entry.levels = next.length === 0 ? null : next;
        if (entry.defaultLevel !== null && entry.levels !== null && entry.levels.indexOf(entry.defaultLevel) < 0) {
          entry.defaultLevel = null;
        }
        renderChosen();
      });
      levelRow.appendChild(chip);
    });
    levelsWrap.appendChild(levelRow);
    body.appendChild(levelsWrap);
  }

  // Attachments
  var attach = el("div", "field");
  attach.appendChild(el("div", "field-head", t("models.capabilities")));
  var attachRow = el("div", "check-row");
  attachRow.appendChild(checkRow("models.imageInput", effectiveImages(model, entry), function (next) {
    entry.images = next === model.nativeSupportsImages ? null : next;
    renderChosen();
  }));
  // Three host-only capabilities are deliberately absent rather than shown as
  // disabled ticks the host never reads (crates/host-core/src/plugins/providers.rs)
  // — a control that cannot act is worse than no control.
  attach.appendChild(attachRow);
  body.appendChild(attach);

  return body;
}


/**
 * The ceiling the host enforces on a token budget (`MAX_TOKEN_BUDGET`).
 *
 * A number past it invalidates the whole selection payload there, so the save
 * drops every edit in this pass rather than clamping one field. Keeping the
 * bound in the browser means the field itself refuses the value.
 */
var MAX_TOKEN_BUDGET = 0xffffffff;
/**
 * A token-budget field, capped at `ceiling` when the caller has one.
 *
 * `MAX_TOKEN_BUDGET` is the host's own limit on any token figure: a number past
 * it makes the whole selection payload invalid there, so the save would drop
 * every edit in this pass rather than clamp one field. `ceiling` is narrower:
 * it is what the model really accepts, and the host sizes its context budget and
 * compaction threshold from whatever is declared, so a larger figure made it
 * believe there was room the upstream does not have.
 *
 * A refused value goes back to `committed` - the number the draft actually holds -
 * rather than to `value`, which may be a half-typed string. Restoring the string
 * left the field showing neither the stored figure nor what the user meant: type
 * `500000` past a `200000` ceiling and the box was refilled with the `50000` that
 * happened to be there when the last repaint rebuilt it, so pressing enter again
 * saved a number nobody had ever typed. `onRefused` says why, and the field itself
 * stays free of the banner: the same control is driven without one in the tests,
 * and a silent snap-back read as the field ignoring the edit.
 */
function numberInput(value, onChange, ceiling, onRefused, onText, committed) {
  var limit = typeof ceiling === "number" && ceiling > 0
    ? Math.min(Math.round(ceiling), MAX_TOKEN_BUDGET)
    : MAX_TOKEN_BUDGET;
  var stored = typeof committed === "number" ? committed : value;
  var input = document.createElement("input");
  input.type = "number";
  input.className = "num-input";
  input.max = String(limit);
  input.min = "1";
  input.step = "1000";
  input.value = String(value);
  // The whole sheet is rebuilt on every repaint, and a repaint really does land
  // between two keystrokes: the panel polls every 1.2 s while a refresh runs and
  // every 2 s for the check-in log. Holding the committed value replaces a
  // half-typed number mid-entry and loses the edit; holding the raw text lets the
  // rebuilt field show what the user is typing.
  input.addEventListener("input", function () {
    if (typeof onText === "function") onText(input.value);
  });
  input.addEventListener("change", function () {
    if (typeof onText === "function") onText(null);
    // Cleared means "follow the catalog": both call sites read an absent value as
    // the row tracking the directory again, and the sheet's own comment promises
    // exactly that. Reading the empty string as a number turned it into 0, which
    // the guard below then refused, so the field snapped back and the only way
    // back to the catalog was to type the directory's number by hand.
    if (input.value.trim() === "") {
      onChange(null);
      return;
    }
    var next = Number(input.value);
    if (!Number.isFinite(next) || next <= 0) {
      input.value = String(stored);
      return;
    }
    if (next > limit) {
      input.value = String(stored);
      if (typeof onRefused === "function") onRefused(limit);
      return;
    }
    onChange(Math.round(next));
  });
  return input;
}

/** Trim trailing zeros from a decimal string: "1.50" -> "1.5", "1.00" -> "1". */
function trimFraction(value) {
  if (value.indexOf(".") < 0) return value;
  return value.replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * A token count, formatted the way the model sheet reads it.
 *
 * One decimal at the K scale and two at the M scale, because 1,000,000 /
 * 1,048,576 / 1,050,000 are indistinguishable at one decimal and rounding them
 * together would overstate the smaller ones.
 */
function formatTokens(tokens) {
  var n = Number(tokens);
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n < 1000) return String(n);
  var thousands = n / 1000;
  if (Number(thousands.toFixed(1)) < 1000) {
    return trimFraction(thousands.toFixed(1)) + "K";
  }
  return trimFraction((n / 1000000).toFixed(2)) + "M";
}

/**
 * A credit balance as one figure, for the source cards' quota row.
 *
 * Whole balances read as the pool's own credit total does; a balance with a
 * fractional part (Trae reports tenths) keeps two decimals rather than being
 * rounded away in front of the user.
 */
function formatCredits(value) {
  var n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/**
 * Show or hide the save bar and keep its buttons in step with `busy`.
 *
 * Both branches have to write the button state. A save that makes the draft
 * clean (deselecting a model, say) hides the bar on the very render that ends
 * the save, so an early return here would leave the button reading "saving"
 * and disabled forever - the data lands, but the panel never says so.
 */
function renderSaveBar(dirty) {
  var saving = busy === "save";
  show($("savebar"), dirty === true);
  $("saveBtn").textContent = saving ? t("models.saving") : t("btn.save");
  $("discardBtn").textContent = t("btn.discard");
  $("saveBtn").disabled = busy !== null;
  $("discardBtn").disabled = busy !== null;
  if (dirty === true) $("saveNote").textContent = t("models.dirty");
}
/** Repaint the save bar from the page's own stored selection, not the pool's. */
function paintSaveBar() {
  var page = modelPage();
  renderSaveBar(isDirty(page.list, page.selection));
}

/**
 * The gateways are up and this plugin declared them, but the host refused the
 * registration - the usual case being a reload that raced the last declaration.
 * The state document carries the ids that are still missing, and a plugin
 * reload re-runs the registration, so that is what the line asks for. Nothing
 * is published by the panel to fix it.
 */
function renderHostHint() {
  var missing = state && Array.isArray(state.unpublishedDeclarations) ? state.unpublishedDeclarations : [];
  show($("hostHint"), missing.length > 0);
  if (missing.length === 0) return;
  $("hostHint").textContent = t("host.missing", { count: missing.length });
}

function renderDoctor() {
  $("checkTitle").textContent = t("check.title");
  $("reportDetails").textContent = t("check.details");
  $("reportDetails").parentElement.hidden = doctorResult === null;
  $("doctorBtn").textContent = t("btn.doctor");
  iconLabel($("copyBtn"), t("btn.copy"));
  $("doctorBtn").disabled = busy !== null;
  $("copyBtn").disabled = doctorResult === null;

  var host = $("findings");
  clear(host);
  if (doctorResult === null) {
    host.appendChild(el("div", "hint", t("check.empty")));
    $("report").textContent = "";
    return;
  }
  (doctorResult.findings || []).forEach(function (finding) {
    var row = el("div", "finding");
    var mark = el("span", finding.ok ? "finding-pass ic-check" : "finding-fail ic-x");
    mark.title = t(finding.ok ? "check.pass" : "check.fail");
    mark.appendChild(el("span", "sr-only", mark.title));
    row.appendChild(mark);
    row.appendChild(el("span", "finding-id", finding.id));
    row.appendChild(el("span", "finding-detail", finding.detail));
    host.appendChild(row);
  });
  $("report").textContent = doctorResult.report || "";
}

/**
 * The endpoint the footer names: the pool's own shim for WorkBuddy, that
 * source's gateway for Trae and Qoder. A WorkBuddy address says nothing about
 * the model list above it, which is what the page is about.
 */
function footerEndpoint() {
  if (activeSource === "workbuddy") {
    var shim = state.shims ? state.shims[activeRegion] : null;
    return shim && shim.running
      ? { on: true, url: shim.baseUrl }
      : { on: false, text: t("foot.shimOff") };
  }
  var row = sourceGatewayRow(activeSource, activeRegionOf(activeSource));
  return row
    ? { on: true, url: "http://127.0.0.1:" + row.port + "/v1" }
    : { on: false, text: t("foot.shimOff") };
}

function renderFooter() {
  var foot = $("foot");
  var endpointOpen = foot.querySelector(".foot-check")?.open === true;
  clear(foot);
  if (state === null) return;
  var endpoint = footerEndpoint();
  var endpointDetails = el("details", "foot-check");
  endpointDetails.open = endpointOpen;
  var endpointTrigger = el("summary", "ic-info");
  iconLabel(endpointTrigger, t("check.title"));
  var endpointChip = el("span", "endpoint-chip" + (endpoint.on ? "" : " off"));
  endpointChip.append(
    el("span", "", t("foot.shim")),
    el("code", "", endpoint.on ? endpoint.url : endpoint.text),
  );
  endpointDetails.append(endpointTrigger, endpointChip);
  foot.appendChild(endpointDetails);
  // Either the gateway could not sign in, or it is still serving a roster from
  // an earlier read. Both are worth saying out loud; the message leads with the
  // reason so it does not have to guess which of the two it is. Only the pool's
  // gateway carries one, and only while the pool is on screen: the other two
  // report theirs in their own strip.
  var rosterWarning = activeSource === "workbuddy" && state.warnings ? state.warnings[activeRegion] : undefined;
  if (rosterWarning) {
    foot.appendChild(el("span", "muted",
      t("foot.rosterStale", { region: regionLabel(activeRegion, false), detail: rosterWarning })));
  }
}

function render() {
  // Every render pass rebuilds most of the panel, so the element holding focus
  // is destroyed and the browser scrolls its replacement into view — the shake a
  // click produces. Record what had focus and where the page was, and put both
  // back afterwards. The same guard the account and model columns already use,
  // lifted to the whole panel.
  var keep = placeOf(document.body);
  renderHeader();
  renderAutoCheckin();
  renderGrowth();
  renderComposerPoints();
  renderHostHint();
  renderRegionTabs();
  renderModelRegionTabs();
  renderWorkbuddyHead();
  renderPoolStrip();
  renderSourceStrip("trae");
  renderSourceStrip("qoder");
  renderAccounts();
  renderModels();
  renderDoctor();
  renderFooter();
  restorePlace(document.body, keep);
  // A control the pass itself disabled cannot be refocused — the browser refuses
  // focus on a disabled element, and no amount of clearing the flag inside one
  // task changes that. So the control the user last pressed is remembered, and
  // when the busy pass ends the focus is handed back to it. Without this the
  // focus sat on the body after every click, and keyboard users lost their place.
  // The memory is cleared once the focus is back, so a later click on empty space
  // stays where it was instead of being pulled onto that button by the next poll.
  if (lastPressed !== null && document.activeElement === document.body) {
    var back = locateControl(document.body, lastPressed);
    if (back && back.disabled === false && back.focus) {
      back.focus({ preventScroll: true });
      lastPressed = null;
    }
  }
  // A pending pass whose poll was stopped (or never started) gets its watcher
  // back here: every state adoption ends in this render, and the log row is the
  // only thing that reports the pass as running. Once the pass has landed there
  // is nothing left to watch, so the banner it set is cleared here as well.
  if (state && state.autoCheckin && state.autoCheckin.last && state.autoCheckin.last.pending === true) {
    pollCheckinLog(checkinPollAttempts);
  } else if (checkinBusyNote) {
    checkinBusyNote = false;
    if (bannerText === t("pool.checkinAllBusy")) note(null);
  }
}

// ---------------------------------------------------------------- actions

var stateRevision = 0;

function adopt(next) {
  if (next && typeof next === "object") {
    state = next;
    stateRevision += 1;
    var growth = next.growth;
    if (growth && growth.readEpoch >= growthReadEpoch) {
      // A same-epoch poll may have started before the explicit read finished.
      if (growth.readEpoch > growthReadEpoch || growthState === null) growthState = growth.read;
      growthReadEpoch = growth.readEpoch;
    }
  }
}

function runBusy(id, work) {
  // A second action while one is running must answer here, once: every caller
  // answers with its own `.catch(function () {})`, so rejecting only here would
  // make the click do nothing and say nothing. The banner is raised here so a
  // busy panel answers every control the same way.
  if (busy !== null) {
    note(t("err.busy"), "warn");
    return Promise.reject(new Error("panel is busy"));
  }
  notePress(document.activeElement);
  busy = id;
  render();
  return work().then(function (result) {
    busy = null;
    // A host answer may still be detecting behind the click. Adopt it through
    // the same polling path the initial open uses, but only when it actually
    // reports that state: most settings/reset answers omit `refreshing`, and
    // adopting those here must not cancel a poll already running.
    if (result && result.accounts && typeof result.refreshing === "boolean") {
      adoptAndMaybePoll(result, 0);
    } else if (result && result.accounts) {
      adopt(result);
    }
    if (result && result.stale === true) note(t("err.stale"), "warn");
    else note(null);
    render();
    pollCheckinLog(0);
    return result;
  }).catch(function (error) {
    busy = null;
    note(String(error && error.message ? error.message : error));
    render();
    pollCheckinLog(0);
    throw error;
  });
}

/**
 * Panel poll timer for the background detection pass.
 *
 * The main process answers an open from cache and refreshes behind it, so the
 * panel has to come back for the refreshed document rather than assume the
 * first answer was final.
 */
var refreshPoll = null;
var REFRESH_POLL_MS = 1200;

function stopPolling() {
  if (refreshPoll !== null) {
    window.clearTimeout(refreshPoll);
    refreshPoll = null;
  }
}

/**
 * Adopt one document, then keep asking while the main process reports that a
 * detection pass is still running. Bounded so a permanently failing refresh
 * cannot spin forever.
 */
function adoptAndMaybePoll(next, attempts) {
  adopt(next);
  render();
  if (!next || next.refreshing !== true) { stopPolling(); return; }
  if (attempts >= 15) {
    // Giving up on the pass, not on the document. Leaving `refreshing` set here
    // left the header saying "detecting…" for good: nothing else comes back for
    // it, so the flag had to be cleared by the one who stopped watching.
    stopPolling();
    adopt(next && typeof next === "object" ? Object.assign({}, next, { refreshing: false }) : next);
    render();
    return;
  }
  stopPolling();
  refreshPoll = window.setTimeout(function () {
    refreshPoll = null;
    // Hidden pages keep no watch: the pass behind this poll belongs to the
    // plugin, and a page nobody is looking at does not need the document.
    if (!pageIsVisible()) { stopPolling(); return; }
    var revision = stateRevision;
    invoke("xd.state").then(function (again) {
      if (revision !== stateRevision) {
        if (state && state.refreshing === true) adoptAndMaybePoll(state, attempts + 1);
        return;
      }
      adoptAndMaybePoll(again, attempts + 1);
    }).catch(function () {
      // The document's own flag is what these two loops watch, and a failing
      // channel leaves it set: stopping the timer here alone left the header
      // saying "detecting…" for good, with nothing left to clear it. The same
      // repair the check-in watch does, one line up.
      stopPolling();
      if (!state) return;
      adopt(Object.assign({}, state, { refreshing: false }));
      render();
    });
  }, REFRESH_POLL_MS);
}

var checkinPoll = null;
var CHECKIN_POLL_MS = 2000;
var CHECKIN_POLL_LIMIT = 90;
var CHECKIN_POLL_SLOW_MS = 10000;
/**
 * How many intermittent polls in a row may fail before the watch gives up.
 *
 * The watch exists to keep a long pass's row from reading "running" all day,
 * but it re-armed itself on every failure without ever clearing the flag it was
 * watching, so a plugin that had stopped answering left a 10 s poll running for
 * the life of the page. Three failures in a row is a dead channel, not a slow
 * pass.
 */
var CHECKIN_POLL_MAX_FAILURES = 3;
var checkinPollAttempts = 0;
var checkinPollAt = null;
var checkinPollFailures = 0;

function stopCheckinPoll() {
  if (checkinPoll !== null) {
    window.clearTimeout(checkinPoll);
    checkinPoll = null;
  }
}

var growthPoll = null;
var GROWTH_POLL_MS = CHECKIN_POLL_MS;
var GROWTH_POLL_MAX_FAILURES = CHECKIN_POLL_MAX_FAILURES;
var growthPollFailures = 0;

function stopGrowthPoll() {
  if (growthPoll !== null) {
    window.clearTimeout(growthPoll);
    growthPoll = null;
  }
}

/**
 * Keep asking for the document while a growth pass is still running.
 *
 * The host answers "run now" after its budget even when the pass continues and
 * leaves `growth.running` set. Without this watch the card's button stayed
 * disabled after that answer, so once the pass landed there was no way to start
 * another one.
 */
function pollGrowthRun() {
  if (!state || !state.growth || state.growth.running !== true || !pageIsVisible()) {
    stopGrowthPoll();
    return;
  }
  // A pending check-in pass already has `pollCheckinLog` asking for the same
  // document, and that watch clears once the pass lands.
  if (state.autoCheckin && state.autoCheckin.last && state.autoCheckin.last.pending === true) {
    stopGrowthPoll();
    return;
  }
  if (busy !== null) { stopGrowthPoll(); return; }
  if (growthPoll !== null) return;
  growthPoll = window.setTimeout(function () {
    growthPoll = null;
    var revision = stateRevision;
    invoke("xd.state").then(function (again) {
      if (revision !== stateRevision) { pollGrowthRun(); return; }
      if (busy !== null) { stopGrowthPoll(); return; }
      var wasRunning = state && state.growth && state.growth.running === true;
      adopt(again);
      growthPollFailures = 0;
      render();
      if (wasRunning && !(again && again.growth && again.growth.running === true)
        && activeTab === "growth" && growthStale()) {
        readGrowth();
      }
    }).catch(function () {
      growthPollFailures += 1;
      if (growthPollFailures < GROWTH_POLL_MAX_FAILURES) { pollGrowthRun(); return; }
      stopGrowthPoll();
      if (state && state.growth && state.growth.running === true) {
        adopt(Object.assign({}, state, { growth: Object.assign({}, state.growth, { running: false }) }));
        render();
      }
    });
  }, GROWTH_POLL_MS);
}

/**
 * Whether this page is worth polling for.
 *
 * The panel is a page in the host's window, not a background service: when it is
 * hidden nobody is watching what a poll would bring back, so both loops stop and
 * the next render re-arms whatever is still running.
 */
function pageIsVisible() {
  return document.hidden !== true;
}

/** Keep reading the log while a check-in pass is still marked pending. */
function pollCheckinLog(attempts) {
  var last = state && state.autoCheckin && state.autoCheckin.last;
  if (!last || last.pending !== true || !pageIsVisible()) {
    if (checkinBusyNote) {
      checkinBusyNote = false;
      if (bannerText === t("pool.checkinAllBusy")) note(null);
    }
    stopCheckinPoll();
    return;
  }
  // Progress is counted per pass: a new `at` starts a fresh fast window, and a
  // failure count from the previous pass would otherwise cut the new one short.
  var stamp = typeof last.at === "string" ? last.at : "";
  if (stamp !== checkinPollAt) { checkinPollAt = stamp; attempts = 0; checkinPollFailures = 0; }
  checkinPollAttempts = attempts;
  // A pass running beside another action is not a reason to stop watching it,
  // but the poll must not run while that action re-renders. `runBusy` calls
  // back here when it finishes, so dropping the timer now is safe.
  if (busy !== null && busy !== "checkin") { stopCheckinPoll(); return; }
  if (checkinPoll !== null) return;
  // Past the fast window the pass is either long or wedged; keep a slow watch
  // instead of giving up, or the row reads "running" for the rest of the day.
  var delay = attempts >= CHECKIN_POLL_LIMIT ? CHECKIN_POLL_SLOW_MS : CHECKIN_POLL_MS;
  checkinPoll = window.setTimeout(function () {
    checkinPoll = null;
    var revision = stateRevision;
    invoke("xd.state").then(function (again) {
      if (revision !== stateRevision) { pollCheckinLog(attempts + 1); return; }
      // Another action adopted the state; its own render re-arms the watch.
      if (busy !== null && busy !== "checkin") { stopCheckinPoll(); return; }
      adopt(again);
      // Set before `render()`: its tail re-arms this loop with whatever
      // `checkinPollAttempts` holds, and `checkinPoll !== null` from there made
      // the recursive call below return without doing anything - so the count
      // never advanced and the slow window was never reached.
      checkinPollAttempts = attempts + 1;
      checkinPollFailures = 0;
      render();
    }).catch(function () {
      // A failing channel leaves the flag set, so re-arming here without a bound
      // polled forever. The watch gives up and clears what it was watching, the
      // same way `adoptAndMaybePoll` does.
      checkinPollFailures += 1;
      if (checkinPollFailures < CHECKIN_POLL_MAX_FAILURES) { pollCheckinLog(attempts + 1); return; }
      stopCheckinPoll();
      if (state && state.autoCheckin && state.autoCheckin.last) {
        adopt(Object.assign({}, state, {
          autoCheckin: Object.assign({}, state.autoCheckin, {
            last: Object.assign({}, state.autoCheckin.last, { pending: false }),
          }),
        }));
        render();
      }
    });
  }, delay);
}

function refresh() {
  return runBusy("refresh", function () {
    // The Refresh button asks for a completed detection pass, not the cache.
    return invoke("xd.state", { wait: true });
  }).catch(function () {});
}

function rescan() {
  return runBusy("rescan", function () { return invoke("xd.rescan"); })
    .then(function (next) { announce(t("pool.summary", {
      count: (next.accounts || []).length,
      cooling: (next.accounts || []).filter(isCooling).length,
    })); })
    .catch(function () {});
}

function clearCooldowns() {
  return runBusy("reset", function () { return invoke("xd.resetCooldowns"); }).catch(function () {});
}

function setPreferredAccount(accountId) {
  return runBusy("account", function () {
    return invoke("xd.preferAccount", { region: activeRegion, accountId: accountId });
  }).catch(function () {});
}

/**
 * Switch one account off, on, out of the pool, or back into it.
 *
 * Every branch answers with the whole status document, so the panel redraws
 * from what was actually stored rather than from what was clicked.
 */
function setAccountState(accountId, next) {
  if (busy !== null) return Promise.resolve();
  return runBusy("account", function () {
    return invoke("xd.setAccountState", { region: activeRegion, accountId: accountId, state: next });
  }).catch(function (error) {
    note(t("acct.stateError", { message: error && error.message ? error.message : String(error) }));
  });
}

/** Save the credit floor for one account; 0 clears it. */
function setCreditReserve(accountId, reserve) {
  if (busy !== null) return Promise.resolve();
  return runBusy("reserve", function () {
    return invoke("xd.setCreditReserve", { region: activeRegion, accountId: accountId, reserve: reserve }).then(function (next) {
      delete reserveDrafts[accountId];
      return next;
    });
  }).catch(function (error) {
    note(t("acct.stateError", { message: error && error.message ? error.message : String(error) }));
  });
}

/** Save one source's usage mode; WorkBuddy's pool applies it live. */
function setDistribution(source, next) {
  var workbuddy = source === "workbuddy";
  return runBusy("distribution", function () {
    return invoke(
      workbuddy ? "xd.distribution" : "xd.sourceDistribution",
      workbuddy ? { region: activeRegion, distribution: next } : { source: source, distribution: next }
    );
  }).catch(function () {});
}

function setComposerPoints(enabled) {
  return runBusy("composer", function () {
    return invoke("xd.setComposerPoints", { enabled: enabled === true });
  }).catch(function () {});
}

/** Switch one source (workbuddy / trae / qoder) on or off; the answer is the refreshed document. */
function setSource(source, enabled) {
  return runBusy("source", function () {
    return invoke("xd.setSource", { source: source, enabled: enabled });
  }).catch(function () {});
}


/**
 * Read the hours box: a comma-separated list of whole hours, or null when
 * something in it is not an hour. An empty box means "keep the default", which
 * is what the background side does with an empty list too.
 */
function parseCheckinHours(text) {
  var parts = String(text).split(",").map(function (part) { return part.trim(); })
    .filter(function (part) { return part !== ""; });
  var hours = [];
  for (var i = 0; i < parts.length; i += 1) {
    if (!/^\d{1,2}$/.test(parts[i])) return null;
    var hour = Number(parts[i]);
    if (hour > 23) return null;
    if (hours.indexOf(hour) < 0) hours.push(hour);
  }
  return hours;
}

/** Switch the daily automatic check-in, or move its hours, in one request. */
function setAutoCheckin(enabled, hours) {
  if (hours === null) {
    // Only switching ON needs a readable hour list. Switching OFF must not: the
    // box can hold stale invalid text from an earlier edit, and bailing out there
    // leaves the timer running while the panel reports the schedule as off.
    if (enabled === true) {
      note(t("auto.badHours"));
      return Promise.resolve();
    }
    var current = state && state.autoCheckin && state.autoCheckin.hours;
    hours = Array.isArray(current) ? current : [];
  }
  return runBusy("autoCheckin", function () {
    return invoke("xd.setAutoCheckin", { enabled: enabled === true, hours: hours });
  }).then(function (result) {
    // Saved: the field now follows the host's value again.
    autoHoursDraft = null;
    render();
    return result;
  }).catch(function () {});
}

/** Run one keep-alive pass by hand. */
function runKeepAliveNow() {
  return runBusy("keepAlive", function () {
    return invoke("xd.keepAlive", {});
  }).catch(function () {});
}

function claimCheckin(accountId) {
  // The same guard the other three claim paths carry: a claim started on top of
  // a rescan or a refresh is two passes writing the same document.
  if (busy !== null || checkinBusy !== null) return Promise.resolve();
  checkinBusy = accountId;
  render();
  return invoke("xd.checkin", { accountId: accountId }).then(function (payload) {
    checkinBusy = null;
    if (payload && payload.state) adopt(payload.state);
    note(null);
    render();
    if (payload && payload.result && payload.result.credit > 0) {
      note(t("checkin.claimed", { credit: payload.result.credit }));
    }
  }).catch(function (error) {
    checkinBusy = null;
    note(String(error && error.message ? error.message : error));
    render();
  });
}

/** Collect every account's daily reward in one request. */
function claimAllCheckins() {
  if (busy !== null || checkinBusy !== null) return Promise.resolve();
  checkinBusy = "all";
  render();
  return invoke("xd.checkinAll", { source: "workbuddy" }).then(function (payload) {
    checkinBusy = null;
    if (payload && payload.state) adopt(payload.state);
    note(null);
    render();
    if (payload && payload.running === true) {
      checkinBusyNote = true;
      note(t("pool.checkinAllBusy"));
      pollCheckinLog(0);
      return;
    }
    var claimed = payload && typeof payload.claimed === "number" ? payload.claimed : 0;
    var failed = payload && typeof payload.failed === "number" ? payload.failed : 0;
    if (failed > 0) note(checkinFailureText(claimed, failed, payload && payload.reason), "warn");
    else if (claimed === 0) note(t("pool.checkinAllNone"));
    else announce(t("pool.checkinAllDone", { count: claimed }));
  }).catch(function (error) {
    checkinBusy = null;
    note(String(error && error.message ? error.message : error));
    render();
  });
}

/**
 * Tick or untick every row the current filter shows.
 *
 * Scoped to the visible rows on purpose: the header box sits above a filtered
 * list, so "select all" that touched hidden rows would contradict what is on
 * screen (the host does the same).
 */
function toggleAllVisible() {
  var wanted = $("modelSelectAll").checked;
  var filter = $("modelSearch").value.trim().toLowerCase();
  modelPage().list.forEach(function (model) {
    if (filter) {
      var hit = String(model.id).toLowerCase().indexOf(filter) >= 0
        || String(model.name).toLowerCase().indexOf(filter) >= 0
        || String(model.alias || "").toLowerCase().indexOf(filter) >= 0;
      if (!hit) return;
    }
    var entry = draft[model.id];
    if (!entry) return;
    entry.enabled = wanted;
    // Unticking through the header drops the sheet exactly as the row's own tick
    // does, or the roster keeps marking a model the header just took out.
    if (!wanted) closeSheetOf(model.id);
  });
  renderModels();
}

/**
 * Fetch the pool's list: re-read the desktop sign-ins, then re-read its
 * catalog from the upstream.
 *
 * Both halves matter here. The pool's roster comes from WorkBuddy's own
 * catalogue, which is read per signed-in account, so a new account and a
 * changed upstream roster are discovered by the same gesture - which is what
 * the button reads as. Trae and Qoder re-read their own directory on their
 * clock, so this button is theirs to hide, not to fake.
 */

function fetchModelList() {
  return runBusy("fetch", function () { return invoke("xd.rescan"); }).catch(function () {});
}

/**
 * Ask the plugin for a live model roster, silently, once per panel.
 *
 * Opening the panel is when the list has to be right: a roster read that timed
 * out while the host was starting leaves the plugin's static fallback in force,
 * and the model page then listed the fallback's own models and reported the
 * user's saved choice as retired - on every start, until a manual fetch. The
 * model page keeps its own "fetch list" button for a deliberate re-read.
 */
var modelRosterRequested = false;
function requestModelRoster() {
  if (modelRosterRequested || bridge === null) return;
  modelRosterRequested = true;
  var revision = stateRevision;
  invoke("xd.fetchModels").then(function (next) {
    if (revision !== stateRevision) {
      modelRosterRequested = false;
      return;
    }
    adoptAndMaybePoll(next, 0);
  }).catch(function (error) {
    // A failed read must not latch the panel onto the static fallback for the
    // rest of its life: release the guard so the next visit tries again.
    modelRosterRequested = false;
    if (revision !== stateRevision) return;
    note(String(error && error.message ? error.message : error), "warn");
  });
}
function discardDraft() {
  // Only the page in view: another page's unsaved edits are not this button's to
  // throw away.
  if (draftSlot !== null) delete drafts[draftSlot];
  draft = null;
  draftSlot = null;
  // The session this page's sheet belonged to is over, so it does not reopen on
  // the rebuild below and the roster stops marking the row. Another page's record
  // is not this button's to throw away either.
  if (selectedSheet !== null && selectedSheet.key === currentModelKey()) selectedSheet = null;
  renderModels();
  note(null);
}

function saveModels() {
  if (busy !== null) return;
  var page = modelPage();
  var submittedSlot = draftSlot;
  var submittedKey = currentModelKey();
  var enabledModelIds = [];
  var overrides = Object.create(null);
  page.list.forEach(function (model) {
    var entry = draft[model.id];
    if (!entry) return;
    if (entry.enabled) enabledModelIds.push(model.id);
    // Only a field that differs from the catalog is stored: an untouched row
    // must not freeze today's catalog numbers into the settings file.
    var override = {};
    if (entry.alias !== "") override.alias = entry.alias.trim();
    if (entry.window !== null) override.contextWindow = entry.window;
    if (entry.output !== null) override.maxOutputTokens = entry.output;
    if (entry.images !== null) override.supportsImages = entry.images;
    if (entry.levels !== null) override.thinkingLevels = entry.levels;
    if (entry.defaultLevel !== null) override.defaultThinkingLevel = entry.defaultLevel;
    if (Object.keys(override).length > 0) overrides[model.id] = override;
  });

  if (enabledModelIds.length === 0) {
    note(t("models.zeroEnabled"));
    return;
  }

  busy = "save";
  render();
  invoke("xd.saveModels", {
    gateway: page.key,
    selection: { enabledModelIds: enabledModelIds, overrides: overrides },
    // The models this page actually showed. A roster read can be partial (the
    // static fallback while the live list is still unread, or a directory that
    // answered with fewer rows), and the host keeps the stored entries for the
    // ids this page could not display instead of reading their absence as a
    // deliberate removal.
    knownModelIds: page.list.map(function (model) { return model.id; }),
  }).then(function (next) {
    busy = null;
    adopt(next);
    // Saved, so this page's slot goes: coming back rebuilds from what was just
    // stored rather than from a draft that is no longer pending.
    if (submittedSlot !== null) delete drafts[submittedSlot];
    draft = null;
    draftSlot = null;
    // The edit is done: the sheet collapses with the draft it belonged to
    // instead of reopening on the rebuild and leaving the row marked as edited.
    if (selectedSheet !== null && selectedSheet.key === submittedKey) selectedSheet = null;
    render();
    announce(t("models.saved"));
  }).catch(function (error) {
    busy = null;
    note(t("models.saveError", { message: String(error && error.message ? error.message : error) }));
    render();
  });
}

function runDoctor() {
  return runBusy("doctor", function () { return invoke("xd.doctor"); }).then(function (result) {
    doctorResult = result;
    render();
  }).catch(function () {});
}

/**
 * Copy the doctor report.
 *
 * The browser's own clipboard is the only writer here: this page is served over
 * a loopback address, which is a secure context, and the click that got here is
 * the user gesture it needs. When it is refused the report is selected in the
 * page instead, so Ctrl+C still gets it out.
 */
function copyReport() {
  if (doctorResult === null) return;
  var text = doctorResult.report || "";
  // Takes the key to show, not a boolean: the two failure cases need different
  // words, and translating here keeps every message in the dictionary.
  var done = function (key) { $("copyHint").textContent = t(key); };
  // The report is a <pre>, which has neither select() nor setSelectionRange():
  // both are input-only. A Range over its contents is what actually selects
  // rendered text, and that is the only way to make the hint's promise true.
  var selectReport = function () {
    var box = $("report");
    if (!box || typeof window.getSelection !== "function" || typeof document.createRange !== "function") return false;
    try {
      box.parentElement.open = true;
      var range = document.createRange();
      range.selectNodeContents(box);
      var selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return selection.toString() !== "";
    } catch (error) {
      return false;
    }
  };
  // The hint claims the report is selected, so say so only when it really is:
  // an unselected report would send the user looking for something that is
  // not there.
  var failed = function () { done(selectReport() ? "copy.failedSelected" : "copy.failed"); };
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    navigator.clipboard.writeText(text).then(function () { done("copy.ok"); }, failed);
    return;
  }
  failed();
}

// -------------------------------------------------------------------- tabs

function selectTab(name) {
  activeTab = name;
  var views = { pool: "poolView", models: "modelsView", check: "checkView", growth: "growthView" };
  Object.keys(views).forEach(function (key) {
    show($(views[key]), key === name);
  });
  var tabs = document.querySelectorAll("#viewTabs .subtab");
  for (var i = 0; i < tabs.length; i += 1) {
    var isActive = tabs[i].getAttribute("data-tab") === name;
    tabs[i].className = isActive ? "subtab active" : "subtab";
    tabs[i].setAttribute("aria-selected", isActive ? "true" : "false");
    tabs[i].tabIndex = isActive ? 0 : -1;
  }
  // Each page starts at its own top. Carrying the previous page's offset over
  // landed the user mid-roster after leaving the pool scrolled to its third
  // account.
  pageScrollTo(0);
  // Entering the tab while another action runs would raise the busy banner and
  // silently skip the doctor; the next entry retries.
  if (name === "check" && doctorResult === null && busy === null) runDoctor();
  // The model page shows a roster, so entering it is the moment to make sure
  // that roster is the vendor's and not this plugin's own fallback.
  if (name === "models") requestModelRoster();
  // Entering the growth page is a refresh, not a prompt to go press a button: the
  // figures the card shows are read on entry, and the cached ones are shown while
  // that read is in flight. A read costs one request per account and claims
  // nothing, so the throttle is what keeps tab-hopping from becoming a burst.
  // A pass already walking those accounts is waited out: a check-in pass runs the
  // growth half itself, and a read beside it would double the requests.
  if (name === "growth" && busy === null && !growthReading && growthStale()
    && !(state && state.growth && state.growth.running === true)) readGrowth();
}

/** Move focus inside a tablist without changing the selected view. */
function moveTabFocus(list, current, key) {
  var tabs = Array.prototype.filter.call(list.querySelectorAll('[role="tab"]'), function (tab) {
    return !tab.hidden && !tab.disabled;
  });
  var index = tabs.indexOf(current);
  if (index < 0 || tabs.length < 2) return false;
  var targetIndex;
  if (key === "ArrowRight") targetIndex = (index + 1) % tabs.length;
  else if (key === "ArrowLeft") targetIndex = (index + tabs.length - 1) % tabs.length;
  else if (key === "Home") targetIndex = 0;
  else if (key === "End") targetIndex = tabs.length - 1;
  else return false;
  current.tabIndex = -1;
  tabs[targetIndex].tabIndex = 0;
  tabs[targetIndex].focus();
  return true;
}

function labelTabs() {
  $("sourceTabs").setAttribute("aria-label", t("tabs.sources"));
  $("viewTabs").setAttribute("aria-label", t("tabs.views"));
  var tabs = document.querySelectorAll("#viewTabs .subtab");
  for (var i = 0; i < tabs.length; i += 1) {
    var key = tabs[i].getAttribute("data-tab");
    tabs[i].textContent = t("tab." + key);
    tabs[i].title = t("tab." + key);
    // The growth centre is WorkBuddy's alone: a tab that leads to a page
    // reading "not this source" is worse than no tab at all.
    tabs[i].hidden = key === "growth" && activeSource !== "workbuddy";
  }
  // The risk note is static markup too, on the line with the source tabs.
  $("riskNote").textContent = t("risk.note");
  document.querySelectorAll("[data-help-label]").forEach(function (node) {
    iconLabel(node, t(node.getAttribute("data-help-label")));
  });
  // The footer links are static markup, so their labels follow the locale here
  // rather than through the render pass.
  document.querySelectorAll(".activity-log > summary span").forEach(function (node) { node.textContent = t("activity.title"); });
  var labels = document.querySelectorAll(".foot-links [data-foot-label]");
  for (var j = 0; j < labels.length; j += 1) {
    labels[j].textContent = t("foot." + labels[j].getAttribute("data-foot-label"));
    labels[j].className = "sr-only";
    labels[j].parentElement.title = labels[j].textContent;
  }
}

// -------------------------------------------------------------------- init

function bind() {
  // A hidden page stops polling; showing it again re-arms whatever the current
  // document says is still running.
  document.addEventListener("visibilitychange", function () {
    if (!pageIsVisible()) { stopPolling(); stopCheckinPoll(); stopGrowthPoll(); return; }
    if (state && state.refreshing === true) adoptAndMaybePoll(state, 0);
    else if (state && state.autoCheckin && state.autoCheckin.last && state.autoCheckin.last.pending === true) {
      checkinPollFailures = 0;
      pollCheckinLog(0);
    }
    if (state && state.growth && state.growth.running === true) {
      growthPollFailures = 0;
      pollGrowthRun();
    }
  });
  $("refreshBtn").addEventListener("click", refresh);
  $("rescanBtn").addEventListener("click", rescan);
  $("resetBtn").addEventListener("click", clearCooldowns);
  $("doctorBtn").addEventListener("click", runDoctor);
  $("copyBtn").addEventListener("click", copyReport);
  $("saveBtn").addEventListener("click", saveModels);
  $("discardBtn").addEventListener("click", discardDraft);
  $("modelSearch").addEventListener("input", renderModels);
  $("chosenSearch").addEventListener("input", renderChosen);
  $("modelSelectAll").addEventListener("change", toggleAllVisible);
  $("modelFetchBtn").addEventListener("click", fetchModelList);
  // The composer readout switch: bound once here because the button is a static
  // node, and the new state is the opposite of what the last render said.
  var composerToggle = $("showComposerPoints");
  if (composerToggle) {
    composerToggle.addEventListener("click", function () {
      setComposerPoints(state === null || state.showComposerPoints !== true);
    });
  }
  // Bound once, with the state read at click time: this is a static node, so the
  // handler cannot live in the render pass that redraws it.
  $("autoHours").addEventListener("input", function () {
    autoHoursDraft = $("autoHours").value;
  });
  $("autoHoursSave").addEventListener("click", function () {
    var auto = (state && state.autoCheckin) || { enabled: false };
    // Saving the box is explicit, so unreadable text is reported even while the
    // switch is off. Turning the switch off still ignores a bad box: that path
    // has to stop the timer.
    var hours = parseCheckinHours($("autoHours").value);
    if (hours === null) {
      note(t("auto.badHours"));
      return;
    }
    setAutoCheckin(auto.enabled === true, hours);
  });
  // The manual pass runs the same work the scheduled hour runs, so it is busy for
  // as long as that takes — the button reports it rather than sitting idle.
  $("autoRunNow").addEventListener("click", async function () {
    if (sourceOn("workbuddy") && SOURCE_REGIONS.workbuddy.some(function (region) { return !regionParked("workbuddy", region); })
      && !await confirmGrowth(t("auto.runConfirm"))) return;
    runBusy("checkin", function () { return invoke("xd.runCheckinNow"); })
      .then(function () { pollCheckinLog(0); })
      .catch(function () {});
  });
  // The keep-alive's one control, bound once for the same reason. There is no
  // schedule behind it, so the button is the only thing that runs a pass.
  $("tokenKeepAliveRun").addEventListener("click", function () {
    runKeepAliveNow();
  });
  // Bound once, like the check-in button above: the render pass rebuilds most of
  // the panel, and a listener added per pass would fire one request per render.
  $("growthRead").addEventListener("click", function () { readGrowth(); });
  $("growthRun").addEventListener("click", async function () { if (await confirmGrowth(t("growth.runConfirm"))) runGrowth(); });

  // One listener for every control in the panel, rather than one per button: the
  // render pass rebuilds most of them, so per-button listeners would have to be
  // re-attached on every pass. Capture phase, so it runs before the button's own
  // handler and records the press even when that handler is about to disable it.
  document.addEventListener("pointerdown", function (event) {
    notePress(controlUnder(event.target));
  }, true);
  // Keyboard activation fires click without a pointerdown, so the same memory
  // has to be filled here or Enter/Space lost the focus on the next render.
  document.addEventListener("keydown", function (event) {
    if (event.key !== "Enter" && event.key !== " ") return;
    notePress(controlUnder(event.target));
  }, true);

  var viewTabs = document.querySelectorAll("#viewTabs .subtab");
  for (var i = 0; i < viewTabs.length; i += 1) {
    (function (button) {
      button.addEventListener("click", function () { selectTab(button.getAttribute("data-tab")); });
      button.addEventListener("keydown", function (event) {
        if (moveTabFocus($('viewTabs'), button, event.key)) event.preventDefault();
      });
    })(viewTabs[i]);
  }
  var viewTabList = $("viewTabs");
  viewTabList.addEventListener("focusout", function (event) {
    if (viewTabList.contains(event.relatedTarget)) return;
    var tabs = viewTabList.querySelectorAll('[role="tab"]');
    for (var i = 0; i < tabs.length; i += 1) {
      tabs[i].tabIndex = tabs[i].getAttribute("aria-selected") === "true" ? 0 : -1;
    }
  });

  // A source tab owns both the pool page and the models page, so switching it
  // re-renders whichever of the two is on screen.
  var sourceTabs = document.querySelectorAll("#sourceTabs .tab");
  for (var j = 0; j < sourceTabs.length; j += 1) {
    (function (button) {
      button.addEventListener("click", function () {
        activeSource = button.getAttribute("data-source");
        renderSourceTabs();
      });
    })(sourceTabs[j]);
  }
}

function boot() {
  labelTabs();
  bind();
  if (bridge === null) {
    note(t("err.bridge"));
    return;
  }
  // The frame bridge reports the host's selected theme and locale.
  function applyAppearance(appearance) {
    var base = appearance && appearance.base;
    if (base === "light" || base === "dark") {
      document.documentElement.dataset.base = base;
    }
    if (!appearance || typeof appearance.locale !== "string") return;
    locale = appearance.locale;
    TABLE = locale.toLowerCase().indexOf("zh") === 0 ? ZH : EN;
    document.documentElement.lang = locale;
    labelTabs();
    render();
  }
  if (typeof bridge.on === "function") bridge.on("appearance:changed", applyAppearance);
  invoke("app.getAppearance").then(applyAppearance).catch(function () {});
  // First paint comes from cache; the poll below picks up the refresh the main
  // process runs behind it, which is what keeps opening the panel fast.
  // A first read can also fail while the plugin is still activating: the panel
  // route exists from the moment the entry applies, but its host half may not
  // have finished starting. A few bounded retries cover that window; anything
  // still failing after them is a real error and renders as one.
  var bootAttempts = 0;
  function requestFirstState() {
    invoke("xd.state").then(function (next) {
      adoptAndMaybePoll(next, 0);
      pollCheckinLog(0);
      // After the first document, so a panel opened while the plugin process is
      // still starting does not burn its one roster request on a dead bridge.
      requestModelRoster();
    }).catch(function (error) {
      bootAttempts += 1;
      if (bootAttempts < 4) {
        setTimeout(requestFirstState, 600);
        return;
      }
      note(String(error && error.message ? error.message : error));
      render();
    });
  }
  requestFirstState();
}

boot();
