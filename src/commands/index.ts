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
import { PREVIEW_NO_CONTENT, PREVIEW_UNREADABLE, sessionPreviewFor } from './preview.js'
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
  /** 当前绑定的会话 id（live 与 idle 都可用，/session 的当前项）。 */
  currentSessionId(chatId: ChatId): string | undefined
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
 *
 * Returns:
 *   Promise<PendingPick | null | undefined>: 见上。
 */
async function resolveNumericSelection(
  ctx: CommandContext,
  chatId: ChatId,
  kind: PendingSelection['kind'],
  arg: string,
): Promise<PendingPick | null | undefined> {
  if (!/^\d+$/.test(arg.trim())) return undefined
  const pending = ctx.pendingSelection(chatId)
  if (pending === undefined || pending.kind !== kind) return undefined
  if (Date.now() - pending.createdAt > PENDING_SELECTION_TTL_MS) {
    ctx.setPendingSelection(chatId, undefined)
    await ctx.sendToChat(chatId, '选项已过期。')
    return null
  }
  const item = pending.items[Number(arg.trim()) - 1]
  if (item === undefined) {
    await ctx.sendToChat(chatId, '没有这个序号。')
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
      providerIds.push(...(ctx.llmCatalog?.listProviders() ?? []).slice(0, 6).map(p => p.id))
    } catch (error) {
      ctx.log('warn', 'listProviders failed: ' + String(error))
    }
    if (providerIds.length > 0) {
      out += '\n可用来源：\n' + providerIds.map((id, i) => `${i + 1}. ${id}`).join('\n')
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
  const picked = await resolveNumericSelection(ctx, chatId, 'model', arg)
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
    await ctx.sendToChat(chatId, '用法：/model 看列表；回复序号选择。')
    return
  }
  const provider = m[1]
  const model = m[2]
  try {
    const models = (await ctx.llmCatalog?.listModels(provider)) ?? []
    if (models.length > 0 && !models.some(x => x.id === model)) {
      await ctx.sendToChat(chatId, `没有这个模型，发 /model 看看可用的。`)
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
    await ctx.sendToChat(chatId, `已设为默认。`)
    return
  }
  if (chat !== undefined && chat.agent.model.current() !== undefined) {
    chat.agent.model.select(next)
  }
  await ctx.sendToChat(chatId, `已切换。`)
}

/** /model 第二级：列出某来源的模型并快照为 phase 'models'。 */
async function sendModelPickList(ctx: CommandContext, chatId: ChatId, provider: string): Promise<void> {
  let models
  try {
    models = (await ctx.llmCatalog?.listModels(provider)) ?? []
  } catch (error) {
    ctx.log('warn', 'listModels failed for ' + provider + ': ' + String(error))
    await ctx.sendToChat(chatId, `读取模型列表失败。`)
    return
  }
  const shown = models.slice(0, 10)
  if (shown.length === 0) {
    await ctx.sendToChat(chatId, '这个来源下没有可用模型。')
    return
  }
  ctx.setPendingSelection(chatId, {
    kind: 'model',
    phase: 'models',
    provider,
    items: shown.map(m => ({ label: m.id, payload: m.id })),
    createdAt: Date.now(),
  })
  await ctx.sendToChat(chatId, `模型列表（${provider}）：\n` + shown.map((m, i) => `${i + 1}. ${m.id}`).join('\n') + '\n回复 /model <序号> 切换。')
}

/** /session：列出可切回的历史会话，或按序号切回。 */
async function handleSessionCommand(ctx: CommandContext, chatId: ChatId, arg: string): Promise<void> {
  if (arg.trim() === '') {
    const list = ctx.switchableSessions(chatId)
    if (list.length === 0) {
      await ctx.sendToChat(chatId, '没有可切回的会话。')
      return
    }
    const lines = await Promise.all(list.map(async (entry, index) => {
      const preview = await sessionPreviewFor(ctx, entry.id)
      const text = preview === undefined ? PREVIEW_UNREADABLE : (preview !== '' ? preview : PREVIEW_NO_CONTENT)
      return `${index + 1}. ${text}`
    }))
    const out = '可切回的会话：\n' + lines.join('\n') + '\n回复 /session <序号> 切回。'
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
    await ctx.sendToChat(chatId, '还在回复中。')
    return
  }
  const picked = await resolveNumericSelection(ctx, chatId, 'session', arg)
  if (picked === null) return
  if (picked === undefined) {
    await ctx.sendToChat(chatId, '发 /session 看列表，回复序号切回。')
    return
  }
  const outcome = await ctx.switchSession(chatId, picked.payload)
  if (outcome.ok) {
    await ctx.sendToChat(chatId, '已切回。')
    return
  }
  if (outcome.reason === 'busy') {
    await ctx.sendToChat(chatId, '还在回复中。')
    return
  }
  if (outcome.reason === 'not-switchable') {
    await ctx.sendToChat(chatId, '这个序号不能切回。')
    return
  }
  if (outcome.reason === 'broken') {
    await ctx.sendToChat(chatId, '这个会话打不开。')
    return
  }
  await ctx.sendToChat(chatId, '切回失败。')
}

/**
 * /compact：把宿主的上下文压缩命令转发到当前会话的 agent。只回报执行结果
 * （已压缩 / 压缩失败），不转发宿主的 result.text。
 *
 * Args:
 *   ctx (CommandContext): 桥接能力。
 *   chatId (ChatId): 命令到达的会话。
 *
 * Returns:
 *   Promise<void>: 无。
 *
 * Callers:
 *   - `COMMANDS`（/compact）。
 */
async function handleCompactCommand(ctx: CommandContext, chatId: ChatId): Promise<void> {
  const chat = ctx.getChat(chatId)
  const commands = ctx.commands
  if (chat === undefined || commands === undefined) return
  try {
    // 宿主命令运行时无条件读取 attachments.length 与 signal.aborted。
    await commands.execute(chat.agent as never, '/compact', [], new AbortController().signal)
    ctx.log('info', 'host compact command for ' + chatId)
    await ctx.sendToChat(chatId, '已压缩。')
  } catch (error) {
    ctx.log('warn', 'host compact command failed: ' + describeError(error))
    await ctx.sendToChat(chatId, '压缩失败。')
  }
}

/** 部署默认模型（没有活跃会话时 /model 的展示值）。 */
function safeDefaultModel(ctx: CommandContext): ModelSelection | undefined {
  return ctx.agentDefaultModel?.currentSelection()
}
