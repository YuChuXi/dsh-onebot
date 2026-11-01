/**
 * /session 切换历史的测试（M5）：`ChatState.retired` 与 `kept` 的语义、
 * /new 的软退役、switchSession 流程，以及端到端契约
 * "/new → /session 1 → 下一条普通消息通过 agents.resume 继续原会话（而非新建）"、
 * 重启往返、kept=false 的拒绝与恢复失败回退。Registry 内部路径沿用
 * registry.spec 的直调约定。
 * @module dsh-onebot/tests/session-switch
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'

import { OneBotConnection } from '../src/onebot/connection.js'
import { ChatBridge } from '../src/bridge/index.js'
import { ChatRegistry } from '../src/registry/index.js'
import type { RegistryDeps } from '../src/registry/index.js'
import type { BridgeConfig } from '../src/bridge/index.js'
import { MediaStore } from '../src/media/store.js'
import { Transcriber } from '../src/media/stt.js'
import { shortSessionId } from '../src/commands/preview.js'

import { makeCmdHarness, makeEvent, makeHarness } from './helpers/bridge-harness.js'

function registryOf(h: { bridge: unknown }): ChatRegistry {
  return (h.bridge as unknown as { registry: ChatRegistry }).registry
}

/** 私有退役索引：测试用来观察某个 id 是否已被永久退役。 */
function retiredIdsOf(r: ChatRegistry): Set<string> {
  return (r as unknown as { retiredIds: Set<string> }).retiredIds
}

/** 私有退役入口：模拟一个历史条目（kept 决定 /session 是否可切回）。 */
function retireOf(r: ChatRegistry): (chatId: string, id: string, kept: boolean) => void {
  return (r as unknown as { retire(chatId: string, id: string, kept: boolean): void }).retire.bind(r)
}

/** Minimal fake agent registry: create always succeeds; resume succeeds unless
 * the id is listed in failResumeIds. Header cwd mirrors the create cwd so no
 * workspace override restoration kicks in. */
function makeDirectAgents(opts?: { failResumeIds?: string[] }) {
  const created: string[] = []
  const resumed: string[] = []
  // dsh 0.2.2: /status reads agent.model.current(); the stub mirrors the
  // host semantics (recorded selection ?? agentOptions fallback ?? undefined).
  const makeModel = (agentOptions?: { provider?: string; model?: string }) => {
    let recorded: { provider: string; model: string } | undefined
    return {
      current: () => recorded ?? (agentOptions?.provider !== undefined && agentOptions?.model !== undefined
        ? { provider: agentOptions.provider, model: agentOptions.model }
        : undefined),
      select: (next: { provider: string; model: string }) => { recorded = { provider: next.provider, model: next.model } },
    }
  }
  const agents = {
    create: vi.fn(async (options: { sessionId: string; meta?: { cwd?: string } }) => {
      const id = String(options.sessionId)
      created.push(id)
      return {
        agent: {
          session: { id, seq: 0, header: { cwd: options.meta?.cwd ?? process.cwd() } },
          status: 'idle',
          model: makeModel(),
          cancel: () => undefined,
          followup: () => undefined,
          steer: () => undefined,
          whenIdle: async () => undefined,
        },
        dispose: async () => undefined,
      }
    }),
    resume: vi.fn(async (options: { resumeSessionId: string }) => {
      const id = String(options.resumeSessionId)
      resumed.push(id)
      if (opts?.failResumeIds?.includes(id)) throw new Error('resume boom: ' + id)
      return {
        agent: {
          session: { id, seq: 1, header: { cwd: process.cwd() } },
          status: 'idle',
          model: makeModel(),
          cancel: () => undefined,
          followup: () => undefined,
          steer: () => undefined,
          whenIdle: async () => undefined,
        },
        dispose: async () => undefined,
      }
    }),
  }
  return { agents, created, resumed }
}

