/**
 * qq_send_poke / qq_end_turn 工具：群聊走 group_poke、私聊走 friend_poke；
 * 戳完可带 end 立即收尾，或直接用 qq_end_turn 结束回合。
 *
 * 私聊省略 user_id 时取当前对端；群聊省略时报错。装配用真实 ChatBridge +
 * 记录型连接桩，不触网。
 * @module dsh-onebot/tests/poke
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'

import { ChatBridge } from '../src/bridge/index.js'
import { registerTools } from '../src/tools/index.js'

interface ToolLike {
  name: string
  execute: (args: unknown, exec: unknown) => Promise<unknown>
}

/** 注册 qq_* 工具并装配真实 ChatBridge（连接是记录型桩）。 */
function makeHarness() {
  const calls: Array<{ action: string; params: Record<string, unknown> }> = []
  const connection = {
    call: async (action: string, params: Record<string, unknown>) => {
      calls.push({ action, params })
      return {}
    },
  }
  const ctx = new Context()
  const tools: ToolLike[] = []
  ctx.provide('tools' as never, {
    register: (tool: ToolLike) => {
      tools.push(tool)
      return () => undefined
    },
  } as never)

  const bridge = new ChatBridge({
    ctx,
    connection: connection as never,
    media: {} as never,
    transcriber: {} as never,
    agents: {} as never,
    sessions: {} as never,
    agentPresets: undefined,
    sessionPersistence: undefined,
    workspaceRegistry: undefined,
    agentDefaultModel: undefined,
    defaultModel: undefined,
    config: {
      botQQ: '10002', ignoreSelf: false, requireMention: true,
      sendErrorNotice: true, restrictedMemberPrefix: false,
      mediaDir: '/tmp', maxImageBytes: 8 * 1024 * 1024,
      maxVoiceBytes: 15 * 1024 * 1024, maxFileBytes: 20 * 1024 * 1024,
      agentPreset: 'standard', workspacePath: '', maxInboundFileBytes: 0,
    },
    policy: {
      dmPolicy: 'open', groupPolicy: 'open', allowFrom: [], groupAllowFrom: [],
      adminUsers: ['10001'], allowAllUsers: false, requireMention: true,
    },
    log: () => undefined,
  })

  /** 种一个会话映射：session → chat（resolveChat 的默认目标）。 */
  const seed = (chatId: string, sessionId: string): void => {
    ;(bridge as unknown as { chats: Map<string, Record<string, unknown>> }).chats.set(chatId, { sessionId })
    ;(bridge as unknown as { bySession: Map<string, string> }).bySession.set(sessionId, chatId)
  }

  registerTools(ctx, bridge, connection as never, {
    maxImageBytes: 1_000_000,
    maxVoiceBytes: 1_000_000,
    maxFileBytes: 1_000_000,
  })
  const tool = (name: string): ToolLike => {
    const found = tools.find(candidate => candidate.name === name)
    if (found === undefined) throw new Error('tool not registered: ' + name)
    return found
  }
  const exec = (sessionId: string) => ({ agent: { session: { id: sessionId } } })

  return { calls, seed, tool, exec }
}

describe('qq_send_poke / qq_end_turn', () => {
  it('群聊：显式 user_id 走 group_poke，带群号与目标 QQ', async () => {
    const h = makeHarness()
    h.seed('group:20001', 'sess-group')
    const result = await h.tool('qq_send_poke').execute({ user_id: '10001' }, h.exec('sess-group'))
    expect(result).toEqual({ poked: '10001', chatId: 'group:20001' })
    expect(h.calls).toEqual([{ action: 'group_poke', params: { group_id: 20001, user_id: 10001 } }])
  })

  it('私聊：省略 user_id 时戳当前对端，走 friend_poke', async () => {
    const h = makeHarness()
    h.seed('private:10001', 'sess-private')
    const result = await h.tool('qq_send_poke').execute({}, h.exec('sess-private'))
    expect(result).toEqual({ poked: '10001', chatId: 'private:10001' })
    expect(h.calls).toEqual([{ action: 'friend_poke', params: { user_id: 10001 } }])
  })

  it('群聊省略 user_id 时拒绝，不发请求', async () => {
    const h = makeHarness()
    h.seed('group:20001', 'sess-group')
    await expect(h.tool('qq_send_poke').execute({}, h.exec('sess-group'))).rejects.toThrow(/群聊必须给 user_id/)
    expect(h.calls).toHaveLength(0)
  })

  it('user_id 非 QQ 号时拒绝', async () => {
    const h = makeHarness()
    h.seed('private:10001', 'sess-private')
    await expect(h.tool('qq_send_poke').execute({ user_id: 'abc' }, h.exec('sess-private')))
      .rejects.toThrow(/必须是 QQ 号/)
    expect(h.calls).toHaveLength(0)
  })

  it('白名单放行 group_poke / friend_poke', async () => {
    const h = makeHarness()
    h.seed('group:20001', 'sess-group')
    await h.tool('qq_napcat_api').execute({ action: 'group_poke', params: { group_id: 20001, user_id: 10001 } }, {})
    await h.tool('qq_napcat_api').execute({ action: 'friend_poke', params: { user_id: 10001 } }, {})
    expect(h.calls.map(call => call.action)).toEqual(['group_poke', 'friend_poke'])
  })

  it('end: true 在戳完之后立即结束回合', async () => {
    const h = makeHarness()
    h.seed('private:10001', 'sess-private')
    let ended = 0
    await h.tool('qq_send_poke').execute({ end: true }, {
      agent: { session: { id: 'sess-private' } },
      concludeTurn: () => { ended += 1 },
    })
    expect(ended).toBe(1)
    expect(h.calls).toEqual([{ action: 'friend_poke', params: { user_id: 10001 } }])
  })

  it('qq_end_turn 直接结束回合，不发任何请求', async () => {
    const h = makeHarness()
    h.seed('private:10001', 'sess-private')
    let ended = 0
    const result = await h.tool('qq_end_turn').execute({}, {
      agent: { session: { id: 'sess-private' } },
      concludeTurn: () => { ended += 1 },
    })
    expect(result).toEqual({ ended: true })
    expect(ended).toBe(1)
    expect(h.calls).toHaveLength(0)
  })
})
