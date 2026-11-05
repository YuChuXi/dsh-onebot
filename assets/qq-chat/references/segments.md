# 消息段

一条消息是 `[{type, data}, …]`。

## 入站

| type | data 字段 | 说明 |
|---|---|---|
| `text` | `text` | 纯文本 |
| `image` | `file`（媒体目录内的文件名）, `sub_type?`, `summary?` | `sub_type=1` 是表情包；`summary` 是 QQ 自带的说明 |
| `record` | `file`（媒体目录内的文件名）, `sub_type?`, `summary?` | 语音；入站先给段，转写完成后以补充指令到达 |
| `video` | `file`（媒体目录内的文件名）, `sub_type?`, `summary?` | 短视频 |
| `file` | `file`（媒体目录内的文件名）, `name?`, `file_id?` | 群/私聊文件 |
| `at` | `qq`, `name?` | `qq=all` 是 @全体 |
| `face` | `id`, `name?` | QQ 经典表情，id 表见 `faces.md` |
| `mface` | `summary`, `emoji_id`, `emoji_package_id`, `key`, `url`, `file`（媒体目录内的文件名） | 商城表情；`summary` 是 QQ 固有摘要，形如 `[飞天猫猫]`，原样保留用于重放 |
| `reply` | `id`；展开后另带被引消息的记录字段 | 引用；展开层级由 `quoteExpandDepth` 控制，0 = 只保留 id |
| `forward` | `id`, `resId?`, `messages?` | 合并转发；展开后 `messages` 是节点数组，层级由 `forwardExpandDepth` 控制，单次条数由 `forwardExpandCount` 控制 |
| `node` | `id?`, `user_id`, `nickname`, `content`, `time?` | 合并转发节点 |
| `dice` / `rps` | `result?` | 骰子 / 猜拳 |
| `json` / `xml` | `data` | 卡片消息 |
| `share` | `url`, `title`, `content?`, `image?` | 链接分享 |
| `contact` | `type`, `id` | 推荐好友/群 |
| `location` | `lat`, `lon`, `title?`, `content?` | 位置 |
| `music` | `type`, `id` / `url` / `audio`, `title?`, `content?`, `image?` | 音乐分享 |
| `markdown` | `content` | Markdown 卡片 |
| `tts` | `text` | 文字转语音 |
| `cardimage` | `file` | 卡片图片 |
| `unknown` | 原始 data + `$type` | 未识别的段，`$type` 是原始类型名 |

入站媒体段的 `file` 是媒体目录内的文件名，完整路径前缀由系统提示词给出；字节由插件下载并落到本机临时目录，默认 6 小时后清理，需要长期引用先转存。普通媒体段里腾讯 CDN 的 `url` 已被丢弃；`mface` 是例外，五个字段连同 `url` 全部保留，用于原样重放。取不到字节时整个段会被替换成文本 `(图片未取到)`／`(语音未取到)` 这类占位。把入站段原样回传给发送工具时，需要把 `file` 拼上系统提示词给出的媒体目录前缀。

## 出站

`file` 字段接受五种形式，按顺序判定：

1. 本机已存在的路径（绝对路径即可，不需要 `file://`）
2. `http://` 或 `https://`
3. `base64://<base64>`
4. `file://<路径>`
5. `data:image/png;base64,<base64>`

「本机」指插件所在的机器：所有工具都接受本机路径，插件读取后编码成 base64 再发给 NapCat，与 NapCat 是否同机无关。可读范围限于插件媒体目录，管理员回合另含会话工作区，越界会被拒绝。

`http(s)` URL 原样交给 NapCat 自己下载，所以 NapCat 必须能访问该地址。

出站时逐段确认 `type` 与必填字段：`mface` 的五个字段缺一个、`face` 的名字不在表中且没给 `id`，这两种段会被丢弃并回报段名，其余段照常发送。
