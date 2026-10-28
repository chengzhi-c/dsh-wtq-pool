<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://github.com/chengzhi-c/dsh-wtq-pool/raw/main/docs/logo-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="https://github.com/chengzhi-c/dsh-wtq-pool/raw/main/docs/logo.png">
    <img src="https://github.com/chengzhi-c/dsh-wtq-pool/raw/main/docs/logo.png" width="240" alt="WTQ Pool">
  </picture>
</p>

<h1 align="center">WTQ Pool</h1>

<p align="center"><sub>DeepSeek Harness 版 · <a href="https://github.com/chengzhi-c/pi-desktop-wtq-pool">PI-Desktop 版</a></sub></p>

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

> **！可能有封号风险，请斟酌使用，概不负责 ！**

把本机 WorkBuddy、Trae、Qoder 的桌面登录接入 DeepSeek Harness。WorkBuddy 在账号被限流或额度用尽时自动换号；Trae、Qoder 按请求选择账号，认证失败、限流或余额耗尽时改用下一个登录重试，模型不存在、请求体非法这类请求自身的问题则按上游原样返回。三个来源各自开关，国内与国际账号分别成组。

限流按上游给出的等待时间冷却，上游未给出时按配置的窗口。额度用尽与登录失效不会自行恢复，账号退出轮换：额度用尽的挂起在余额重新读到后释放，登录失效的挂起在刷新成功、重新登录或手动重置冷却后释放，两者都在六小时后（WorkBuddy 侧）到期。积分、签到状态、模型目录与手动签到这些非流式读取遇到登录失效，会先强制刷新令牌并重试一次：刷新令牌还有效的账号当场恢复，不退出轮换；刷新令牌同样失效的才挂起。Trae、Qoder 的失败挂起另计：只按冷却窗口（默认 60 秒，最长可配到 24 小时）或上游给出的等待时间降权，池中只剩它一个时仍会使用。上游主机不可达时结束本轮并报告网络错误。上游判定账号套餐不含某模型（11158）时，该账号的这个模型停用 24 小时，其他模型照常服务；全部账号都不含该模型时按 400 返回。

## 预览

面板界面如下，默认亮色：

