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

A rate limit cools for the wait the upstream stated, taking the reset time from the response header when that is the only place it appears. Exhausted quota and a dead sign-in do not recover on their own: that account leaves rotation. A balance read releases an exhausted-quota hold, a fresh sign-in or a manual cooldown reset releases a refused-sign-in hold, and both lapse after six hours (WorkBuddy). Trae and Qoder holds are accounted separately, demoting the sign-in only by the cooldown window (60 seconds by default, configurable up to 24 hours) or by the wait the upstream stated, and it is still used when it is the only one left. When the upstream host cannot be reached at all, the next sign-in is tried.

## Preview

The settings panel in its default light theme:

![Account pool](https://github.com/chengzhi-c/dsh-wtq-pool/raw/main/docs/preview-pool.png)

The panel reads the host's `app.getAppearance()` when it loads, which fixes its palette and its language. After a host theme switch, press "Reload panel" on the card to read it again:

![Dark theme](https://github.com/chengzhi-c/dsh-wtq-pool/raw/main/docs/preview-dark.png)

The model page edits the display name, context window, output limit, thinking levels and image support. A Trae directory row states only its plan default, which differs per model (116k to 400k). A model that states no larger tier is published with the measured 1M ceiling. A Trae model whose directory states a rate carries a cost tag such as `x0.79`; models whose directory states none, and every Qoder model, stay unlabelled:

![Model settings](https://github.com/chengzhi-c/dsh-wtq-pool/raw/main/docs/preview-models.png)

The growth centre lists one row per account. "Read state" only reads; "Run now" performs that stage alone:

![Growth centre](https://github.com/chengzhi-c/dsh-wtq-pool/raw/main/docs/preview-growth.png)

Live preview: <https://chengzhi-c.github.io/dsh-wtq-pool/>.

`docs/index.html` drives the actual panel code with synthetic demo data. It supports source switching, model settings and theme previews without reading local accounts or tokens.

![Preview page](https://github.com/chengzhi-c/dsh-wtq-pool/raw/main/docs/preview-page.png)

With `showComposerPoints` enabled, the composer toolbar shows the credits of the account behind the current model; click it to inspect that group and switch accounts. The image below is an off-screen render of the actual composer extension:

![Composer credits](https://github.com/chengzhi-c/dsh-wtq-pool/raw/main/docs/preview-composer.png)

To run the preview locally, clone the repository, run `node docs/serve.cjs`, and open the address it prints. The page cannot be opened over `file://`, because a browser will not let it read the panel files beside it.

## Features

- Reuse the local sign-ins: the sign-in files the three desktop apps already saved are read and never modified, and no extra authorization is requested. The single exception is the panel's Add account, which opens the vendor's own login page and writes the result into the plugin's own directory.
- Register model groups by region: each region of each vendor becomes its own provider, and several can be on at once; a region with no account is not registered. A domestic model runs only on domestic accounts, and an international model only on international ones.
- Account distribution: WorkBuddy supports priority, round-robin, expiring credits first and conversation-sticky accounts, and fails over on a rate limit or exhausted quota. Trae and Qoder support priority, round-robin and expiring credits first, and move on to the next sign-in on an authentication failure, a rate limit or exhausted quota.
- Credit automation: automatic check-in is off by default. Once enabled, the scheduled run and "Run now" perform the same round: the three check-ins plus the WorkBuddy streak bonus and cat travel. The upstream advances the streak on a conversation, so the round reports one chat activity per account before reading the streak tiers, and a tier that comes due is unlocked and collected without the user opening WorkBuddy to send a message. The streak step also spends a make-up card when yesterday was missed, collects the one-off starter gift and campaign compensation, and spends the draws a redeemed tier awards. These growth steps run for domestic and international accounts alike; cat travel runs for domestic accounts only, because the international host has no such API. The plugin page carries a growth-centre tab that reads the state or runs that stage on its own and lists the accounts one row each.
- Token keep-alive: on demand, with no schedule behind it. "Refresh now" on the check-in card runs one pass by hand and handles only tokens within five minutes of expiry and tokens that report no expiry at all; a token with time left costs no request. It serves accounts nobody has used: once their token expires, the next request renews it, which pays that round trip on the user's own turn, and a dead refresh token fails that same turn. Disabled accounts and disabled regions stay out.
- Composer credits: with `showComposerPoints` on, the composer toolbar shows the balance of the account behind the current model; click it to switch accounts, and switching the feature off stops the readout's polling.
- Panel: account and pool state, model selection, the connection check and the growth centre all live in the account-pool card on the plugin page. The model catalogue loads at startup and refreshes on demand once its cache expires; it does not poll while idle. Disabled accounts are never probed, and the panel does not sit on "detecting" because of them.
- Connection check: every finding carries a verdict. A gateway that is not listening, a catalogue that could not be read, a published address that differs from the one actually bound, and a provider the host did not accept all count as failures and say what to change. A gateway whose start failed is reported with the reason, and the panel surfaces address drift as a reload hint. When the check itself throws, the failure becomes a finding rather than taking the whole channel down.

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

An account can also be added without the desktop app: "Add account" in the panel's WorkBuddy header opens the vendor's login page in a new tab, and the account joins the pool once that page completes. The credential is written under `signins/` in the plugin's own data directory and takes part in distribution on the same terms as a desktop sign-in. Such an account also carries a "Delete" action, which confirms on a second press and then removes the sign-in file together with its archive entry, with no way back. The account is added to the region currently selected, so the domestic realm signs in a domestic account and the international realm an international one.

To migrate accounts left behind by another tool, write the files into that directory: `signins/` is the import format, and one `{auth, account}` document named `*.info` dropped there becomes an ordinary account on the next scan. `tools/import-signins.cjs` reads those account files (`--from` accepts files or directories) and writes them in the shape this plugin reads, skipping any account the plugin's own data directory already holds; `--dry-run` shows what would change and `--force` overwrites:

```
node tools/import-signins.cjs --data "<plugin data dir>" --from "<account file or directory>" [--region cn|global|all] [--dry-run] [--force]
```

The panel offers no import or export button. Those files hold live tokens whose reach equals that of the account itself, so exporting them would copy the token elsewhere. To back them up, copy the `signins/` directory, which already has the format a backup needs.

A source is selected at the top level; below it sit four tabs: the account pool, the models, the connection check and the growth centre.

- **Account pool**: each account's label, remaining credits, quota expiry, cooldown state and check-in progress. An account can be disabled on its own or removed, and a region can be pinned to one preferred account. WorkBuddy supports priority, round-robin, expiring credits first and conversation-sticky distribution; Trae and Qoder support priority, round-robin and expiring credits first.
- **Models**: select which models this region exposes; anything unselected stays out of the model picker. The display name, context window, output limit, thinking levels and image support are editable. A model group publishes at most 64 models; any beyond that are marked "not published" while the gateway still serves them.
- **Connection check**: reports line by line whether each gateway is listening, how many models its catalogue returned, whether the registered address matches the one actually bound, and whether the host accepted each provider, and can copy the whole report.
- **Growth centre**: applies to WorkBuddy only. It lists one row per account, and expanding a row shows that account's streak tiers. "Read state" is read-only and claims nothing; "Run now" performs the growth stage of the scheduled pass on its own and reports it per step: the make-up card, the gift and compensation, the activity report, and the streak tiers with their draws.

Check-in runs per account, or for a whole source from the title bar. Automatic check-in is off by default; when on it claims at 09:00 (Beijing time), and a slot missed earlier the same day is still claimed at the next start, while one from a previous day is not. Trae's daily check-in is once per device; Qoder's new round opens at 10:00 (Beijing time).

The domestic WorkBuddy host refuses conversational requests whose client identifies itself as DeepSeek Harness (11128, channel check failed). Check-in, the growth centre and the keep-alive are unaffected, because they do not go through that check.

The panel's **Client name** switch controls that rewrite and is off by default. Turned on, every occurrence of `DeepSeek Harness` in the prompt is sent as `DeepSeek`; turned off, the original wording is sent.

The token keep-alive sits on the same card as the schedule, with no hour to set and no background timer: "Refresh now" runs one pass by hand and reports refreshed, already fresh, failed and without a refresh token separately. It touches no check-in progress.

Within the growth stage, the make-up card and the draws are consumed by a run, while the remaining steps are idempotent and repeating them pays nothing twice. A read stays in the host process, so reloading the panel still paints the last figures. Entering the tab re-reads when the figures are over two minutes old, when a pass ran after the read (including the growth stage of a scheduled check-in), or when a region was disabled.

## Settings

Every key below is declared in the host's settings schema and written back to the profile:

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
| `rewriteClientName` | `false` | Send `DeepSeek` in place of the client name `DeepSeek Harness` in the prompt going to the domestic host, so its channel check (11128) passes; the international host is untouched |
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

The PI-Desktop edition uses a separate range starting at 41831, so both plugins can be installed on one machine with each range intact.

## Data and outbound requests

The plugin only reads the vendors' local sign-in files and never writes back sign-in state. Providers are registered at runtime without rewriting host provider configuration, while the host still persists plugin settings in the profile. Tokens stay in the plugin process and are sent only to the relevant vendor endpoints. Gateways listen on `127.0.0.1`; panel assets and RPC require an actual loopback peer and ignore forwarded address headers, so a remote browser cannot use the panel directly. The plugin neither manages nor deletes host conversation records.

The plugin's own data directory, `~/.dsh/dsh-wtq-pool/` (or `$DSH_HOME` when set), holds three files. `checkin-slots.json` records the check-in slots already collected, kept for three days. `doctor.txt` is the most recent connection report, item by item, and names no account. `credentials-archive.json` keeps the sign-ins a later account switch overwrote, access tokens included, by token expiry, dropping each 30 days after it.

A sign-in added with "Add account" lands in a `signins/` subdirectory of the same place, named after the account's billing identity and read on the same terms as a desktop sign-in. "Delete" in the panel removes that file together with its archive entry, with no way back, whereas "Remove" only disables the account and "Removed accounts" restores it.

Another process on the same machine can call these loopback endpoints and spend a signed-in account's quota. If replies go missing after a restart, check both the plugin log and the host's persisted log. The plugin sends no telemetry, and panel links open only when clicked.

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
