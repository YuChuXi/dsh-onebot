# dsh-onebot

> **[English](README.en.md) | 中文**

给 DeepSeek Harness 加上 QQ 通道。A QQ channel for dsh.

本插件把 dsh 变成一个 QQ 机器人（**OneBot 11 协议**，兼容 NapCat / Lagrange / LLOneBot / go-cqhttp），
与 [dsh-vision](https://github.com/dsh-external/dsh-vision) 同款的外部插件形态：**零 Python、纯 TS、
原生 Cordis 插件**，挂载进 dsh 宿主进程，不改任何核心代码。

```
用户(QQ) ←→ NapCat ←→ dsh-onebot 插件 ←→ dsh Agent（每个会话一个）
                        ├─ 反向 WS 服务器 / 正向 WS 客户端（自动重连）
                        ├─ 入站：CQ 解析、图片下载、语音转写(STT)、引用/合并转发展开
                        └─ 出站：模型调用 qq_* 工具发送，按字数节流
```

## 架构

![dsh-onebot QQ 通道架构](docs/dsh-onebot-architecture.png)

> 可交互版本（暗/亮主题切换 + 引导视图）：[docs/dsh-onebot-architecture.html](docs/dsh-onebot-architecture.html)；矢量版：[docs/dsh-onebot-architecture.svg](docs/dsh-onebot-architecture.svg)。

## 功能

| 类别 | 能力 |
|---|---|
| 连接 | 反向 WS（NapCat ws-reverse 拨入，默认端口 8643）或正向 WS（拨出，默认 ws://127.0.0.1:3001）；断线自动重连（2s→60s 退避） |
| 入站 | 私聊/群聊；载荷是 **JSON 记录数组**（按时间升序，末条为当前消息，其余是它之前最近的群聊窗口；记录含 qq/nickname/id/time/message，群主与管理员另有 role）；群聊窗口按持久化水位 `{time,id}` 从 `get_group_msg_history` 截取，滑出历史时标注「更早的消息已省略」，注入过的消息不再重复注入；段数组直读（无 CQ 字符串层）、@/回复触发（fail-closed；回复仅认机器人自己的消息，作者由 get_msg 证实，且与引用展开共用同一次查询）、媒体段回填本机路径（图片四路解析 url/base64/file/hash、大图自动压缩长边 ≤`inboundImageMaxPx`、GIF 不压、文件段双通道 get_private_file_url + get_file base64/url 回退），取不到时写成「(图片未取到)」这类明确说明；引用与合并转发在原位置展开为被引记录与节点记录；表情段带中文名；戳一戳唤醒，其他人之间的戳并入上文 |
| 语音 | ffmpeg 转 16kHz WAV + whisper 转写（openai-whisper / whisper.cpp / 自定义命令）；**非阻塞**：语音消息先以 `record` 段（带本机路径）进入回合（不阻塞回复），转写完成后以「（语音转写：…）」补递（默认超时 60s）；转写失败/超时/空结果保留 `record` 段为最终状态 |
| 出站 | **模型调用 `qq_send_*` 工具才是唯一发言出口**：回合的助手文本不会自动发送（模型不发就是不发）；合并转发用 `qq_send_forward`（群/私聊）、按字数节流（基础间隔 300ms + 每字 60ms + ±30% 抖动，见下方三个配置键）、正在输入提示（set_input_status，仅私聊） |
| 命令 | 斜杠命令（仅管理员）：`/new` 开新会话、`/session` 查看可切回历史会话并按序号切回、`/model` 查看或切换当前会话模型（`--default` 修改部署默认；无参输出两级序号列表，回复序号选 provider → 再回复序号选模型）；按会话类型的长期模型在设置页「私聊」「群聊」两块分别用下拉配置（`modelPrivate` / `modelGroup`）；`/compact` 转发宿主的上下文压缩命令；其余斜杠文本一律交给模型 |
| 工具 | `qq_send_message`（唯一通用出口，支持文本/图片/语音/视频/文件段）、`qq_send_text`、`qq_send_image`（≤9 张，路径或 URL）、`qq_send_voice`、`qq_send_video`、`qq_send_file`、`qq_send_forward`、`qq_send_poke`（戳一戳）、`qq_list_stickers`（收藏表情列表）、`qq_send_sticker`（发表情：收藏/图片/商城）、`qq_collect_sticker`（收藏表情）、`qq_napcat_api`（22 个白名单 action）、`qq_end_turn`（结束回合）、`qq_create_schedule` / `qq_list_schedules` / `qq_delete_schedule` / `qq_update_schedule`（群/私聊定时任务，规则与 dsh 的 `schedule_*` 一致：相对延时、绝对时刻、固定间隔、每日、每周、cron）、`qq_group_history`、`qq_model`（查看生效模型与配置指定；切换当前会话或部署默认的模型/思考强度）、文件编辑工具 `code_safe_edit` 等已拆至独立插件 dsh-safe-edit（见下文「安全编辑」） |
| 权限 | 管理员白名单（`ONEBOT_ALLOWED_USERS`）、dm/group 策略（open/allowlist/disabled）、群聊 @提及 gating、受限用户 [受限用户:仅问答] 软限制 |
| 会话 | 每个 QQ 会话一个持久 Agent（session id 稳定派生），重启后自动 resume；按 `agentPreset`/`workspacePath` 挂载到 preset 与工作区；每轮结束 flush 落盘 |
| 运维 | 热加载：profile 层 patch 的 **config 覆盖**与 **insert 新增/删除**均热生效——插件 fiber 秒级原地重启（宿主进程不重启；代价：QQ 桥一次秒级重连、在途回合中断）；touch/内容未变不触发任何动作；bundle 自带 patch、仓库模板、部署副本的 patch 文件与根配置 `cordis.yml` 的改动**不**热生效；临时媒体 TTL 过期清理 |
| 提示词 | 自动注入 QQ 平台说明（纯文本输出、图片/语音标注 `[图片]`/`[语音]` 占位、工具与命令指引、禁宿主交互卡）；按**每个 QQ 会话 agent 自身作用域**注入，Web 会话不可见 |

## 兼容性

| 项 | 要求 |
|---|---|
| dsh | ≥ 0.1.5-rc.1（`engines.dsh`：0.1.5/0.1.6/0.1.7 全线 + 0.2.0 线 ≥0.2.0-rc.1；@deepseek-ai/* peer 依赖同范围，JsonValue 由 dsh-util-values 提供） |
| Node.js | ≥ 22 |
| OneBot 11 实现 | NapCat / Lagrange / LLOneBot / go-cqhttp（reverse 或 forward WebSocket） |
| 可选依赖 | 语音转写需 ffmpeg + whisper CLI |

最后验证：2026-11-01（`npx tsc --noEmit` 零错误；vitest 406 用例全绿）。

## 安装

**前置**：dsh（≥0.1.5-rc.1）在 PATH 上；NapCat 或其他 OneBot 11 实现已运行。

### npm 安装（发布通道，与下方源码安装二选一，勿混装）

```sh
dsh plugin --profile web add dsh-onebot-qq
```

（或用 Web 界面的 Plugins 页安装。）随后：

1. 在 profile 目录 `<DSH_HOME>/profiles/web/` 的 `pnpm-workspace.yaml` 中写入两行
   （实测 pnpm 12 不读项目级 `.npmrc`，见 `docs/npm-e2e-report.md` D1）：

   ```yaml
   autoInstallPeers: false
   hoist: false
   ```

   ——防止 pnpm 自动拉入 registry 上陈旧的 `@deepseek-ai/*` 独立副本。npm/pnpm 版本差异：
   此配置仅 pnpm 12 用户必须（pnpm 12 已不读 `.npmrc`）；npm 用户无此问题——实测 npm 默认
   peer 自动安装拉入的 registry 现版本满足 peer 范围（`docs/npm-e2e-report.md` §1 #2）。
   运行期 peer 统一由宿主解析层完成：插件 import 的 `@deepseek-ai/*`
   只要声明在该包 peerDependencies 里，就会被宿主拦截并重定向到宿主安装树的同一实例，
   无需任何 npm override。
2. 把包内 `cordis.patch.yml` 模板的两行 insert 合并进 profile 层
   `<DSH_HOME>/profiles/web/cordis.patch.yml`：主条目 `name: 'dsh-onebot-qq'`，
   host-plane 行 `name: 'dsh-onebot-qq/settings-remote'`；config 覆盖须挂
   patch 顶层同 id 行（详见模板头注释）。
3. **不要**在 profile 的 package.json 手写任何 `@deepseek-ai/*` 依赖——手写副本会
   覆盖宿主安装树成为拦截目标，造成版本错位双包。
4. 若安装被兼容门拒绝（dsh 版本不在 peer 范围内），按官方口径用
   `dsh plugin allow-version ... --accept-risk` 显式豁免。

### 方式二：git clone 源码安装

```sh
git clone <repo> ~/dsh-plugins/dsh-onebot
cd ~/dsh-plugins/dsh-onebot
npm install --include=dev
./scripts/build.sh          # 链接宿主 @deepseek-ai 包 + tsc 编译 src/ → lib/
```

> **部署副本必须带完整 node_modules 链接集**（`scripts/link-host.sh` 产物）：`files` 只打包 `lib/`，
> 但运行时 peer 依赖 `@deepseek-ai/*` 是链接到宿主安装的——只复制 `lib/` 会挂载失败（插件入口会
> 显式报「peer 依赖解析失败」错误）。宿主无 `dsh` 在 PATH 上（如 fnOS 应用形态）时用逃生门：
> `DSH_ROOT=<宿主node_modules路径> ./scripts/build.sh`。

**fnOS 应用形态宿主构建**：fnOS 应用中心安装的 dsh 没有 `dsh` CLI 在 PATH 上，`build.sh` 的自动定位
（PATH 二进制 → npx store）会失败并显式报 `cannot locate the dsh install`。此时用 `DSH_ROOT` 显式指定
宿主 node_modules 根（该目录下须有 `@deepseek-ai/`，否则报错退出而非静默回退）：

```sh
DSH_ROOT=<fnOS 应用数据目录>/node_modules ./scripts/build.sh
```

构建完成后把部署副本（`lib/` + 完整 node_modules 链接集）放到目标位置再挂载；运行副本缺链接集同样会挂载失败（见上方说明）。

挂载到 ~/.dsh/config.yaml（没有就新建）：

```yaml
- insert:
    - id: dsh-onebot
      name: '$HOME/dsh-plugins/dsh-onebot/lib/index.js'
      config:
        mode: reverse        # reverse = NapCat 拨入；forward = 插件拨出
        port: 8643
        # accessToken: '与NapCat一致的token'   # 必配：reverse 模式留空将拒绝启动（M0 安全加固）
        # botQQ: ''          # 留空自动从 meta 事件学习
        adminUsers: ['你的QQ号']   # 必配：至少一个管理员，否则私聊/斜杠命令不可用
```

> ⚠️ **首次配置必须设置至少一个管理员**（`adminUsers` 或环境变量 `ONEBOT_ALLOWED_USERS`）：
> `dmPolicy: open`（默认）只允许管理员私聊，斜杠命令也仅管理员可用；不设置则无人能对话。
> 开发调试可临时 `allowAllUsers: true`（或 `ONEBOT_ALLOW_ALL_USERS=true`）放行所有用户。

重启 dsh（`dsh web` 或你的启动方式），日志出现 `[dsh-onebot] mounted` 即挂载成功。

**NapCat 侧（必须配置，两种模式二选一）**：

- **reverse 模式（NapCat 拨入 dsh，推荐）**：NapCat 网络设置里新增「**WebSocket 客户端**」，
  「上报地址」填 dsh 的 WS 地址 `ws://<dsh 所在机器 IP>:<port>/ws`（如 `ws://192.168.1.100:8643/ws`），
  「token」填插件 `accessToken` 相同的值；dsh 与 NapCat 不同机时不能用 `127.0.0.1`。
- **forward 模式（dsh 拨出到 NapCat）**：NapCat 网络设置里启用「**WebSocket 服务端**」（默认监听
  `0.0.0.0:3001`），插件 `url` 配置为 `ws://<NapCat 所在机器 IP>:3001`（同机可用
  `ws://127.0.0.1:3001`），token 两边一致。

两侧 token 必须一致；消息上报格式建议选「**数组**」（插件段数组优先解析，CQ 字符串仅回退）。
配置完成后重启 dsh，日志出现 `[dsh-onebot] mounted` 且 NapCat 显示连接成功即就绪。

**部署位置要求**：NapCat 必须部署在 dsh **可达的局域网**内（同一网段/能互通），
WS 连接、图片下载、文件解析都依赖这条网络通路；NapCat 与 dsh 不在同一台机器时，
需要在 NapCat 侧**开启「文件转 URL」开关**，`get_file` 才会返回可下载的 http(s) url
（否则返回容器内路径，本插件无法访问）。

## 配置

完整配置项见 [src/index.ts](src/index.ts) 的 `Config` schema（schemastery 校验，均有默认值）。常用：

| 键 | 默认 | 说明 |
|---|---|---|
| `mode` | `reverse` | `reverse`/`forward` |
| `host` / `port` | `127.0.0.1` / `8643` | reverse 监听；跨机部署（NapCat 从其他机器拨入）需显式改为 `0.0.0.0` |
| `url` | `ws://127.0.0.1:3001` | forward 目标 |
| `reconnectMaxAttempts` | `100` | 自动重连放弃上限：连续失败达到该次数后停止重连，日志输出上限值与恢复指引；`0` = 无限重连（退避封顶 60s） |
| `accessToken` | 空 | OneBot token；**reverse 模式必填**，留空插件拒绝启动（fail-closed）；forward 可为空 |
| `botQQ` | 空 | 机器人 QQ（空=自动学习） |
| `ignoreSelf` | `true` | 忽略机器人自己发出的消息（防自循环） |
| `requireMention` | `true` | 群聊需 @ 或回复机器人的消息才响应；仅靠引用触发时通过 `get_msg.sender.user_id` 确认原作者，回复他人、作者未知或查询失败均不触发（fail-closed）。显式 @机器人不受引用查询结果影响 |
| `recentMessages` | `50` | 每次 @ 注入的记录总条数（含当前消息；顶部「更早的消息已省略」那条不计数；`0` = 只注入当前消息，范围 0–100）。群聊按水位从当前消息向前截取，私聊只有当前消息 |
| `sleepMode` | `window` | 休眠模式：`window` = 用 `sleepStart`/`sleepEnd` 的每日时段；`peak` = 按高峰价格时段休眠（北京时间工作日 9:00–12:00、14:00–18:00） |
| `sleepStart` / `sleepEnd` | 空 | 休眠时段（HH:MM，Asia/Shanghai 墙钟，可跨午夜如 `23:30`–`08:00`）；留空 = 不启用，起止须同时设置且不同。休眠期间不响应唤醒，每个会话每个时段把首个唤醒交给模型回一句告别，之后静默 |
| `dedupWindowSeconds` | `300` | 入站消息去重窗口（秒，W2-②）：同一会话内相同 message_id 在该窗口内重投（断线重连重放等）只处理第一条，后续静默跳过并记 debug；仅对会触发回复处理的消息事件生效（notice/meta 类不经过此闸）；`0` = 禁用去重 |
| `traceEnabled` | `false` | 链路追踪（W1）：为每条入站消息生成 traceId 并贯穿入站→模型回合→出站，决策事件（含去重/白名单/@ 门控与每个静默丢弃分支的中文 reason）逐行 JSON 落盘 `mediaDir/qq-trace.jsonl`（4MiB 改名轮转，保留 `qq-trace.1/2.jsonl`；同因失败事件 5 分钟限频；异步队列写不阻塞管线）；默认关闭——关闭时不生成 traceId、不落盘、决策行为与开启前完全一致 |
| `traceLevel` | `debug` | 追踪事件级别（W1）：`debug` 记录全部决策事件；`warn` 仅记录 ok:false（被拒/失败/丢弃）事件 |
| `logLevel` | `info` | 控制台日志级别门槛（debug < info < warn < error）：低于该级别的日志不输出。`debug` 全部输出（含「session 事件早退」等调试行）；`info` 常规信息（启动、连接建立、meta 事件等，默认）；`warn` 仅警告与错误；`error` 仅错误 |
| `recordInbound` | `false` | 入站录制（W1）：把收到的每条入站事件（含被门控跳过的，附当时决策 reason）按可回放形状逐行 JSON 追加写 `mediaDir/qq-inbox.jsonl`（2MiB 改名轮转，保留 `qq-inbox.1/2.jsonl`；注入的帧不会被二次录制，杜绝「注入→录制→回放→注入」自激）；纯旁路：写失败仅 warn 限频，绝不影响回复管线 |
| `inboxRedact` | `false` | 录制脱敏（W1）：落盘前把帧中 6 位以上的数字串（QQ 号/群号等）脱敏为前 3 位+`****`（数字型 id 字段一并处理），便于把录制文件发给别人离线回放（`npm run replay`） |
| `injectEnabled` | `false` | 事件注入通道（W1，**仅调试用**）：开启后按 `injectIntervalMs` 轮询 `mediaDir/qq-inject.jsonl`，把新行（每行一个 OneBot 消息事件 JSON）喂进**真实入站管线**（trace 事件标 `stage=inject`）；启动时已存在的历史行跳过并记一条说明。信任边界：注入是调试通道，默认全关，勿在生产开启 |
| `injectDryRun` | `true` | 注入干跑（W1，**强烈建议保持 `true`**）：注入回合触发的全部出站写操作（发消息/撤回等，**含异步模型回合的最终回复**——拦截点在出站动作层）被拦截计数、原文进 trace 事件、绝不真发 QQ；真实消息到达同一会话立即解除拦截（不连坐真人）；`false` = 注入内容会真实发送，仅限隔离环境实验 |
| `injectIntervalMs` | `2000` | 注入队列轮询间隔（毫秒，W1；最小 500） |
| `steerEnabled` | `false` | 任务运行中收到新消息的处理策略（插话开关）：开=把新消息作为补充指令插进当前回合（模型在下一步读取），任意消息形态（文字/图片/文件/语音/带引用/合并转发）一视同仁；关（默认）=排队到当前任务结束后的后续回合，等待期间每运行回合至多回复一次排队提示。无运行中任务时不受本项影响。设置页 behavior 组可改，热重启生效 |
| `steerAllMembers` | `false` | 插话资格（插话开关打开时生效）：开=所有成员都能插话；关（默认）=仅管理员。不具备资格的消息按排队处理（入队+排队提示）。设置页 behavior 组可改，热重启生效 |
| `steerAllowRestricted` | `true` | 受限成员插话（插话开关打开时生效）：开（默认）=群内受限成员（非管理员且 `restrictedMemberPrefix` 开）也能插话；关=受限成员始终排队。设置页 behavior 组可改，热重启生效 |
| `steerNotice` | `true` | 插话提示：插话成功时回一句「已作为补充指令提交给当前任务」；关=静默插话。设置页 behavior 组可改，热重启生效 |
| `thinkingPrivate` | `default` | 私聊新建会话的思考强度；`default` = 跟随部署默认。设置页为下拉，选项由所选私聊模型的能力决定；切换模型时下拉会即时重算 |
| `thinkingGroup` | `default` | 群聊新建会话的思考强度，规则同 `thinkingPrivate` |
| `modelPrivate` | `''` | 私聊使用的模型，`<provider>/<model>`；留空 = 跟随部署默认。设置页「私聊」块用两级下拉选择（provider → model），选项来自宿主模型目录 |
| `modelGroup` | `''` | 群聊使用的模型，`<provider>/<model>`；留空 = 跟随部署默认。规则同 `modelPrivate` |
| `sendErrorNotice` | `true` | 一轮运行出错时向用户发送 ⚠️ 错误提示 |
| `outboundIntervalBaseMs` | `300` | 同一会话相邻两条出站消息的固定间隔（毫秒） |
| `outboundIntervalPerCharMs` | `60` | 每条消息按字数追加的间隔（毫秒/字） |
| `outboundIntervalJitterPct` | `30` | 在计算出的间隔上叠加的随机抖动比例（0–100，实际为 ±该百分比） |
| `dmPolicy` | `open` | 私聊策略：`open`(仅管理员)/`allowlist`(白名单)/`disabled` |
| `groupPolicy` | `open` | 群聊策略：`open`(所有人)/`allowlist`/`disabled` |
| `restrictedMemberPrefix` | `true` | 群聊非管理员消息注入 `[受限用户:仅问答]` 前缀（软限制） |
| `adminUsers` | `[]` | 管理员 QQ；也可用 `ONEBOT_ALLOWED_USERS` 环境变量。**必须至少设置一个**，否则私聊（dmPolicy=open）与斜杠命令无人可用 |
| `allowFrom` / `groupAllowFrom` | `[]` | 白名单用户/群 |
| `sendErrorNotice` | `true` | 一轮运行出错时向用户发送 ⚠️ 错误提示 |
| `sttEnabled` | `true` | 语音转写（需 ffmpeg + whisper CLI） |
| `sttEngine` | `auto` | STT 引擎：`auto`(自动探测 whisper-cli/whisper/mlx_whisper)/`openai`/`whisper-cpp`/`custom` |
| `sttModel` | `small` | whisper 模型 |
| `sttCommand` | 空 | `custom` 引擎的程序名/路径 |
| `sttArgs` | `[]` | `custom` 引擎参数模板，`{file}` 与 `{out}` 会被替换 |
| `sttTimeoutMs` | `60000` | 语音转写超时（毫秒）：超时保留 [语音] 占位；`<=0` 回落内置 60s |
| `mediaDir` | `<dsh-home>/media/onebot` | 入站媒体/映射文件目录 |
| `tempTtlHours` | `6` | 入站临时媒体文件保留时长（小时），到期自动清理 |
| `inboundImageMaxPx` | `2048` | 入站图片长边上限（px）：超过则等比压缩后交给视觉模型（透明 PNG 保留、GIF 不压）；`<=0` 禁用 |
| `outboundImageMaxBytes` | `8388608` | 出站图片段大小上限（字节）：工具发送的图片超过该值时拒绝发送并回报模型 |
| `maxVoiceBytes` | `15728640` | 出站语音大小上限（字节） |
| `maxFileBytes` | `20971520` | 出站视频/文件大小上限（字节） |
| `inboundFileMaxBytes` | `20971520` | QQ 入站文件大小上限（字节）：超限文件拒收并提示 |
| `allowPrivateHosts` | `false` | 下载媒体 URL 时允许私网/环回地址（仅跳过私网检查，协议白名单与限长仍生效）；仅本机反代等可信场景开启，公网部署保持 `false` |
| `agentPreset` | 空 | 会话挂载的 agent preset（留空=默认） |
| `workspacePath` | 空 | 会话挂载的工作区（留空=宿主进程 cwd；未配置时插件启动会 warn 一次建议显式配置——宿主未提供可编程查询的默认工作区）。per-chat 覆盖随映射文件持久化，重启不丢 |
| `chatIdleEvictDays` | `7` | 会话空闲淘汰天数：chat 超过该天数无任何活动时，在下一条入站消息处理前清理其内存态 agent（会话先 flush 落盘、映射保留，同一 chat 之后再发消息可 resume 恢复原会话）；`0` = 禁用 |

> ⚠️ **BREAKING（M0 安全加固）**：reverse 模式下 `accessToken` 留空会拒绝启动（fail-closed）；`host` 默认从 `0.0.0.0` 改为 `127.0.0.1`（仅本机监听），跨机部署需显式配置 `host: 0.0.0.0`。

环境变量：`ONEBOT_ALLOWED_USERS`（逗号分隔管理员）、`ONEBOT_ALLOW_ALL_USERS=true`（开发用）。

### 引用唤醒的查询成本与诊断

开启 `requireMention` 时，通过群策略与去重检查、机器人身份已知且没有显式 @ 的有效引用消息，每条都会发起一次 `get_msg` 来确认原作者，群友之间互相引用也一样。校验通过后，引用展开复用该响应，不再重复查询。当前不使用跨消息缓存，如高流量群出现瓶颈再考虑缓存优化。

引用 ID 只接受可精确表示的十进制整数（支持负数），无效 ID 不发起查询。开启 trace 后，`mention` 阶段会区分无效 ID、查询失败或空响应、作者缺失、作者非机器人与普通未提及，便于排查拒绝原因。显式 @、私聊及关闭提及门控时，无效引用仅跳过展开，不阻断当前消息。

## 录制 · 回放 · 注入（W1）

| 能力 | 开关（默认） | 用法 |
|---|---|---|
| 入站录制 | `recordInbound`（**false**）+ `inboxRedact`（false） | 开启后每条入站事件逐行 JSON 追加写 `mediaDir/qq-inbox.jsonl`（含被门控跳过的事件与当时决策 reason；2MiB 改名轮转）；纯旁路，写失败仅 warn 限频 |
| 离线回放 | 无需开关 | `npm run build` 后 `npm run replay -- <inbox.jsonl> [--media-dir <dir>] [--limit <n>] [--require-mention] [--bot-qq <qq>] [--admin <qq>] [--out report.json]`：读录制文件喂**真实入站管线**（强制 dry-run：不启 WebSocket、出站写全部拦截计数），输出每条消息的 traceId+决策链汇总；不依赖宿主运行。回放门控取自命令行参数（默认全放行），需复现线上门控请传相同策略 |
| 事件注入 | `injectEnabled`（**false**）+ `injectDryRun`（**true**）+ `injectIntervalMs`（2000，最小 500） | **仅调试用**：往 `mediaDir/qq-inject.jsonl` 追加一行 OneBot 消息事件 JSON（可直接复制 `qq-inbox.jsonl` 的行），桥按间隔轮询喂进真实管线；dry-run 下该回合全部出站写（含异步模型回复）被拦截计数、原文进 trace（`stage=inject`），绝不真发 QQ。启动时已存在的历史行跳过并记一条说明 |

## 设置页

dsh Web GUI 的设置页提供本插件的可视化配置（host-plane Remote `onebotSettings`，写入 profile 层
`cordis.patch.yml` 中 `dsh-onebot` 条目的 config 覆盖行——与手改 patch、宿主原生设置页是同一个持久层）。

### 六组 37 键

设置页按「私聊」「群聊」分成两个大块：该类型的准入（策略/白名单）、模型、思考强度、附加提示词都在
块内；全局项留在「连接」「权限」「行为」「诊断」。模型与思考强度都是下拉（模型为 provider → model
两级，档位随所选模型的能力即时重算）。

| 组 | 键 |
|---|---|
| connection（连接） | `mode`、`host`、`port`、`url`、`accessToken`、`botQQ`、`workspacePath` |
| private（私聊） | `modelPrivate`、`thinkingPrivate`、`extraPromptPrivate`、`dmPolicy`、`allowFrom` |
| group（群聊） | `modelGroup`、`thinkingGroup`、`extraPromptGroup`、`requireMention`、`groupPolicy`、`groupAllowFrom` |
| permissions（权限） | `adminUsers`、`allowAllUsers` |
| behavior（行为） | `sendErrorNotice`、`outboundIntervalBaseMs`、`outboundIntervalPerCharMs`、`outboundIntervalJitterPct`、`recentMessages`、`steerEnabled`、`steerAllMembers`、`steerAllowRestricted`、`steerNotice`、`sleepMode`、`sleepStart`、`sleepEnd` |
| diagnostics（诊断） | `traceEnabled`、`recordInbound`、`inboxRedact`、`injectEnabled`、`injectDryRun` |

`accessToken` 在设置页做密码型输入，快照返回侧脱敏（不回显明文）；写入侧仍在 patch 文件明文落盘。

### 与 patch config 的优先级

**schema 默认值 ← bundle/底层 patch（继承层） ← profile 覆盖行（设置页写这里）**；同一层内后写的 patch
条目胜出。设置页键与手改 patch 是同一层的同一行，不存在两套优先级。六组 37 键之外的键
（media/STT/性能/`agentPreset` 等低频键）不设 UI，仍在同一行 config 手改 patch。

### 生效方式

每次保存（设置页或手改同一覆盖行）= 插件 fiber 秒级原地重启生效，宿主进程与 Web GUI 不重启；
代价：QQ 桥一次秒级重连、在途回合中断（会话映射/历史不受影响）。
与当前覆盖行全等的保存是 no-op，不触发重启；写入导致插件激活失败时 patch 文件自动回滚、旧配置继续运行。

## 会话工作区（workspace）选择

每个 QQ 会话创建时按以下优先级确定工作目录（写入 session meta，**创建时冻结**，不随配置变化）：

1. 该会话设置里的 `workspacePath` 覆盖（随映射文件持久化，跨 `/new` 保留）
2. 配置 `workspacePath`
3. 宿主进程 cwd（`process.cwd()`）

设置页的 workspace 下拉可把 GUI 工作区路径「填入」配置项；保存后只对新会话生效。

会话自动挂载到 GUI 工作区：仅当会话 cwd 等于配置的 `workspacePath`（未配置时为宿主 cwd）
才自动创建 workspace；沿用旧 cwd 的遗留会话只在已有 workspace 拥有该路径时挂载，不会自动新建。

## 斜杠命令速查（全部仅管理员）

| 命令 | 作用 |
|---|---|
| `/new` | 开启新会话（清空上下文，旧会话进入可切回列表） |
| `/session [序号]` | 查看本会话可切回的历史会话（无参编号列表，每项含内容预览、建立时间与退休时间，id 截短显示；日志不可读的项显示「（内容不可读）」且不影响其余项），回复序号切回：当前会话退休进列表、目标会话恢复其历史上下文（含 per-chat 设置），支持来回切换；列表跨重启保留（随 chat 状态写入 chat-sessions.json，每 chat 上限 20 条） |
| `/model [--default] <provider> <model>` | 查看或切换当前会话模型；`--default` 修改部署默认。无参输出两级序号列表：回复序号选 provider → 再回复序号选模型并切换当前会话 |
| `/compact` | 转发宿主的上下文压缩命令（`@deepseek-ai/dsh-command-compact`）到当前会话 |

`/session` 的可切回列表随 chat 状态持久化在媒体目录的 chat-sessions.json（与映射、每 chat 设置同属一个
文件、共用同一套原子写纪律；文件缺失=全新、损坏保留内存；每 chat 上限 20 条、去重、最新在前）。列表每项渲染一条内容预览
（该会话事件日志第一条真实用户输入：kind 'user' 或本插件署名的 QQ 消息优先，缺失时回退任何 user/message；
提取全部 text 块拼接、剥去 QQ 入站的 <user_message> 包裹与拼接在边界外的可信前缀（[受限用户:仅问答] / [HH:MM 昵称(QQ)]，包裹不完整或空正文则原样回退）后换行折叠、按码点截断 ≤40 字，emoji 不拆半；找不到用户输入显示「（无对话内容）」）、
建立时间（会话 header 的 createdAt，取不到则省略）、退休时间与截短 id（前 8+…+后 8 字符，保留两侧便于辨认）。
预览经 sessionPersistence 的 read handle 冷读日志前 24 个事件取得（不开写所有权，读完即 close）；单会话日志
缺失/损坏/读取失败只降级该项为「（内容不可读）」，其余项与切回功能不受影响。切换成功后目标会话解除退休
标记，重启 resume 与空闲淘汰后的再激活都走常规路径找回它；切回目标 resume 失败时该 id 立即硬退休并移出列表，
chat 回退到下一条消息新建会话，不会卡死。损坏（碰撞/恢复失败）退休的会话绝不进列表、不可切回。
序号选择基于命令输出列表的快照，5 分钟内有效（过期提示重新查看）；纯数字参数仅在有对应有效列表时
按序号解释，否则维持原参数语义。路由表之外的斜杠文本不拦截，原样交给模型。

## 安全编辑（code_safe_edit）

受守卫的宿主文件编辑由**独立插件 dsh-safe-edit** 提供（`~/dsh-plugins/dsh-safe-edit/`，2026-08-18 从本插件拆出，对所有通道全局注册）。三个工具：
思路借鉴 [irmia_devkit_open](https://github.com/irmia2026/irmia_devkit_open) 的 safe_edit（AGPL-3.0，独立 TypeScript 清洁实现）。工具与边界见 dsh-safe-edit 仓库/说明：

- `code_safe_edit`：read → 路径白名单 → **自动备份** → 匹配（精确 → 剥行号前缀 → 空白对齐/Aider 式）→ 替换 → 语法检查（js/cjs/mjs 走 `node --check`）→ **失败自动回滚**
- `code_safe_rollback` / `code_list_backups`
- 边界随会话 sandbox 策略：`danger-full-access` 无限制、`workspace-write` 限会话工作区、`read-only` 拒绝；无策略服务回落 `safeEditRoot`（默认 `/Users/mario/workspace`）
- 模型可优先使用此工具（`code-safe-edit` skill 全渠道引导；QQ 平台提示词引导内置 read/edit 惯例，不绑定具体工具名）

## dm / group 访问策略（初始化必选）

私聊（`dmPolicy`）与群聊（`groupPolicy`）各自三选一，选项含义如下：

| 选项 | dmPolicy（私聊） | groupPolicy（群聊） |
|---|---|---|
| `open` | **仅管理员**可私聊（adminUsers/`ONEBOT_ALLOWED_USERS`；设 `allowAllUsers: true` 则所有人可） | **所有群**可聊（群内消息受 `requireMention` 控制：需 @ 或回复机器人的消息才触发；群成员带 [受限用户:仅问答] 软限制） |
| `allowlist` | 仅 **`allowFrom`** 白名单 QQ 可私聊（不要求是管理员） | 仅 **`groupAllowFrom`** 白名单群可聊 |
| `disabled` | 私聊全部拒绝 | 群聊全部拒绝 |

**初始化建议**：
- 只想自己用 → `dmPolicy: open` + 配好 `adminUsers`（私聊只有你能发）；
- 想开放给几个熟人 → `dmPolicy: allowlist` + `allowFrom: ['QQ1','QQ2']`；
- 群聊专用机器人 → `groupPolicy: open`（配合默认 `requireMention: true`，群成员需 @ 才触发）；
- 只允许特定群 → `groupPolicy: allowlist` + `groupAllowFrom`。

## 权限与数据

- **网络**：与 OneBot 11 网关建立 WebSocket 连接（reverse 监听或 forward 拨出）；入站图片/文件从 QQ CDN 下载。
- **文件**：入站媒体与会话映射写入 `<dsh-home>/media/onebot/`（`mediaDir`，6 小时过期清理）；会话数据由 dsh 宿主持久化。
- **系统调用**：语音转写调用本机 ffmpeg 与 whisper CLI（可 `sttEnabled: false` 关闭）。
- **敏感信息**：`accessToken` 与管理员白名单存于 dsh 配置，不写入日志。
- **不收集**：无遥测，除用户配置的 OneBot 网关与图片 CDN 外不调用任何第三方服务。

## 给模型的平台说明（自动注入）

- QQ 不渲染 Markdown → 输出纯文本（编号/短横线列表、行内反引号）。
- **发言必须调用 `qq_send_message`（或其它 `qq_send_*` 工具）**：回合的助手文本不会自动发送到 QQ；需要回复用户时先把内容发出去。
- 发图/文件/语音/视频用 `qq_send_*` 工具；合并转发用 `qq_send_forward`。
- 用户发来的图片/语音/视频在文本中标注为 `[图片]`/`[语音]`/`[视频]` 占位（路径不进入文本）；无可用看图工具时如实告知用户。
- 群聊消息带 `[HH:MM 昵称(QQ)]` 前缀；受限用户消息带 `[受限用户:仅问答]` 前缀（仅回答，禁止文件/终端/配置操作）。
- 本通道为 QQ，宿主无 Web 交互卡：禁止调用 `ask_user_question` / `exit_plan_mode`（确认卡仅 Web 可用，会阻塞对话），提问/确认走纯文本。
- 斜杠命令由插件拦截（4 个，仅管理员）；其余斜杠文本（含路径）原样交给模型。
- 修改宿主文件走内置 read/edit（行级 hash 锚点、dsh-better-edit 自动 undo），勿用 write 整文件覆盖（清空 undo 历史）。

## 卸载

1. 从 `~/.dsh/profiles/<profile>/cordis.patch.yml` 删除 dsh-onebot 的 insert 条目；
2. 重启 dsh，日志不再出现 `[dsh-onebot] mounted` 即卸载完成；
3. 可选：删除插件目录与 `<dsh-home>/media/onebot/` 残留媒体。

## 开发

```sh
./scripts/build.sh                                   # 编译 src/ → lib/
./node_modules/.bin/vitest run --no-file-parallelism --pool=threads   # 全量：单元 + 真实 WS 对端 + 全管线
```

要点（来自移植源 DEVLOG 的教训）：

- **CQ 反转义**：NapCat 会把 URL 里的 `&` 转成 `&amp;`，下载前必须反转义（CDN 403 的根因）。
- **@ 检测 fail-closed**：不知道机器人 QQ 时，群消息一律视为未 @，不自动回复。
- **断线即失败 pending**：WS 断开时立即 reject 所有未完成 action，避免 10-30s 干等与泄漏。
- **重连去重**：并发断线只允许一个重连任务，防止双 WS 连接。
- **int(target) 兜底**：chat_id 解析进 try/catch，坏目标不能炸掉宿主。
- **临时媒体 6h 过期清理**：只写不删会无限堆积。

## 故障排查

| 症状 | 原因与处理 |
|---|---|
| 群聊不响应 | `requireMention: true` 时需 @ 或回复机器人的消息才触发；确认 botQQ 已从事件学习或显式配置。仅靠引用触发还需 `get_msg` 能确认原作者是机器人；原消息不存在或查询失败时，可显式 @机器人 |
| 图片下载 403 | NapCat 会把 URL 中的 `&` 转成 `&amp;`（解析已自动反转义）；仍失败可查日志中 media 下载行 |
| 文件接收失败 | 非本机部署 NapCat 时需开启「文件转 URL」开关，否则 get_file 返回容器内路径不可达；确认 dsh 与 NapCat 网络互通 |
| 崩溃循环 / 工具注册冲突 | 同一插件文件被 insert 两次（双实例）——检查 patch 无重复条目 |
| 语音一直只有 [语音] 占位、没有转写补递 | ffmpeg 或 whisper 不可用，或转写超时：安装后重启、调大 `sttTimeoutMs`，或 `sttEnabled: false` 关闭 |
| 插件挂载失败 / peer 依赖解析失败 | 部署副本缺完整 node_modules 链接集：只复制 `lib/` 不够，运行时 peer 依赖 `@deepseek-ai/*` 需经 `scripts/link-host.sh` 链接到宿主安装；插件入口会 fail-loud 显式报「peer 依赖解析失败」，按报错补齐链接集后重启 |
| `build.sh` 报 `cannot locate the dsh install` | 宿主无 `dsh` 在 PATH（如 fnOS 应用形态）且未找到 npx store：设 `DSH_ROOT=<宿主 node_modules 路径>` 后重跑 `./scripts/build.sh`（该目录下须有 `@deepseek-ai/`，设错路径会显式报错而非静默回退） |
| 改了设置页 / patch 但不生效 | 按顺序排查：① 确认改的是**被监视的文件**——profile 层 `<DSH_HOME>/profiles/web/cordis.patch.yml` 或 home 层 `<DSH_HOME>/cordis.patch.yml`（仓库 patch 模板、部署副本、bundle 自带 patch 均不被监视，需同步到上述文件）；② 内容须真的变化（touch 同内容文件是 no-op）；③ 看宿主日志有无激活失败——insert 新增条目激活失败（如 peer 缺失）会显式报错、条目失活，等待重启重试；④ 设置页的持久层是 profile 层 `dsh-onebot` 覆盖行，改到别处（如已被宿主废弃改名的 settings.yaml）不会生效 |
| 日志在哪 | dsh 宿主日志；插件历史根因与修复见 [DEVLOG.md](DEVLOG.md) |

## 开发记录

完整时间线/根因/修复见 [DEVLOG.md](DEVLOG.md)（移植自 Hermes onebot 插件的 DEVLOG 惯例）。

## License

BSD-3-Clause

