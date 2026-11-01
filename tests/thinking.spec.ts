/**
 * qq_thinking（思考强度）工具测试。
 *
 * 覆盖三条读取/写入路径：
 *   ① get：在线会话读 agent.model.current()，离线会话回落到部署默认选择；
 *   ② set scope=chat：只改写 reasoningEffort，模型另一半保持不变；
 *   ③ set scope=default：管理员回合写部署默认存储，成员回合拒绝。
 * 装配用真实 ChatBridge + 最小 model 替身（记录 select 收到的选择对象），
 * 连接是记录型桩，不触网。
 * @module dsh-onebot/tests/thinking
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'

import { ChatBridge } from '../src/bridge/index.js'
import { registerTools } from '../src/tools/index.js'

interface ToolLike {
  name: string
  execute: (args: unknown, exec: unknown) => Promise<unknown>
}

interface Selection {
  provider: string
  model: string
  reasoningEffort?: string
}

/** 注册 qq_* 工具并装配真实 ChatBridge（agent/model/默认模型存储均为替身）。 */
async function makeHarness(opts?: { deployment?: Selection }) {
  const ctx = new Context()
  const tools: ToolLike[] = []
  ctx.provide('tools' as never, {
    register: (tool: ToolLike) => {
      tools.push(tool)
      return () => undefined
    },
  } as never)

  /** 每个会话的 model 替身：current 返回活值，select 记录完整选择对象。 */
  const makeModel = (initial: Selection) => {
    const live: Selection = { ...initial }
    const selections: Selection[] = []
    return {
      current: (): Selection => live,
      select: (next: Selection) => {
        selections.push({ ...next })
        Object.assign(live, next)
      },
      selections,
      live,
    }
  }

  const models = {
    admin: makeModel({ provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' }),
    member: makeModel({ provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' }),
  }
  const savedDefaults: Selection[] = []
  const defaultModelStore = {
    currentSelection: () => opts?.deployment,
    saveSelection: async (next: Selection) => {
      savedDefaults.push({ ...next })
    },
  }

  const bridge = new ChatBridge({
    ctx,
    connection: { call: async () => ({}) } as never,
    media: {} as never,
    transcriber: {} as never,
    agents: {} as never,
    sessions: {} as never,
    agentPresets: undefined,
    sessionPersistence: undefined,
    workspaceRegistry: undefined,
    agentDefaultModel: defaultModelStore,
    defaultModel: () => opts?.deployment,
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

  /** 种一个在线会话：会话 id → chat 映射 + 回合角色（canEditFiles 判定来源）。 */
  const seed = (role: 'admin' | 'member'): string => {
    const chatId = 'group:' + (role === 'admin' ? '20001' : '20002')
    const sessionId = 'sess-' + role
    ;(bridge as unknown as { chats: Map<string, Record<string, unknown>> }).chats.set(chatId, {
      sessionId,
      activeTurnRole: role,
      agent: { session: { id: sessionId }, model: models[role] },
    })
    ;(bridge as unknown as { bySession: Map<string, string> }).bySession.set(sessionId, chatId)
    return chatId
  }

  registerTools(ctx, bridge, {} as never, {
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

  return { bridge, tool, exec, models, savedDefaults, seed }
}

describe('qq_thinking（思考强度）', () => {
  it('get：在线会话读 agent.model.current()，报出等级与模型路由', async () => {
    const h = await makeHarness()
    const chatId = h.seed('admin')
    const result = await h.tool('qq_thinking').execute({ action: 'get', chat_id: chatId }, h.exec('sess-admin')) as Record<string, unknown>
    expect(result.level).toBe('high')
    expect(result.provider).toBe('deepseek')
    expect(result.model).toBe('deepseek-chat')
    expect(result.levels).toEqual(['off', 'low', 'high', 'max'])
    expect(result.summary).toContain('high')
  })

  it('get：无在线会话回落到部署默认选择；部署未配置时报 default', async () => {
    const h = await makeHarness()
    const offline = await h.tool('qq_thinking').execute({ action: 'get', chat_id: 'private:99999' }, {}) as Record<string, unknown>
    expect(offline.level).toBe('default')
    expect(offline.summary).toContain('没有默认模型')

    const withDefault = await makeHarness({ deployment: { provider: 'deepseek', model: 'deepseek-reasoner' } })
    const viaDefault = await withDefault.tool('qq_thinking').execute({ action: 'get', chat_id: 'private:99999' }, {}) as Record<string, unknown>
    expect(viaDefault.level).toBe('default')
    expect(viaDefault.model).toBe('deepseek-reasoner')
  })

  it('set scope=chat：只改写 reasoningEffort，select 收到完整选择对象', async () => {
    const h = await makeHarness()
    const chatId = h.seed('admin')
    await h.tool('qq_thinking').execute({ action: 'set', level: 'max', chat_id: chatId }, h.exec('sess-admin'))
    expect(h.models.admin.selections).toEqual([{ provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'max' }])
    const readBack = await h.tool('qq_thinking').execute({ action: 'get', chat_id: chatId }, h.exec('sess-admin')) as Record<string, unknown>
    expect(readBack.level).toBe('max')
  })

  it('set scope=chat level=default：移除 reasoningEffort（跟随部署默认）', async () => {
    const h = await makeHarness()
    const chatId = h.seed('member')
    await h.tool('qq_thinking').execute({ action: 'set', level: 'default', chat_id: chatId }, h.exec('sess-member'))
    expect(h.models.member.selections).toEqual([{ provider: 'deepseek', model: 'deepseek-chat' }])
  })

  it('set scope=default：管理员回合写部署默认存储，成员回合拒绝', async () => {
    const h = await makeHarness({ deployment: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' } })
    const adminChat = h.seed('admin')
    const memberChat = h.seed('member')

    const written = await h.tool('qq_thinking').execute({ action: 'set', level: 'low', scope: 'default', chat_id: adminChat }, h.exec('sess-admin')) as Record<string, unknown>
    expect(h.savedDefaults).toEqual([{ provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'low' }])
    expect(written.level).toBe('low')

    await expect(h.tool('qq_thinking').execute({ action: 'set', level: 'off', scope: 'default', chat_id: memberChat }, h.exec('sess-member')))
      .rejects.toThrow(/只有管理员回合能改部署默认思考强度/)
    expect(h.savedDefaults).toHaveLength(1)
  })

  it('非法 action / 缺 level 直接拒绝（不写任何选择）', async () => {
    const h = await makeHarness()
    const chatId = h.seed('admin')
    await expect(h.tool('qq_thinking').execute({ action: 'toggle', chat_id: chatId }, h.exec('sess-admin')))
      .rejects.toThrow(/action.*must be one of/)
    await expect(h.tool('qq_thinking').execute({ action: 'set', chat_id: chatId }, h.exec('sess-admin')))
      .rejects.toThrow(/set 需要 level/)
    expect(h.models.admin.selections).toHaveLength(0)
  })
})