function makeRegistryDeps(mediaDir: string, agents: unknown, logLines: string[] = []): RegistryDeps {
  return {
    agents: agents as never,
    sessions: { flush: vi.fn(async () => undefined) } as never,
    sessionPersistence: undefined,
    workspaceRegistry: undefined as never,
    agentPresets: undefined as never,
    defaultModel: undefined,
    config: {
      mediaDir,
      workspacePath: '',
      agentPreset: '',
      restrictedMemberPrefix: false,
      maxImageBytes: 8 * 1024 * 1024,
      maxVoiceBytes: 15 * 1024 * 1024,
      maxFileBytes: 20 * 1024 * 1024,
    },
    log: (level, message) => { logLines.push(level + ': ' + message) },
    isStopping: () => false,
    onChatRemoved: () => undefined,
    installChannelScope: () => undefined,
  }
}

function mkdtemp(): string {
  return mkdtempSync(join(tmpdir(), 'onebot-switch-'))
}

/** A fresh bridge over an existing mediaDir (the restart leg of round-trips). */
async function makeRestartBridge(mediaDir: string, opts?: { failResumeIds?: string[] }) {
  const { agents, resumed } = makeDirectAgents(opts)
  const bridge = new ChatBridge({
    ctx: new Context(),
    connection: new OneBotConnection({ mode: 'reverse', host: '127.0.0.1', port: 0, url: 'ws://127.0.0.1:3002', accessToken: 'test-token', callTimeoutMs: 3_000 }),
    media: new MediaStore(join(mediaDir, 'media'), 6),
    transcriber: new Transcriber({ enabled: false, engine: 'auto', command: '', args: [], model: 'small', timeoutMs: 10_000 }),
    agents: agents as never,
    sessions: { flush: vi.fn(async () => undefined) } as never,
    agentPresets: undefined as never,
    workspaceRegistry: undefined as never,
    sessionPersistence: undefined,
    defaultModel: undefined,
    config: {
      botQQ: '10002', ignoreSelf: false, requireMention: true,
      sendErrorNotice: true, restrictedMemberPrefix: false,
      mediaDir, maxImageBytes: 8 * 1024 * 1024,
      maxVoiceBytes: 15 * 1024 * 1024, maxFileBytes: 20 * 1024 * 1024,
    },
    policy: {
      dmPolicy: 'open', groupPolicy: 'open', allowFrom: [], groupAllowFrom: [],
      adminUsers: ['10001'], allowAllUsers: false, requireMention: true,
    },
    log: () => undefined,
  })
  bridge.start()
  return { bridge, resumed }
}

