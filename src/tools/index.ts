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
import { incomingSegments, parseMessage } from '../onebot/segments.js'
import { registerSendTools } from './send.js'
import { resolveChat, type MediaLimits, type RegisterTool } from './shared.js'

/** OneBot actions a model may invoke through qq_napcat_api. */
const NAPCAT_API_WHITELIST = [
  'get_group_member_list',
  'get_group_member_info',
  'get_stranger_info',
  'get_forward_msg',
  'get_record',
  'get_file',
  'upload_group_file',
  'upload_private_file',
  'get_group_root_files',
  'get_group_files_by_folder',
  'get_group_file_url',
  'get_private_file_url',
  'ocr_image',
  'get_ai_characters',
  'send_group_ai_record',
]

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

  register(defineTool({
    name: 'qq_napcat_api',
    description: '调用 NapCat 白名单内的 OneBot 扩展 API（群成员列表/信息、文件、OCR、AI 语音等）。非白名单 action 会被拒绝。',
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
    execute: async (args, _exec) => {
      const a = args as { action?: unknown; params?: unknown }
      if (typeof a.action !== 'string' || !NAPCAT_API_WHITELIST.includes(a.action)) {
        throw new Error('qq_napcat_api: action 不在白名单内（' + NAPCAT_API_WHITELIST.join(', ') + '）')
      }
      const params = typeof a.params === 'object' && a.params !== null ? a.params as Record<string, unknown> : {}
      return await connection.call(a.action, params) as JsonValue
    },
  }))

  register(defineTool({
    name: 'qq_group_history',
    description: '拉取群聊最近消息历史（供总结群内上下文、查看用户之前的发言）。仅群聊可用。',
    parameters: {
      chat_id: { type: 'string', description: '目标群会话 group:<群号>；省略时默认当前会话（须为群聊）' },
      count: { type: 'number', description: '拉取条数（≤50，默认 20）' },
      message_seq: { type: 'number', description: '起始消息序号（翻页用，可选）' },
    },
    output: {
      schema: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
      },
      render: (_args: unknown, value: unknown) => {
        const list = Array.isArray(value) ? value : []
        return [{ type: 'text', text: list.length + ' 条历史消息' }]
      },
    },
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const a = args as { chat_id?: unknown; count?: unknown; message_seq?: unknown }
      const chatId = resolveChat(bridge, exec, a.chat_id)
      if (splitChatId(chatId).kind !== 'group') throw new Error('qq_group_history: 仅支持群聊')
      const groupId = Number(splitChatId(chatId).target)
      const count = Math.min(Math.max(typeof a.count === 'number' ? Math.floor(a.count) : 20, 1), 50)
      const params: Record<string, unknown> = { group_id: groupId, count }
      if (typeof a.message_seq === 'number') params.message_seq = a.message_seq
      const data = await connection.call('get_group_msg_history', params) as { messages?: unknown }
      const messages = Array.isArray(data.messages) ? data.messages : []
      return messages.map(m => {
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
