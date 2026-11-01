/**
 * Shared bridge test harnesses (M2-T0 migration map §1): the fake agent
 * registry, the full reverse-WS harness, the compact command harness, and
 * the M1-B6 disconnect/reconnect helpers. Extracted from bridge.spec.ts so
 * the split target specs (commands/inbound/outbound/registry) can reuse the
 * same stubs.
 * @module dsh-onebot/tests/helpers/bridge-harness
 */
import { expect, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import WebSocket from 'ws'

import { OneBotConnection } from '../../src/onebot/connection.js'
import { ChatBridge } from '../../src/bridge/index.js'
import { MediaStore } from '../../src/media/store.js'
import { Transcriber } from '../../src/media/stt.js'
import { TraceSink } from '../../src/ops/trace.js'
import { InboundRecorder } from '../../src/ops/record.js'
import { InjectChannel } from '../../src/inbound/inject.js'

/** dsh 0.2.2 host-faithful Agent.model stub: current() returns the last
 * recorded selection, else the agentOptions fallback (provider/model), else
 * undefined; select() records the selection — mirroring the durable
 * model/selection event the host's AgentModel appends. Selections keep every
 * field the bridge wrote (reasoningEffort included) so qq_thinking assertions
 * can read back the full selection object. */
function makeFakeModel(agentOptions?: { provider?: string; model?: string }) {
  type Selection = { provider: string; model: string; reasoningEffort?: string }
  const selections: Selection[] = []
  return {
    current: (): Selection | undefined => selections[selections.length - 1]
      ?? (agentOptions?.provider !== undefined && agentOptions?.model !== undefined
        ? { provider: agentOptions.provider, model: agentOptions.model }
        : undefined),
    select: (next: Selection) => { selections.push({ ...next }) },
    selections,
  }
}

/** A fake agent handle for the bridge. */
export function makeFakeAgents(
  sessionIds: string[],
  captured: {
    followups: Array<{ text: string; sessionId: string }>
    steers?: Array<{ text: string; sessionId: string }>
    createdMeta?: Array<{ cwd?: string; agentPreset?: string }>
    channelTools?: string[]
    channelSections?: string[]
    /** 注册到会话作用域的技能名。 */
    channelSkills?: string[]
    /** 注册到会话作用域的工具定义（测试可像模型一样调用它们发言）。 */
    tools?: Array<{ name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }>
  },
  opts?: { failCreateFor?: string; resumeOk?: boolean; createDelayMs?: number },
) {
  const disposed: string[] = []
  const agents = {
    create: vi.fn(async (options: { sessionId: string; meta?: { cwd?: string; agentPreset?: string }; agentOptions?: { provider?: string; model?: string }; setup?: (agentCtx: unknown) => unknown }) => {
      if (opts?.createDelayMs !== undefined) await new Promise(resolve => setTimeout(resolve, opts.createDelayMs))
      const sessionId = String(options.sessionId)
      sessionIds.push(sessionId)
      captured.createdMeta?.push({ ...options.meta })
      if (opts?.failCreateFor !== undefined && sessionId === opts.failCreateFor) {
        throw new Error('session "' + sessionId + '" already has a persisted log on disk that does not match this live session (id collision)')
      }
      const agent = {
        session: { id: sessionId, seq: 0, header: { cwd: options.meta?.cwd ?? process.cwd() } },
        status: 'idle',
        model: makeFakeModel(options.agentOptions),
        cancel: () => { agent.status = 'idle' },
        followup: (message: { content: Array<{ type: string; text?: string }> }) => {
          const text = message.content.map(b => b.text ?? '').join('')
          captured.followups.push({ text, sessionId })
        },
        // M3-D4c: the transcript steer path (raw text capture).
        steer: (message: { content: Array<{ type: string; text?: string }> }) => {
          captured.steers?.push({ text: message.content.map(b => b.text ?? '').join(''), sessionId })
        },
        whenIdle: async () => undefined,
      }
      if (typeof options.setup === 'function') {
        // Agent setup receives the agent's own scope: platform prompt section
        // + qq_* tools must register here (installChannelScope), never on the
        // plugin context.
        const agentCtx = {
          on: () => () => undefined,
          systemPrompt: { section: (s: { name: string }) => { captured.channelSections?.push(s.name); return () => undefined } },
          skills: {
            register: (s: { name: string }) => {
              captured.channelSkills?.push(s.name)
              return () => undefined
            },
          },
          tools: {
            register: (t: { name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }) => {
              captured.channelTools?.push(t.name)
              captured.tools?.push(t)
              return () => undefined
            },
          },
        }
        await options.setup(agentCtx)
      }
      return { agent, dispose: vi.fn(async () => { disposed.push(sessionId) }) }
    }),
    disposed,
    resume: vi.fn(async (options: { resumeSessionId: string; agentOptions?: { provider?: string; model?: string }; setup?: (agentCtx: unknown) => unknown }) => {
      if (opts?.resumeOk !== true) throw new Error('not persisted')
      const sessionId = String(options.resumeSessionId)
      sessionIds.push(sessionId)
      const agent = {
        session: { id: sessionId, seq: 1, header: { cwd: process.cwd() } },
        status: 'idle',
        model: makeFakeModel(options.agentOptions),
        cancel: () => { agent.status = 'idle' },
        followup: (message: { content: Array<{ type: string; text?: string }> }) => {
          const text = message.content.map(b => b.text ?? '').join('')
          captured.followups.push({ text, sessionId })
        },
        steer: (message: { content: Array<{ type: string; text?: string }> }) => {
          captured.steers?.push({ text: message.content.map(b => b.text ?? '').join(''), sessionId })
        },
        whenIdle: async () => undefined,
      }
      if (typeof options.setup === 'function') {
        await options.setup({
          on: () => () => undefined,
          systemPrompt: { section: () => () => undefined },
          skills: { register: () => () => undefined },
          tools: { register: () => () => undefined },
        })
      }
      return { agent, dispose: async () => undefined }
    }),
  }
  return agents
}

/** Full bridge + WS harness: inbound via real WebSocket, outbound captured. */
export async function makeHarness(opts?: { failCreateFor?: string; mediaDir?: string; maxImageBytes?: number; resumeOk?: boolean; createDelayMs?: number; transcriber?: Transcriber; trace?: TraceSink; ignoreSelf?: boolean; recorder?: InboundRecorder; inject?: InjectChannel; steerEnabled?: boolean; steerAllMembers?: boolean; steerAllowRestricted?: boolean; steerNotice?: boolean; log?: (level: string, message: string) => void }) {
  const ctx = new Context()
  const sessionIds: string[] = []
  const captured = {
    followups: [] as Array<{ text: string; sessionId: string }>,
    steers: [] as Array<{ text: string; sessionId: string }>,
    channelTools: [] as string[],
    channelSections: [] as string[],
    channelSkills: [] as string[],
    tools: [] as Array<{ name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }>,
  }
  const agents = makeFakeAgents(sessionIds, captured, opts)
  const sessions = { flush: vi.fn(async () => undefined) }
  const mediaDir = opts?.mediaDir ?? mkdtempSync(join(tmpdir(), 'onebot-test-'))
  const connection = new OneBotConnection({
    mode: 'reverse', host: '127.0.0.1', port: 0, url: 'ws://127.0.0.1:3001', accessToken: 'test-token', callTimeoutMs: 3_000,
  })
  const bridge = new ChatBridge({
    ctx,
    connection,
    media: new MediaStore(join(mediaDir, 'media'), 6),
    transcriber: opts?.transcriber ?? new Transcriber({ enabled: false, engine: 'auto', command: '', args: [], model: 'small', timeoutMs: 10_000 }),
    agents: agents as never,
    sessions: sessions as never,
    agentPresets: undefined as never,
    workspaceRegistry: undefined as never,
    defaultModel: undefined,
    config: {
      botQQ: '10002', ignoreSelf: opts?.ignoreSelf ?? false, requireMention: true,
      sendErrorNotice: true, restrictedMemberPrefix: false,
      outboundIntervalBaseMs: 0, outboundIntervalPerCharMs: 0, outboundIntervalJitterPct: 0,
      mediaDir, maxImageBytes: opts?.maxImageBytes ?? 8 * 1024 * 1024,
      maxVoiceBytes: 15 * 1024 * 1024, maxFileBytes: 20 * 1024 * 1024,
      agentPreset: 'standard', workspacePath: mediaDir,
      // 插话四开关（缺省 = 不插话、仅管理员、受限成员放行、插话回执开）。
      ...(opts?.steerEnabled !== undefined ? { steerEnabled: opts.steerEnabled } : {}),
      ...(opts?.steerAllMembers !== undefined ? { steerAllMembers: opts.steerAllMembers } : {}),
      ...(opts?.steerAllowRestricted !== undefined ? { steerAllowRestricted: opts.steerAllowRestricted } : {}),
      ...(opts?.steerNotice !== undefined ? { steerNotice: opts.steerNotice } : {}),
      // W1: optional decision-trace sink (absent = tracing off).
      trace: opts?.trace,
      // W1/T5: optional recorder / inject channel (absent = feature off).
      recorder: opts?.recorder,
      inject: opts?.inject,
    },
    policy: {
      dmPolicy: 'open', groupPolicy: 'open', allowFrom: [], groupAllowFrom: [],
      adminUsers: ['10001'], allowAllUsers: false, requireMention: true,
    },
    log: (level: string, message: string) => opts?.log?.(level, message),
  })
  connection.onEvent = event => {
    void bridge.handleInbound(event)
  }
  // 入站窗口会向 NapCat 拉群历史与群成员表：测试里没有真实的 OneBot 服务端，
  // 用空结果作答，等价于「只有触发消息、没有可补的 @ 名字」。
  const realCall = connection.call.bind(connection)
  connection.call = (async (action: string, params: Record<string, unknown>) => {
    if (action === 'get_group_msg_history') return { messages: [] }
    if (action === 'get_group_member_list') return []
    return await realCall(action, params)
  }) as never
  bridge.start()
  connection.start()
  await vi.waitFor(() => expect(connection.address()).toBeDefined())
  const address = connection.address()!
  const client = new WebSocket('ws://127.0.0.1:' + address.port + '/ws', { headers: { Authorization: 'Bearer test-token' } })
  await vi.waitFor(() => expect(client.readyState).toBe(WebSocket.OPEN))
  const outbound: Array<Record<string, unknown>> = []
  client.on('message', data => {
    const frame = JSON.parse(data.toString()) as Record<string, unknown>
    outbound.push(frame)
    if (typeof frame.echo === 'string') {
      client.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 7 }, echo: frame.echo }))
    }
  })
  const sendText = (text: string): void => {
    client.send(JSON.stringify({
      post_type: 'message', message_type: 'private', user_id: 10001, self_id: 10002,
      message: [{ type: 'text', data: { text } }], raw_message: text,
      sender: { user_id: 10001, nickname: '小明' },
    }))
  }
  /** 像模型一样发言：调用会话作用域里的 qq_send_message（回合最终文本不会自动发送）。 */
  const say = (text: string, extra: Record<string, unknown> = {}): Promise<unknown> => {
    const tool = captured.tools.find(item => item.name === 'qq_send_message')
    if (tool === undefined) throw new Error('qq_send_message 未注册')
    return tool.execute({ text, ...extra }, {
      agent: { session: { id: sessionIds[0] } },
      concludeTurn: () => undefined,
    })
  }
  return { ctx, sessionIds, captured, sessions, mediaDir, connection, bridge, client, outbound, sendText, say }
}

