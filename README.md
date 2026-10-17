<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://github.com/chengzhi-c/dsh-wtq-pool/raw/main/docs/logo-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="https://github.com/chengzhi-c/dsh-wtq-pool/raw/main/docs/logo.png">
    <img src="https://github.com/chengzhi-c/dsh-wtq-pool/raw/main/docs/logo.png" width="240" alt="WTQ账号池">
  </picture>
</p>

<h1 align="center">WTQ账号池</h1>

<p align="center"><b>把本机已登录的 WorkBuddy、Trae、Qoder 账号接入 DeepSeek Harness，限流或额度用尽时自动换号。</b></p>

<p align="center">
  <a href="README.en.md">English</a> | <b>简体中文</b>
</p>

<p align="center">
  <a href="#安装">安装</a> ·
  <a href="#使用">使用</a> ·
  <a href="#功能">功能</a> ·
  <a href="#设置">设置</a> ·
  <a href="CHANGELOG.md">更新日志</a> ·
  <a href="https://github.com/chengzhi-c/dsh-wtq-pool/issues">问题反馈</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-wtq-pool"><img src="https://img.shields.io/npm/v/dsh-wtq-pool?style=flat-square&amp;label=npm&amp;color=cb3837" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/dsh-wtq-pool"><img src="https://img.shields.io/npm/d18m/dsh-wtq-pool?style=flat-square&amp;label=downloads&amp;color=cb3837" alt="npm downloads"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/chengzhi-c/dsh-wtq-pool?style=flat-square" alt="MIT license"></a>
  <a href="https://github.com/chengzhi-c/dsh-wtq-pool/releases"><img src="https://img.shields.io/github/v/release/chengzhi-c/dsh-wtq-pool?style=flat-square&amp;label=release" alt="release"></a>
  <a href="https://github.com/chengzhi-c/dsh-wtq-pool/stargazers"><img src="https://img.shields.io/github/stars/chengzhi-c/dsh-wtq-pool?style=flat-square" alt="GitHub stars"></a>
</p>

把本机 WorkBuddy、Trae、Qoder 的桌面登录接入 DeepSeek Harness。WorkBuddy 被限流或额度用尽时自动换号；Trae、Qoder 按请求选择账号，认证失败、限流或余额耗尽时换下一个登录重试，模型不存在、请求体非法这类请求自身的问题则按上游原样应答。三个来源独立开关，国内与国际账号分别成组。

限流按上游给出的等待时间冷却，上游只在响应头给出时以它为准；额度用尽与登录失效不会自行恢复，该账号会退出轮换，直到余额重新读到或重新登录。上游主机不可达时换下一个登录重试。

## 预览

设置面板界面如下（默认亮色）：

