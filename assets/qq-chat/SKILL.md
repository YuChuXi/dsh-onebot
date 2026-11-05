---
name: qq-chat
description: NapCat（OneBot 11）白名单接口的参数与返回、消息段与媒体细节、表情 id、定时任务规则，以及 dsh-onebot 的 qq_* 工具限制。Use when calling a whitelisted NapCat API, building message segments, scheduling a reminder, or a send fails.
---

# QQ 聊天（OneBot 11 / NapCat）

入站记录格式与发言契约由通道系统提示词给出，工具参数由 `qq_*` 工具的 schema 给出。本技能只补它们没有的内容。

## 查接口

`qq_napcat_api` 只放行 `references/api.md` 里的 21 个 action，其他接口会被拒。该文件按用途分节，每个 action 一节，标题是 `### <action> — <中文用途>`，按任务词检索即可命中。

需要群号的接口，`group_id` 用系统提示词「当前会话」里的群号；私聊接口用其中的对方 QQ。不要从消息记录或接口返回值里推断。

任务词：群文件、子目录、下载、上传、私聊文件、群公告、群相册、相册图片、群成员、单个成员、陌生人、合并转发、语音、文件路径、OCR、AI 语音。

## 段与媒体

`references/segments.md`：段类型与字段、`file` 的五种形式、媒体 URL 时效。

## 表情

表情保存在插件媒体目录的本地库中，按「表情包 + 摘要」组织，不使用 QQ 收藏体系。发送只认 `pack + summary`，详细描述 `caption` 只用于理解与检索。

- 收：商城表情在入站记录里就是 `image` 段，带 `summary` 与本地 `file`。重放所需的 `emoji_id`、`emoji_package_id`、`key`、`url` 由插件随图片保存，既不渲染给模型，也不需要模型搬运。
- 收藏：`qq_collect_sticker` 的 `pack` 是表情包名，一整套一次传完。每项只需给 `path`（入站段的 `file` 加上系统提示词给出的媒体目录前缀）；插件按随图保存的元数据自动识别商城表情，普通图片另需 `summary` 与 `caption`。
- 看：`qq_list_stickers` 按 `pack` 列出一套，文本给摘要与详细描述；`preview=true` 额外返回一张 4×4 拼图（一套 16 张，每格 300×300），一次看完整套画面后批量补描述。
- 补描述：`qq_remark_sticker` 按 `pack + summary` 批量写 `caption`，`newSummary` 用于改名；文件会随摘要一起改名。
- 发：`qq_send_sticker` 用 `pack + summary`；全库摘要唯一时可省略 `pack`。摘要按原值精确匹配，直接从 `qq_list_stickers` 复制即可。

经典表情（`face` 段）的 id 与中文名对照见 `references/faces.md`。

## 定时任务

四个 `qq_*_schedule` 工具绑定群/私聊，不绑会话：`/new` 换会话后仍按原来的 chat 触发；`chat_id` 省略时是当前会话，操作其他群/私聊必须显式给出。

- `qq_create_schedule` 的时间参数六选一，`time_zone` 必填；本部署使用 `Asia/Shanghai`。
- `prompt` 是到点后投递给你的提醒内容，不是发给群或好友的消息；到点后要不要发言、发什么，仍按通道契约调用 `qq_send_*`。
- 循环任务在停机恢复后只补发最近一次漏掉的触发；本地时刻不存在（夏令时跳变）时跳过，重复时刻取较早的一次。
- `qq_list_schedules` / `qq_delete_schedule` / `qq_update_schedule` 只作用于 `chat_id` 指定的会话；`update` 不能改 `after_seconds`，新的相对延时需要新建。

## 模型与思考强度

`qq_model` 查看/切换模型与思考强度：`action=get` 报当前生效的 provider/model/level，并给出设置页为该群/私聊类型指定的值（`modelPrivate` / `modelGroup` + `thinkingPrivate` / `thinkingGroup`）；`action=set` 切换当前会话（`scope=chat`，只影响本会话）或部署默认（`scope=default`，仅管理员回合）。

群/私聊类型的长期模型在设置页「私聊」「群聊」两块分别用下拉配置（`modelPrivate` / `modelGroup`），思考强度同样用下拉（`thinkingPrivate` / `thinkingGroup`）；留空 = 跟随部署默认。该配置在新会话创建时生效，改模型或思考强度优先改这里。

档位不是固定四档：以下拉列出的、目标 provider/model 支持的能力为准（设置页按宿主模型能力生成选项，切换模型即重算）。要确认某路由支持什么，先 `qq_model action=get` 看 `levels`。

## 历史返回

`qq_group_history` 返回 `{messages, next_seq}`。每条消息与入站记录的字段相同：`qq`、`nickname`、`id`、`time`、`role?`、`message`；`message` 走与入站同一套渲染（纯文本是字符串，含媒体时是段数组，图片已取成本机文件、@ 已补显示名，引用与合并转发按配置展开）。需要未归一化的 NapCat 原始段时传 `raw=true`。

`next_seq` 是继续向更早翻页的唯一游标，直接作为 `message_seq` 传入即可，返回结果不会重复上一页的最后一条。不要用 `id` 或消息里的其他字段替代，NapCat 只认这个短 id。`next_seq` 为 `null` 表示已经没有更早的消息。

入站上下文被截断时会出现一条「更早的消息已省略」的系统记录，并附上 `message_seq=<n>`；把它传给 `qq_group_history` 就能取到被省略的那部分。

## 发送失败

- 一个坏段会让整条消息发送失败（通常 `retcode 1200`），发之前逐段确认 `type` 与必填字段。
- 文件路径一律给插件本机路径，插件负责读取并编码；`http(s)` URL 才由 NapCat 自行下载。
