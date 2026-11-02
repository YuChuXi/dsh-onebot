# 白名单 API

`qq_napcat_api {action, params}` 只放行本文件的 22 个 action，其余 OneBot/NapCat 接口会被拒绝。返回 NapCat 响应里的 `data`；`retcode != 0` 时 `message` 是失败原因。

参数里的 `group_id`、`user_id` 传数字即可，NapCat 内部按字符串处理。

## 群文件

### get_group_root_files — 列群文件根目录

| 字段 | 类型 | 必选 | 说明 |
|---|---|---|---|
| `group_id` | number | 是 | 群号 |
| `file_count` | number | 否 | 返回条数，默认 50 |

```json
{"files":[{"file_id":"...","file_name":"a.zip","busid":102,"file_size":123,"upload_time":1690000000,"dead_time":1692592000,"modify_time":1690000000,"download_times":3,"uploader":123,"uploader_name":"小明"}],"folders":[{"folder_id":"...","folder_name":"文档","total_file_count":3,"create_time":1690000000,"creator":123,"creator_name":"小明"}]}
```

`folders[].folder_id` 传给 `get_group_files_by_folder`；`files[].file_id` 传给 `get_group_file_url`。`dead_time` 是过期时间，`0` 表示不过期。

### get_group_files_by_folder — 列群文件子目录

| 字段 | 类型 | 必选 | 说明 |
|---|---|---|---|
| `group_id` | number | 是 | 群号 |
| `folder_id` | string | 否 | 来自 `folders[].folder_id`；省略为根目录 |
| `file_count` | number | 否 | 返回条数，默认 50 |

返回结构与 `get_group_root_files` 相同。

### get_group_file_url — 取群文件下载链接

| 字段 | 类型 | 必选 | 说明 |
|---|---|---|---|
| `group_id` | number | 是 | 群号 |
| `file_id` | string | 是 | 来自 `files[].file_id` |

```json
{"url":"https://..."}
```

不接受 `busid`。`file_id` 必须是从本接口族返回的原值（内含 NapCat 编码的 UUID），自己拼的 id 会报 `real fileUUID not found!`。链接有时效，过期重新调用；返回链接，不是文件内容。

### upload_group_file — 上传文件到群文件

| 字段 | 类型 | 必选 | 说明 |
|---|---|---|---|
| `group_id` | number | 是 | 群号 |
| `file` | string | 是 | 本机路径（插件读取并编码）、`base64://` 或 http(s) URL |
| `name` | string | 是 | 群文件里显示的文件名 |
| `folder` | string | 否 | 目标目录的 `folder_id`，缺省为根目录 |
| `upload_file` | boolean | 否 | 默认 `true`；`false` 只创建条目不传内容 |

```json
{"file_id":"..."}
```

`file_id` 在失败时可能是 `null`。失败时 `retcode` 非 0，`message` 给原因。

## 私聊文件

### upload_private_file — 上传文件到私聊

| 字段 | 类型 | 必选 | 说明 |
|---|---|---|---|
| `user_id` | number | 是 | 对方 QQ |
| `file` | string | 是 | 同 `upload_group_file` |
| `name` | string | 是 | 显示的文件名 |
| `upload_file` | boolean | 否 | 默认 `true` |

```json
{"file_id":"..."}
```

### get_private_file_url — 取私聊文件下载链接

| 字段 | 类型 | 必选 | 说明 |
|---|---|---|---|
| `file_id` | string | 是 | 私聊文件 id |

```json
{"url":"https://..."}
```

`file_id` 需能解析出原消息 id，否则报 `real fileUUID not found!`。链接有时效。

## 群公告

### _get_group_notice — 读群公告

| 字段 | 类型 | 必选 | 说明 |
|---|---|---|---|
| `group_id` | number | 是 | 群号 |

```json
[{"notice_id":"...","sender_id":123,"publish_time":1690000000,"message":{"text":"公告正文","image":[{"id":"...","width":"0","height":"0"}],"images":[{"id":"...","width":"0","height":"0"}]},"read_num":10,"pinned":false,"send_to_new_member":false}]
```

