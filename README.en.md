<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://github.com/chengzhi-c/dsh-wtq-pool/raw/main/docs/logo-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="https://github.com/chengzhi-c/dsh-wtq-pool/raw/main/docs/logo.png">
    <img src="https://github.com/chengzhi-c/dsh-wtq-pool/raw/main/docs/logo.png" width="240" alt="WTQ Pool">
  </picture>
</p>

<h1 align="center">WTQ Pool</h1>

<p align="center"><sub>For DeepSeek Harness · <a href="https://github.com/chengzhi-c/pi-desktop-wtq-pool">PI-Desktop edition</a></sub></p>

<p align="center"><b>Use local WorkBuddy, Trae and Qoder sign-ins in DeepSeek Harness, with automatic failover when an account is rate-limited or out of quota.</b></p>

<p align="center">
  <b>English</b> | <a href="README.md">简体中文</a>
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#features">Features</a> ·
  <a href="#usage">Usage</a> ·
  <a href="#settings">Settings</a> ·
  <a href="CHANGELOG.md">Changelog</a> ·
  <a href="https://github.com/chengzhi-c/dsh-wtq-pool/issues">Issues</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-wtq-pool"><img src="https://img.shields.io/npm/v/dsh-wtq-pool?style=flat-square&amp;label=npm&amp;color=cb3837" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/dsh-wtq-pool"><img src="https://img.shields.io/npm/d18m/dsh-wtq-pool?style=flat-square&amp;label=downloads&amp;color=cb3837" alt="npm downloads"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/chengzhi-c/dsh-wtq-pool?style=flat-square" alt="MIT license"></a>
  <a href="https://github.com/chengzhi-c/dsh-wtq-pool/releases"><img src="https://img.shields.io/github/v/release/chengzhi-c/dsh-wtq-pool?style=flat-square&amp;label=release" alt="release"></a>
  <a href="https://github.com/chengzhi-c/dsh-wtq-pool/stargazers"><img src="https://img.shields.io/github/stars/chengzhi-c/dsh-wtq-pool?style=flat-square" alt="GitHub stars"></a>
</p>

> **! A ban is possible. Use at your own discretion; no liability accepted !**

Use local WorkBuddy, Trae and Qoder desktop sign-ins in DeepSeek Harness. WorkBuddy fails over when an account is rate-limited or out of quota. Trae and Qoder select an account per request and move on to the next sign-in on an authentication failure, a rate limit or exhausted quota, while a problem with the request itself, such as an unknown model or a malformed body, is answered as the upstream answered it. Each source has its own switch, with domestic and international accounts grouped separately.

A rate limit cools for the wait the upstream stated, or the configured window when it stated none. Exhausted quota and a dead sign-in do not recover on their own: that account leaves rotation. A balance read releases an exhausted-quota hold; a successful token refresh, a fresh sign-in or a manual cooldown reset releases a refused-sign-in hold, and both lapse after six hours (WorkBuddy). The non-stream reads of credits, check-in state, the model catalogue and check-ins force one token refresh and one retry when a sign-in is refused: an account whose refresh token still works recovers on the spot and never leaves rotation, and only one whose refresh token is spent too is held. Trae and Qoder holds are accounted separately, demoting the sign-in only by the cooldown window (60 seconds by default, configurable up to 24 hours) or by the wait the upstream stated, and it is still used when it is the only one left. When the upstream host cannot be reached at all, the turn ends with a network error. When the upstream says an account's plan does not include a model (11158), that model is disabled on that account for 24 hours while its other models keep serving; if no account includes it, the turn is answered with 400.

## Preview

The settings panel in its default light theme:

