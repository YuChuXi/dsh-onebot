/**
 * 出站管线：每会话串行发送链、纯文本发送（sendToChat）、原始段发送、
 * 合并转发与断线待发队列。
 * 频率控制只有一个落点：按字数的发送间隔（throttleSend）。
 * @module dsh-onebot/outbound
 */
import type { BridgeConfig } from '../bridge/config.js'
import type { ChatId } from '../chat/index.js'
import { splitChatId } from '../chat/index.js'
import { OneBotActionError, OneBotNotConnectedError } from '../onebot/connection.js'
import { describeError } from '../shared/errors.js'
import { TRACE_REASONS } from '../ops/trace.js'
import type { TraceStage } from '../ops/trace.js'

/** One OneBot message segment for outbound sends. */
export interface OutboundSegment {
  type: string
  data: Record<string, unknown>
}

/** Options for an explicit outbound send (from tools or command replies). */
export interface SendOptions {
  replyTo?: string
  /** Queue the send for resend on reconnect instead of failing while the
   * connection is down (error notices). Tool sends never queue: the model
   * sees the failure and decides whether to retry. */
  queuable?: boolean
}

/** The bridge capabilities the outbound pipeline touches. Deliberately
 * narrower than BridgeDeps: the connection call gate, the stop flag guarding
 * the B6 drain, and the config subset the pipeline reads — never the agent
 * registry, media store, or policy. */
export interface OutboundContext {
  /** Whether the OneBot connection currently accepts sends. */
  connected(): boolean
  /** The connection's own QQ id (forward-node uin). */
  selfId(): string
  /** Raw OneBot action invocation (send_msg / send_*_forward_msg). W1/T5:
   * the target chatId rides along when known so the bridge's inject dry-run
   * guard can attribute the call to a chat's injected round. */
  call(action: string, params: Record<string, unknown>, chatId?: ChatId): Promise<unknown>
  /** Bridge stop flag: the B6 drain must never run while stopping. */
  isStopping(): boolean
  /** Bridge log line callback. */
  log(level: 'info' | 'warn' | 'error' | 'debug', message: string): void
  /** W1: emit one outbound/queue decision event for a chat. The bridge owns
   * the traceId resolution (chat-level association table; unmapped proactive
   * writes mint a fresh id) — absent = tracing off, zero cost. */
  trace?: (chatId: ChatId, event: { stage: TraceStage; ok?: boolean; reason?: string; data?: Record<string, unknown> }) => void
  /** 出站管线读取的配置子集（发送间隔键可选，缺席用默认值）。 */
  config: Pick<BridgeConfig, 'botQQ'> & Partial<{
    /** 每条消息的固定间隔（毫秒）。 */
    outboundIntervalBaseMs: number
    /** 每个字追加的间隔（毫秒）。 */
    outboundIntervalPerCharMs: number
    /** 间隔的随机抖动百分比（0–100）。 */
    outboundIntervalJitterPct: number
  }>
}

/** Queued final replies older than this are dropped at drain time (M1-B6). */
const PENDING_SEND_TTL_MS = 5 * 60_000
/** Max queued final replies per chat; the oldest is dropped beyond this (M1-B6). */
const PENDING_SEND_MAX = 20

/** 发送间隔默认值：每秒级基础间隔 + 每字追加 + ±30% 抖动。 */
export const DEFAULT_OUTBOUND_INTERVAL_BASE_MS = 300
export const DEFAULT_OUTBOUND_INTERVAL_PER_CHAR_MS = 60
export const DEFAULT_OUTBOUND_INTERVAL_JITTER_PCT = 30

/**
 * 一条出站消息的字数：文本段算字符数，引用段不计，其余段各计 1。
 *
 * Args:
 *   message (OutboundSegment[]): 出站段数组。
 *
 * Returns:
 *   number: 用于节流的字数。
 */
export function outboundTextLength(message: OutboundSegment[]): number {
  let total = 0
  for (const segment of message) {
    if (segment.type === 'reply') continue
    if (segment.type === 'text' || segment.type === 'markdown') {
      total += String(segment.data.text ?? '').length
    } else {
      total += 1
    }
  }
  return total
}

/**
 * The outbound pipeline. Owns the B6 pendingSends state; the bridge keeps
 * same-name delegating facades and wires the reconnect drain trigger.
 */
export class OutboundPipeline {
  private readonly ctx: OutboundContext
  /** Clock override (tests); behavior-affecting timestamps (send chains,
   * offline queue, write gate) all read it — never the wall clock directly. */
  private readonly now: () => number
  /** Per-chat FIFO of model final replies parked while disconnected; drained
   * oldest-first on reconnect (M1-B6). */
  private readonly pendingSends = new Map<ChatId, Array<{ text: string; sentAt: number }>>()
  /** 每会话上一条消息的发送时刻（按字数节流的基准）。 */
  private readonly lastSendAtByChat = new Map<ChatId, number>()