没有公告时 `data` 是空数组。`_` 前缀是 NapCat 扩展接口，不是 OneBot 11 标准。`image` 与 `images` 是同一组 `{id, width, height}`，`width`、`height` 是字符串。`id` 只能标识图片，NapCat 没有按公告图片 id 下载的接口，`get_image` 也不接受它，公告图片拿不到内容。

## 群相册

以下两个接口直接把 NTQQ 的相册服务响应作为 `data` 返回，字段名由客户端决定，下列结构是 NapCat 给出的示例。

### get_qun_album_list — 列群相册

| 字段 | 类型 | 必选 | 说明 |
|---|---|---|---|
| `group_id` | number | 是 | 群号 |
| `attach_info` | string | 否 | 分页游标，首页留空 |

```json
{"album_list":[{"album_id":"...","album_name":"...","cover_url":"...","create_time":1690000000}],"attach_info":"...","has_more":true}
```

`has_more` 为 `true` 时把返回的 `attach_info` 原样传入取下一页。

### get_group_album_media_list — 列相册图片

| 字段 | 类型 | 必选 | 说明 |
|---|---|---|---|
| `group_id` | number | 是 | 群号 |
| `album_id` | string | 是 | 来自 `album_list[].album_id` |
| `attach_info` | string | 否 | 分页游标，首页留空 |

```json
{"media_list":[{"media_id":"...","url":"https://..."}],"attach_info":"...","has_more":false}
```

分页规则同 `get_qun_album_list`。`url` 是腾讯 CDN 地址，有时效；返回链接，不是图片字节。

## 群成员与消息

### get_group_member_list — 查群成员列表

| 字段 | 类型 | 必选 | 说明 |
|---|---|---|---|
| `group_id` | number | 是 | 群号 |
| `no_cache` | boolean | 否 | 默认 `false`；`true` 强制刷新成员缓存 |

```json
[{"group_id":123,"user_id":123,"nickname":"...","card":"...","role":"member","join_time":1690000000,"last_sent_time":1690000000,"level":"3","shut_up_timestamp":0}]
```

每项字段：`group_id`、`user_id`、`nickname` 必有；`card`、`sex`、`age`、`join_time`、`last_sent_time`、`level`、`qq_level`、`role`、`title`、`area`、`unfriendly`、`title_expire_time`、`card_changeable`、`shut_up_timestamp`、`is_robot`、`qage` 可选。`role` 取值 `owner`、`admin`、`member`。

### get_group_member_info — 查单个群成员

| 字段 | 类型 | 必选 | 说明 |
|---|---|---|---|
| `group_id` | number | 是 | 群号 |
| `user_id` | number | 是 | 成员 QQ |
| `no_cache` | boolean | 否 | 默认 `true`，读实时资料 |

返回单个成员对象，字段同 `get_group_member_list` 的单项。

### get_stranger_info — 查陌生人资料

| 字段 | 类型 | 必选 | 说明 |
|---|---|---|---|
| `user_id` | number | 是 | QQ 号 |
| `no_cache` | boolean | 否 | 默认 `false` |

```json
{"user_id":123,"uid":"u_...","nickname":"...","sex":"unknown","age":0,"qid":"","qqLevel":0,"long_nick":"","reg_time":0,"is_vip":false,"is_years_vip":false,"vip_level":0,"remark":"","status":0,"login_days":0}
```

`login_days` 恒为 `0`（客户端已不提供）。

### group_poke — 群聊戳一戳

| 字段 | 类型 | 必选 | 说明 |
|---|---|---|---|
| `group_id` | number | 是 | 群号 |
| `user_id` | number | 是 | 对方 QQ 号 |

无返回数据。

### friend_poke — 私聊戳一戳

| 字段 | 类型 | 必选 | 说明 |
|---|---|---|---|
| `user_id` | number | 是 | 对方 QQ 号 |

无返回数据。

### get_forward_msg — 取合并转发内容

| 字段 | 类型 | 必选 | 说明 |
|---|---|---|---|
| `message_id` | string | 否 | 合并转发所在消息 id |
| `id` | string | 否 | 同上；与 `message_id` 二选一，都不传会报错 |

```json
{"messages":[{"type":"node","data":{"user_id":123,"nickname":"...","message":[{"type":"text","data":{"text":"..."}}],"content":[]}}]}
```

