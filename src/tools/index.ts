/**
 * Model-facing tools for the OneBot channel: the send family (tools/send),
 * the whitelisted NapCat API proxy, group history and thinking control.
 * Tools infer the target chat from the calling agent's session; an explicit
 * chat_id overrides.
 * @module dsh-onebot/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

import type { ChatBridge } from '../bridge/index.js'
import type { OneBotConnection } from '../onebot/connection.js'
import { splitChatId } from '../chat/index.js'
import { encodeLocalFile, isLocalPath } from '../media/local.js'
import { incomingSegments, parseMessage } from '../onebot/segments.js'
import { registerSendTools } from './send.js'
import { registerStickerTools } from './stickers.js'
import { CHAT_ID_PARAM, END_PARAM, mediaRoots, resolveChat, type MediaLimits, type RegisterTool } from './shared.js'

/** OneBot actions a model may invoke through qq_napcat_api. */
const NAPCAT_API_WHITELIST = [
  'get_group_member_list',
  'get_group_member_info',
  'get_stranger_info',
  'fetch_custom_face',
  'add_custom_face',
  'group_poke',
  'friend_poke',
  'get_forward_msg',
  'get_record',
  'get_file',
  'upload_group_file',
  'upload_private_file',
  'get_group_root_files',
  'get_group_files_by_folder',
  'get_group_file_url',
  'get_private_file_url',
  '_get_group_notice',
  'get_qun_album_list',
  'get_group_album_media_list',
  'ocr_image',
  'get_ai_characters',
  'send_group_ai_record',
]

/** 直通接口里按本机路径读取的参数：action → 字段与大小上限。 */
const NAPCAT_LOCAL_FILES: Record<string, { field: string; limit: 'maxImageBytes' | 'maxFileBytes' }> = {
  upload_group_file: { field: 'file', limit: 'maxFileBytes' },
  upload_private_file: { field: 'file', limit: 'maxFileBytes' },
  ocr_image: { field: 'image', limit: 'maxImageBytes' },
}

/** Thinking-intensity levels the llm layer accepts. */
const THINK_LEVELS = ['off', 'low', 'high', 'max'] as const

/** Human label of one thinking level (unset = follow the deployment default).
 *
 * Args:
 *   level (string | undefined): 选择里的 reasoningEffort；undefined/'' 表示未设置。
 *
 * Returns:
 *   string: 面板/工具输出用的等级标签。
 *
 * Callers:
 *   - `tools/index.ts:registerTools`（qq_thinking 的 get/set 回包）。
 */
function levelLabel(level: string | undefined): string {
  return level === undefined || level === '' ? 'default（跟随部署默认）' : level
}

/** Build one model selection with an optional thinking level rewritten.
 *
 * Args:
 *   base (ModelSelection): 现有的 provider/model 选择。
 *   level (string | undefined): 目标等级；undefined 表示删除 reasoningEffort。
 *
 * Returns:
 *   ModelSelection: 只改写 reasoningEffort 一半的选择对象。
 *
 * Callers:
 *   - `tools/index.ts:registerTools`（qq_thinking 的会话级与部署级写入）。
 */
function selectionWithLevel(base: ModelSelection, level: string | undefined): ModelSelection {
  return {
    provider: base.provider,
    model: base.model,
    ...(level === undefined ? {} : { reasoningEffort: ReasoningEffortId(level) }),
  }
}

/**
 * Register all qq_* tools on the context. Registration is effect-based: the
 * returned disposer unregisters them.
 *
 * Args:
 *   ctx (Context): 插件上下文（工具注册面）。
 *   bridge (ChatBridge): 会话解析与出站发送的桥接对象。
 *   connection (OneBotConnection): NapCat API 代理与群历史的调用通道。
 *   limits (MediaLimits): 各媒体类型的大小上限。
 *
 * Returns:
 *   () => void: 注销全部工具的 disposer。
 *
 * Callers:
 *   - `bridge/index.ts:installChannelScope`（agent 作用域安装频道能力）。
 */