  constructor(ctx: OutboundContext, options: { now?: () => number } = {}) {
    this.ctx = ctx
    // Lazy default: read Date.now through a wrapper so an injected clock is
    // optional and callers without one keep the dynamic global lookup (fake
    // timers in tests must keep influencing the wall-clock path).
    this.now = options.now ?? (() => Date.now())
  }

  /**
   * 发送插件自产的纯文本（命令回执、通知、错误提示）。
   *
   * 模型回复不走这里：模型的发言出口是 `qq_send_message` 等工具，
   * 工具把结构化消息段直接交给 `sendSegments`。
   *
   * Args:
   *   chatId (ChatId): 目标会话。
   *   text (string): 要发送的纯文本。
   *   options (SendOptions): 引用与排队选项。
   *
   * Returns:
   *   Promise<string[]>: 发出的 message_id 列表（空正文时为空数组）。
   *
   * Callers:
   *   - `commands/index.ts`：命令回执。
   *   - `bridge/index.ts`：固定通知、错误通知、新会话回执。
   *   - `outbound/index.ts:drainPendingSends`：断线排队补发。
   */
  sendToChat(chatId: ChatId, text: string, options: SendOptions = {}): Promise<string[]> {
    return this.enqueue(chatId, async () => {
      if (!this.ctx.connected()) {
        if (options.queuable === true) {
          this.ctx.log('debug', '连接断开，回复已排队等待重连补发: ' + chatId)
          this.ctx.trace?.(chatId, { stage: 'queue', ok: true, reason: TRACE_REASONS.outboundQueued })
          this.queuePendingSend(chatId, text)
          return []
        }
        this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason: TRACE_REASONS.outboundNotConnected })
        throw new OneBotNotConnectedError()
      }
      const ids: string[] = []
      if (text !== '') {
        const id = await this.sendMsg(chatId, [{ type: 'text', data: { text } }], options)
        if (id !== undefined) ids.push(id)
      } else {
        this.ctx.log('debug', '正文为空，未发送: ' + chatId)
        this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason: TRACE_REASONS.outboundEmptyText })
      }
      this.ctx.trace?.(chatId, { stage: 'outbound', ok: true, reason: TRACE_REASONS.outboundSent, data: { segments: ids.length } })
      return ids
    })
  }

  /** Park one queuable send for a chat while disconnected (M1-B6):
   * per-chat FIFO, capped — the oldest entry is dropped beyond the cap. */
  private queuePendingSend(chatId: ChatId, text: string): void {
    const queue = this.pendingSends.get(chatId) ?? []
    if (queue.length >= PENDING_SEND_MAX) {
      queue.shift()
      this.ctx.log('warn', 'pending send queue full for ' + chatId + ', dropped oldest')
      this.ctx.trace?.(chatId, { stage: 'queue', ok: false, reason: TRACE_REASONS.queueFull })
    }
    queue.push({ text, sentAt: this.now() })
    this.pendingSends.set(chatId, queue)
  }

  /**
   * 按字数排队：同一会话相邻两条消息至少间隔 base + perChar × 字数，
   * 再乘一个随机抖动，避免机器人的发送节奏完全固定。
   *
   * Args:
   *   chatId (ChatId): 目标会话。
   *   chars (number): 本条消息的字数（outboundTextLength）。
   *
   * Returns:
   *   Promise<void>: 等够间隔后返回。
   */
  private async throttleSend(chatId: ChatId, chars: number): Promise<void> {
    const base = Math.max(0, this.ctx.config.outboundIntervalBaseMs ?? DEFAULT_OUTBOUND_INTERVAL_BASE_MS)
    const perChar = Math.max(0, this.ctx.config.outboundIntervalPerCharMs ?? DEFAULT_OUTBOUND_INTERVAL_PER_CHAR_MS)
    const jitterPct = Math.min(1, Math.max(0, (this.ctx.config.outboundIntervalJitterPct ?? DEFAULT_OUTBOUND_INTERVAL_JITTER_PCT) / 100))
    const nominal = base + perChar * Math.max(0, chars)
    if (nominal <= 0) return
    const interval = nominal * (1 + (Math.random() * 2 - 1) * jitterPct)
    const wait = (this.lastSendAtByChat.get(chatId) ?? 0) + interval - this.now()
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
    if (this.lastSendAtByChat.size > 2000) this.lastSendAtByChat.clear()
    this.lastSendAtByChat.set(chatId, this.now())
  }

  /** Resend parked final replies oldest-first after a reconnect (M1-B6).
   * Per-chat send chains keep the order; a send that hits a fresh
   * disconnection re-queues itself via the queuable gate. Expired entries
   * (TTL) are dropped. Never runs while stopping. Wired from the bridge's
   * onStatus(true) handler (bridge.start). */
  drainPendingSends(): void {
    if (this.ctx.isStopping()) return
    const now = this.now()
    const batch: Array<{ chatId: ChatId; text: string }> = []
    for (const [chatId, queue] of this.pendingSends) {
      this.pendingSends.delete(chatId)
      for (const item of queue) {
        if (now - item.sentAt < PENDING_SEND_TTL_MS) {
          batch.push({ chatId, text: item.text })
        } else {
          this.ctx.log('debug', '排队回复超过 5 分钟未送达，已丢弃: ' + chatId)
          this.ctx.trace?.(chatId, { stage: 'queue', ok: false, reason: TRACE_REASONS.queueTtlExpired })
        }
      }
    }
    for (const { chatId, text } of batch) {
      void this.sendToChat(chatId, text, { queuable: true }).catch((error: unknown) => {
        this.ctx.log('warn', 'queued resend failed: ' + describeError(error))
        this.ctx.trace?.(chatId, { stage: 'queue', ok: false, reason: '排队回复补发失败: ' + describeError(error) })
      })
    }
  }

  /**
   * Send raw OneBot segments (used by the media tools).
   *
   * Args:
   *   chatId (ChatId): 目标会话。
   *   segments (OutboundSegment[]): 出站段。
   *   options (SendOptions): 引用与排队选项。
   *
   * Returns:
   *   Promise<string | undefined>: 发出的 message_id。
   */
  sendSegments(chatId: ChatId, segments: OutboundSegment[], options: SendOptions = {}): Promise<string | undefined> {
    return this.enqueue(chatId, async () => {
      let messageId: string | undefined
      try {
        messageId = await this.sendMsg(chatId, segments, options)
      } catch (error) {
        this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason: TRACE_REASONS.outboundSendFailed + describeError(error) })
        throw error
      }
      this.ctx.trace?.(chatId, { stage: 'outbound', ok: true, reason: TRACE_REASONS.outboundSent, data: { segments: segments.length } })
      return messageId
    })
  }

  /** B8d: per-chat send chains owned by the pipeline (decoupled from the
   * registry's chat lifecycle — unregistered chats serialize too, the
   * original C6b ask). Entries clean themselves up once settled so evicted
   * chats do not accumulate. */
  private readonly sendChains = new Map<ChatId, Promise<unknown>>()

  /** Serialize work on one chat's send chain. */
  private enqueue<T>(chatId: ChatId, work: () => Promise<T>): Promise<T> {
    const chain = this.sendChains.get(chatId) ?? Promise.resolve()
    const run = chain.then(work, work)
    const tail = run.catch(() => undefined)
    this.sendChains.set(chatId, tail)
    void tail.then(() => {
      if (this.sendChains.get(chatId) === tail) this.sendChains.delete(chatId)
    })
    return run
  }

  /** Send one message to a chat and return its message id. */
  async sendMsg(chatId: ChatId, segments: OutboundSegment[], options: SendOptions): Promise<string | undefined> {
    const ref = splitChatId(chatId)
    const params: Record<string, unknown> = {}
    let target: number
    try {
      target = Number(ref.target)
      if (!Number.isFinite(target)) throw new Error('bad target')
    } catch {
      throw new OneBotActionError('invalid chat target: ' + chatId)
    }
    if (ref.kind === 'group') params.group_id = target
    else params.user_id = target
    params.message = segments
    if (options.replyTo !== undefined) {
      params.message = [{ type: 'reply', data: { id: options.replyTo } }, ...segments]
    }
    await this.throttleSend(chatId, outboundTextLength(params.message as OutboundSegment[]))
    const data = await this.ctx.call('send_msg', params, chatId) as { message_id?: number | string }
    return data.message_id !== undefined ? String(data.message_id) : undefined
  }

  /**
   * Send forward nodes as a merged-forward message.
   *
   * Args:
   *   chatId (ChatId): 目标会话。
   *   nodes (Array<{ name: string; content: string }>): 转发节点。
   *
   * Returns:
   *   Promise<void>
   */
  async sendForward(chatId: ChatId, nodes: Array<{ name: string; content: string }>): Promise<void> {
    await this.sendForwardNodes(chatId, nodes)
  }

  /** 发送合并转发（`qq_send_forward` 工具的唯一落点）。 */
  private async sendForwardNodes(chatId: ChatId, nodes: Array<{ name: string; content: string }>): Promise<void> {
    const ref = splitChatId(chatId)
    const target = Number(ref.target)
    if (!Number.isFinite(target)) throw new OneBotActionError('invalid chat target: ' + chatId)
    const messages = nodes.map(node => ({
      type: 'node',
      data: {
        uin: this.ctx.selfId() || this.ctx.config.botQQ,
        name: node.name.slice(0, 24),
        content: [{ type: 'text', data: { text: node.content.slice(0, 500) } }],
      },
    }))
    await this.throttleSend(chatId, nodes.reduce((sum, node) => sum + node.content.length, 0))
    if (ref.kind === 'group') {
      await this.ctx.call('send_forward_msg', { group_id: target, messages }, chatId)
    } else {
      await this.ctx.call('send_private_forward_msg', { user_id: target, messages }, chatId)
    }
  }
}
