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
  <a href="#usage">Usage</a> ·
  <a href="#features">Features</a> ·
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

Use local WorkBuddy, Trae and Qoder desktop sign-ins in DeepSeek Harness. WorkBuddy fails over when an account is rate-limited or out of quota; Trae and Qoder select an account per request and move on to the next sign-in on an authentication failure, a rate limit or exhausted quota, while a problem with the request itself (an unknown model, a malformed body) is answered exactly as the upstream answered it. Each source has its own switch, with domestic and international accounts grouped separately.

## Preview

The settings panel, in its default light theme:

![Account pool](https://github.com/chengzhi-c/dsh-wtq-pool/raw/main/docs/preview-pool.png)

The panel reads the DeepSeek Harness appearance setting on load. Reload the panel after changing the host theme:

![Dark theme](https://github.com/chengzhi-c/dsh-wtq-pool/raw/main/docs/preview-dark.png)

The model page edits the display name, context window, output limit, thinking levels and image support. A Trae model whose directory states a rate carries a cost tag such as `x0.79`; models that state none (and every Qoder model) stay unlabelled:

![Model settings](https://github.com/chengzhi-c/dsh-wtq-pool/raw/main/docs/preview-models.png)

Live preview: <https://chengzhi-c.github.io/dsh-wtq-pool/>.

`docs/index.html` drives the actual panel code with synthetic demo data. It supports source switching, model settings and theme previews without reading local accounts or tokens.

![Preview page](https://github.com/chengzhi-c/dsh-wtq-pool/raw/main/docs/preview-page.png)

With `showComposerPoints` enabled, the composer shows the current model's account credits. Click it to inspect the group and switch accounts. The image below is an off-screen render of the actual composer extension:

![Composer credits](https://github.com/chengzhi-c/dsh-wtq-pool/raw/main/docs/preview-composer.png)

To run it locally, clone the repo, run `node docs/serve.cjs`, and open the address it prints. (`docs/index.html` has to be served over http: a `file://` page cannot read the panel files beside it.)

## Features

- Reuse the local sign-ins: the plugin only reads the sign-in files the three desktop apps already saved. It starts no OAuth flow of its own and asks for no extra authorization.
- Register model groups by region: each of the three vendors' regions becomes its own provider, and they can be on at once; a region with no account is not registered.
- Account distribution: WorkBuddy supports priority, round-robin, expiring credits first and conversation-sticky accounts, with failover on rate limits or exhausted quota. Trae and Qoder support round-robin and expiring credits first, and move on to the next sign-in on an authentication failure, a rate limit or exhausted quota. A rate limit cools for the wait the upstream stated, taking the response header when that is the only place it appears. Exhausted quota and a dead sign-in do not recover on their own, so that account leaves rotation until the balance is read again or the user signs in anew. When the upstream host cannot be reached at all, the next sign-in is tried.
- Credit automation: automatic check-in is off by default. The scheduled run and "Run now" perform the same round: vendor check-ins, plus the domestic WorkBuddy streak bonus, task rewards and cat travel. The upstream advances the streak on a conversation, so the round reports one chat activity per domestic account before reading the streak tiers; a tier that comes due is unlocked and collected without the user having to open WorkBuddy and send a message.
- Composer credits: with `showComposerPoints` on, the composer shows the balance of the account behind the current model; click it to switch accounts. Switching the feature off stops the readout's polling.
- One panel: account state, pool state, model selection and the connection check all live in the Account pool card on the plugin page. The model catalog loads at startup and refreshes on demand once its cache expires; it does not poll while idle. An account switched off in the panel is never probed, so it does not hold the panel's polling open either.
- Connection check: every finding carries a verdict. A gateway that is not listening, a catalog that could not be read, a published address that differs from the one bound, or a provider the host did not accept all count as failures and say what to change. A gateway whose start failed is reported with the reason and surfaced as address drift. When the check itself throws, the failure becomes a finding rather than taking the whole channel down.

## Install

For a local package, run `pnpm install && pnpm run build && npm pack --pack-destination dist` in the source directory, then install the generated `.tgz`:

```powershell
$package = (Get-ChildItem .\dist\*.tgz | Sort-Object LastWriteTime | Select-Object -Last 1).FullName
dsh plugin --profile desktop add $package
```

Requires DeepSeek Harness on the 0.2.0 line (`engines.dsh` in `package.json`: `>=0.2.0-rc.1 <0.2.1`) and Node `^22.19.0 || >=24.0.0`.

Replace `desktop` with your actual profile name. If `dsh` is not on PATH, use the CLI in its installation directory. The npm name `dsh-wtq-pool` and the repository URL work as install sources too; a repository-URL install builds from source through the `prepare` script, which requires `allowBuilds: dsh-wtq-pool: true` in the profile's `pnpm-workspace.yaml` and a pinned commit.

**Where the panel is**: open **Plugins** in the sidebar, then open the **dsh-wtq-pool** card (or the **Configure** control beside it); the full panel is embedded in that card. If the model groups do not appear, restart dsh as the note at the top of the panel says.

## Usage

Sign in inside each vendor's desktop app, then click "Detect accounts again". WorkBuddy reads multiple saved sign-ins; `$wbEncrypted` sign-ins from 5.6 onward use a key obtained from the local WorkBuddy installation. Domestic Trae has two sign-in slots, Trae CN and TRAE SOLO CN. Qoder keeps one sign-in per installation; signing in again overwrites the previous one.

A source is selected at the top level; below it are three screens:

- **Account pool**: each account's label, remaining credits, quota expiry, cooldown state and check-in progress. An account can be disabled on its own or removed, and a region can be pinned to prefer one account. WorkBuddy distributes by using one account first, round-robin, expiring credits first, or one account pinned per conversation; Trae and Qoder offer round-robin and expiring credits first.
- **Models**: select which models this region exposes; anything unselected stays out of the model picker. The display name, context window, output limit, thinking levels and image support are editable. A model group publishes at most 64 models; any beyond that are marked "not published" while the gateway still serves them.
- **Connection check**: reports one line at a time whether each gateway is listening, how many models its catalog returned, whether the published address matches the one actually bound, and whether the host accepted each provider, and can copy the whole report. A gateway whose start failed is reported with its reason, and the panel surfaces it as address drift.

Check-in runs per account, or for a whole source from the title bar. Automatic check-in is off by default; when on it claims at 09:00 (Beijing time), and a slot missed earlier the same day is still claimed at the next start, while one from a previous day is not. Trae's daily check-in is once per device. Qoder's new round opens at 10:00 (Beijing time).

## Settings

Every key below is declared in the host's settings schema and written back to the profile:

| Key | Default (effective) | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Off: the gateways do not start |
| `sourceWorkbuddy` / `sourceTrae` / `sourceQoder` | `true` | Off: that source is not scanned, published or requested |
| `distribution` | `priority` | How the WorkBuddy pool spreads requests: `priority` uses one account first, `round-robin` spreads evenly, `expiry` spends expiring credits first, `sticky` pins one account per conversation |
| `sourceDistributions` | `{}` | Trae/Qoder distribution: `round-robin` / `expiry`; legacy `priority` is accepted |
| `cooldownSeconds` | `60` | Rate-limit cooldown. A reset time the upstream reports takes precedence; Beijing time |
| `creditReserves` | `{}` | Per-account credit floor, keyed by account id; an account below its floor is not distributed to |
| `authFile` | `""` | WorkBuddy sign-in file path; every `.info` sign-in in its directory is scanned. Empty discovers it |
| `autoCheckin` | `{"enabled":false,"hours":[9]}` | Automatic check-in switch and times; `hours` are Beijing-time hours, empty means 09:00 |
| `showComposerPoints` | `false` | Show the active account's credits in the composer |
| `disabledAccountIds` | `[]` | Account ids switched off in the panel |
| `disabledRegions` | `[]` | Regions parked on their own, as `source:region` keys |
| `modelSelection` | `{}` | Which models each gateway publishes, plus the display name, context window and other overrides |
| `preferredAccountIds` | `{}` | Preferred WorkBuddy account per region |
| `preferredSourceAccounts` | `{}` | Preferred Trae/Qoder account per region, keyed by `source:region` |
| `removedAccounts` | `[]` | Accounts removed from the pool for good, with their label and region kept so the panel can offer a restore |

The default column lists effective values: `autoCheckin.hours` is stored as an empty array and normalises to `[9]`; an unset or empty `authFile` means auto-discovery.

Model selection and preferred accounts are saved by the panel. The command palette also opens the panel, detects accounts again, clears cooldowns, checks in everywhere and runs the connection check.

## Ports

```
WorkBuddy  42831 / 42841
Trae       42851 / 42861
Qoder      42871 / 42881
```

These are preferred ports. If occupied, the gateway binds an ephemeral port and runtime provider registration uses that actual address. The panel reports the fallback. Domestic models only use domestic accounts.

When another process takes a port between the reservation and the listen, that gateway's start fails: its model group is dropped, the connection check reports the reason, and the panel surfaces address drift. Requests only reach the new address after the host re-reads the registration, which a restart does.

## Data and outbound requests

The plugin only reads local vendor sign-in files and does not modify them. Providers are registered at runtime without rewriting host provider configuration; the host still persists plugin settings in the profile. Tokens stay in the plugin process and are sent to the relevant vendor endpoints. Gateways listen on `127.0.0.1`. Panel assets and RPC require an actual loopback peer and ignore forwarded address headers, so remote browsers cannot access the panel directly. The plugin does not directly manage or delete host conversation records. Its own data directory, `~/.dsh/dsh-wtq-pool/` (or `$DSH_HOME` when set), also holds two files: `checkin-slots.json`, the check-in slots already collected, written beside its target and renamed and kept for three days, and `doctor.txt`, the most recent connection report.

Another process on the same machine can call these loopback endpoints and spend a signed-in account's quota. If replies disappear after a restart, check both the plugin logs and the host's persisted logs.

Tokens go only to the hosts below:

- WorkBuddy: `copilot.tencent.com`, `www.codebuddy.cn`, `www.codebuddy.ai`, `www.workbuddy.ai`, `www.workbuddy.cn`
- Trae: `api.trae.cn`, `solo.trae.cn`, `trae-api-cn.mchost.guru`, `coresg-normal.trae.ai`, `growsg-normal.trae.ai`
- Qoder: `gateway.qoder.com.cn`, `openapi.qoder.com.cn`, `api3.qoder.sh`, `openapi.qoder.sh`

The plugin sends no telemetry. Panel links open only when clicked.

## Development

```sh
pnpm install
pnpm run build           # emits lib/ (host half as ESM, client half as CJS)
pnpm run typecheck       # host half
pnpm run typecheck:client
pnpm test                # Node's own test runner, offline regressions
```

`src/host.ts` is the engine (account discovery, the pool, the gateways, the panel channels), `src/index.ts` is the Cordis entry (settings schema, provider registration, panel routes), and `src/pi-compat.ts` adapts the host's capabilities to the calls the engine already makes. `renderer/` is the panel itself: `index.html`, `panel.js` and `panel.css`, plain JavaScript with no build step, mounted by `src/web-panel.ts` on the host's web server and served to the plugin card as a same-origin iframe. `src/client/` is the React half, and holds only the plugin-page card that embeds that iframe (`index.tsx`) and the composer readout (`composer.tsx`). `lib/` is emitted by `tsdown`, is listed in `package.json`'s `files` and is committed, so it must be rebuilt after changing `src/`.

The host-agnostic core:

| Module | Responsibility |
| --- | --- |
| `loopback.ts` | The loopback security model (Host/Origin checks, response writing, relay pumping via pumpToResponse/relayStreamOf, message redaction) |
| `accounts.ts` | WorkBuddy sign-in parsing, token encryption, the account pool and its cooldowns |
| `upstream.ts` | The WorkBuddy upstream client, error classification, rate-limit reset parsing |
| `catalog.ts` | The model catalog and its static fallback list |
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

## License

MIT, see [LICENSE](./LICENSE).
