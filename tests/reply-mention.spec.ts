/**
 * 纯引用触发的群聊提及校验：没有显式 @ 时，只有「回复机器人自己的消息」可以
 * 唤醒机器人，作者必须由 get_msg 证实；查询失败、作者缺失、回复他人一律
 * 不唤醒（fail-closed）。显式 @、私聊与关闭 requireMention 的群不受此校验影响。
 * @module dsh-onebot/tests/reply-mention
 */
import { describe, expect, it, vi } from 'vitest'

import type { OneBotEvent } from '../src/onebot/connection.js'
import type { IncomingSegment } from '../src/onebot/segments.js'
import { InboundPipeline } from '../src/inbound/index.js'
import { normalizeOneBot11 } from '../src/inbound/normalize.js'
import type { InboundContext } from '../src/inbound/index.js'
import { runWithTrace, TRACE_REASONS } from '../src/ops/trace.js'
import type { TraceScope } from '../src/ops/trace.js'

const BOT = '10002'
const OTHER = '10003'

const atBot: IncomingSegment = { type: 'at', data: { qq: BOT } }
const atOther: IncomingSegment = { type: 'at', data: { qq: OTHER } }
const body: IncomingSegment = { type: 'text', data: { text: 'reply body' } }
const reply = (id: string | number, qq?: string): IncomingSegment => ({
  type: 'reply',
  data: { id, ...(qq !== undefined ? { qq } : {}) },
})

interface HarnessOptions {
  /** get_msg 响应的发送方 QQ；缺省 = 他人。 */
  author?: string | number
  /** 整个 get_msg 响应覆盖（null / 缺字段用于 fail-closed 用例）。 */
  response?: unknown
  /** get_msg 抛错。 */
  error?: string
  selfId?: string
  busy?: boolean
  command?: boolean
  config?: Partial<InboundContext['config']>
  policy?: Partial<InboundContext['policy']>
  replyMessageId?: number
}

/** 隔离的管线：动作调用、命令路由与投递都是内存桩。 */
function makeHarness(options: HarnessOptions = {}) {
  const response = Object.hasOwn(options, 'response') ? options.response : {
    sender: { user_id: options.author ?? OTHER, nickname: 'original author' },
    message: [{ type: 'text', data: { text: 'original text' } }],
  }
  const calls: Array<{ action: string; params: Record<string, unknown> }> = []
  const call = vi.fn(async (action: string, params: Record<string, unknown>) => {
    calls.push({ action, params })
    if (action === 'get_group_msg_history') return { messages: [] }
    if (action === 'get_group_member_list') return []
    expect(action).toBe('get_msg')
    expect(params).toEqual({ message_id: options.replyMessageId ?? 123 })
    if (options.error !== undefined) throw new Error(options.error)
    return response
  })
  const tryHandleCommand = vi.fn(async () => options.command === true)
  const interceptBusyTurn = vi.fn(async (_id: string, _text: string, _role: string, _nickname: string | undefined) => options.busy === true)
  const dispatched: string[] = []
  const dispatchFollowup = vi.fn(async (_id: string, text: string) => { dispatched.push(text) })
  const emit = vi.fn<TraceScope['emit']>()
  const trace: TraceScope = { traceId: 't-reply', chatId: 'group:888', messageId: '456', emit }
  const pipeline = new InboundPipeline({
    call,
    selfId: () => options.selfId ?? BOT,
    policy: {
      dmPolicy: 'open', groupPolicy: 'open', allowFrom: [], groupAllowFrom: [],
      adminUsers: [OTHER], allowAllUsers: false, requireMention: true, ...options.policy,
    },
    getSettings: () => ({}) as never,
    saveMapping: () => undefined,
    sweepIdleChats: async () => undefined,
    media: { cleanupExpired: async () => undefined } as never,
    transcriber: { enabled: false } as never,
    steerTranscript: () => undefined,
    tryHandleCommand,
    interceptBusyTurn,
    dispatchFollowup,
    log: () => undefined,
    config: {
      botQQ: BOT, ignoreSelf: true, requireMention: true,
      maxInboundFileBytes: 0, ...options.config,
    },
  })
  const getMsgCalls = (): Array<{ action: string; params: Record<string, unknown> }> =>
    calls.filter(entry => entry.action === 'get_msg')
  return { pipeline, call, calls, getMsgCalls, tryHandleCommand, interceptBusyTurn, dispatchFollowup, dispatched, trace, emit }
}

/** 归一条群聊/私聊事件。 */
function inbound(
  message: IncomingSegment[],
  overrides: Partial<OneBotEvent> = {},
): NonNullable<ReturnType<typeof normalizeOneBot11>> {
  return normalizeOneBot11({
    post_type: 'message', message_type: 'group', user_id: Number(OTHER), group_id: 888,
    self_id: Number(BOT), message_id: 456, sender: { user_id: Number(OTHER), nickname: 'sender' },
    message, ...overrides,
  })!
}

/** 断言消息被提及闸门挡下：没有查询副作用，没有后续阶段。 */
function expectBlocked(h: ReturnType<typeof makeHarness>, reason: string): void {
  expect(h.dispatched).toEqual([])
  expect(h.tryHandleCommand).not.toHaveBeenCalled()
  expect(h.interceptBusyTurn).not.toHaveBeenCalled()
  expect(h.emit).toHaveBeenCalledWith('mention', { ok: false, reason })
}

