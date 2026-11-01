/**
 * 斜杠命令面：/new、/session、/model、/compact。
 * 路由器只认管理员，未匹配的命令原样落回模型（不拦截、不做相近词建议）。
 * @module dsh-onebot/commands
 */

import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'

import type { ChatId } from '../chat/index.js'
import type { AgentDefaultModelLike, BridgeDeps, LlmCatalogPort, SessionPersistenceLike } from '../bridge/config.js'
import type { PendingSelection, SessionSwitchOutcome, SwitchableSession } from '../registry/index.js'
import { PREVIEW_NO_CONTENT, PREVIEW_UNREADABLE, sessionPreviewFor, shortSessionId } from './preview.js'
import { describeError } from '../shared/errors.js'

/** 命令处理器可读的活跃会话视图（registry.ChatAgent 的结构子集）。 */
export interface CommandChatView {
  agent: Agent
  sessionId: SessionId
  busy: boolean
}

/** 命令面触碰的桥接能力。 */
export interface CommandContext {
  /** 出站发送（命令唯一的回复路径）。 */
  sendToChat(chatId: ChatId, text: string): Promise<string[]>
  /** 桥接日志。 */
  log(level: 'info' | 'warn' | 'error' | 'debug', message: string): void
  /** 路由入口的管理员校验。 */
  isAdmin(userId: string): boolean
  /** 活跃会话查找。 */
  getChat(chatId: ChatId): CommandChatView | undefined
  /** /new：销毁会话并退役其 id。 */
  resetChat(chatId: ChatId): Promise<void>
  /** 无活跃会话时从映射文件读 session id（/session 的当前项）。 */
  sessionIdFromMapping(chatId: ChatId): Promise<string | undefined>
  /** /session：可切回的历史会话（新→旧）。 */
  switchableSessions(chatId: ChatId): SwitchableSession[]
  /** /session <序号>：切回历史会话。 */
  switchSession(chatId: ChatId, targetSessionId: string): Promise<SessionSwitchOutcome>
  /** /session 列表预览的持久化读端口。 */
  sessionPersistence: SessionPersistenceLike | undefined
  /** 序号选择快照（/model 与 /session 共用）。 */
  pendingSelection(chatId: ChatId): PendingSelection | undefined
  setPendingSelection(chatId: ChatId, value: PendingSelection | undefined): void
  /** /model：实时模型目录。 */
  llmCatalog: LlmCatalogPort | undefined
  /** /model --default：部署默认模型存储。 */
  agentDefaultModel: AgentDefaultModelLike | undefined
  /** /compact：转发给宿主命令运行时。 */
  commands: BridgeDeps['commands']
}

/** 一条斜杠命令：命令名 + 处理器。 */
export interface CommandDefinition {
  /** 斜杠后的命令词（大小写不敏感）。 */
  name: string
  handler(ctx: CommandContext, chatId: ChatId, arg: string): Promise<void>
}

/** 路由表。 */
export const COMMANDS: CommandDefinition[] = [
  { name: 'new', handler: async (ctx, chatId) => {
    ctx.log('info', 'slash /new for ' + chatId)
    await ctx.resetChat(chatId)
  } },
  { name: 'session', handler: handleSessionCommand },
  { name: 'model', handler: handleModelCommand },
  { name: 'compact', handler: handleCompactCommand },
]

/**
 * 斜杠命令路由：只在首个词形如 `/word` 时接管；管理员之外一律拒绝，
 * 未匹配的命令返回 false，由入站管线交给模型。
 *
 * Args:
 *   ctx (CommandContext): 桥接能力。
 *   chatId (ChatId): 命令到达的会话。
 *   text (string): 入站文本。
 *   userId (string): 发送方 QQ。
 *
 * Returns:
 *   Promise<boolean>: true = 已被命令消费。
 *
 * Callers:
 *   - `src/inbound/index.ts:InboundPipeline.processInbound`。
 */
