# tests/ — 测试设施与覆盖地图

> 用例数单一事实源 = `npx vitest run` 实跑。`tsconfig` 只覆盖 `src/`，tests 由 vitest 转译。
> 全量运行（本机内存紧张时单 worker + 线程池，避免 fork 失败）：`npx vitest run --no-file-parallelism --pool=threads`。

## 1. 共享桩设施（`tests/helpers/bridge-harness.ts`）

| 设施 | 说明 |
|---|---|
| `makeFakeAgents(sessionIds, captured, opts?)` | 假 AgentRegistry：create/resume 桩、`captured.followups/steers/createdMeta/tools`、`failCreateFor` 注入 id-collision、dsh 0.2.2 的 `agent.model` 替身 |
| `makeHarness(opts?)` | 真实反向 WS（NapCat 拟真对端）+ MediaStore + 出站帧录制 `outbound`；opts：`failCreateFor / mediaDir / maxImageBytes / resumeOk / createDelayMs / transcriber / trace / ignoreSelf / recorder / inject / steer 四开关 / log`；返回 `sendText / say` |
| `makeCmdHarness(opts?)` | 命令测试紧凑桩；opts：`agentPresets / dshHome / ocrResult / restrictedMemberPrefix / steer 四开关 / mediaDir / commands / allowAllUsers / agentDefaultModel / workspaceRegistry / sessionPersistence / trace / log`；返回 `sendText / sendTextAs / sendGroupTextAs / chats / say` |
| `makeEvent(type, data)` | 构造 SessionEvent |
| `disconnect / reconnect / inboundAndDisconnect / sentTexts` | 断线/重连（B6 离线队列）桩 |

`say(text, extra?)` = 像模型一样调用会话作用域里的 `qq_send_message`。回合最终文本不会自动发送，
出站断言必须经由工具调用（或命令/通知的 `sendToChat`）产生。

## 2. 出站契约（所有测试的前提）

- 唯一主动出口是模型调用 `qq_*` 工具（`src/tools/send.ts`）→ `bridge.sendSegments`。
- `sendToChat` 只服务于命令回复、错误通知、插话回执等插件自讲话术。
- 频率控制只有一处：`outbound.spec.ts` 的按字数发送间隔（base + perChar × 字数，±jitter%）。
- 断线队列（B6）只承载 `queuable: true` 的插件通知；工具发送失败直接抛给模型。

## 3. 测试文件 → 覆盖点

| 文件 | 覆盖 |
|---|---|
| `bridge.spec.ts` | 会话事件分发、角色冻结、昵称、golden 端到端（私聊单条 / 群 @ + 工具发言单条 / 长文单条）、入站管线顺序 |
| `inbound.spec.ts` | 归一化、策略/@ 门、记录数组载荷、上文窗口与水位、媒体回填、戳一戳、去重、休眠窗口、命令前置换行防注入 |
| `reply-mention.spec.ts` | 引用唤醒门（作者校验、只查一次、无效 id 零查询） |
| `outbound.spec.ts` | 段发送/合并转发、断线队列、按字数节流 |
| `commands.spec.ts` | 命令面 `/new` `/session` `/model` `/compact` 的路由与边界 |
| `registry.spec.ts` | ensureChat/loadMapping/saveMapping、退休集合、collision 自愈、会话切换、每会话设置存活 |
| `mapping-settings.spec.ts` | workspacePath 与上文水位在映射文件里的持久化往返、驱逐/重置/失败重试的设置载体 |
| `settings-remote.spec.ts` | Typert Remote：36 键白名单、快照脱敏、revision 乐观锁、宿主 configEditor 失败归一 |
| `client-settings.spec.ts` | `lib/client.js` bundle：四组 36 键、descriptor 契约、渲染/保存/冲突合并/数字行内校验 |
| `trace.spec.ts` | traceId 贯穿、jsonl 字段与轮转、同因限流、warn 级过滤 |
| `record-replay.spec.ts` | 入站录制、脱敏、轮转，以及离线回放的真实管线决策摘要 |
| `inject.spec.ts` | 调试注入通道：历史行跳过、dry-run 拦截、真实消息清除注入轮次 |
| `session-v4-persistence.spec.ts` | 会话行 `source.kind = plugin:dsh-onebot` 的两个写入点与防漂移扫描 |
| `session-switch.spec.ts` / `steer-queue.spec.ts` | `/session` 切换、插话三开关与排队/插话策略 |
| `tools-*.spec.ts` / `model.spec.ts` | qq_* 工具族、主动写闸、`qq_model`（按群/私聊指定模型与思考强度） |
| `connection.spec.ts` / `segments.spec.ts` / `media-*.spec.ts` / `stt-*.spec.ts` | 反向/正向 WS、消息段、媒体围栏与语音转写 |

## 4. 纪律

1. 出站断言先问「这条消息是谁发的」：模型发言走 `say(...)`，插件话术走 `sendToChat`。
2. 设置面改键时同时改三处：`src/settings-remote.ts`、`lib/client.js`、`settings-remote.spec.ts` + `client-settings.spec.ts`。
3. 删除特性时连同其配置键、trace 常量、测试与文档一起删，不保留兼容分支。
