/**
 * Mapping-file settings persistence tests (M3-D4b / T3): the per-chat
 * workspace override and the recent-message watermark survive a restart
 * through the chat-sessions.json mapping. The format is additive — a legacy
 * entry is a bare chat→session-id string; an entry with persisted settings
 * becomes { session, workspacePath?, recentWatermark? }. Covers: debounced
 * write → restart round-trip, the legacy-file fallback, and the idle-eviction
 * snapshot cycle.
 * @module dsh-onebot/tests/mapping-settings
 */
import { describe, expect, it, vi } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { ChatRegistry } from '../src/registry/index.js'
import type { RegistryDeps } from '../src/registry/index.js'
import type { BridgeConfig } from '../src/bridge/config.js'

import { makeFakeAgents } from './helpers/bridge-harness.js'

/** Minimal RegistryDeps for direct-registry tests (same convention as registry.spec). */
function makeRegistryDeps(overrides?: {
  agents?: unknown
  config?: Partial<Pick<BridgeConfig, 'mediaDir' | 'workspacePath' | 'agentPreset' | 'restrictedMemberPrefix' | 'maxImageBytes' | 'maxVoiceBytes' | 'maxFileBytes' | 'chatIdleEvictDays'>>
}): RegistryDeps {
  return {
    agents: (overrides?.agents ?? { create: vi.fn(), resume: vi.fn() }) as never,
    sessions: { flush: vi.fn(async () => undefined) } as never,
    sessionPersistence: undefined,
    workspaceRegistry: undefined as never,
    call: async () => ({}),
    sessionTitle: undefined,
    agentPresets: {
      defaultId: 'standard',
      resolve: vi.fn(async (id?: string) => ({ id: id ?? 'standard' })),
      mount: vi.fn(async (_agentCtx: unknown, id?: string) => ({ id: id ?? 'standard' })),
    } as never,
    defaultModel: undefined,
    config: {
      mediaDir: mkdtemp(),
      workspacePath: '',
      agentPreset: '',
      restrictedMemberPrefix: false,
      maxImageBytes: 8 * 1024 * 1024,
      maxVoiceBytes: 15 * 1024 * 1024,
      maxFileBytes: 20 * 1024 * 1024,
      ...overrides?.config,
    },
    log: () => undefined,
    isStopping: () => false,
    onChatRemoved: () => undefined,
    installChannelScope: () => undefined,
  }
}

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

function mkdtemp(): string {
  return mkdtempSync(join(tmpdir(), 'onebot-test-'))
}