describe('switchable list persistence (registry)', () => {
  it('resetChat soft-retires the current session into the chat history and the durable file', async () => {
    const mediaDir = mkdtemp()
    const { agents } = makeDirectAgents()
    const registry = new ChatRegistry(makeRegistryDeps(mediaDir, agents))
    const chat = await registry.ensureChat('private:10001', '小明')
    const bareId = String(chat.sessionId)
    expect(bareId).toBe('onebot-private-10001')
    expect(registry.switchableSessions('private:10001')).toEqual([])

    await registry.resetChat('private:10001')
    const list = registry.switchableSessions('private:10001')
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe(bareId)
    expect(typeof list[0].retiredAt).toBe('number')
    // SOFT retire: durably retired (out of every create path) but kept — /session
    // keeps it switchable.
    expect(retiredIdsOf(registry).has(bareId)).toBe(true)
    // The single mapping file carries the binding removal and the history.
    await vi.waitFor(async () => {
      const content = await readFile(join(mediaDir, 'chat-sessions.json'), 'utf8')
      const entry = JSON.parse(content)['private:10001']
      expect(entry.session).toBeUndefined()
      expect(entry.retired).toEqual([{ id: bareId, retiredAt: list[0].retiredAt, kept: true }])
    })
  })

  it('resetChat retires an idle session too, so the next message never resumes it', async () => {
    const mediaDir = mkdtemp()
    const { agents } = makeDirectAgents()
    const registry = new ChatRegistry(makeRegistryDeps(mediaDir, agents))
    const chat = await registry.ensureChat('private:10001', '小明')
    const oldId = String(chat.sessionId)
    // Idle: the sweep releases the agent but keeps the binding.
    chat.lastActivityAt = Date.now() - 30 * 24 * 60 * 60 * 1000
    await registry.sweepIdleChats()
    expect(registry.chats.has('private:10001')).toBe(false)
    expect(registry.currentSessionId('private:10001')).toBe(oldId)

    await registry.resetChat('private:10001')
    expect(registry.currentSessionId('private:10001')).toBeUndefined()
    expect(registry.switchableSessions('private:10001').map(entry => entry.id)).toEqual([oldId])
    await vi.waitFor(async () => {
      const entry = JSON.parse(await readFile(join(mediaDir, 'chat-sessions.json'), 'utf8'))['private:10001']
      expect(entry.session).toBeUndefined()
      expect(entry.retired).toEqual([{ id: oldId, retiredAt: expect.any(Number), kept: true }])
    })

    const next = await registry.ensureChat('private:10001', '小明')
    expect(next.sessionId).not.toBe(oldId)
  })

  it('retire caps the switchable list at 20 per chat while keeping every id blocked and newest first', () => {
    const mediaDir = mkdtemp()
    const { agents } = makeDirectAgents()
    const registry = new ChatRegistry(makeRegistryDeps(mediaDir, agents))
    const retire = retireOf(registry)
    for (let i = 1; i <= 25; i++) retire('private:10001', 'onebot-private-10001-s' + String(i).padStart(2, '0'), true)
    retire('private:10001', 'onebot-private-10001-s07', true)
    const list = registry.switchableSessions('private:10001')
    expect(list).toHaveLength(20)
    expect(list.filter(e => e.id === 'onebot-private-10001-s07')).toHaveLength(1)
    // The oldest entries left the switchable list but stay blocked for reuse.
    expect(list.some(e => e.id === 'onebot-private-10001-s01')).toBe(false)
    expect(retiredIdsOf(registry).has('onebot-private-10001-s01')).toBe(true)
    // Other chats are untouched.
    expect(registry.switchableSessions('group:888')).toEqual([])
  })

  it('migrates the legacy switchable list into the chat history', async () => {
    const mediaDir = mkdtemp()
    const { agents } = makeDirectAgents()
    const registry = new ChatRegistry(makeRegistryDeps(mediaDir, agents))
    await mkdir(mediaDir, { recursive: true })
    await writeFile(join(mediaDir, 'chat-sessions.json'), JSON.stringify({ 'private:10001': 'onebot-private-10001' }), 'utf8')
    await writeFile(join(mediaDir, 'switchable-sessions.json'), JSON.stringify({
      'private:10001': [
        { id: 'onebot-private-10001-new', retiredAt: 20 },
        { id: 'onebot-private-10001-old', retiredAt: 10 },
      ],
    }), 'utf8')
    await registry.loadMapping()
    // The history keeps the old list's new→old order and the binding resumes.
    expect(registry.switchableSessions('private:10001').map(e => e.id)).toEqual([
      'onebot-private-10001-new',
      'onebot-private-10001-old',
    ])
    expect(registry.currentSessionId('private:10001')).toBe('onebot-private-10001')
    const mapping = JSON.parse(await readFile(join(mediaDir, 'chat-sessions.json'), 'utf8'))
    expect(mapping['private:10001'].retired.map((entry: { id: string }) => entry.id)).toEqual([
      'onebot-private-10001-new',
      'onebot-private-10001-old',
    ])
    await registry.stop()
  })
  it('a missing mapping file is a silent fresh start (no warn)', async () => {
    const mediaDir = mkdtemp()
    const logLines: string[] = []
    const { agents } = makeDirectAgents()
    const registry = new ChatRegistry(makeRegistryDeps(mediaDir, agents, logLines))
    await registry.loadMapping()
    expect(logLines.some(l => l.includes('mapping read failed'))).toBe(false)
    expect(registry.switchableSessions('private:10001')).toEqual([])
  })
})