export function makeEvent(type: string, data: unknown): SessionEvent {
  return { seq: 0, time: Date.now(), type: type as never, data: data as never } as SessionEvent
}

/** Compact harness for the slash-command tests (options inject stubs). */
export async function makeCmdHarness(opts?: {
  agentPresets?: unknown
  dshHome?: string
  ocrResult?: unknown
  restrictedMemberPrefix?: boolean
  steerEnabled?: boolean
  /** 插话资格：true = 所有成员，false/缺省 = 仅管理员。 */
  steerAllMembers?: boolean
  /** 受限成员插话：false = 一律排队，true/缺省 = 放行。 */
  steerAllowRestricted?: boolean
  /** 插话成功回执：false = 静默，true/缺省 = 回一句提示。 */
  steerNotice?: boolean
  /** T3 (P2): media dir override（重启恢复测试复用同一目录的注册表/映射文件）。 */
  mediaDir?: string
  commands?: unknown
  allowAllUsers?: boolean
  agentDefaultModel?: unknown
  workspaceRegistry?: unknown
  /** /session list previews: a SessionPersistenceLike stub (stat probe +
   * open read handles). Absent = the bridge sees no persistence service and
   * the list renders preview-less items. */
  sessionPersistence?: unknown
  /** T4 (P3): optional trace sink (absent = tracing off). */
  trace?: TraceSink
  /** T4 (P3): optional log capture for reference-number assertions. */
  log?: (level: string, message: string) => void
}) {
  const ctx = new Context()
  const sessionIds: string[] = []
  const capturedMeta: Array<{ cwd?: string; agentPreset?: string }> = []
  // T2 (P1): steers are captured alongside followups so the /steer and
  // 'steer'-policy tests can assert the exact steered text.
  const captured = {
    followups: [] as Array<{ text: string; sessionId: string }>,
    steers: [] as Array<{ text: string; sessionId: string }>,
    createdMeta: capturedMeta,
    tools: [] as Array<{ name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }>,
  }
  const agents = makeFakeAgents(sessionIds, captured)
  const sessions = { flush: vi.fn(async () => undefined) }
  const mediaDir = opts?.mediaDir ?? mkdtempSync(join(tmpdir(), 'onebot-test-'))
  const connection = new OneBotConnection({
    mode: 'reverse', host: '127.0.0.1', port: 0, url: 'ws://127.0.0.1:3001', accessToken: 'test-token', callTimeoutMs: 3_000,
  })
  const bridge = new ChatBridge({
    ctx,
    connection,
    dshHome: opts?.dshHome,
    media: new MediaStore(join(mediaDir, 'media'), 6),
    transcriber: new Transcriber({ enabled: false, engine: 'auto', command: '', args: [], model: 'small', timeoutMs: 10_000 }),
    agents: agents as never,
    sessions: sessions as never,
    agentPresets: opts?.agentPresets as never,
    commands: (opts?.commands ?? {
      execute: vi.fn(async (_agent: unknown, _line: string, attachments: readonly unknown[], signal: AbortSignal | undefined) => {
        // Mirror the host: execute() reads submittedAttachments.length and
        // signal.aborted unconditionally.
        if (!Array.isArray(attachments)) throw new Error("Cannot read properties of undefined (reading 'length')")
        if (signal === undefined) throw new Error("Cannot read properties of undefined (reading 'aborted')")
        return { commandId: 'cmd-test', result: { kind: 'success', text: 'Plan mode on. Use /plan off to leave.' } }
      }),
    }) as never,
    sessionPersistence: (opts?.sessionPersistence ?? undefined) as never,
    workspaceRegistry: (opts?.workspaceRegistry ?? undefined) as never,
    agentDefaultModel: (opts?.agentDefaultModel ?? undefined) as never,
    defaultModel: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    config: {
      botQQ: '10002', ignoreSelf: false, requireMention: true,
      outboundIntervalBaseMs: 0, outboundIntervalPerCharMs: 0, outboundIntervalJitterPct: 0,
      sendErrorNotice: true,
      ...(opts?.restrictedMemberPrefix !== undefined ? { restrictedMemberPrefix: opts.restrictedMemberPrefix } : {}),
      ...(opts?.steerEnabled !== undefined ? { steerEnabled: opts.steerEnabled } : {}),
      ...(opts?.steerAllMembers !== undefined ? { steerAllMembers: opts.steerAllMembers } : {}),
      ...(opts?.steerAllowRestricted !== undefined ? { steerAllowRestricted: opts.steerAllowRestricted } : {}),
      ...(opts?.steerNotice !== undefined ? { steerNotice: opts.steerNotice } : {}),
      mediaDir, maxImageBytes: 8 * 1024 * 1024,
      maxVoiceBytes: 15 * 1024 * 1024, maxFileBytes: 20 * 1024 * 1024,
      agentPreset: 'standard', workspacePath: mediaDir,
      ...(opts?.trace !== undefined ? { trace: opts.trace } : {}),
    },
    policy: {
      dmPolicy: 'open', groupPolicy: 'open', allowFrom: [], groupAllowFrom: [],
      adminUsers: ['10001'], allowAllUsers: opts?.allowAllUsers ?? false, requireMention: true,
    },
    log: (level: string, message: string) => opts?.log?.(level, message),
  })
  if (opts?.ocrResult !== undefined) {
    const real = connection.call.bind(connection)
    connection.call = (async (action: string, params: unknown) => {
      if (action === 'ocr_image') return opts.ocrResult
      return await real(action, params)
    }) as never
  }
  connection.onEvent = event => { void bridge.handleInbound(event) }
  // 群历史窗口与成员表在测试里没有真实服务端：空结果 = 只注入触发消息。
  const realCall = connection.call.bind(connection)
  connection.call = (async (action: string, params: Record<string, unknown>) => {
    if (action === 'get_group_msg_history') return { messages: [] }
    if (action === 'get_group_member_list') return []
    return await realCall(action, params)
  }) as never
  bridge.start()
  connection.start()
  await vi.waitFor(() => expect(connection.address()).toBeDefined())
  const address = connection.address()!
  const client = new WebSocket('ws://127.0.0.1:' + address.port + '/ws', { headers: { Authorization: 'Bearer test-token' } })
  await vi.waitFor(() => expect(client.readyState).toBe(WebSocket.OPEN))
  const outbound: Array<Record<string, unknown>> = []
  client.on('message', data => {
    const frame = JSON.parse(data.toString()) as Record<string, unknown>
    outbound.push(frame)
    if (typeof frame.echo === 'string') {
      client.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 7 }, echo: frame.echo }))
    }
  })
  const sendText = (text: string): void => {
    client.send(JSON.stringify({
      post_type: 'message', message_type: 'private', user_id: 10001, self_id: 10002,
      message: [{ type: 'text', data: { text } }], raw_message: text,
      sender: { user_id: 10001, nickname: '小明' },
    }))
  }
  // Variant senders for the M1-A2 turn-role tests (non-default users / group).
  const sendTextAs = (text: string, userId: number): void => {
    client.send(JSON.stringify({
      post_type: 'message', message_type: 'private', user_id: userId, self_id: 10002,
      message: [{ type: 'text', data: { text } }], raw_message: text,
      sender: { user_id: userId, nickname: '用户' + userId },
    }))
  }
  const sendGroupTextAs = (text: string, userId: number): void => {
    client.send(JSON.stringify({
      post_type: 'message', message_type: 'group', user_id: userId, group_id: 888, self_id: 10002,
      message: [
        { type: 'at', data: { qq: '10002' } },
        { type: 'text', data: { text } },
      ],
      raw_message: '[CQ:at,qq=10002]' + text,
      sender: { user_id: userId, nickname: '用户' + userId },
    }))
  }
  const chats = () => (bridge as unknown as {
    chats: Map<string, { agent: { session: { id: string }; status: string }, lastFollowup: string | undefined, busy: boolean }>
  }).chats
  /** 像模型一样发言：调用会话作用域里的 qq_send_message。 */
  const say = (text: string, extra: Record<string, unknown> = {}): Promise<unknown> => {
    const tool = captured.tools.find(item => item.name === 'qq_send_message')
    if (tool === undefined) throw new Error('qq_send_message 未注册')
    return tool.execute({ text, ...extra }, {
      agent: { session: { id: sessionIds[0] } },
      concludeTurn: () => undefined,
    })
  }
  return { ctx, sessionIds, capturedMeta, captured, sessions, mediaDir, connection, bridge, client, outbound, sendText, sendTextAs, sendGroupTextAs, chats, say }
}