describe('T3: workspacePath persistence + default directory (方案 B)', () => {
  it('round-trips the /workspace override through the mapping (write → restart → restore)', async () => {
    const sessionIds: string[] = []
    const deps1 = makeRegistryDeps({ agents: makeFakeAgents(sessionIds, { followups: [] }, { resumeOk: true }) })
    const registry1 = new ChatRegistry(deps1)
    registry1.getSettings('private:10001').workspacePath = '/tmp/onebot-ws-a'
    await registry1.ensureChat('private:10001', '小明')
    await registry1.saveMapping()
    await registry1.stop()
    const mapping = JSON.parse(await readFile(join(deps1.config.mediaDir, 'chat-sessions.json'), 'utf8')) as Record<string, { session: string; workspacePath?: string }>
    expect(mapping['private:10001']).toEqual({ session: sessionIds[0], workspacePath: '/tmp/onebot-ws-a' })

    const deps2 = makeRegistryDeps({ agents: makeFakeAgents([], { followups: [] }, { resumeOk: true }), config: { mediaDir: deps1.config.mediaDir } })
    const registry2 = new ChatRegistry(deps2)
    await registry2.loadMapping()
    expect(registry2.chats.get('private:10001')?.sessionId).toBe(sessionIds[0])
    expect(registry2.getSettings('private:10001').workspacePath).toBe('/tmp/onebot-ws-a')
    await registry2.stop()
  })

  it('loads a mixed legacy file: bare strings keep working, workspacePath entries restore', async () => {
    const deps = makeRegistryDeps({ agents: makeFakeAgents([], { followups: [] }, { resumeOk: true }) })
    await writeFile(join(deps.config.mediaDir, 'chat-sessions.json'), JSON.stringify({
      'private:10001': 'onebot-private-10001',
      'private:10002': { session: 'onebot-private-10002', workspacePath: '/tmp/onebot-ws-b' },
    }), 'utf8')
    const registry = new ChatRegistry(deps)
    await registry.loadMapping()
    expect(registry.chats.get('private:10001')?.sessionId).toBe('onebot-private-10001')
    expect(registry.getSettings('private:10001').workspacePath).toBeUndefined()
    expect(registry.chats.get('private:10002')?.sessionId).toBe('onebot-private-10002')
    expect(registry.getSettings('private:10002').workspacePath).toBe('/tmp/onebot-ws-b')
    await registry.stop()
  })

  it('keeps the bare-string entry byte-identical when no settings are persisted', async () => {
    const sessionIds: string[] = []
    const deps = makeRegistryDeps({ agents: makeFakeAgents(sessionIds, { followups: [] }, { resumeOk: true }) })
    const registry = new ChatRegistry(deps)
    await registry.ensureChat('private:10001', '小明')
    await registry.saveMapping()
    const text = await readFile(join(deps.config.mediaDir, 'chat-sessions.json'), 'utf8')
    expect(text).toBe('{\n  "private:10001": "' + sessionIds[0] + '"\n}')
    await registry.stop()
  })

  it('falls back to the host process cwd when unconfigured (方案 B default dir)', () => {
    const deps = makeRegistryDeps()
    const registry = new ChatRegistry(deps)
    expect(registry.effectiveCwd('private:10001')).toBe(process.cwd())
    expect(registry.effectiveCwd()).toBe(process.cwd())
  })

  it('closes the resume-failure hole: after retire the fresh session still uses the persisted override', async () => {
    const sessionIds: string[] = []
    const captured = { followups: [] as Array<{ text: string; sessionId: string }>, createdMeta: [] as Array<{ cwd?: string; agentPreset?: string }> }
    const deps = makeRegistryDeps({ agents: makeFakeAgents(sessionIds, captured, { resumeOk: false }) })
    await writeFile(join(deps.config.mediaDir, 'chat-sessions.json'), JSON.stringify({
      'private:10001': { session: 'onebot-private-10001', workspacePath: '/tmp/onebot-ws-c' },
    }), 'utf8')
    const registry = new ChatRegistry(deps)
    await registry.loadMapping()
    // The override is restored BEFORE the resume attempt, so the failed resume
    // (session retired) cannot lose it.
    expect(registry.getSettings('private:10001').workspacePath).toBe('/tmp/onebot-ws-c')
    const chat = await registry.ensureChat('private:10001', '小明')
    expect(chat.sessionId).not.toBe('onebot-private-10001')
    expect(captured.createdMeta[0]?.cwd).toBe('/tmp/onebot-ws-c')
    await registry.stop()
  })

  it('keeps the override across an idle eviction cycle and its in-run resume', async () => {
    const sessionIds: string[] = []
    const deps1 = makeRegistryDeps({ agents: makeFakeAgents(sessionIds, { followups: [] }, { resumeOk: true }), config: { chatIdleEvictDays: 7 } })
    const registry1 = new ChatRegistry(deps1)
    registry1.getSettings('private:10001').workspacePath = '/tmp/onebot-ws-d'
    await registry1.ensureChat('private:10001', '小明')
    const chat = registry1.chats.get('private:10001')!
    chat.lastActivityAt = Date.now() - 8 * 24 * 60 * 60 * 1000
    await registry1.sweepIdleChats()
    expect(registry1.chats.has('private:10001')).toBe(false)
    await registry1.saveMapping()
    const mapping = JSON.parse(await readFile(join(deps1.config.mediaDir, 'chat-sessions.json'), 'utf8')) as Record<string, { session: string; workspacePath?: string }>
    expect(mapping['private:10001']).toEqual({ session: sessionIds[0], workspacePath: '/tmp/onebot-ws-d' })

    // In-run: the evicted chat resumes and the snapshot restores the override.
    const resumed = await registry1.ensureChat('private:10001', '小明')
    expect(resumed.sessionId).toBe(sessionIds[0])
    expect(registry1.getSettings('private:10001').workspacePath).toBe('/tmp/onebot-ws-d')
    await registry1.stop()
  })

  it('resetChat keeps a settings-carrying entry and never resumes the retired session', async () => {
    const sessionIds: string[] = []
    const agents1 = makeFakeAgents(sessionIds, { followups: [] }, { resumeOk: true })
    const deps1 = makeRegistryDeps({ agents: agents1 })
    const registry1 = new ChatRegistry(deps1)
    registry1.getSettings('private:10001').workspacePath = '/tmp/onebot-ws-e'
    await registry1.ensureChat('private:10001', '小明')
    await registry1.resetChat('private:10001')
    await registry1.saveMapping()
    // The entry survives the reset's mapping rewrite (it carries the override).
    const mapping = JSON.parse(await readFile(join(deps1.config.mediaDir, 'chat-sessions.json'), 'utf8')) as Record<string, { session: string; workspacePath?: string }>
    expect(mapping['private:10001']).toEqual({ session: sessionIds[0], workspacePath: '/tmp/onebot-ws-e' })

    // Next message: the retired session is never resumed — a fresh suffixed
    // session is created under the persisted override.
    const next = await registry1.ensureChat('private:10001', '小明')
    expect(next.sessionId).not.toBe(sessionIds[0])
    expect(next.sessionId).not.toBe('onebot-private-10001')
    expect(registry1.getSettings('private:10001').workspacePath).toBe('/tmp/onebot-ws-e')
    await registry1.stop()

    // After a restart, an entry still pointing at the RETIRED session id is a
    // settings carrier only: loadRetired + loadMapping must not resume it.
    await writeFile(join(deps1.config.mediaDir, 'chat-sessions.json'), JSON.stringify({
      'private:10001': { session: sessionIds[0], workspacePath: '/tmp/onebot-ws-e' },
    }), 'utf8')
    const agents2 = makeFakeAgents([], { followups: [] }, { resumeOk: true })
    const registry2 = new ChatRegistry(makeRegistryDeps({ agents: agents2, config: { mediaDir: deps1.config.mediaDir } }))
    await registry2.loadRetired()
    await registry2.loadMapping()
    expect(registry2.getSettings('private:10001').workspacePath).toBe('/tmp/onebot-ws-e')
    await registry2.stop()
  })

  it('persists a /workspace override set before the chat ever goes live (non-live flush)', async () => {
    const deps1 = makeRegistryDeps()
    const registry1 = new ChatRegistry(deps1)
    registry1.noteWorkspaceOverride('private:10001')
    expect(registry1.noteWorkspaceOverride('private:10001')).toBeUndefined()
    registry1.getSettings('private:10001').workspacePath = '/tmp/onebot-ws-f'
    registry1.noteWorkspaceOverride('private:10001')
    await registry1.saveMapping()
    const mapping = JSON.parse(await readFile(join(deps1.config.mediaDir, 'chat-sessions.json'), 'utf8')) as Record<string, { session: string; workspacePath?: string }>
    // Never-lived chat: the entry carries the derived bare session id.
    expect(mapping['private:10001']).toEqual({ session: 'onebot-private-10001', workspacePath: '/tmp/onebot-ws-f' })
    await registry1.stop()

    // Restart: the bare-id resume fails harmlessly; the override still keys the
    // fresh session created by the next message.
    const captured = { followups: [] as Array<{ text: string; sessionId: string }>, createdMeta: [] as Array<{ cwd?: string; agentPreset?: string }> }
    const registry2 = new ChatRegistry(makeRegistryDeps({ agents: makeFakeAgents([], captured, { resumeOk: false }), config: { mediaDir: deps1.config.mediaDir } }))
    await registry2.loadMapping()
    expect(registry2.getSettings('private:10001').workspacePath).toBe('/tmp/onebot-ws-f')
    const chat = await registry2.ensureChat('private:10001', '小明')
    expect(captured.createdMeta[0]?.cwd).toBe('/tmp/onebot-ws-f')
    await registry2.stop()
  })
})