export async function tryHandleCommand(ctx: CommandContext, chatId: ChatId, text: string, userId: string): Promise<boolean> {
  const normalized = text.replace(/^@\d+\s*/, '')
  const first = (normalized.split(/\s+/, 1)[0] ?? '').trim()
  if (!/^\/[A-Za-z][A-Za-z0-9_-]*$/.test(first)) return false

  const name = first.slice(1).toLowerCase()
  const command = COMMANDS.find(c => c.name === name)
  if (command === undefined) return false

  if (!ctx.isAdmin(userId)) {
    await ctx.sendToChat(chatId, '该命令仅管理员可用。')
    return true
  }
  ctx.log('debug', 'slash /' + name + ' for ' + chatId)
  await command.handler(ctx, chatId, normalized.slice(first.length).trim())
  return true
}

/** R2：序号选择快照的惰性有效期（无计时器，下一次同命令的数字回复时判定）。 */
const PENDING_SELECTION_TTL_MS = 5 * 60 * 1000

/** 数字选择的结果：命中项载荷 + 快照来源（/model 需要 phase/provider）。 */
interface PendingPick {
  payload: string
  phase?: 'providers' | 'models'
  provider?: string
}

/**
 * 把纯数字参数解释为对当前命令快照的 1 起序号选择。
 * 非数字 / 无同类快照 → undefined（走原语义）；过期或越界 → null（已回复，停止）。
 *
 * Args:
 *   ctx (CommandContext): 命令能力。
 *   chatId (ChatId): 会话。
 *   kind (PendingSelection['kind']): 期望的快照种类。
 *   arg (string): 用户参数。
 *   command (string): 用于提示的命令名。
 *
 * Returns:
 *   Promise<PendingPick | null | undefined>: 见上。
 */
async function resolveNumericSelection(
  ctx: CommandContext,
  chatId: ChatId,
  kind: PendingSelection['kind'],
  arg: string,
  command: string,
): Promise<PendingPick | null | undefined> {
  if (!/^\d+$/.test(arg.trim())) return undefined
  const pending = ctx.pendingSelection(chatId)
  if (pending === undefined || pending.kind !== kind) return undefined
  if (Date.now() - pending.createdAt > PENDING_SELECTION_TTL_MS) {
    ctx.setPendingSelection(chatId, undefined)
    await ctx.sendToChat(chatId, `❌ 序号选择已过期，请重新执行 ${command} 查看。`)
    return null
  }
  const item = pending.items[Number(arg.trim()) - 1]
  if (item === undefined) {
    await ctx.sendToChat(chatId, `❌ 序号越界，请回复 ${command} 重新查看列表。`)
    return null
  }
  ctx.setPendingSelection(chatId, undefined)
  return { payload: item.payload, phase: pending.phase, provider: pending.provider }
}