describe('switchSession (registry)', () => {
  it('refuses a non-switchable id and never leaks another chat\'s history', async () => {
    const mediaDir = mkdtemp()
    const { agents, resumed } = makeDirectAgents()
    const registry = new ChatRegistry(makeRegistryDeps(mediaDir, agents))
    const target = 'onebot-private-10001-old'
    retireOf(registry)('private:10001', target, false)
    const outcome = await registry.switchSession('private:10001', target)
    expect(outcome).toEqual({ ok: false, reason: 'broken', message: '目标会话已损坏' })
    expect(resumed).toEqual([])
    // The refusal is not a destructive write: the id stays blocked and out of
    // the switchable list.
    expect(registry.switchableSessions('private:10001')).toEqual([])
    expect(retiredIdsOf(registry).has(target)).toBe(true)
    // Chat B can neither see nor switch to chat A's switchable session.
    expect(registry.switchableSessions('private:99999')).toEqual([])
    const cross = await registry.switchSession('private:99999', target)
    expect(cross).toEqual({ ok: false, reason: 'not-switchable', message: '目标会话不在该 chat 的可切回列表中' })
    expect(resumed).toEqual([])
  })

  it('live round trip: the current session enters the list, the target is un-retired and live again', async () => {
    const mediaDir = mkdtemp()
    const { agents, resumed } = makeDirectAgents()
    const registry = new ChatRegistry(makeRegistryDeps(mediaDir, agents))
    const chat1 = await registry.ensureChat('private:10001', '小明')
    const s1 = String(chat1.sessionId)
    await registry.resetChat('private:10001')
    const chat2 = await registry.ensureChat('private:10001', '小明')
    const s2 = String(chat2.sessionId)
    expect(s2).not.toBe(s1)
    expect(s2).toMatch(/^onebot-private-10001-[a-z0-9]+$/)

    const outcome = await registry.switchSession('private:10001', s1)
    expect(outcome).toEqual({ ok: true, sessionId: s1 })
    expect(resumed).toEqual([s1])
    // The target is live again and no longer retired (in-memory + durable).
    expect(String(registry.chats.get('private:10001')!.sessionId)).toBe(s1)
    expect(retiredIdsOf(registry).has(s1)).toBe(false)
    await vi.waitFor(async () => {
      const mapping = JSON.parse(await readFile(join(mediaDir, 'chat-sessions.json'), 'utf8'))
      expect(mapping['private:10001'].retired.map((entry: { id: string }) => entry.id)).not.toContain(s1)
    })
    // The previous session took its place in the switchable list (round trip).
    expect(registry.switchableSessions('private:10001').map(e => e.id)).toEqual([s2])
    expect(retiredIdsOf(registry).has(s2)).toBe(true)
    // The mapping now points at the restored session.
    await vi.waitFor(async () => {
      const mapping = JSON.parse(await readFile(join(mediaDir, 'chat-sessions.json'), 'utf8'))
      expect(mapping['private:10001'].session).toBe(s1)
    })
  })

  it('resume failure hard-retires the target, drops it from the list and the chat rebuilds fresh', async () => {
    const mediaDir = mkdtemp()
    const target = 'onebot-private-10001-old'
    const { agents, resumed } = makeDirectAgents({ failResumeIds: [target] })
    const registry = new ChatRegistry(makeRegistryDeps(mediaDir, agents))
    const chat1 = await registry.ensureChat('private:10001', '小明')
    const s1 = String(chat1.sessionId)
    // Simulate a /new-retired switchable target.
    retireOf(registry)('private:10001', target, true)

    const outcome = await registry.switchSession('private:10001', target)
    expect(outcome.ok).toBe(false)
    expect((outcome as { reason: string }).reason).toBe('resume-failed')
    expect(resumed).toEqual([target])
    // The unusable target is marked broken and left the switchable list…
    expect(retiredIdsOf(registry).has(target)).toBe(true)
    expect(registry.switchableSessions('private:10001').map(e => e.id)).toEqual([s1])
    // …the chat is not stuck: the next ensureChat rebuilds a FRESH session.
    const chat2 = await registry.ensureChat('private:10001', '小明')
    const s2 = String(chat2.sessionId)
    expect(s2).not.toBe(s1)
    expect(s2).not.toBe(target)
    expect(s2).toMatch(/^onebot-private-10001-[a-z0-9]+$/)
  })
})