describe('会话名称（宿主 sessionTitle）', () => {
  it('names a new chat after the group / friend and never overwrites a user rename', async () => {
    const calls: Array<{ action: string; params: Record<string, unknown> }> = []
    const renamed: string[] = []
    let title = ''
    const deps = makeRegistryDeps({ agents: makeFakeAgents([], { followups: [] }, { resumeOk: true }) })
    deps.call = async (action, params) => {
      calls.push({ action, params })
      return action === 'get_group_info' ? { group_name: '欠狐的家' } : { nickname: '玉子' }
    }
    deps.sessionTitle = () => ({
      get: () => ({ title }),
      rename: (_session, next) => {
        title = next
        renamed.push(next)
        return { title: next }
      },
    })
    const registry = new ChatRegistry(deps)
    await registry.ensureChat('group:980577471', '')
    await vi.waitFor(() => expect(renamed).toHaveLength(1))
    expect(renamed[0]).toMatch(/^群 欠狐的家 · \d{2}-\d{2} \d{2}:\d{2}$/)
    expect(calls[0]).toEqual({ action: 'get_group_info', params: { group_id: 980577471 } })

    // 用户自己起的名字不归插件管：新建的私聊会话保持原名。
    title = '我自己起的名字'
    await registry.ensureChat('private:10001', '玉子')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(renamed).toHaveLength(1)

    await registry.stop()
  })
})

