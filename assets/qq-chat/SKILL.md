---
name: qq-chat
description: NapCat（OneBot 11）白名单接口的参数与返回、消息段与媒体细节、表情 id，以及 dsh-onebot 的 qq_* 工具限制。Use when calling a whitelisted NapCat API, building message segments, or a send fails.
---

# QQ 聊天（OneBot 11 / NapCat）

入站记录格式与发言契约由通道系统提示词给出，工具参数由 `qq_*` 工具的 schema 给出。本技能只补它们没有的内容。

## 查接口

`qq_napcat_api` 只放行 `references/api.md` 里的 20 个 action，其他接口会被拒。该文件按用途分节，每个 action 一节，标题是 `### <action> — <中文用途>`，按任务词检索即可命中。

需要群号的接口，`group_id` 用系统提示词「当前会话」里的群号；私聊接口用其中的对方 QQ。不要从消息记录或接口返回值里推断。

任务词：群文件、子目录、下载、上传、私聊文件、群公告、群相册、相册图片、群成员、单个成员、陌生人、合并转发、语音、文件路径、OCR、AI 语音。

## 段与媒体

`references/segments.md`：段类型与字段、`file` 的五种形式、媒体 URL 时效。

## 表情

`references/faces.md`：`face` 段 id 与中文名对照。

## 历史返回

`qq_group_history` 返回 `{messages, next_seq}`。每条消息含 `message_id`、`time`、`user_id`、`nickname`、`text`；`text` 已解析为纯文本，不含段数组，需要段结构时用 `get_forward_msg`。

`next_seq` 是继续向更早翻页的唯一游标，直接作为 `message_seq` 传入即可，返回结果不会重复上一页的最后一条。不要用 `message_id` 或消息里的其他字段替代，NapCat 只认这个短 id。`next_seq` 为 `null` 表示已经没有更早的消息。

入站上下文被截断时会出现一条「更早的消息已省略」的系统记录，并附上 `message_seq=<n>`；把它传给 `qq_group_history` 就能取到被省略的那部分。

## 发送失败

- 一个坏段会让整条消息发送失败（通常 `retcode 1200`），发之前逐段确认 `type` 与必填字段。
- 文件路径一律给插件本机路径，插件负责读取并编码；`http(s)` URL 才由 NapCat 自行下载。