![账号池](https://github.com/chengzhi-c/dsh-wtq-pool/raw/main/docs/preview-pool.png)

面板载入时读取 DeepSeek Harness 的外观设置；宿主切换主题后须重新载入面板：

![暗色主题](https://github.com/chengzhi-c/dsh-wtq-pool/raw/main/docs/preview-dark.png)

模型页可以改显示名、上下文窗口、输出上限、思考等级和贴图。Trae 目录给出费率的模型会带上 `x0.79` 这样的费率标签，未给出费率的模型（以及 Qoder 全部模型）不标注：

![模型设置](https://github.com/chengzhi-c/dsh-wtq-pool/raw/main/docs/preview-models.png)

在线预览：<https://chengzhi-c.github.io/dsh-wtq-pool/>。

`docs/index.html` 用虚构演示数据加载实际面板代码，支持来源切换、模型设置和主题预览，不读取本机账号或令牌。

![预览页](https://github.com/chengzhi-c/dsh-wtq-pool/raw/main/docs/preview-page.png)

开启 `showComposerPoints` 后，输入框工具栏显示当前模型的账号积分，点击可查看该组账号并切换账号。下图由实际输入框扩展离屏渲染：

![输入框积分](https://github.com/chengzhi-c/dsh-wtq-pool/raw/main/docs/preview-composer.png)

本地预览需先克隆仓库，再运行 `node docs/serve.cjs` 并打开它输出的地址。该页面不能用 `file://` 打开，浏览器不允许它读取同目录的面板文件。

## 功能

- 复用本机登录：只读三家桌面 App 已保存的登录文件，不发起自己的 OAuth，不额外要一次授权。
- 按 region 注册模型分组：三家各自的 region 各注册成一个 provider，可以同时开启；没有账号的 region 不注册。
- 账号分发：WorkBuddy 支持先用一个账号、轮流使用、临期积分优先和同一对话固定一个账号，并在限流或额度用尽时自动换号；Trae、Qoder 支持轮流使用与临期积分优先，认证失败、限流或余额耗尽时换下一个登录重试。
- 积分自动化：自动签到默认关闭。开启后的定时任务与「立即运行」执行同一轮，包含三家签到、WorkBuddy 国内账号的连登奖励、任务奖励和猫猫旅行。连登天数由上游按对话推进，该轮在每个国内账号读取连登档位前先补发一次对话活动上报，因此档位到点即可解锁领取，不需要用户自己进 WorkBuddy 聊一句。
- 输入框积分：开启 `showComposerPoints` 后，输入框工具栏显示当前模型使用的账号余额，点开可换号。功能关闭后浮层停止轮询。
- 面板：账号状态、池状态、模型勾选、连接检查都在插件页的「账号池」卡片里。模型目录启动时加载，缓存过期后按需刷新，空闲不轮询。停用的账号不参与探测，也不让面板一直显示"检测中"。
- 连接检查：每条发现都带判定。网关没在听、模型目录读不到、发布的地址与实际绑定的不一致、provider 没被宿主接受，都算失败并给出要改什么；检查自己出错时也作为一条发现写进报告，而不是让整条通道失败。

## 安装

本地包：在源码目录执行 `pnpm install && pnpm run build && npm pack --pack-destination dist`，再安装生成的 `.tgz`：

```powershell
$package = (Get-ChildItem .\dist\*.tgz | Sort-Object LastWriteTime | Select-Object -Last 1).FullName
dsh plugin --profile desktop add $package
```

需要 DeepSeek Harness 0.2.0 线（`package.json` 的 `engines.dsh`：`>=0.2.0-rc.1 <0.2.1`）与 Node `^22.19.0 || >=24.0.0`。

使用实际 profile 名替换 `desktop`。若 `dsh` 不在 PATH，使用安装目录中的 CLI。也可按 npm 包名 `dsh-wtq-pool` 或仓库地址安装；按仓库地址安装时 pnpm 会执行 `prepare` 脚本从源码构建，需要在 profile 的 `pnpm-workspace.yaml` 里写 `allowBuilds: dsh-wtq-pool: true`，并钉在某个 commit 上。

**面板在哪儿**：在侧边栏进入 **插件**，点开 **dsh-wtq-pool** 那张卡片（或它旁边的 **配置**），完整面板嵌在卡片里。模型分组没出现时，按面板顶部的提示重启 dsh。

## 使用

在各家桌面 App 中登录后，点击「重新检测账号」。WorkBuddy 支持读取多个已保存登录，5.6 起的 `$wbEncrypted` 登录通过本机 WorkBuddy 获取密钥。Trae 国内版有 Trae CN 与 TRAE SOLO CN 两个登录位；Qoder 每个安装仅保存一个登录，重新登录会覆盖前一个。

顶层选来源，下面三屏：

- **账号池**：每个号的标签、剩余积分、额度到期时间、冷却状态、签到进度；可单独停用某个号、移除它，或指定某个 region 优先用哪个号。WorkBuddy 的分发有先用一个账号、轮流使用、临期积分优先、同一对话固定一个账号；Trae 与 Qoder 有轮流使用和临期积分优先。
- **模型**：勾选这个 region 要暴露的模型，未勾选的不进模型选择器。可改显示名、上下文窗口、输出上限、思考等级和贴图支持。一个模型组最多发布 64 个，超出的标「未发布」，网关仍会服务它们。
- **连接检查**：逐条报出网关在不在听、模型目录读到几个、注册的地址与实际绑定的是否一致、每个 provider 有没有被宿主接受，并可复制整份报告。网关启动失败时给出失败原因，面板按地址漂移提示重启。
签到可单账号执行，也可在标题栏一次领完该来源。自动签到默认关闭，开启后默认于 09:00（北京时间）执行；当天错过的时段在当天内的下一次启动仍会补领，跨天则不补。Trae 的每日签到每台设备限领一次，Qoder 的新一轮在每天 10:00（北京时间）开出。

## 设置

这些键全部经宿主设置 schema 声明，改动写回 profile 后即生效：

| 键 | 默认（生效值） | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关闭后网关不启动 |
| `sourceWorkbuddy` / `sourceTrae` / `sourceQoder` | `true` | 关闭后该来源不扫描、不发布、不请求 |
| `distribution` | `priority` | WorkBuddy 池的发放方式：`priority` 先用一个账号，`round-robin` 均摊，`expiry` 优先消耗临期积分，`sticky` 同一对话固定 |
| `sourceDistributions` | `{}` | Trae、Qoder 的分发方式：`round-robin` / `expiry`；兼容旧值 `priority` |
| `cooldownSeconds` | `60` | 限流冷却时长。上游报出重置时间时以它为准，按北京时间 |
| `creditReserves` | `{}` | 按账号 id 设定的积分保底，余额低于它的账号不参与分发 |
| `authFile` | `""` | WorkBuddy 登录文件路径；扫描其所在目录的全部 `.info` 登录，留空自动发现 |
| `autoCheckin` | `{"enabled":false,"hours":[9]}` | 自动签到的开关与时点；`hours` 为北京时间整点，留空用 09:00 |
| `showComposerPoints` | `false` | 在输入框工具栏显示当前账号积分 |
| `disabledAccountIds` | `[]` | 面板里停用的账号 id |
| `disabledRegions` | `[]` | 单独停用的 region，形如 `source:region` |
| `modelSelection` | `{}` | 每个网关勾选哪些模型，以及显示名、上下文窗口等覆写 |
| `preferredAccountIds` | `{}` | WorkBuddy 每个 region 的首选账号 |
| `preferredSourceAccounts` | `{}` | Trae、Qoder 每个 region 的首选账号，键为 `source:region` |
| `removedAccounts` | `[]` | 从池里移除的账号，标签与 region 一并保留，面板可据此提供恢复 |

默认列是生效值：`autoCheckin.hours` 存为空数组，运行时归一为 `[9]`；`authFile` 未设或留空即自动发现。

模型勾选和首选账号由面板保存。命令面板里也可打开面板、重新检测、清除冷却、全部签到、连接检查。

## 端口

```
WorkBuddy  42831 / 42841
Trae       42851 / 42861
Qoder      42871 / 42881
```

以上为首选端口。被占用时网关绑定临时端口，运行时 provider 注册使用本次实际地址，面板显示回退结果。国内模型仅使用国内账号。

端口在预留与监听之间被别的进程抢走时，该网关本次启动失败：它的模型组会被摘掉，连接检查报出失败原因，面板提示重启宿主。重启后 host 重新读注册表，请求才会落到新地址上。

## 数据与出网

只读三家 App 的本机登录文件，不写回登录状态。provider 通过运行时注册接入，不改写宿主 provider 配置；插件设置仍由宿主持久化至 profile。令牌仅在插件进程中使用，并发往对应厂商接口。网关仅监听 `127.0.0.1`；面板资源与 RPC 只接受实际回环对端，不信任代理转发头，因此远程浏览器不能直接使用面板。插件不直接管理或删除宿主会话记录。插件自管数据目录 `~/.dsh/dsh-wtq-pool/`（设了 `DSH_HOME` 则用它）里另有两个文件：`checkin-slots.json` 记录已领取的签到时段，先写临时文件再改名，只保留三天；`doctor.txt` 是最近一次连接检查的报告。

同一台机器上的其他进程可以调用这些回环端点，从而消耗已登录账号的额度。重启后回复缺失时应同时检查插件日志与宿主持久化日志。

令牌只会发往以下主机：

- WorkBuddy：`copilot.tencent.com`、`www.codebuddy.cn`、`www.codebuddy.ai`、`www.workbuddy.ai`、`www.workbuddy.cn`
- Trae：`api.trae.cn`、`solo.trae.cn`、`trae-api-cn.mchost.guru`、`coresg-normal.trae.ai`、`growsg-normal.trae.ai`
- Qoder：`gateway.qoder.com.cn`、`openapi.qoder.com.cn`、`api3.qoder.sh`、`openapi.qoder.sh`

插件不发送遥测。面板外链仅在用户点击时打开。

## 开发

```sh
pnpm install
pnpm run build           # 产出 lib/（宿主半为 ESM，客户端半为 CJS）
pnpm run typecheck       # 宿主半
pnpm run typecheck:client
pnpm test                # Node 自带测试，离线回归
```

`src/host.ts` 是引擎（账号发现、池、网关、面板通道），`src/index.ts` 是 Cordis 入口（设置 schema、provider 注册、面板路由），`src/pi-compat.ts` 把宿主能力适配成引擎已在用的那套调用。`renderer/` 是面板本体：`index.html`、`panel.js`、`panel.css`，原生 JS，无构建步骤，由 `src/web-panel.ts` 挂在宿主 web 服务上，以同源 iframe 提供给插件页卡片；`src/client/` 是 React 半，只有嵌这个 iframe 的插件页卡片（`index.tsx`）和输入框工具栏读数（`composer.tsx`）。`lib/` 由 `tsdown` 产出，`package.json` 的 `files` 与版本库都带着它，修改 `src/` 后须重建并提交。

与宿主无关的核心模块：

| 模块 | 职责 |
| --- | --- |
| `loopback.ts` | 回环端点的安全模型（Host/Origin 校验、响应写入、报错脱敏） |
| `accounts.ts` | WorkBuddy 登录文件解析、令牌加解密、账号池与冷却 |
| `upstream.ts` | WorkBuddy 上游客户端、错误分类、限流重置解析 |
| `catalog.ts` | 模型目录与静态兜底列表 |
| `shim.ts` | WorkBuddy 网关的 OpenAI 兼容端点 |
| `at-rest.ts` | 5.6+ 密封登录字段的解封 |
| `promo.ts` | 促销窗口判定 |
| `trae-*.ts` / `qoder-*.ts` | 两家的登录发现、协议客户端、SSE 解码与网关 |

## 致谢

本插件的若干模块移植或参考自下列 MIT 项目：

| 项目 | 版权 | 用于 |
| --- | --- | --- |
| [XDTrees/dsh-workbuddy-xdpool](https://github.com/XDTrees/dsh-workbuddy-xdpool) | (c) 2026 XDTrees | WorkBuddy 账号池与整体移植来源 |
| [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) | (c) 2026 Corrine Hu | 回环端点的安全模型 |
| [dingminhua/dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy) | (c) 2026 LaoDing | 上游接口与错误分类 |
| [dingminhua/dsh-connect-trae](https://github.com/dingminhua/dsh-connect-trae) | (c) 2026 dingminhua | Trae 协议参考 |
| [eghrhegpe/dsh-connect-qoder](https://github.com/eghrhegpe/dsh-connect-qoder) | (c) 2026 eghrhegpe | Qoder 协议参考 |

## 许可

MIT，见 [LICENSE](./LICENSE)。