describe('T3-R1 review closure: retired-entry and collision-heal settings carriers', () => {
  it('loadMapping keeps a retired object entry through a mid-flight saveMapping (settings survive the next restart)', async () => {
    const sessionIds: string[] = []
    const deps1 = makeRegistryDeps({ agents: makeFakeAgents(sessionIds, { followups: [] }, { resumeOk: true }) })
    const registry1 = new ChatRegistry(deps1)
    registry1.getSettings('private:10001').workspacePath = '/tmp/onebot-ws-g'
    registry1.getSettings('private:10001').recentWatermark = { time: 1_760_000_000, id: '5001' }
    await registry1.ensureChat('private:10001', '小明')
    await registry1.resetChat('private:10001')
    await registry1.saveMapping()
    await registry1.stop()
    // The reset leaves the entry in the file as a settings carrier under the
    // now-retired session id.
    await vi.waitFor(async () => {
      const retired = JSON.parse(await readFile(join(deps1.config.mediaDir, 'retired-sessions.json'), 'utf8')) as string[]
      expect(retired).toContain(sessionIds[0])
    })

    // Restart: loadMapping restores the settings and (T3-R1) re-registers the
    // entry so ANY later saveMapping keeps writing it.
    const deps2 = makeRegistryDeps({ agents: makeFakeAgents([], { followups: [] }, { resumeOk: true }), config: { mediaDir: deps1.config.mediaDir } })
    const registry2 = new ChatRegistry(deps2)
    await registry2.loadRetired()
    await registry2.loadMapping()
    expect(registry2.getSettings('private:10001').workspacePath).toBe('/tmp/onebot-ws-g')
    expect(registry2.getSettings('private:10001').recentWatermark).toEqual({ time: 1_760_000_000, id: '5001' })
    // Mid-flight save triggered by another chat's createChat: the settings
    // carrier must not be wiped from the file (it sits in neither chats nor
    // evictedChats without the re-registration).
    await registry2.ensureChat('private:10002', '小红')
    await registry2.saveMapping()
    const mapping = JSON.parse(await readFile(join(deps2.config.mediaDir, 'chat-sessions.json'), 'utf8')) as Record<string, { session: string; recentWatermark?: { time: number; id: string }; workspacePath?: string }>
    expect(mapping['private:10001']).toEqual({ session: sessionIds[0], recentWatermark: { time: 1_760_000_000, id: '5001' }, workspacePath: '/tmp/onebot-ws-g' })
    await registry2.stop()

    // Second restart: the settings are still in the file.
    const registry3 = new ChatRegistry(makeRegistryDeps({ agents: makeFakeAgents([], { followups: [] }, { resumeOk: true }), config: { mediaDir: deps1.config.mediaDir } }))
    await registry3.loadRetired()
    await registry3.loadMapping()
    expect(registry3.chats.get('private:10001')).toBeUndefined()
    expect(registry3.getSettings('private:10001').workspacePath).toBe('/tmp/onebot-ws-g')
    expect(registry3.getSettings('private:10001').recentWatermark).toEqual({ time: 1_760_000_000, id: '5001' })
    await registry3.stop()
  }, 20_000)

  it('healSessionCollision keeps a settings-carrying entry (workspace override survives the restart)', async () => {
    const sessionIds: string[] = []
    const deps1 = makeRegistryDeps({ agents: makeFakeAgents(sessionIds, { followups: [] }, { resumeOk: true }) })
    const registry1 = new ChatRegistry(deps1)
    registry1.getSettings('private:10001').workspacePath = '/tmp/onebot-ws-h'
    await registry1.ensureChat('private:10001', '小明')
    await registry1.healSessionCollision('private:10001')
    await registry1.saveMapping()
    // The heal's mapping rewrite keeps the entry (settings carrier under the
    // retired id) instead of dropping the chat entirely.
    const mapping = JSON.parse(await readFile(join(deps1.config.mediaDir, 'chat-sessions.json'), 'utf8')) as Record<string, { session: string; workspacePath?: string }>
    expect(mapping['private:10001']).toEqual({ session: sessionIds[0], workspacePath: '/tmp/onebot-ws-h' })
    await vi.waitFor(async () => {
      const retired = JSON.parse(await readFile(join(deps1.config.mediaDir, 'retired-sessions.json'), 'utf8')) as string[]
      expect(retired).toContain(sessionIds[0])
    })
    await registry1.stop()

    const registry2 = new ChatRegistry(makeRegistryDeps({ agents: makeFakeAgents([], { followups: [] }, { resumeOk: true }), config: { mediaDir: deps1.config.mediaDir } }))
    await registry2.loadRetired()
    await registry2.loadMapping()
    expect(registry2.chats.get('private:10001')).toBeUndefined()
    expect(registry2.getSettings('private:10001').workspacePath).toBe('/tmp/onebot-ws-h')
    await registry2.stop()
  }, 20_000)

  it('healSessionCollision without persisted settings keeps the pre-T3 drop behavior (helper parity with resetChat)', async () => {
    const deps = makeRegistryDeps({ agents: makeFakeAgents([], { followups: [] }, { resumeOk: true }) })
    const registry = new ChatRegistry(deps)
    await registry.ensureChat('private:10001', '小明')
    await registry.healSessionCollision('private:10001')
    await registry.saveMapping()
    const mapping = JSON.parse(await readFile(join(deps.config.mediaDir, 'chat-sessions.json'), 'utf8')) as Record<string, unknown>
    expect(mapping['private:10001']).toBeUndefined()
    await registry.stop()
  })
})