![账号池](https://github.com/chengzhi-c/dsh-wtq-pool/raw/main/docs/preview-pool.png)

面板在载入时读取宿主的 `app.getAppearance()`，配色与语言随之确定。宿主切换主题后，按卡片上的「重新载入面板」重新取一次：

![暗色主题](https://github.com/chengzhi-c/dsh-wtq-pool/raw/main/docs/preview-dark.png)

模型页编辑每个模型的显示与发布参数。Trae 目录给出的默认窗口因模型而异（116k 至 400k）；未声明更大档位的模型，本插件按实测可用的 1M 发布上限。Trae 目录给出费率的模型带 `x0.79` 形式的费率标签；目录未给出费率的模型以及全部 Qoder 模型均不标注：

![模型设置](https://github.com/chengzhi-c/dsh-wtq-pool/raw/main/docs/preview-models.png)

成长中心：

![成长中心](https://github.com/chengzhi-c/dsh-wtq-pool/raw/main/docs/preview-growth.png)

在线预览：<https://chengzhi-c.github.io/dsh-wtq-pool/>。

`docs/index.html` 以虚构演示数据加载实际面板代码，支持来源切换、模型设置与主题预览。

![预览页](https://github.com/chengzhi-c/dsh-wtq-pool/raw/main/docs/preview-page.png)

开启 `showComposerPoints` 后，输入框工具栏显示当前模型所用账号的积分，点击可查看该组账号并切换。下图为实际输入框扩展的离屏渲染：

![输入框积分](https://github.com/chengzhi-c/dsh-wtq-pool/raw/main/docs/preview-composer.png)

本地预览需先克隆仓库，运行 `node docs/serve.cjs`，再打开它输出的地址。该页面不能用 `file://` 打开，因为浏览器不允许它读取同目录下的面板文件。

## 功能

- 复用本机登录：读取三家桌面 App 已保存的登录文件。面板的「添加账号」打开厂商官方登录页，并把登录写入插件自管目录。
- 按 region 注册模型分组：三家厂商各自的 region 各注册为一个 provider，可同时启用；没有账号的 region 不注册。国内模型只走国内账号，国际版模型只走国际账号。
- 账号分发：WorkBuddy 支持先用一个账号、轮流使用、临期积分优先和同一对话固定一个账号，并在限流或额度用尽时自动换号；Trae、Qoder 支持优先使用、轮流使用与临期积分优先，认证失败、限流或余额耗尽时改用下一个登录重试。
- 网关以 SSE 返回 `chat.completion.chunk`；请求体里的 `stream` 字段不改变响应格式。
- 积分自动化：自动签到默认关闭。开启后的定时任务与「立即运行」执行同一轮，包含三家签到、WorkBuddy 的连登奖励和猫猫旅行。连登天数由上游按对话推进，该轮在每个账号读取连登档位前先补发一次对话活动上报，因此档位到点即可解锁领取，用户无需再进 WorkBuddy 发一句消息。连登环节还会在昨日漏签且持有补签卡时自动补签以保住连续天数，领取一次性的新手礼包与活动补偿，并在兑换解锁的档位后把由此获得的抽奖次数抽完。这些成长步骤国内版与国际版都执行；猫猫旅行只跑国内账号，国际版没有对应接口。
- 登录令牌保活：独立卡片，按需执行。桌面端留下的登录快照在扫描时并入插件自己的登录目录，由插件接管续期；桌面端正在使用的登录由桌面端续期。「立即刷新」处理插件自管的副本，按签发时间判断：签发满 6 小时的刷新，距到期不足 5 分钟的同样刷新。刷新结果写回插件自己的登录文件，登录被上游拒绝时当天即可发现。同一账号在多处留有登录时按签发时间取最新的一份。停用账号、已停用的 region 与登录已被上游拒绝的账号不参与。
- 输入框积分：开启 `showComposerPoints` 后，输入框工具栏显示当前模型所用账号的余额，点开可换号。功能关闭后浮层隐藏，读数降为每 5 分钟一次，重新开启后无需切换模型即可恢复。
- 面板：账号与池状态、模型勾选、连接检查、成长中心都在插件页的「账号池」卡片内。模型目录在启动时加载，缓存过期后按需刷新，空闲时不轮询。停用的账号与登录已被上游拒绝的账号不参与探测。
- 连接检查：每条发现都带判定。网关没有监听、模型目录读取失败、发布的地址与实际绑定的不一致、provider 未被宿主接受，都算失败并给出需要修改的内容。网关启动失败时给出原因，面板按地址漂移提示重新加载插件。检查自身出错也记一条发现，报告照常给出其余结果。

## 安装

本地包：在源码目录执行 `pnpm install && pnpm run build && npm pack --pack-destination dist`，再安装生成的 `.tgz`：

```powershell
$package = (Get-ChildItem .\dist\*.tgz | Sort-Object LastWriteTime | Select-Object -Last 1).FullName
dsh plugin --profile desktop add $package
```

需要 DeepSeek Harness 0.2.0 线（`package.json` 的 `engines.dsh`：`>=0.2.0-rc.1 <0.2.1`）与 Node `^22.19.0 || >=24.0.0`。

> 从 1.1.x 升级到 1.2.0 后，模型提供商 ID 改为 `wtqpool-*`，请在模型选择里重新选一次。

请将 `desktop` 替换为实际使用的 profile 名。若 `dsh` 不在 `PATH` 中，改用安装目录中的 CLI。也可按 npm 包名 `dsh-wtq-pool` 或仓库地址安装；按仓库地址安装时 pnpm 会通过 `prepare` 脚本从源码构建，需要在 profile 的 `pnpm-workspace.yaml` 中写入 `allowBuilds: dsh-wtq-pool: true`，并固定在某个 commit 上。

**面板位置**：在侧边栏进入 **插件**，打开 **dsh-wtq-pool** 卡片（或其旁的 **配置**），完整面板嵌在该卡片内。模型分组未出现时，按面板顶部的提示重新加载插件。

## 使用

在各家桌面 App 中登录，再点面板的「重新检测账号」。WorkBuddy 支持读取多个已保存的登录，需要多个账号就在 App 里逐个登录；5.6 起的 `$wbEncrypted` 登录由插件向本机已安装的 WorkBuddy 索取密钥后读取。Trae 国内版有 Trae CN 与 TRAE SOLO CN 两个登录位；Qoder 每个安装只保存一个登录，在 App 里重新登录会覆盖前一个。WorkBuddy 国际版只有一个登录文件，切换账号会直接覆盖上一个。插件在扫描时为被覆盖的登录留档，该账号照常参与分发，直到它的令牌到期；在 App 里重新登录即可续期。

没有桌面 App 也可以添加账号：面板 WorkBuddy 标题栏的「添加账号」在新标签页中打开官方登录页，登录完成后该账号即加入账号池。凭证写在插件自管目录的 `signins/` 下，与桌面登录同等参与分发。这类账号在面板上另有「删除」，按两次确认；删除范围见「数据」一节。桌面端正在登录的账号不给删除，那份会话属于桌面端。添加的账号属于当前选中的 region，国内版登国内号，国际版登国际号。

迁移其他工具留下的账号，直接向该目录写入文件即可：`signins/` 本身就是导入导出格式，放入一份以 `.info` 结尾的 `{auth, account}` 登录文件，下次扫描即作为一个普通账号。仓库中的 `tools/import-signins.cjs` 读取其他工具留下的账号文件（`--from` 接受文件或目录），按本插件识别的形状写入 `signins/`，默认跳过本插件数据目录里已有的账号，`--dry-run` 先查看，`--force` 才覆盖：

```
node tools/import-signins.cjs --data <插件数据目录> --from <账号文件或目录> [--region cn|global|all] [--dry-run] [--force]
```

需要备份时直接复制 `signins/` 目录，它已经是备份应有的格式；这些文件持有完整可用的令牌，其权能与账号本身相同。

- **账号池**：每个账号的标签、剩余积分、额度到期时间、冷却状态与签到进度。可单独停用某个账号、将其移除，或指定某个 region 优先使用哪个账号。登录被上游拒绝的账号另显示「需重新登录」徽标、拒绝原因与「暂停至」时间，挂起期间积分与签到留空。被上游判定异常使用的账号另显示「已限制」徽标与「被上游限制，直至」时间，六小时重试一次，需要到官方后台申诉。
- **模型**：勾选该 region 要暴露的模型，未勾选的模型不进入模型选择器。可修改显示名、上下文窗口、输出上限、思考等级与贴图支持。一个模型组最多发布 64 个模型，超出部分标记为「未发布」，网关仍会服务它们。
- **连接检查**：逐条报告网关是否监听、模型目录读到几个、注册的地址与实际绑定的是否一致、每个 provider 是否被宿主接受，并可复制整份报告。
- **成长中心**：仅对 WorkBuddy 生效。页面按账号逐行列出，展开一行可见该账号的连登档位。「读取状态」读取当前档位与可领取项；「立即执行」产生领取并执行成长环节，按步骤报告结果。登录被上游拒绝的账号在该轮被跳过。

签到可对单个账号执行，也可在标题栏一次领完该来源。自动签到默认关闭，开启后默认于 09:00（北京时间）执行；当天错过的时段在当天内的下一次启动仍会补领，跨天则不补。Trae 的每日签到每台设备限领一次；Qoder 的新一轮于每天 10:00（北京时间）开放。登录被上游拒绝的账号在该轮被跳过。

WorkBuddy 国内版上游会拒绝「客户端身份写着 DeepSeek Harness」的对话请求（返回 11128，渠道校验未通过）。插件遇到这条拒绝时，会把系统消息并入首条用户消息并重试一次；助手历史里的客户端名称也会移除，因为渠道校验同样读取助手消息。通过的提示按 region 记住，同一段提示之后不再重复这次往返。签到、成长中心与保活走各自的接口。

「立即刷新」的结果按刷新、已是最新、失败、无刷新令牌分项报告。

读取结果留在宿主进程内：重新载入面板仍显示上次的数字。读数超过两分钟、之后又跑过一轮，或某个 region 被停用时，进入页签会重读。

## 设置

以下键在插件页或 DSH 的设置页修改，保存后生效：

| 键 | 默认（生效值） | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关闭后网关不启动 |
| `sourceWorkbuddy` / `sourceTrae` / `sourceQoder` | `true` | 关闭后该来源不扫描、不发布、不请求 |
| `distribution` | `priority` | WorkBuddy 池的发放方式：`priority` 先用一个账号，`round-robin` 均摊，`expiry` 优先消耗临期积分，`sticky` 同一对话固定 |
| `sourceDistributions` | `{}` | Trae、Qoder 的分发方式：`priority` / `round-robin` / `expiry`；未设时按 `priority` |
| `cooldownSeconds` | `60` | 限流冷却时长。上游报出重置时间时以它为准；没有重置时间时，连续限流会让它逐次翻倍，封顶 15 分钟（窗口本身超过 15 分钟时不再翻倍）。上游给出的重置时间最长按 2 小时计；余额耗尽或登录被上游拒绝另按 6 小时停用 |
| `creditReserves` | `{}` | 按账号 id 设定的积分保底，余额不高于它的账号不参与分发 |
| `authFile` | `""` | WorkBuddy 登录文件路径；扫描其所在目录的全部 `.info` 登录，留空则自动发现 |
| `autoCheckin` | `{"enabled":false,"hours":[9]}` | 自动签到的开关与时点；`hours` 为北京时间整点，留空用 09:00 |
| `showComposerPoints` | `false` | 在输入框工具栏显示当前账号积分 |
| `disabledAccountIds` | `[]` | 面板中停用的账号 id |
| `disabledRegions` | `[]` | 单独停用的 region，形如 `source:region` |
| `modelSelection` | `{}` | 每个网关勾选哪些模型，以及显示名、上下文窗口等覆写 |
| `preferredAccountIds` | `{}` | WorkBuddy 每个 region 的首选账号 |
| `preferredSourceAccounts` | `{}` | Trae、Qoder 每个 region 的首选账号，键为 `source:region` |
| `removedAccounts` | `[]` | 从池中移除的账号，标签与 region 一并保留，面板可据此提供恢复 |

默认列为生效值：`autoCheckin.hours` 存为空数组，运行时归一为 `[9]`；`authFile` 未设或留空即自动发现。

模型勾选与首选账号由面板保存。

## 端口

```
WorkBuddy  42831 / 42841
Trae       42851 / 42861
Qoder      42871 / 42881
```

以上为首选端口。端口被占用时网关绑定系统分配的临时端口，运行时注册的 provider 使用本次实际地址，面板显示回退结果。

PI-Desktop 版使用 41831 开头的另一段端口，两个插件可以同时安装在同一台机器上，两套端口各自正确。两版各自保留一份登录并各自续期，上游在续期时轮换刷新令牌，因此同一账号只会被先续期的那一版持有：另一版手上的刷新令牌随之失效，面板会把它标成「需重新登录」，用「添加账号」补一次即可。签名天数因此也会一边一个样，那是两份登录各自的到期时间。想让同一账号两版都能用，就只在其中一版里添加，或在被标出的那一版重新添加。

端口在预留与监听之间被其他进程占用时，该网关本次启动失败：其模型组被摘掉，连接检查报出失败原因，面板提示重新加载插件。重新加载后宿主重新读取声明，请求才会落到新地址。

## 数据与出网

读取三家 App 的本机登录文件。provider 通过运行时注册接入，插件设置由宿主持久化至 profile。令牌由插件保管，只发往对应厂商的接口。网关监听 `127.0.0.1`，面板只接受本机回环请求。

插件自管数据目录 `~/.dsh/dsh-wtq-pool/`（设置了 `DSH_HOME` 时改用它）包含四个文件（写删除记录时会短暂多一个 `deleted-signins.json.lock`）。`checkin-slots.json` 记录已领取的签到时段和待重试的 Qoder 时点，时段只保留三天。`doctor.txt` 是最近一次连接检查的报告，逐项记录通过与否，不含账号名称。`credentials-archive.json` 留存被切号覆盖的登录，含访问令牌；按令牌到期时间保留，到期后再过 30 天清除。`deleted-signins.json` 记录已删除的登录，只存令牌摘要、该登录的签发时间与删除时间，用来阻止扫描把桌面端遗留的同一份快照重新接管回来；同一个账号重新登录后（签发时间更新）该记录自动失效。

插件写入的登录都在同目录的 `signins/`：面板添加的、接管桌面端快照的、续期后的副本。文件名带账号的计费身份，与桌面登录同等参与分发。在面板中「删除」该账号会连同 `credentials-archive.json` 里的留档一起清除，桌面端遗留的同一份快照随之失效；重新登录该账号即解除。「移除」只是停用，可在「已移除的账号」中恢复。

插件只向三家厂商的接口发起请求；面板外链仅在用户点击时打开。

令牌只会发往以下主机：

- WorkBuddy：`copilot.tencent.com`、`www.codebuddy.cn`、`www.codebuddy.ai`、`www.workbuddy.ai`
- Trae：`api.trae.cn`、`solo.trae.cn`、`trae-api-cn.mchost.guru`、`coresg-normal.trae.ai`、`growsg-normal.trae.ai`
- Qoder：`gateway.qoder.com.cn`、`openapi.qoder.com.cn`、`api3.qoder.sh`、`openapi.qoder.sh`

## 开发

```sh
pnpm install
pnpm run build           # 产出 lib/（宿主半为 ESM，客户端半为 CJS）
pnpm run typecheck       # 宿主半
pnpm run typecheck:client
pnpm test                # Node 自带测试，离线回归
```

`src/host.ts` 是引擎（账号发现、池、网关、面板通道），`src/index.ts` 是 Cordis 入口（设置 schema、provider 注册、面板路由），`src/pi-compat.ts` 把宿主能力适配成引擎使用的调用形式。`renderer/` 是面板本体（`index.html`、`panel.js`、`panel.css`），原生 JS，无构建步骤，由 `src/web-panel.ts` 挂载到宿主的 web 服务上，以同源 iframe 提供给插件页卡片；`src/client/` 是 React 半：嵌入该 iframe 的插件页卡片（`index.tsx`）、其地址构造（`panel-url.ts`）与输入框工具栏读数（`composer.tsx`）。`lib/` 由 `tsdown` 产出，`package.json` 的 `files` 与版本库都包含它，修改 `src/` 后须重建并提交。

与宿主无关的核心模块：

| 模块 | 职责 |
| --- | --- |
| `loopback.ts` | 回环端点的安全模型（Host 与 Origin 校验）、响应写入、流式中继与报错脱敏 |
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
| [ardeyouxipianyi/workbuddy2api-hub](https://github.com/ardeyouxipianyi/workbuddy2api-hub) | (c) 2026 ardeyouxipianyi | 成长中心与连登闭环（补签卡、礼包、补偿、抽奖）、多账号凭证留存、国际版活跃上报 |

## 许可

MIT，见 [LICENSE](./LICENSE)。