describe('reply-only group mention verification', () => {
  it('blocks a reply without an explicit @ when the author is another member', async () => {
    const h = makeHarness()
    await runWithTrace(h.trace, () => h.pipeline.processInbound(inbound([reply('123'), body])))
    expect(h.getMsgCalls()).toHaveLength(1)
    expectBlocked(h, TRACE_REASONS.inboundReplyOtherAuthor)
  })

  it('blocks a reply plus an @ for another member', async () => {
    const h = makeHarness()
    await runWithTrace(h.trace, () => h.pipeline.processInbound(inbound([reply('123'), atOther, body])))
    expectBlocked(h, TRACE_REASONS.inboundReplyOtherAuthor)
  })

  it('allows a verified reply to the bot and dispatches one record payload', async () => {
    const h = makeHarness({ author: BOT })
    await runWithTrace(h.trace, () => h.pipeline.processInbound(inbound([reply('123'), body])))
    expect(h.getMsgCalls()).toHaveLength(1)
    expect(h.dispatchFollowup).toHaveBeenCalledTimes(1)
    expect(h.dispatched).toHaveLength(1)
    expect(JSON.parse(h.dispatched[0])[0]).toMatchObject({ qq: OTHER, nickname: 'sender' })
  })

  it('trusts an explicit @ and reuses the single quote lookup for expansion', async () => {
    const h = makeHarness({ author: OTHER })
    await runWithTrace(h.trace, () => h.pipeline.processInbound(inbound([atBot, reply('123'), body])))
    expect(h.getMsgCalls()).toHaveLength(1)
    expect(h.dispatchFollowup).toHaveBeenCalledTimes(1)
  })

  it('blocks when the author lookup fails or returns no author', async () => {
    const failing = makeHarness({ error: 'message not found' })
    await runWithTrace(failing.trace, () => failing.pipeline.processInbound(inbound([reply('123'), body])))
    expectBlocked(failing, TRACE_REASONS.inboundReplyLookupFailed)

    const empty = makeHarness({ response: null })
    await runWithTrace(empty.trace, () => empty.pipeline.processInbound(inbound([reply('123'), body])))
    expectBlocked(empty, TRACE_REASONS.inboundReplyLookupFailed)

    const anonymous = makeHarness({ response: { message: [body] } })
    await runWithTrace(anonymous.trace, () => anonymous.pipeline.processInbound(inbound([reply('123'), body])))
    expectBlocked(anonymous, TRACE_REASONS.inboundReplyAuthorUnknown)
  })

  it('rejects a reply id that cannot be requested safely, without calling get_msg', async () => {
    for (const id of ['', 'abc', '1.5', '1e3', '0x7b', ' 123 ', '123\n', 'NaN', 'Infinity', '9007199254740993']) {
      const h = makeHarness()
      await runWithTrace(h.trace, () => h.pipeline.processInbound(inbound([reply(id), body])))
      expect(h.getMsgCalls()).toHaveLength(0)
      expectBlocked(h, TRACE_REASONS.quoteInvalidId)
    }
  })

  it('accepts signed and safe-integer adapter ids and looks them up once', async () => {
    const h = makeHarness({ author: BOT, replyMessageId: -123 })
    await runWithTrace(h.trace, () => h.pipeline.processInbound(inbound([reply(-123), body])))
    expect(h.getMsgCalls()).toEqual([{ action: 'get_msg', params: { message_id: -123 } }])
    expect(h.dispatchFollowup).toHaveBeenCalledTimes(1)
  })

  it('treats a numeric reply id like its string form', async () => {
    const h = makeHarness({ author: BOT, replyMessageId: 123 })
    await runWithTrace(h.trace, () => h.pipeline.processInbound(inbound([reply(123), body])))
    expect(h.getMsgCalls()).toHaveLength(1)
    expect(h.dispatchFollowup).toHaveBeenCalledTimes(1)
  })

  it('keeps private chats free of quote-author verification', async () => {
    const h = makeHarness()
    await runWithTrace(h.trace, () => h.pipeline.processInbound(inbound([reply('123'), body], {
      message_type: 'private', group_id: undefined,
    })))
    // 私聊不做作者校验；唯一一次 get_msg 只为展开引用。
    expect(h.getMsgCalls()).toHaveLength(1)
    expect(h.dispatchFollowup).toHaveBeenCalledTimes(1)
  })

  it('keeps groups without requireMention free of quote-author verification', async () => {
    const h = makeHarness({ config: { requireMention: false } })
    await runWithTrace(h.trace, () => h.pipeline.processInbound(inbound([reply('123'), body])))
    expect(h.getMsgCalls()).toHaveLength(1)
    expect(h.dispatchFollowup).toHaveBeenCalledTimes(1)
  })

  it('falls back to the configured botQQ when the learned self id is absent', async () => {
    const h = makeHarness({ author: BOT, selfId: '' })
    await runWithTrace(h.trace, () => h.pipeline.processInbound(inbound([reply('123'), body])))
    expect(h.dispatchFollowup).toHaveBeenCalledTimes(1)
  })

  it('deduplicates before the author lookup and the dispatch', async () => {
    const h = makeHarness({ author: BOT })
    const message = inbound([reply('123'), body])
    await runWithTrace(h.trace, () => h.pipeline.processInbound(message))
    await runWithTrace(h.trace, () => h.pipeline.processInbound(message))
    expect(h.getMsgCalls()).toHaveLength(1)
    expect(h.dispatchFollowup).toHaveBeenCalledTimes(1)
  })

  it('hands a verified reply to the busy-turn policy instead of dispatching', async () => {
    const h = makeHarness({ author: BOT, busy: true })
    await runWithTrace(h.trace, () => h.pipeline.processInbound(inbound([reply('123'), body])))
    expect(h.interceptBusyTurn).toHaveBeenCalledTimes(1)
    expect(h.dispatchFollowup).not.toHaveBeenCalled()
  })
})