describe('T3-R2: resume-failed settings carrier + settings-only saveMapping invariant', () => {
  it('loadMapping keeps the entry when the resume fails: a later saveMapping still writes workspacePath/watermark', async () => {
    const deps = makeRegistryDeps({ agents: makeFakeAgents([], { followups: [] }, { resumeOk: false }) })
    // A suffixed session id (the real-world shape) — the carrier must keep the
    // file's own session id, not be rewritten under the derived bare id.
    await writeFile(join(deps.config.mediaDir, 'chat-sessions.json'), JSON.stringify({
      'private:10001': { session: 'onebot-private-10001-k3x9', workspacePath: '/tmp/onebot-ws-i', recentWatermark: { time: 1_760_000_000, id: '5001' } },
    }), 'utf8')
    const registry = new ChatRegistry(deps)
    await registry.loadMapping()
    expect(registry.chats.get('private:10001')).toBeUndefined()
    await registry.saveMapping()
    const mapping = JSON.parse(await readFile(join(deps.config.mediaDir, 'chat-sessions.json'), 'utf8')) as Record<string, { session: string; recentWatermark?: { time: number; id: string }; workspacePath?: string }>
    expect(mapping['private:10001']).toEqual({ session: 'onebot-private-10001-k3x9', recentWatermark: { time: 1_760_000_000, id: '5001' }, workspacePath: '/tmp/onebot-ws-i' })
    await registry.stop()
  })

  it('saveMapping keeps a settings-only chat that sits in neither chats nor evictedChats', async () => {
    const deps = makeRegistryDeps({ agents: makeFakeAgents([], { followups: [] }, { resumeOk: true }) })
    const registry = new ChatRegistry(deps)
    // Persisted settings without a live chat or evicted snapshot: any
    // saveMapping used to wipe this chat from the file entirely.
    registry.getSettings('private:10001').workspacePath = '/tmp/onebot-ws-j'
    registry.getSettings('private:10001').recentWatermark = { time: 1_760_000_001, id: '5002' }
    // A lazily-created empty settings entry must NOT produce a placeholder.
    registry.getSettings('private:10002')
    await registry.saveMapping()
    const mapping = JSON.parse(await readFile(join(deps.config.mediaDir, 'chat-sessions.json'), 'utf8')) as Record<string, { session: string; recentWatermark?: { time: number; id: string }; workspacePath?: string }>
    expect(mapping['private:10001']).toEqual({ session: 'onebot-private-10001', recentWatermark: { time: 1_760_000_001, id: '5002' }, workspacePath: '/tmp/onebot-ws-j' })
    expect(mapping['private:10002']).toBeUndefined()
    await registry.stop()

    // The written entry restores on a restart (resume fails harmlessly; the
    // settings still key the next fresh session).
    const registry2 = new ChatRegistry(makeRegistryDeps({ agents: makeFakeAgents([], { followups: [] }, { resumeOk: false }), config: { mediaDir: deps.config.mediaDir } }))
    await registry2.loadMapping()
    expect(registry2.getSettings('private:10001').recentWatermark).toEqual({ time: 1_760_000_001, id: '5002' })
    expect(registry2.getSettings('private:10001').workspacePath).toBe('/tmp/onebot-ws-j')
    await registry2.stop()
  })

  it('createChat keeps the evicted snapshot settings when the reactivation resume fails', async () => {
    const sessionIds: string[] = []
    const captured = { followups: [] as Array<{ text: string; sessionId: string }>, createdMeta: [] as Array<{ cwd?: string; agentPreset?: string }> }
    // resumeOk: false — only the resume fails; the fresh create still works.
    const deps = makeRegistryDeps({ agents: makeFakeAgents(sessionIds, captured, { resumeOk: false }) })
    const registry = new ChatRegistry(deps)
    registry.getSettings('private:10001').workspacePath = '/tmp/onebot-ws-k'
    registry.getSettings('private:10001').recentWatermark = { time: 1_760_000_002, id: '5003' }
    await registry.ensureChat('private:10001', '小明')
    const chat = registry.chats.get('private:10001')!
    chat.lastActivityAt = Date.now() - 8 * 24 * 60 * 60 * 1000
    await registry.sweepIdleChats()
    expect(registry.chats.has('private:10001')).toBe(false)

    // Re-activate: the resume of the evicted session fails — the snapshot's
    // settings must carry into the fresh session, and the retired session id
    // must never be reused.
    const next = await registry.ensureChat('private:10001', '小明')
    expect(next.sessionId).not.toBe(sessionIds[0])
    expect(registry.getSettings('private:10001').workspacePath).toBe('/tmp/onebot-ws-k')
    expect(registry.getSettings('private:10001').recentWatermark).toEqual({ time: 1_760_000_002, id: '5003' })
    expect(captured.createdMeta.at(-1)?.cwd).toBe('/tmp/onebot-ws-k')
    await registry.saveMapping()
    const mapping = JSON.parse(await readFile(join(deps.config.mediaDir, 'chat-sessions.json'), 'utf8')) as Record<string, { session: string; recentWatermark?: { time: number; id: string }; workspacePath?: string }>
    expect(mapping['private:10001']).toEqual({ session: next.sessionId, recentWatermark: { time: 1_760_000_002, id: '5003' }, workspacePath: '/tmp/onebot-ws-k' })
    await registry.stop()
  })
})
