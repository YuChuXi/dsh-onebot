/**
 * Model-facing tools for the OneBot channel: the send family (tools/send),
 * the whitelisted NapCat API proxy, group history and per-chat model control.
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
import type { RawMessage } from '../inbound/normalize.js'
import { displayName, splitChatId } from '../chat/index.js'
import { formatClock } from '../shared/clock.js'
import { encodeLocalFile, isLocalPath } from '../media/local.js'
import { StickerLibrary } from '../media/stickers.js'
import { registerSendTools } from './send.js'
import { registerStickerTools, type StickerImageStore } from './stickers.js'
import { registerScheduleTools } from './schedule.js'
import { CHAT_ID_PARAM, END_PARAM, mediaRoots, resolveChat, type MediaLimits, type RegisterTool } from './shared.js'

/** OneBot actions a model may invoke through qq_napcat_api. */
const NAPCAT_API_WHITELIST = [
  'get_group_member_list',
  'get_group_member_info',
  'get_stranger_info',
  'group_poke',
  'friend_poke',
  'get_msg',
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

/**
 * 把一条历史消息做成未归一化的模型侧记录：字段与入站记录一致，
 * `message` 保留 NapCat 原始段，供模型核对 url / emoji_id / sub_type 等。
 *
 * Args:
 *   msg (RawMessage): `get_group_msg_history` 返回的原始消息。
 *
 * Returns:
 *   JsonValue: 记录。
 *
 * Callers:
 *   - `qq_group_history`（raw=true）。
 */
function rawHistoryRecord(msg: RawMessage): JsonValue {
  const sender = msg.sender ?? {}
  const qq = String(sender.user_id ?? msg.user_id ?? '')
  return {
    qq,
    nickname: displayName(sender, qq),
    ...(msg.message_id != null ? { id: String(msg.message_id) } : {}),
    ...(msg.time != null ? { time: formatClock(Number(msg.time) * 1000) } : {}),
    message: msg.message ?? [],
  }
}

/** 一段人类可读的可用思考强度说明（能力未知 / 不支持 / 档位列表）。 */
function levelHint(supported: readonly string[] | undefined): string {
  if (supported === undefined) return '可设思考强度：以 provider 能力为准'
  if (supported.length === 0) return '该模型不接受思考强度'
  return '可设思考强度：' + supported.join(' / ')
}

/**
 * 校验目标模型接受某个思考强度；不接受时拒绝，并列出可用档位。
 *
 * Args:
 *   bridge (ChatBridge): 提供 provider/model 能力查询的桥接对象。
 *   provider (string): 目标提供商路由。
 *   model (string): 目标模型 id。
 *   level (string): 要写入的档位（调用方已排除空串与 default）。
 *
 * Returns:
 *   Promise<void>: 能力未知或档位受支持时返回。
 *
 * Callers:
 *   - `tools/index.ts:registerTools`（qq_model 的 set 路径）。
 */
async function assertLevelSupported(bridge: ChatBridge, provider: string, model: string, level: string): Promise<void> {
  const supported = await bridge.reasoningEfforts(provider, model)
  if (supported === undefined || supported.includes(level)) return
  throw new Error('qq_model: ' + provider + '/' + model + ' 不支持思考强度 ' + level
    + '（' + (supported.length === 0 ? '该模型不接受思考强度' : '支持：' + supported.join(' / ')) + '）')
}

/** Human label of one thinking level (unset = follow the deployment default).
 *
 * Args:
 *   level (string | undefined): 选择里的 reasoningEffort；undefined/'' 表示未设置。
 *
 * Returns:
 *   string: 面板/工具输出用的等级标签。
 *
 * Callers:
 *   - `tools/index.ts:registerTools`（qq_model 的 get/set 回包）。
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
 *   - `tools/index.ts:registerTools`（qq_model 的会话级与部署级写入）。
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
 *   mediaDir (string): 插件媒体目录；本地表情库落在其 `stickers` 子目录。
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
  mediaDir: string,
): () => void {
  const disposers: Array<() => void> = []
  const register: RegisterTool = tool => {
    disposers.push(ctx.tools.register(tool))
  }

  registerSendTools(register, bridge, limits)
  registerStickerTools(register, bridge, new StickerLibrary(mediaDir), limits, () => (
    ctx.get('attachments' as never) as unknown as StickerImageStore | undefined
  ))
  registerScheduleTools(register, bridge)

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
    description: '拉取群聊历史消息。每条消息按入站同一套渲染给出：媒体已取成本机文件、@ 补了显示名、引用与合并转发按配置展开；raw=true 时改给 NapCat 原始段。更早的消息用返回的 next_seq 继续翻页。仅群聊可用。',
    parameters: {
      chat_id: { type: 'string', description: '目标群会话 group:<群号>；省略时默认当前会话（须为群聊）' },
      count: { type: 'number', description: '拉取条数（≤50，默认 20）' },
      message_seq: { type: 'number', description: '继续向更早翻页的游标，取上一页返回的 next_seq；省略时返回最近消息' },
      raw: { type: 'boolean', description: '返回 NapCat 原始 message 段，不做归一化（含 url / emoji_id / sub_type 等）；默认 false' },
    },
    output: {
      schema: { type: 'json' },
      // 与入站载荷 formatRecords 同一种序列化：紧凑 JSON，不额外缩进。
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const a = args as { chat_id?: unknown; count?: unknown; message_seq?: unknown; raw?: unknown }
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
      const fetched = Array.isArray(data.messages) ? data.messages : []
      // NapCat 以传入游标为包含边界返回，剔除该条避免与上一页重复。
      const incoming = (typeof a.message_seq === 'number'
        ? fetched.filter(m => Number((m as Record<string, unknown>).message_seq) !== a.message_seq)
        : fetched) as RawMessage[]
      const messages: JsonValue[] = []
      for (const msg of incoming) {
        messages.push(a.raw === true ? rawHistoryRecord(msg) : await bridge.recordOfHistoryMessage(msg, chatId))
      }
      let nextSeq: number | null = null
      let earliest = Infinity
      for (const msg of incoming) {
        const time = Number(msg.time)
        if (msg.message_seq != null && Number.isFinite(time) && time < earliest) {
          earliest = time
          nextSeq = Number(msg.message_seq)
        }
      }
      return { messages, next_seq: nextSeq }
    },
  }))

  register(defineTool({
    name: 'qq_model',
    description: '查看/切换模型与思考强度。action=get 报生效值与该模型支持的档位，并给出配置里为该群/私聊指定的模型；action=set 切换当前会话（scope=chat，沿用会话自己的选择）或部署默认（scope=default，仅管理员回合）。'
      + '群/私聊类型的长期模型与思考强度在设置页「私聊」「群聊」两块用下拉配置（配置键 modelPrivate/modelGroup 与 thinkingPrivate/thinkingGroup）。'
      + '思考强度取值以 get 返回的 levels 为准（常见 off/low/high/max），default 表示跟随按会话类型的默认；模型不支持的档位会被拒绝。',
    parameters: {
      action: { type: 'string', enum: ['get', 'set'], description: 'get=查看（默认）；set=设置' },
      provider: { type: 'string', description: '提供商路由；与 model 同时给出' },
      model: { type: 'string', description: '模型 id；与 provider 同时给出' },
      level: { type: 'string', description: '思考强度 id；取值见 get 的 levels，default=跟随按会话类型的默认' },
      scope: { type: 'string', enum: ['chat', 'default'], description: 'chat=当前会话（默认）；default=部署默认（仅管理员回合）' },
      chat_id: CHAT_ID_PARAM,
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
      const a = args as { action?: unknown; provider?: unknown; model?: unknown; level?: unknown; scope?: unknown; chat_id?: unknown }
      const action = String(a.action ?? 'get')
      const scope = String(a.scope ?? 'chat')
      const chatId = resolveChat(bridge, exec, a.chat_id)
      const provider = typeof a.provider === 'string' ? a.provider.trim() : ''
      const model = typeof a.model === 'string' ? a.model.trim() : ''
      const level = typeof a.level === 'string' ? a.level.toLowerCase() : ''
      const sessionId = exec.agent?.session.id
      const isAdmin = sessionId !== undefined && bridge.canEditFiles(String(sessionId))
      const payload: Record<string, JsonValue> = { scope, chatId }

      if (action === 'get') {
        if (scope === 'default') {
          const selection = bridge.deploymentModel()
          const supported = selection === undefined
            ? undefined
            : await bridge.reasoningEfforts(selection.provider, selection.model)
          payload.summary = '部署默认模型：' + (selection === undefined ? '（未设置）' : selection.provider + '/' + selection.model)
            + '，思考强度 ' + levelLabel(selection?.reasoningEffort)
            + '\n' + levelHint(supported)
          payload.provider = selection?.provider ?? ''
          payload.model = selection?.model ?? ''
          payload.level = selection?.reasoningEffort ?? 'default'
          payload.levels = supported === undefined ? [] : [...supported]
          return payload
        }
        const live = bridge.agentOf(chatId)?.model.current()
        const configured = bridge.configuredModel(chatId)
        const deployment = bridge.deploymentModel()
        const effectiveProvider = live?.provider ?? configured?.provider ?? deployment?.provider
        const effectiveModel = live?.model ?? configured?.model ?? deployment?.model
        const effectiveLevel = live?.reasoningEffort ?? configured?.reasoningEffort
        const supported = effectiveProvider === undefined || effectiveModel === undefined
          ? undefined
          : await bridge.reasoningEfforts(effectiveProvider, effectiveModel)
        payload.summary = '当前模型：' + (effectiveProvider === undefined ? '（未设置）' : effectiveProvider + '/' + effectiveModel)
          + '，思考强度 ' + levelLabel(effectiveLevel)
          + (configured === undefined ? '' : '（配置已为该群/私聊指定）')
          + '\n' + levelHint(supported)
        payload.provider = effectiveProvider ?? ''
        payload.model = effectiveModel ?? ''
        payload.level = effectiveLevel ?? 'default'
        payload.levels = supported === undefined ? [] : [...supported]
        payload.configured = configured === undefined ? null : configured as unknown as JsonValue
        return payload
      }

      const changingRoute = provider !== '' || model !== ''
      if (changingRoute && (provider === '' || model === '')) {
        throw new Error('qq_model: provider 与 model 必须同时给出')
      }
      if (!changingRoute && level === '') {
        throw new Error('qq_model: set 需要 provider+model 或 level')
      }
      if (changingRoute && !isAdmin) throw new Error('qq_model: 只有管理员回合能改模型')

      if (scope === 'default') {
        if (!isAdmin) throw new Error('qq_model: 只有管理员回合能改部署默认模型')
        const base = bridge.deploymentModel()
        const store = bridge.defaultModelStore()
        const nextProvider = changingRoute ? provider : base?.provider
        const nextModel = changingRoute ? model : base?.model
        if (store === undefined || nextProvider === undefined || nextModel === undefined) {
          throw new Error('qq_model: 部署没有默认模型，set 需要 provider 与 model')
        }
        const effort = level === 'default' ? undefined : level !== '' ? level : base?.reasoningEffort
        if (effort !== undefined) await assertLevelSupported(bridge, nextProvider, nextModel, String(effort))
        await store.saveSelection(selectionWithLevel({ provider: nextProvider, model: nextModel }, effort))
        payload.summary = '部署默认模型：' + nextProvider + '/' + nextModel + '，思考强度 ' + levelLabel(effort)
          + '（新建/恢复会话按此起步）'
        payload.provider = nextProvider
        payload.model = nextModel
        payload.level = effort ?? 'default'
        return payload
      }

      const agent = bridge.agentOf(chatId)
      const current = agent?.model.current()
      if (agent === undefined || current === undefined) {
        throw new Error('qq_model: 当前群/私聊还没有在线会话（先发一条消息建会话；长期模型在设置页「私聊」「群聊」两块配置）')
      }
      const nextProvider = changingRoute ? provider : current.provider
      const nextModel = changingRoute ? model : current.model
      const effort = level === 'default' ? undefined : level !== '' ? level : current.reasoningEffort
      if (effort !== undefined) await assertLevelSupported(bridge, nextProvider, nextModel, String(effort))
      agent.model.select({
        provider: nextProvider,
        model: nextModel,
        ...(effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) }),
      })
      payload.summary = '本会话已切换：' + nextProvider + '/' + nextModel
        + '，思考强度 ' + levelLabel(effort) + '（下一步请求生效；长期默认在设置页「私聊」「群聊」两块配置）'
      payload.provider = nextProvider
      payload.model = nextModel
      payload.level = effort ?? 'default'
      return payload
    },
  }))

  return () => {
    for (const dispose of disposers) dispose()
  }
}