export function registerTools(
  ctx: Context,
  bridge: ChatBridge,
  connection: OneBotConnection,
  limits: MediaLimits,
): () => void {
  const disposers: Array<() => void> = []
  const register: RegisterTool = tool => {
    disposers.push(ctx.tools.register(tool))
  }

  registerSendTools(register, bridge, limits)
  registerStickerTools(register, bridge, connection, limits)

  register(defineTool({
    name: 'qq_napcat_api',
    description: '调用 NapCat 白名单内的 OneBot 扩展 API（群成员、群文件、群公告、群相册、OCR、AI 语音等）。非白名单 action 会被拒绝。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        description: '白名单 action：' + NAPCAT_API_WHITELIST.join(' / '),
      },
      params: {
        type: 'object',
        additionalProperties: true,
        description: 'action 参数（JSON 对象）',
      },
    },
    output: { schema: { type: 'json' }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const a = args as { action?: unknown; params?: unknown }
      if (typeof a.action !== 'string' || !NAPCAT_API_WHITELIST.includes(a.action)) {
        throw new Error('qq_napcat_api: action 不在白名单内（' + NAPCAT_API_WHITELIST.join(', ') + '）')
      }
      const params = typeof a.params === 'object' && a.params !== null ? { ...a.params as Record<string, unknown> } : {}
      // 模型只给本机路径：直通接口的路径参数在这里读成 base64，NapCat 不需要访问该路径。
      const local = NAPCAT_LOCAL_FILES[a.action]
      if (local !== undefined) {
        const value = params[local.field]
        if (typeof value === 'string' && isLocalPath(value)) {
          params[local.field] = await encodeLocalFile(value, limits[local.limit], await mediaRoots(bridge, exec))
        }
      }
      return await connection.call(a.action, params) as JsonValue
    },
  }))

  register(defineTool({
    name: 'qq_send_poke',
    description: '戳一戳指定 QQ：群聊内戳群成员，或私聊戳对方。省略 user_id 时取当前私聊对端。',
    parameters: {
      chat_id: CHAT_ID_PARAM,
      user_id: { type: 'string', description: '要戳的 QQ 号；群聊必填，私聊省略时取当前对端' },
      end: END_PARAM,
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const v = value as { poked?: unknown }
        return [{ type: 'text', text: '已戳 ' + String(v.poked ?? '') }]
      },
    },
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const a = args as { user_id?: unknown; chat_id?: unknown; end?: unknown }
      const chatId = resolveChat(bridge, exec, a.chat_id)
      const ref = splitChatId(chatId)
      const given = typeof a.user_id === 'string' || typeof a.user_id === 'number' ? String(a.user_id) : ''
      if (given === '' && ref.kind === 'group') throw new Error('qq_send_poke: 群聊必须给 user_id')
      const userId = given !== '' ? given : ref.target
      if (!/^\d+$/.test(userId)) throw new Error('qq_send_poke: user_id 必须是 QQ 号')
      if (ref.kind === 'group') {
        await connection.call('group_poke', { group_id: Number(ref.target), user_id: Number(userId) })
      } else {
        await connection.call('friend_poke', { user_id: Number(userId) })
      }
      if (a.end === true) exec.concludeTurn()
      return { poked: userId, chatId }
    },
  }))

  register(defineTool({
    name: 'qq_end_turn',
    description: '立即结束当前回合，不发送任何消息。发言已发完或无需回复时用它收尾。',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: () => [{ type: 'text', text: '已结束回合' }],
    },
    isConcurrencySafe: () => false,
    execute: async (_args, exec) => {
      exec.concludeTurn()
      return { ended: true }
    },
  }))

  register(defineTool({
    name: 'qq_group_history',
    description: '拉取群聊最近消息历史（供总结群内上下文、查看用户之前的发言）。仅群聊可用。',
    parameters: {
      chat_id: { type: 'string', description: '目标群会话 group:<群号>；省略时默认当前会话（须为群聊）' },
      count: { type: 'number', description: '拉取条数（≤50，默认 20）' },
      message_seq: { type: 'number', description: '继续向更早翻页的游标，取上一页返回的 next_seq；省略时返回最近消息' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          messages: { type: 'array', items: { type: 'object', additionalProperties: true } },
          next_seq: { oneOf: [{ type: 'number' }, { type: 'null' }] },
        },
        additionalProperties: false,
      },
      render: (_args: unknown, value: unknown) => {
        const page = (value ?? {}) as { messages?: unknown; next_seq?: unknown }
        const list = Array.isArray(page.messages) ? page.messages : []
        const cursor = typeof page.next_seq === 'number' ? '，更早的游标 ' + page.next_seq : ''
        return [{ type: 'text', text: list.length + ' 条历史消息' + cursor }]
      },
    },
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const a = args as { chat_id?: unknown; count?: unknown; message_seq?: unknown }
      const chatId = resolveChat(bridge, exec, a.chat_id)
      if (splitChatId(chatId).kind !== 'group') throw new Error('qq_group_history: 仅支持群聊')
      const groupId = Number(splitChatId(chatId).target)
      const count = Math.min(Math.max(typeof a.count === 'number' ? Math.floor(a.count) : 20, 1), 50)
      const params: Record<string, unknown> = {
        group_id: groupId,
        // NapCat 以传入游标为包含边界返回，多取一条抵消该边界，保证每页条数稳定。
        count: typeof a.message_seq === 'number' ? count + 1 : count,
      }
      if (typeof a.message_seq === 'number') {
        params.message_seq = String(a.message_seq)
        // reverse_order 缺省为向更新方向取，翻到更早必须显式置 true。
        params.reverse_order = true
      }
      const data = await connection.call('get_group_msg_history', params) as { messages?: unknown }
      const raw = Array.isArray(data.messages) ? data.messages : []
      // NapCat 以传入游标为包含边界返回，剔除该条避免与上一页重复。
      const messages = typeof a.message_seq === 'number'
        ? raw.filter(m => Number((m as Record<string, unknown>).message_seq) !== a.message_seq)
        : raw
      const rows = messages.map(m => {
        const msg = m as Record<string, unknown>
        const sender = (msg.sender ?? {}) as Record<string, unknown>
        const message = msg.message
        const parsed = parseMessage(incomingSegments(message))
        return {
          message_id: msg.message_id != null ? String(msg.message_id) : null,
          time: msg.time != null ? String(msg.time) : null,
          user_id: sender.user_id != null ? String(sender.user_id) : msg.user_id != null ? String(msg.user_id) : null,
          nickname: typeof sender.card === 'string' && sender.card !== '' ? sender.card
            : typeof sender.nickname === 'string' && sender.nickname !== '' ? sender.nickname
              : String(sender.user_id ?? ''),
          text: parsed.text,
        }
      })
      let nextSeq: number | null = null
      let earliest = Infinity
      for (const m of messages) {
        const msg = m as Record<string, unknown>
        const time = Number(msg.time)
        if (msg.message_seq != null && Number.isFinite(time) && time < earliest) {
          earliest = time
          nextSeq = Number(msg.message_seq)
        }
      }
      return { messages: rows, next_seq: nextSeq }
    },
  }))

  register(defineTool({
    name: 'qq_thinking',
    description: '查看/设置思考强度（reasoning effort）。action=get 报出当前生效等级；action=set 立刻改写本会话（scope=default 改部署默认）的选择，下一次请求生效。'
      + '等级 off（关闭思考）| low | high | max | default（跟随部署默认）：复杂推理调高，闲聊/简单活儿调低省时间。',
    parameters: {
      action: { type: 'string', enum: ['get', 'set'], description: 'get=查看（默认）；set=设置，需要 level' },
      level: { type: 'string', enum: [...THINK_LEVELS, 'default'], description: 'action=set 必填' },
      scope: { type: 'string', enum: ['chat', 'default'], description: 'chat=当前会话（默认）；default=部署默认选择（仅管理员回合）' },
      chat_id: { type: 'string', description: '目标会话；省略=当前会话' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const v = value as { summary?: unknown }
        return [{ type: 'text', text: typeof v.summary === 'string' ? v.summary : JSON.stringify(value) }]
      },
    },
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const a = args as { action?: unknown; level?: unknown; scope?: unknown; chat_id?: unknown }
      const action = String(a.action ?? 'get')
      const scope = String(a.scope ?? 'chat')
      const chatId = resolveChat(bridge, exec, a.chat_id)
      const payload: Record<string, JsonValue> = { scope }
      if (action === 'get') {
        const live = bridge.agentOf(chatId)?.model.current()
        const selection = live ?? bridge.deploymentModel()
        const route = selection === undefined ? '（部署没有默认模型）' : selection.provider + '/' + selection.model
        payload.summary = '当前思考强度：' + levelLabel(selection?.reasoningEffort)
          + '（模型 ' + route + '）'
          + '\n可设：' + THINK_LEVELS.join(' / ') + ' / default'
        payload.chatId = chatId
        payload.level = selection?.reasoningEffort ?? 'default'
        payload.levels = [...THINK_LEVELS]
        payload.provider = selection?.provider ?? ''
        payload.model = selection?.model ?? ''
        return payload
      }
      const level = String(a.level ?? '').toLowerCase()
      if (!(THINK_LEVELS as readonly string[]).includes(level) && level !== 'default') {
        throw new Error('qq_thinking: set 需要 level（' + THINK_LEVELS.join(' / ') + ' / default）')
      }
      const effort = level === 'default' ? undefined : level
      payload.level = effort ?? 'default'
      if (scope === 'default') {
        // 部署级改写与 /model --default 同一个存储；只允许管理员回合操作
        // （canEditFiles 只有在回合发起者是管理员时才为 true）。
        const sessionId = exec.agent?.session.id
        if (sessionId !== undefined && !bridge.canEditFiles(String(sessionId))) {
          throw new Error('qq_thinking: 只有管理员回合能改部署默认思考强度')
        }
        const base = bridge.deploymentModel()
        const store = bridge.defaultModelStore()
        if (base === undefined || store === undefined) throw new Error('qq_thinking: 部署默认模型不可用，改不了默认选择')
        await store.saveSelection(selectionWithLevel(base, effort))
        payload.summary = '✅ 部署默认思考强度已改为 ' + levelLabel(effort) + '（新建/恢复会话按此起步）'
        return payload
      }
      const agent = bridge.agentOf(chatId)
      const current = agent?.model.current()
      if (agent === undefined || current === undefined) {
        throw new Error('qq_thinking: 当前会话还没有模型选择（先发一条消息建会话，或 /model 选一个）')
      }
      // 只改写 effort 一半：之后 /model 切换模型时，等级随选择对象保留。
      agent.model.select(selectionWithLevel(current, effort))
      payload.summary = '✅ 本会话思考强度：' + levelLabel(effort) + '（下一步请求生效）'
      payload.chatId = chatId
      return payload
    },
  }))

  return () => {
    for (const dispose of disposers) dispose()
  }
}