/** Close the harness client and wait until the bridge sees the disconnect. */
export async function disconnect(h: Awaited<ReturnType<typeof makeHarness>>): Promise<void> {
  h.client.close()
  await vi.waitFor(() => expect(h.connection.connected).toBe(false))
}

/** Reconnect a fresh WS client with the echo responder; returns its own captured outbound. */
export async function reconnect(h: Awaited<ReturnType<typeof makeHarness>>): Promise<{ client: WebSocket; outbound: Array<Record<string, unknown>> }> {
  const client = new WebSocket('ws://127.0.0.1:' + h.connection.address()!.port + '/ws', { headers: { Authorization: 'Bearer test-token' } })
  const outbound: Array<Record<string, unknown>> = []
  client.on('message', data => {
    const frame = JSON.parse(data.toString()) as Record<string, unknown>
    outbound.push(frame)
    if (typeof frame.echo === 'string') {
      client.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 7 }, echo: frame.echo }))
    }
  })
  await vi.waitFor(() => expect(client.readyState).toBe(WebSocket.OPEN))
  return { client, outbound }
}

export const inboundAndDisconnect = async (h: Awaited<ReturnType<typeof makeHarness>>): Promise<{ id: string }> => {
  h.sendText('hi')
  await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
  const session = { id: h.sessionIds[0] }
  await disconnect(h)
  return session
}

export const sentTexts = (outbound: Array<Record<string, unknown>>): string[] =>
  outbound.filter(f => f.action === 'send_msg').map(f => JSON.stringify(f.params))