/** /model：查看（含两级序号列表）或切换模型；`--default` 改部署默认。 */
async function handleModelCommand(ctx: CommandContext, chatId: ChatId, arg: string): Promise<void> {
  const chat = ctx.getChat(chatId)
  const current = chat?.agent.model.current() ?? safeDefaultModel(ctx)
  if (arg === '') {
    const cur = current !== undefined ? current.provider + '/' + current.model : '（未设置）'
    let out = '当前模型：' + cur
    const providerIds: string[] = []
    try {
      const providers = ctx.llmCatalog?.listProviders() ?? []
      for (const p of providers.slice(0, 6)) {
        providerIds.push(p.id)
        try {
          const models = (await ctx.llmCatalog?.listModels(p.id)) ?? []
          out += '\n' + p.id + ': ' + models.slice(0, 10).map(m => m.id).join(', ')
        } catch (error) {
          out += '\n' + p.id + ': （列表不可用）'
          ctx.log('warn', 'listModels failed for ' + p.id + ': ' + String(error))
        }
      }
    } catch (error) {
      out += '\n（模型列表不可用）'
      ctx.log('warn', 'listProviders failed: ' + String(error))
    }
    if (providerIds.length > 0) {
      out += '\n可选来源：\n' + providerIds.map((id, i) => `${i + 1}. ${id}`).join('\n')
      out += '\n回复 /model <序号> 查看该来源的模型。'
      ctx.setPendingSelection(chatId, {
        kind: 'model',
        phase: 'providers',
        items: providerIds.map(id => ({ label: id, payload: id })),
        createdAt: Date.now(),
      })
    }
    await ctx.sendToChat(chatId, out)
    return
  }
  const picked = await resolveNumericSelection(ctx, chatId, 'model', arg, '/model')
  if (picked === null) return
  if (picked !== undefined) {
    if (picked.phase === 'providers') {
      await sendModelPickList(ctx, chatId, picked.payload)
      return
    }
    if (picked.phase === 'models' && picked.provider !== undefined) {
      arg = picked.provider + ' ' + picked.payload
    }
  }
  const first = arg.split(/\s+/, 1)[0] ?? ''
  const toDefault = first === '--default'
  const rest = toDefault ? arg.slice(first.length).trim() : arg
  const m = /^(\S+)[\s/]+(\S+)$/.exec(rest)
  if (m === null) {
    await ctx.sendToChat(chatId, '❌ 参数不完整或无法识别。\n用法：/model <provider> <model> 切换当前会话；/model --default <provider> <model> 修改部署默认')
    return
  }
  const provider = m[1]
  const model = m[2]
  try {
    const models = (await ctx.llmCatalog?.listModels(provider)) ?? []
    if (models.length > 0 && !models.some(x => x.id === model)) {
      await ctx.sendToChat(chatId, `❌ ${provider} 下没有模型 ${model}。可用：` + models.slice(0, 10).map(x => x.id).join(', ') + '\n用法：/model <provider> <model> 切换；/model 查看序号列表')
      return
    }
  } catch (error) {
    ctx.log('debug', 'model switch precheck failed for ' + provider + ': ' + String(error))
  }
  const next = { provider, model }
  if (toDefault) {
    if (ctx.agentDefaultModel !== undefined) {
      try {
        await ctx.agentDefaultModel.saveSelection(next)
      } catch (error) {
        ctx.log('warn', 'saveSelection failed: ' + String(error))
      }
    }
    await ctx.sendToChat(chatId, `✅ 已修改部署默认模型：${provider}/${model}（下一步生效）`)
    return
  }
  if (chat !== undefined && chat.agent.model.current() !== undefined) {
    chat.agent.model.select(next)
  }
  await ctx.sendToChat(chatId, `✅ 已切换当前会话模型：${provider}/${model}（下一步生效）`)
}

/** /model 第二级：列出某来源的模型并快照为 phase 'models'。 */
async function sendModelPickList(ctx: CommandContext, chatId: ChatId, provider: string): Promise<void> {
  let models
  try {
    models = (await ctx.llmCatalog?.listModels(provider)) ?? []
  } catch (error) {
    ctx.log('warn', 'listModels failed for ' + provider + ': ' + String(error))
    await ctx.sendToChat(chatId, `❌ 无法列出 ${provider} 的模型，请重新执行 /model 查看。`)
    return
  }
  const shown = models.slice(0, 10)
  if (shown.length === 0) {
    await ctx.sendToChat(chatId, `（${provider} 下没有可用模型，请重新执行 /model 查看。）`)
    return
  }
  ctx.setPendingSelection(chatId, {
    kind: 'model',
    phase: 'models',
    provider,
    items: shown.map(m => ({ label: m.id, payload: m.id })),
    createdAt: Date.now(),
  })
  await ctx.sendToChat(chatId, `模型列表（${provider}）：\n` + shown.map((m, i) => `${i + 1}. ${m.id}`).join('\n') + '\n回复 /model <序号> 切换当前会话模型。')
}

