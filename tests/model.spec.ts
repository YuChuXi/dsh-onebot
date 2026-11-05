/**
 * qq_model（查看/切换模型与思考强度）工具测试。
 *
 * 覆盖四条路径：
 *   ① get：在线会话读 agent.model.current()，并报出配置里为该 chat 指定的模型；
 *   ② set provider+model：只切换当前会话（仅管理员回合）；
 *   ③ set level：只改思考强度，保留既有 provider/model；
 *   ④ set scope=default：管理员写部署默认选择。
 * 装配用真实 ChatBridge + 最小 model 替身（记录 select 收到的选择对象），
 * 连接是记录型桩，不触网。
 * @module dsh-onebot/tests/model
 */
import { describe, expect, it } from 'vitest'
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
async function makeHarness(opts?: {
  deployment?: Selection
  modelPrivate?: Selection
  modelGroup?: Selection
  thinkingPrivate?: 'off' | 'low' | 'high' | 'max' | 'default'
  thinkingGroup?: 'off' | 'low' | 'high' | 'max' | 'default'
  /** 该路由支持的思考强度；默认四种常见档位。 */
  efforts?: readonly string[]
}) {
  const ctx = new Context()
  const tools: ToolLike[] = []
  ctx.provide('tools' as never, {
    register: (tool: ToolLike) => {
      tools.push(tool)
      return () => undefined
    },
  } as never)

  /** 每个会话的 model 替身：current 返回活值，select 记录完整选择对象。 */
  const makeModel = (initial?: Selection) => {
    const live: Selection | undefined = initial === undefined ? undefined : { ...initial }
    const selections: Selection[] = []
    return {
      current: (): Selection | undefined => live,
      select: (next: Selection) => {
        selections.push({ ...next })
        if (live === undefined) return
        live.reasoningEffort = next.reasoningEffort
        live.provider = next.provider
        live.model = next.model
      },
      selections,
      live,
    }
  }

  const models = {
    admin: makeModel({ provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' }),
    member: makeModel({ provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' }),
    offline: makeModel(),
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
    llmCatalog: {
      listProviders: () => [],
      listModels: async () => [],
      resolveReasoningEfforts: async () => opts?.efforts ?? ['off', 'low', 'high', 'max'],
    },
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
      ...(opts?.modelPrivate !== undefined ? { modelPrivate: opts.modelPrivate } : {}),
      ...(opts?.modelGroup !== undefined ? { modelGroup: opts.modelGroup } : {}),
      ...(opts?.thinkingPrivate !== undefined ? { thinkingPrivate: opts.thinkingPrivate } : {}),
      ...(opts?.thinkingGroup !== undefined ? { thinkingGroup: opts.thinkingGroup } : {}),
    },
    policy: {
      dmPolicy: 'open', groupPolicy: 'open', allowFrom: [], groupAllowFrom: [],
      adminUsers: ['10001'], allowAllUsers: false, requireMention: true,
    },
    log: () => undefined,
  })

  /** 种一个在线会话：会话 id → chat 映射 + 回合角色（canEditFiles 判定来源）。 */
  const seed = (role: 'admin' | 'member' | 'offline'): string => {
    const chatId = role === 'offline' ? 'private:90001' : 'group:' + (role === 'admin' ? '20001' : '20002')
    const sessionId = 'sess-' + role
    ;(bridge as unknown as { chats: Map<string, Record<string, unknown>> }).chats.set(chatId, {
      sessionId,
      activeTurnRole: role === 'admin' ? 'admin' : 'member',
      agent: { session: { id: sessionId }, model: models[role] },
    })
    ;(bridge as unknown as { bySession: Map<string, string> }).bySession.set(sessionId, chatId)
    return chatId
  }

  registerTools(ctx, bridge, {} as never, {
    maxImageBytes: 1_000_000,
    maxVoiceBytes: 1_000_000,
    maxFileBytes: 1_000_000,
  }, '/tmp')
  const tool = (name: string): ToolLike => {
    const found = tools.find(candidate => candidate.name === name)
    if (found === undefined) throw new Error('tool not registered: ' + name)
    return found
  }
  const exec = (sessionId: string) => ({ agent: { session: { id: sessionId } } })

  return { bridge, tool, exec, models, savedDefaults, seed }
}

describe('qq_model（查看/切换模型与思考强度）', () => {
  it('get：在线会话读 agent.model.current()，报出路由、等级与配置指定', async () => {
    const h = await makeHarness({
      modelGroup: { provider: 'openai', model: 'gpt-5' },
      thinkingGroup: 'max',
    })
    const chatId = h.seed('admin')
    const result = await h.tool('qq_model').execute({ action: 'get', chat_id: chatId }, h.exec('sess-admin')) as Record<string, unknown>
    // 在线会话的选择优先于配置声明。
    expect(result.provider).toBe('deepseek')
    expect(result.model).toBe('deepseek-chat')
    expect(result.level).toBe('high')
    expect(result.configured).toEqual({ provider: 'openai', model: 'gpt-5', reasoningEffort: 'max' })
    expect(result.levels).toEqual(['off', 'low', 'high', 'max'])
  })

  it('get：离线会话按配置指定回报；没有配置回落到部署默认', async () => {
    const h = await makeHarness({ deployment: { provider: 'deepseek', model: 'deepseek-reasoner' } })
    const chatId = h.seed('offline')
    const plain = await h.tool('qq_model').execute({ action: 'get', chat_id: chatId }, {}) as Record<string, unknown>
    expect(plain.provider).toBe('deepseek')
    expect(plain.model).toBe('deepseek-reasoner')
    expect(plain.level).toBe('default')
    expect(plain.configured).toBeNull()

    const bound = await makeHarness({
      deployment: { provider: 'deepseek', model: 'deepseek-reasoner' },
      modelPrivate: { provider: 'openai', model: 'gpt-5' },
      thinkingPrivate: 'low',
    })
    const viaType = await bound.tool('qq_model').execute({ action: 'get', chat_id: 'private:90001' }, {}) as Record<string, unknown>
    expect(viaType.provider).toBe('openai')
    expect(viaType.model).toBe('gpt-5')
    expect(viaType.level).toBe('low')
  })

  it('set provider+model：管理员切换当前会话，成员拒绝', async () => {
    const h = await makeHarness()
    const adminChat = h.seed('admin')
    const memberChat = h.seed('member')

    await h.tool('qq_model').execute(
      { action: 'set', provider: 'openai', model: 'gpt-5', level: 'max', chat_id: adminChat },
      h.exec('sess-admin'),
    )
    expect(h.models.admin.selections).toEqual([{ provider: 'openai', model: 'gpt-5', reasoningEffort: 'max' }])

    await expect(h.tool('qq_model').execute(
      { action: 'set', provider: 'openai', model: 'gpt-5', chat_id: memberChat },
      h.exec('sess-member'),
    )).rejects.toThrow(/只有管理员回合能改模型/)
    expect(h.models.member.selections).toHaveLength(0)
  })

  it('set level：模型不支持的档位被拒绝，并列出可用档位', async () => {
    const h = await makeHarness({ efforts: ['low', 'high', 'max'] })
    const chatId = h.seed('member')
    await expect(h.tool('qq_model').execute({ action: 'set', level: 'off', chat_id: chatId }, h.exec('sess-member')))
      .rejects.toThrow(/不支持思考强度 off（支持：low \/ high \/ max）/)
    expect(h.models.member.selections).toHaveLength(0)
  })

  it('set level：只改思考强度，保留既有路由；成员可用', async () => {
    const h = await makeHarness()
    const chatId = h.seed('member')
    await h.tool('qq_model').execute({ action: 'set', level: 'off', chat_id: chatId }, h.exec('sess-member'))
    expect(h.models.member.selections).toEqual([{ provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'off' }])

    await h.tool('qq_model').execute({ action: 'set', level: 'default', chat_id: chatId }, h.exec('sess-member'))
    expect(h.models.member.selections.at(-1)).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
  })

  it('set scope=default：管理员写部署默认选择，成员拒绝', async () => {
    const h = await makeHarness({ deployment: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' } })
    const adminChat = h.seed('admin')
    const memberChat = h.seed('member')

    await h.tool('qq_model').execute(
      { action: 'set', scope: 'default', provider: 'openai', model: 'gpt-5', level: 'low', chat_id: adminChat },
      h.exec('sess-admin'),
    )
    expect(h.savedDefaults).toEqual([{ provider: 'openai', model: 'gpt-5', reasoningEffort: 'low' }])

    await expect(h.tool('qq_model').execute(
      { action: 'set', scope: 'default', level: 'off', chat_id: memberChat },
      h.exec('sess-member'),
    )).rejects.toThrow(/只有管理员回合能改部署默认模型/)
    expect(h.savedDefaults).toHaveLength(1)
  })

  it('没有在线会话时 set 直接拒绝；非法参数不写任何选择', async () => {
    const h = await makeHarness()
    const offline = h.seed('offline')
    await expect(h.tool('qq_model').execute({ action: 'set', level: 'low', chat_id: offline }, {}))
      .rejects.toThrow(/还没有在线会话/)

    const chatId = h.seed('admin')
    await expect(h.tool('qq_model').execute({ action: 'toggle', chat_id: chatId }, h.exec('sess-admin')))
      .rejects.toThrow(/action.*must be one of/)
    await expect(h.tool('qq_model').execute({ action: 'set', provider: 'openai', chat_id: chatId }, h.exec('sess-admin')))
      .rejects.toThrow(/provider 与 model 必须同时给出/)
    await expect(h.tool('qq_model').execute({ action: 'set', chat_id: chatId }, h.exec('sess-admin')))
      .rejects.toThrow(/set 需要 provider\+model 或 level/)
    expect(h.models.admin.selections).toHaveLength(0)
  })
})