`messages` 的每一项是 `node` 包裹：正文在 `data.message`（段数组，按 `segments.md` 解析），`data.content` 通常为空。嵌套转发会出现在 `data.message` 里，同样带 `type: "node"`。

### get_record — 取语音文件

| 字段 | 类型 | 必选 | 说明 |
|---|---|---|---|
| `file` | string | 否 | 语音段里的 `file` 值 |
| `file_id` | string | 否 | 与 `file` 二选一 |
| `out_format` | string | 是 | 转换格式：`mp3`、`amr`、`wma`、`m4a`、`spx`、`ogg`、`wav`、`flac` |

```json
{"file":"/path/to/record.mp3","url":"/path/to/record.mp3","file_size":"1234","file_name":"...","base64":"..."}
```

`out_format` 是必填字段，但传空字符串可跳过转换。跳过转换时 `base64` 通常不存在；转换后 `file`、`url` 都是 NapCat 机器上的本地路径，`base64` 是转换结果。

### get_file — 取文件路径或链接

| 字段 | 类型 | 必选 | 说明 |
|---|---|---|---|
| `file_id` | string | 否 | 与 `file` 二选一 |
| `file` | string | 否 | 与 `file_id` 二选一，取文件段里的 `file` 值 |

```json
{"file":"...","url":"...","file_size":"1234","file_name":"a.zip","base64":"..."}
```

各字段都可能出现，以实际返回为准。`file` 是 NapCat 机器上的路径，`url` 是下载链接，都不是字节；需要内容再读该路径、下载该链接，或直接用 `base64`。

## 表情

### fetch_custom_face — 获取收藏表情

| 字段 | 类型 | 必选 | 说明 |
|---|---|---|---|
| `count` | number | 否 | 数量，默认 48 |

```json
["https://...","https://..."]
```

返回 JSON 字符串数组，每项是一张收藏表情的图片 URL。

### add_custom_face — 添加自定义表情

| 字段 | 类型 | 必选 | 说明 |
|---|---|---|---|
| `file` | string | 是 | NapCat 本机可读的表情文件路径 |
| `emoji_id` | string | 否 | 商城表情 ID，默认空串 |
| `package_id` | number | 否 | 商城表情包 ID，默认 0 |
| `file_name` | string | 否 | 文件名，默认取 `file` 的 basename |
| `file_size` | number | 否 | 文件大小，默认读取本地文件 |
| `md5` | string | 否 | 文件 MD5，默认读取本地文件计算 |
| `is_mark_face` | boolean | 否 | 是否商城表情 |
| `is_origin` | boolean | 否 | 是否原图 |

无返回数据。`file` 必须位于 NapCat 能访问的本机路径；跨机部署时插件媒体目录不可见，收藏会失败。

## 图片识别与 AI 语音

### ocr_image — 图片 OCR

| 字段 | 类型 | 必选 | 说明 |
|---|---|---|---|
| `image` | string | 是 | 本机路径（插件读取并编码）、`base64://` 或 URL |

NapCat 的实现仅在 Windows 客户端可用，Linux 下调用会失败。返回的是客户端 OCR 服务的原始结果（源码直接透传 `ret.result`），不是固定结构，不要假设有 `texts` 字段。图片文字优先交给模型自身的视觉能力处理。

### get_ai_characters — 列 AI 语音角色

| 字段 | 类型 | 必选 | 说明 |
|---|---|---|---|
| `group_id` | number | 是 | 群号 |
| `chat_type` | number | 否 | 默认 `1` |

```json
[{"type":"1","characters":[{"character_id":"...","character_name":"...","preview_url":"..."}]}]
```

`type` 是字符串形式的分类标识。

### send_group_ai_record — 发 AI 语音

| 字段 | 类型 | 必选 | 说明 |
|---|---|---|---|
| `group_id` | number | 是 | 群号 |
| `character` | string | 是 | 来自 `characters[].character_id` |
| `text` | string | 是 | 要朗读的文字 |

```json
{"message_id":0}
```

返回的 `message_id` 恒为 `0`：底层接口不回传消息 id，不能用它引用这条语音。