/** /session：列出可切回的历史会话，或按序号切回。 */
async function handleSessionCommand(ctx: CommandContext, chatId: ChatId, arg: string): Promise<void> {
  if (arg.trim() === '') {
    const list = ctx.switchableSessions(chatId)
    const current = ctx.getChat(chatId)?.sessionId ?? await ctx.sessionIdFromMapping(chatId)
    if (list.length === 0) {
      await ctx.sendToChat(chatId, '当前 session：' + (current ?? '（未建立会话）') + '\n（该会话没有可切回的历史会话）\n用法：/session <序号> 切回；/new 切换下来的旧会话会进入列表。')
      return
    }
    const lines = await Promise.all(list.map(async (entry, index) => {
      const preview = await sessionPreviewFor(ctx, entry.id)
      const text = preview === undefined ? PREVIEW_UNREADABLE : (preview.text !== '' ? preview.text : PREVIEW_NO_CONTENT)
      const created = preview?.createdAt !== undefined ? formatTimestamp(preview.createdAt) + ' 建立 · ' : ''
      return `${index + 1}. ${text}（${created}${formatTimestamp(entry.retiredAt)} 退休 · ${shortSessionId(entry.id)}）`
    }))
    let out = '当前 session：' + (current ?? '（未建立会话）') + '\n可切回历史会话：\n' + lines.join('\n')
    out += '\n回复 /session <序号> 切回（当前会话会进入列表，可来回切换）。'
    ctx.setPendingSelection(chatId, {
      kind: 'session',
      items: list.map(e => ({ label: e.id, payload: e.id })),
      createdAt: Date.now(),
    })
    await ctx.sendToChat(chatId, out)
    return
  }
  const chat = ctx.getChat(chatId)
  if (/^\d+$/.test(arg.trim()) && chat !== undefined && chat.busy) {
    await ctx.sendToChat(chatId, '当前正在生成回复，请先 /stop 再切换会话。')
    return
  }
  const picked = await resolveNumericSelection(ctx, chatId, 'session', arg, '/session')
  if (picked === null) return
  if (picked === undefined) {
    await ctx.sendToChat(chatId, '用法：/session 查看可切回会话；/session <序号> 切回。')
    return
  }
  const outcome = await ctx.switchSession(chatId, picked.payload)
  if (outcome.ok) {
    await ctx.sendToChat(chatId, `✅ 已切回历史会话：${outcome.sessionId}\n（原会话已进入可切回列表，发 /session 查看；下一条消息继续该会话的历史上下文。）`)
    return
  }
  if (outcome.reason === 'busy') {
    await ctx.sendToChat(chatId, '当前正在生成回复，请先 /stop 再切换会话。')
    return
  }
  if (outcome.reason === 'not-switchable') {
    await ctx.sendToChat(chatId, '❌ 该序号对应的会话不在当前会话的可切回列表中。发 /session 重新查看。')
    return
  }
  if (outcome.reason === 'broken') {
    await ctx.sendToChat(chatId, '❌ 该历史会话已损坏，无法切回。\n发 /session 查看其他可切回会话。')
    return
  }
  await ctx.sendToChat(chatId, '❌ 切回历史会话失败：' + outcome.message + '\n已回退：下一条消息将开启全新会话，原会话仍保留在 /session 列表中。')
}

/** 时间戳格式（/session 列表的建立/退休时间）。 */
function formatTimestamp(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

/** /compact：把宿主的上下文压缩命令转发到当前会话的 agent。 */
async function handleCompactCommand(ctx: CommandContext, chatId: ChatId): Promise<void> {
  const chat = ctx.getChat(chatId)
  if (chat === undefined) {
    await ctx.sendToChat(chatId, '请先发一条消息建立会话，再 /compact。')
    return
  }
  const commands = ctx.commands
  if (commands === undefined) {
    await ctx.sendToChat(chatId, '❌ 宿主未提供 commands 服务，无法压缩上下文。')
    return
  }
  try {
    // 宿主命令运行时无条件读取 attachments.length 与 signal.aborted。
    const result = unwrapCommandResult(await commands.execute(chat.agent as never, '/compact', [], new AbortController().signal))
    const text = result?.text !== undefined && result.text !== '' ? result.text : '✅ 已压缩上下文。'
    await ctx.sendToChat(chatId, text)
    ctx.log('info', 'host compact command for ' + chatId)
  } catch (error) {
    ctx.log('warn', 'host compact command failed: ' + describeError(error))
    await ctx.sendToChat(chatId, '❌ 上下文压缩失败：' + describeError(error))
  }
}

/** 宿主的命令结果包装（新宿主为 `{ commandId, result }`，旧宿主为扁平对象）。 */
function unwrapCommandResult(
  executed: { kind?: string; text?: string; result?: { kind?: string; text?: string } } | undefined,
): { kind?: string; text?: string } | undefined {
  if (executed === undefined) return undefined
  return 'result' in executed ? executed.result : executed
}

/** 部署默认模型（没有活跃会话时 /model 的展示值）。 */
function safeDefaultModel(ctx: CommandContext): ModelSelection | undefined {
  return ctx.agentDefaultModel?.currentSelection()
}