![Account pool](https://github.com/chengzhi-c/dsh-wtq-pool/raw/main/docs/preview-pool.png)

The panel reads the host's `app.getAppearance()` when it loads, which fixes its palette and its language. After a host theme switch, press "Reload panel" on the card to read it again:

![Dark theme](https://github.com/chengzhi-c/dsh-wtq-pool/raw/main/docs/preview-dark.png)

The model page edits each model's display and publishing settings. A Trae directory row states only its plan default, which differs per model (116k to 400k). A model that states no larger tier is published with the measured 1M ceiling. A Trae model whose directory states a rate carries a cost tag such as `x0.79`; models whose directory states none, and every Qoder model, stay unlabelled:

![Model settings](https://github.com/chengzhi-c/dsh-wtq-pool/raw/main/docs/preview-models.png)

Growth centre:

![Growth centre](https://github.com/chengzhi-c/dsh-wtq-pool/raw/main/docs/preview-growth.png)

Live preview: <https://chengzhi-c.github.io/dsh-wtq-pool/>.

`docs/index.html` drives the actual panel code with synthetic demo data. It supports source switching, model settings and theme previews.

![Preview page](https://github.com/chengzhi-c/dsh-wtq-pool/raw/main/docs/preview-page.png)

With `showComposerPoints` enabled, the composer toolbar shows the credits of the account behind the current model; click it to inspect that group and switch accounts. The image below is an off-screen render of the actual composer extension:

![Composer credits](https://github.com/chengzhi-c/dsh-wtq-pool/raw/main/docs/preview-composer.png)

To run the preview locally, clone the repository, run `node docs/serve.cjs`, and open the address it prints. The page cannot be opened over `file://`, because a browser will not let it read the panel files beside it.

## Features

- Reuse the local sign-ins: the sign-in files the three desktop apps saved are read as they are. The panel's Add account opens the vendor's own login page and writes the result into the plugin's own directory.
- Register model groups by region: each region of each vendor becomes its own provider, and several can be on at once; a region with no account is not registered. A domestic model runs only on domestic accounts, and an international model only on international ones.
- Account distribution: WorkBuddy supports priority, round-robin, expiring credits first and conversation-sticky accounts, and fails over on a rate limit or exhausted quota. Trae and Qoder support priority, round-robin and expiring credits first, and move on to the next sign-in on an authentication failure, a rate limit or exhausted quota.
- Gateway responses are SSE streams of `chat.completion.chunk`; the `stream` field in the request body does not change the format.
- Credit automation: automatic check-in is off by default. Once enabled, the scheduled run and "Run now" perform the same round: the three check-ins plus the WorkBuddy streak bonus and cat travel. The upstream advances the streak on a conversation, so the round reports one chat activity per account before reading the streak tiers, and a tier that comes due is unlocked and collected without the user opening WorkBuddy to send a message. The streak step also spends a make-up card when yesterday was missed, collects the one-off starter gift and campaign compensation, and spends the draws a redeemed tier awards. These growth steps run for domestic and international accounts alike; cat travel runs for domestic accounts only, because the international host has no such API.
- Token keep-alive: on demand, on a card of its own. A snapshot the desktop client left behind is adopted into the plugin's own sign-in directory when the pool scans, and the plugin renews it from then on; the desktop app renews the sign-in it is using. "Refresh now" works on the plugin's own copies and judges by issue time: anything signed more than six hours ago is refreshed, and a token within five minutes of expiry takes the same path. The answer is written back into the sign-in file the plugin owns, so a sign-in the upstream refused is found the same day. When one account has sign-ins in several places, the newest issue time wins. Disabled accounts, disabled regions and accounts whose sign-in the upstream refused stay out.
- Composer credits: with `showComposerPoints` on, the composer toolbar shows the balance of the account behind the current model; click it to switch accounts, and switching the feature off stops the readout's polling.
- Panel: account and pool state, model selection, the connection check and the growth centre all live in the account-pool card on the plugin page. The model catalogue loads at startup and refreshes on demand once its cache expires; it does not poll while idle. Disabled accounts and accounts whose sign-in the upstream refused are never probed.
- Connection check: every finding carries a verdict. A gateway that is not listening, a catalogue that could not be read, a published address that differs from the one actually bound, and a provider the host did not accept all count as failures and say what to change. A gateway whose start failed is reported with the reason, and the panel surfaces address drift as a reload hint. A check that fails on its own becomes a finding, and the rest of the report still appears.

## Install

For a local package, run `pnpm install && pnpm run build && npm pack --pack-destination dist` in the source directory, then install the generated `.tgz`:

```powershell
$package = (Get-ChildItem .\dist\*.tgz | Sort-Object LastWriteTime | Select-Object -Last 1).FullName
dsh plugin --profile desktop add $package
```

Requires DeepSeek Harness on the 0.2.0 line (`engines.dsh` in `package.json`: `>=0.2.0-rc.1 <0.2.1`) and Node `^22.19.0 || >=24.0.0`.

Replace `desktop` with the profile name actually in use. If `dsh` is not on `PATH`, use the CLI in its installation directory. The npm name `dsh-wtq-pool` and the repository URL also work as install sources; a repository-URL install builds from source through the `prepare` script, which requires `allowBuilds: dsh-wtq-pool: true` in the profile's `pnpm-workspace.yaml` and a pinned commit.

**Where the panel is**: open **Plugins** in the sidebar, then open the **dsh-wtq-pool** card, or the **Configure** control beside it; the full panel is embedded in that card. If the model groups do not appear, reload the plugin as the note at the top of the panel says.

## Usage

Sign in inside each vendor's desktop app, then click "Detect accounts again". WorkBuddy reads several saved sign-ins; a `$wbEncrypted` sign-in from 5.6 on is read with a key obtained from the locally installed WorkBuddy. The domestic Trae build has two sign-in slots, Trae CN and TRAE SOLO CN. Qoder keeps one sign-in per installation, so signing in again in the app overwrites the previous one. The international WorkBuddy client keeps a single sign-in file, so switching accounts overwrites the previous one. The plugin archives a sign-in as it is overwritten, and that account keeps serving until its token expires; signing it in again in the app renews it.

An account can also be added without the desktop app: "Add account" in the panel's WorkBuddy header opens the vendor's login page in a new tab, and the account joins the pool once that page completes. The credential is written under `signins/` in the plugin's own data directory and takes part in distribution on the same terms as a desktop sign-in. Such an account also carries a "Delete" action, which confirms on a second press; see the Data section for what it removes. An account the desktop app is signed into right now has no Delete: that session belongs to the app. The account is added to the region currently selected, so the domestic region signs in a domestic account and the international region an international one.

To migrate accounts left behind by another tool, write the files into that directory: `signins/` is the import format, and one `{auth, account}` document named `*.info` dropped there becomes an ordinary account on the next scan. `tools/import-signins.cjs` reads those account files (`--from` accepts files or directories) and writes them in the shape this plugin reads, skipping any account the plugin's own data directory already holds; `--dry-run` shows what would change and `--force` overwrites:

```
node tools/import-signins.cjs --data "<plugin data dir>" --from "<account file or directory>" [--region cn|global|all] [--dry-run] [--force]
```

To back them up, copy the `signins/` directory, which already has the format a backup needs. Those files hold live tokens whose reach equals that of the account itself.

- **Account pool**: each account's label, remaining credits, quota expiry, cooldown state and check-in progress. An account can be disabled on its own or removed, and a region can be pinned to one preferred account. An account whose sign-in the upstream refused shows a "re-login needed" badge, the reason and a "held until" time; credits and check-in stay blank while held. An account the upstream restricted instead shows a "restricted" badge and a "restricted by the upstream until" stamp, is retried every six hours, and needs an appeal in the WorkBuddy console.
- **Models**: select which models this region exposes; anything unselected stays out of the model picker. The display name, context window, output limit, thinking levels and image support are editable. A model group publishes at most 64 models; any beyond that are marked "not published" while the gateway still serves them.
- **Connection check**: reports line by line whether each gateway is listening, how many models its catalogue returned, whether the registered address matches the one actually bound, and whether the host accepted each provider, and can copy the whole report.
- **Growth centre**: applies to WorkBuddy only. It lists one row per account, and expanding a row shows that account's streak tiers. "Read state" reads the current tiers and what is due; "Run now" claims them and runs the growth stage, reporting every step: the make-up card, the gift and compensation, the activity report, and the streak tiers with their draws. An account whose sign-in the upstream refused is skipped in that round.

Check-in runs per account, or for a whole source from the title bar. Automatic check-in is off by default; when on it claims at 09:00 (Beijing time), and a slot missed earlier the same day is still claimed at the next start, while one from a previous day is not. Trae's daily check-in is once per device; Qoder's new round opens at 10:00 (Beijing time). An account whose sign-in the upstream refused is skipped in that round.

The domestic WorkBuddy host refuses conversational requests whose client identifies itself as DeepSeek Harness (11128, channel check failed). Check-in, the growth centre and the keep-alive use their own endpoints.

The panel's **Client name** switch controls that rewrite and is off by default. Turned on, every occurrence of `DeepSeek Harness` in the prompt is sent as `DeepSeek`; turned off, the original wording is sent.

"Refresh now" reports refreshed, already fresh, failed and without a refresh token separately.

A read stays in the host process, so reloading the panel still paints the last figures. Entering the tab re-reads figures older than two minutes, figures a later pass has outdated, or figures from a region since disabled.

## Settings

Every key below is editable in the plugin page and saved on confirm:

| Key | Default (effective) | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Off: the gateways do not start |
| `sourceWorkbuddy` / `sourceTrae` / `sourceQoder` | `true` | Off: that source is not scanned, published or requested |
| `distribution` | `priority` | How the WorkBuddy pool spreads requests: `priority` uses one account first, `round-robin` spreads evenly, `expiry` spends expiring credits first, `sticky` pins one account per conversation |
| `sourceDistributions` | `{}` | Trae/Qoder distribution: `priority` / `round-robin` / `expiry`; unset behaves as `priority` |
| `cooldownSeconds` | `60` | Rate-limit cooldown. A reset time the upstream reports takes precedence; with none, consecutive limits double it up to 15 minutes (a longer configured window is left alone) |
| `creditReserves` | `{}` | Per-account credit floor, keyed by account id; an account at or below its floor is not distributed to |
| `authFile` | `""` | WorkBuddy sign-in file path; every `.info` sign-in in its directory is scanned. Empty discovers it |
| `autoCheckin` | `{"enabled":false,"hours":[9]}` | Automatic check-in switch and times; `hours` are Beijing-time hours, empty means 09:00 |
| `showComposerPoints` | `false` | Show the active account's credits in the composer |
| `rewriteClientName` | `false` | Send `DeepSeek` in place of the client name `DeepSeek Harness` in the prompt going to the domestic host, so its channel check (11128) passes; the international host accepts either name |
| `disabledAccountIds` | `[]` | Account ids disabled in the panel |
| `disabledRegions` | `[]` | Regions disabled on their own, as `source:region` keys |
| `modelSelection` | `{}` | Which models each gateway publishes, plus display name, context window and other overrides |
| `preferredAccountIds` | `{}` | Preferred WorkBuddy account per region |
| `preferredSourceAccounts` | `{}` | Preferred Trae/Qoder account per region, keyed by `source:region` |
| `removedAccounts` | `[]` | Accounts removed from the pool, with label and region kept so the panel can offer a restore |

The default column lists effective values: `autoCheckin.hours` is stored as an empty array and normalises to `[9]`, and an unset or empty `authFile` means auto-discovery.

Model selection and preferred accounts are saved by the panel.

## Ports

```
WorkBuddy  42831 / 42841
Trae       42851 / 42861
Qoder      42871 / 42881
```

These are the preferred ports. When one is taken, the gateway binds an ephemeral port and runtime provider registration uses that address, which the panel reports as the fallback.

When another process takes a port between the reservation and the listen, that gateway's start fails: its model group is dropped, the connection check reports the reason, and the panel surfaces address drift. Requests reach the new address only after the plugin is reloaded and the host re-reads its declaration.

The PI-Desktop edition uses a separate range starting at 41831, so both plugins can be installed on one machine with each range intact. Each edition keeps its own copy of a sign-in and renews it on its own schedule, and the upstream rotates the refresh token whenever one does. A single account is therefore held by whichever edition renewed it last: the other one's refresh token stops working, its panel marks the account as needing a sign-in, and "Add account" puts it back. The token days differ for the same reason, since each row shows the expiry of that edition's own copy. To keep one account working in both editions, add it in only one of them, or re-add it in the one that was marked.

## Data and outbound requests

The plugin reads the vendors' local sign-in files. Providers are registered at runtime; the host persists plugin settings in the profile. Tokens are held by the plugin and go only to the relevant vendor endpoints. Gateways listen on `127.0.0.1`; the panel accepts loopback requests only.

The plugin's own data directory, `~/.dsh/dsh-wtq-pool/` (or `$DSH_HOME` when set), holds four files (a `deleted-signins.json.lock` appears for a moment while the delete record is written). `checkin-slots.json` records the check-in slots already collected, kept for three days. `doctor.txt` is the most recent connection report, item by item, and names no account. `credentials-archive.json` keeps the sign-ins a later account switch overwrote, access tokens included, by token expiry, dropping each 30 days after it. `deleted-signins.json` records deleted sign-ins as a token digest, the sign-in's issue time and a delete time, so a scan cannot take the same superseded snapshot back over from the desktop app; the entry lapses once that account signs in again.

Every sign-in the plugin writes lives in `signins/` beside it: ones added from the panel, snapshots adopted from the desktop app, and renewed copies. Each file is named after the account's billing identity and read on the same terms as a desktop sign-in. "Delete" in the panel removes that file together with its archive entry, and the snapshot the desktop app left behind stops being adopted; signing the account in again brings it back. "Remove" only disables the account, and "Removed accounts" restores it.

The plugin sends requests only to the vendor endpoints; panel links open only when clicked.

Tokens go only to the hosts below:

- WorkBuddy: `copilot.tencent.com`, `www.codebuddy.cn`, `www.codebuddy.ai`, `www.workbuddy.ai`
- Trae: `api.trae.cn`, `solo.trae.cn`, `trae-api-cn.mchost.guru`, `coresg-normal.trae.ai`, `growsg-normal.trae.ai`
- Qoder: `gateway.qoder.com.cn`, `openapi.qoder.com.cn`, `api3.qoder.sh`, `openapi.qoder.sh`

## Development

```sh
pnpm install
pnpm run build           # emits lib/ (host half as ESM, client half as CJS)
pnpm run typecheck       # host half
pnpm run typecheck:client
pnpm test                # Node's own test runner, offline regressions
```

`src/host.ts` is the engine (account discovery, the pool, the gateways, the panel channels), `src/index.ts` is the Cordis entry (settings schema, provider registration, panel routes), and `src/pi-compat.ts` adapts the host's capabilities to the calls the engine makes. `renderer/` is the panel itself, `index.html`, `panel.js` and `panel.css`, in plain JavaScript with no build step, mounted by `src/web-panel.ts` on the host's web server and served to the plugin card as a same-origin iframe. `src/client/` is the React half: the plugin-page card that embeds that iframe (`index.tsx`), its address construction (`panel-url.ts`), and the composer readout (`composer.tsx`). `lib/` is emitted by `tsdown`, listed in `package.json`'s `files` and committed, so it must be rebuilt after changing `src/`.

The host-agnostic core:

| Module | Responsibility |
| --- | --- |
| `loopback.ts` | The loopback security model (Host and Origin checks), response writing, stream relay and message redaction |
| `accounts.ts` | WorkBuddy sign-in parsing, token encryption, the account pool and its cooldowns |
| `upstream.ts` | The WorkBuddy upstream client, error classification, rate-limit reset parsing |
| `catalog.ts` | The model catalogue and its static fallback list |
| `shim.ts` | The WorkBuddy gateway's OpenAI-compatible endpoint |
| `at-rest.ts` | Unsealing 5.6+ encrypted sign-in fields |
| `promo.ts` | Promotion window matching |
| `trae-*.ts` / `qoder-*.ts` | Sign-in discovery, protocol clients, SSE decoding and gateways for both vendors |

## Credits

Several modules are ported from or reference the MIT projects below:

| Project | Copyright | Used for |
| --- | --- | --- |
| [XDTrees/dsh-workbuddy-xdpool](https://github.com/XDTrees/dsh-workbuddy-xdpool) | (c) 2026 XDTrees | WorkBuddy account pool and the port this plugin came from |
| [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) | (c) 2026 Corrine Hu | The loopback endpoint's security model |
| [dingminhua/dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy) | (c) 2026 LaoDing | Upstream API and error classification |
| [dingminhua/dsh-connect-trae](https://github.com/dingminhua/dsh-connect-trae) | (c) 2026 dingminhua | Trae protocol reference |
| [eghrhegpe/dsh-connect-qoder](https://github.com/eghrhegpe/dsh-connect-qoder) | (c) 2026 eghrhegpe | Qoder protocol reference |
| [ardeyouxipianyi/workbuddy2api-hub](https://github.com/ardeyouxipianyi/workbuddy2api-hub) | (c) 2026 ardeyouxipianyi | Growth centre and streak loop (make-up cards, gift, compensation, lottery), multi-account credential retention, activity reporting for international accounts |

## License

MIT, see [LICENSE](./LICENSE).