describe('/session command (bridge harness)', () => {
  it('e2e pinned: /new → /session → /session 1 → the next plain message continues the ORIGINAL session via resume', async () => {
    const h = await makeHarness({ resumeOk: true })
    h.sendText('你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const original = h.sessionIds[0]

    h.sendText('/new')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('已开启新会话'))).toBe(true)
    })
    h.sendText('/session')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('可切回历史会话'))).toBe(true)
    })
    h.sendText('/session 1')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('已切回历史会话'))).toBe(true)
    })

    // The switch went through agents.resume with the ORIGINAL id…
    const registry = registryOf(h)
    const agents = (registry as unknown as { deps: { agents: { resume: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> } } }).deps.agents
    expect(agents.resume).toHaveBeenCalledWith(expect.objectContaining({ resumeSessionId: original }))
    // …and the next PLAIN message lands in that same session (not a fresh
    // create): the session id list holds the id twice, create ran only once.
    h.sendText('回到原会话的一条')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    expect(h.captured.followups[1].sessionId).toBe(original)
    expect(h.sessionIds).toEqual([original, original])
    expect(agents.create).toHaveBeenCalledTimes(1)

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 30_000)

  it('restart path: loadMapping restores the switched-back session (un-retired entry resumes normally)', async () => {
    const h = await makeHarness({ resumeOk: true })
    h.sendText('你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const original = h.sessionIds[0]
    h.sendText('/new')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('已开启新会话'))).toBe(true)
    })
    h.sendText('/session')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('可切回历史会话'))).toBe(true)
    })
    h.sendText('/session 1')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('已切回历史会话'))).toBe(true)
    })
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()

    // The switch un-retired the id: the durable history no longer contains it,
    // and the mapping entry resumes on restart.
    const mapping = JSON.parse(await readFile(join(h.mediaDir, 'chat-sessions.json'), 'utf8'))
    const entry = mapping['private:10001']
    expect(entry.session).toBe(original)
    expect(entry.retired.map((item: { id: string }) => item.id)).not.toContain(original)
    const { bridge: bridge2, resumed } = await makeRestartBridge(h.mediaDir)
    await vi.waitFor(() => {
      expect(String(registryOf({ bridge: bridge2 }).chats.get('private:10001')?.sessionId ?? '')).toBe(original)
    })
    expect(resumed).toEqual([original])
    await bridge2.stop()
  }, 30_000)

  it('bare form renders the numbered list with retire time and sets the session snapshot; out of range keeps it; non-numeric gets usage', async () => {
    const h = await makeCmdHarness()
    // No switchable history yet (and no live chat): the friendly empty reply.
    h.sendText('/session')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('没有可切回的历史会话'))).toBe(true)
    })
    expect(registryOf(h).getSettings('private:10001').pendingSelection).toBeUndefined()

    h.sendText('你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const original = h.sessionIds[0]
    h.sendText('/new')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('已开启新会话'))).toBe(true)
    })

    h.sendText('/session')
    await vi.waitFor(() => {
      const text = h.outbound.map(f => JSON.stringify(f.params)).join('\n')
      expect(text).toContain('可切回历史会话：')
      // Preview degradation: this harness has no persistence service, so the
      // item renders the no-content placeholder and omits the creation time;
      // the id (≤20 chars) stays verbatim after the retire time.
      expect(text).toContain('1. （无对话内容）（')
      expect(text).toContain(' 退休 · ' + original + '）')
      expect(text).not.toContain(' 建立 ')
      expect(text).toContain('回复 /session <序号> 切回')
    })
    const pending = registryOf(h).getSettings('private:10001').pendingSelection
    expect(pending?.kind).toBe('session')
    expect(pending?.items.map(i => i.payload)).toEqual([original])

    h.sendText('/session 9')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('序号越界，请回复 /session 重新查看列表'))).toBe(true)
    })
    // Deliberately retained for a retry.
    expect(registryOf(h).getSettings('private:10001').pendingSelection?.items).toHaveLength(1)

    h.sendText('/session foo')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('用法：/session 查看可切回会话'))).toBe(true)
    })

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)

  it('live-chat switch: current session enters the list, the target resumes its history, and switching back works', async () => {
    const h = await makeHarness({ resumeOk: true })
    h.sendText('第一条')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const s1 = h.sessionIds[0]
    h.sendText('/new')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('已开启新会话'))).toBe(true)
    })
    h.sendText('第二条')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    const s2 = h.sessionIds[1]
    expect(s2).not.toBe(s1)

    // List first: the numeric pick resolves against the snapshot the bare
    // form rendered (same R2 contract as /model).
    h.sendText('/session')
    await vi.waitFor(() => {
      // New item format: preview placeholder (this harness has no persistence
      // service) + retire time + recognizable id.
      const text = h.outbound.map(f => JSON.stringify(f.params)).join('\n')
      expect(text).toContain('1. （无对话内容）（')
      expect(text).toContain(' 退休 · ' + s1 + '）')
    })
    h.sendText('/session 1')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('已切回历史会话：' + s1))).toBe(true)
    })
    expect(String(registryOf(h).chats.get('private:10001')!.sessionId)).toBe(s1)
    expect(registryOf(h).switchableSessions('private:10001').map(e => e.id)).toEqual([s2])
    h.sendText('第三条')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(3))
    expect(h.captured.followups[2].sessionId).toBe(s1)

    // Round trip: /session back to s2.
    h.sendText('/session')
    await vi.waitFor(() => {
      // New item format: the retired s2 shows as the preview placeholder +
      // retire time + recognizable id.
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('1. （无对话内容）（'))).toBe(true)
      expect(h.outbound.some(f => JSON.stringify(f.params).includes(' 退休 · ' + shortSessionId(s2) + '）'))).toBe(true)
    })
    h.sendText('/session 1')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('已切回历史会话：' + s2))).toBe(true)
    })
    expect(String(registryOf(h).chats.get('private:10001')!.sessionId)).toBe(s2)
    expect(registryOf(h).switchableSessions('private:10001').map(e => e.id)).toEqual([s1])

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 30_000)

  it('refuses to switch while the chat is busy (提示先 /stop) and keeps the snapshot', async () => {
    const h = await makeCmdHarness()
    h.sendText('你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    h.sendText('/new')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('已开启新会话'))).toBe(true)
    })
    // Rebuild a live chat first — /new left no live agent to be busy.
    h.sendText('第二条')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    h.sendText('/session')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('可切回历史会话'))).toBe(true)
    })
    h.chats().get('private:10001')!.busy = true
    const resumedBefore = (registryOf(h) as unknown as { deps: { agents: { resume: ReturnType<typeof vi.fn> } } }).deps.agents.resume
    h.sendText('/session 1')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('请先 /stop 再切换会话'))).toBe(true)
    })
    expect(resumedBefore).not.toHaveBeenCalled()
    // The snapshot was not consumed by the refused attempt.
    expect(registryOf(h).getSettings('private:10001').pendingSelection?.kind).toBe('session')
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)

  it('command-level resume failure: ❌ fallback reply and the next message opens a fresh session', async () => {
    const h = await makeCmdHarness()
    h.sendText('第一条')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const s1 = h.sessionIds[0]
    h.sendText('/new')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('已开启新会话'))).toBe(true)
    })
    h.sendText('第二条')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    const s2 = h.sessionIds[1]

    h.sendText('/session')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('可切回历史会话'))).toBe(true)
    })
    h.sendText('/session 1')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('切回历史会话失败'))).toBe(true)
    })
    // The broken target left the list; the previous session is switchable.
    expect(registryOf(h).switchableSessions('private:10001').map(e => e.id)).toEqual([s2])
    // The chat is not stuck: the next message builds a fresh session.
    h.sendText('第三条')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(3))
    const s3 = h.captured.followups[2].sessionId
    expect(s3).not.toBe(s1)
    expect(s3).not.toBe(s2)
    expect(s3).toMatch(/^onebot-private-10001-[a-z0-9]+$/)

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)

  it('collision heal and create-collision fallback never enter the switchable list', async () => {
    const h = await makeHarness({ failCreateFor: 'onebot-private-10001' })
    h.sendText('hi')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    // The bare-id create collision is a hard retire — no switchable entry.
    expect(registryOf(h).switchableSessions('private:10001')).toEqual([])
    expect(retiredIdsOf(registryOf(h)).has('onebot-private-10001')).toBe(true)

    // A collision heal retires the live session without listing it either.
    const fallback = h.sessionIds[0]
    h.ctx.emit('session/event', { id: fallback } as never, makeEvent('turn/end', {
      turn: 1,
      reason: { kind: 'error', error: { code: 'E_COLLISION', message: 'session "' + fallback + '" already has a persisted log on disk that does not match this live session (id collision)' } },
    }))
    await vi.waitFor(async () => {
      const mapping = JSON.parse(await readFile(join(h.mediaDir, 'chat-sessions.json'), 'utf8'))
      expect(mapping['private:10001'].retired.map((entry: { id: string }) => entry.id)).toContain(fallback)
    })
    expect(registryOf(h).switchableSessions('private:10001')).toEqual([])

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 30_000)
})
