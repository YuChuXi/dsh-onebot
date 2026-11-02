/**
 * 会话注册表：每个 QQ 会话绑定一个 dsh 会话，绑定状态收敛在单一 `ChatState`。
 *
 * 一个 chat 的绑定只有两种运行时形态（live / idle）与一层历史：
 * - live：`chats` 里有 agent，`bySession` 反向路由宿主会话事件；
 * - idle：agent 已释放，`state.sessionId` 仍记录绑定，下一条消息恢复；
 * - `state.retired` 记录已退役的会话 id（`kept` = 历史完好、/session 可切回）。
 *
 * 持久化只有 `chat-sessions.json` 一份：映射、每 chat 设置与退役历史都在
 * `ChatState` 里，不再维护独立的退役 / 可切回文件。`retiredIds` 是
 * `retired` 的派生索引，只用于 O(1) 的 id 复用判定。
 * @module dsh-onebot/registry
 */
import type { Agent, AgentOptions, AgentRegistry, AgentSetup, ModelSelection } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { SessionId as makeSessionId } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'

import type { ChatId, UserRole } from '../chat/index.js'
import { sessionIdForChat, splitChatId } from '../chat/index.js'
import type { AgentPresetsLike, BridgeConfig, SessionPersistenceLike, SessionReadHandleLike, SessionTitlePort, WorkspaceRegistryLike } from '../bridge/config.js'
import { describeError } from '../shared/errors.js'

/** 会话映射文件名（媒体目录内）：映射、每 chat 设置与退役历史的唯一持久化文件。 */
const MAPPING_FILE = 'chat-sessions.json'
/** 旧版独立退役 id 文件；仅在一次性迁移时读取。 */
const LEGACY_RETIRED_FILE = 'retired-sessions.json'
/** 旧版每 chat 可切回列表文件；仅在一次性迁移时读取。 */
const LEGACY_SWITCHABLE_FILE = 'switchable-sessions.json'
/** 群会话标题的前缀；同时用来识别「本插件生成的名字」。 */
const GROUP_TITLE_PREFIX = '群 '
/** 私聊会话标题的前缀；同时用来识别「本插件生成的名字」。 */
const DM_TITLE_PREFIX = '私聊 '

/** `/session` 列表的一项：一个历史完好、可切回的退役会话。 */
export interface SwitchableSession {
  id: string
  retiredAt: number
}

/** 一个已退役的会话 id。`kept` 表示历史完好、/session 可以切回；
 * 所有条目（含 kept=false）都阻止该 id 被再次创建。 */
export interface RetiredSession {
  id: string
  retiredAt: number
  kept: boolean
}

/** 一个 chat 的绑定状态：当前会话、跨会话保留的设置、已退役历史。
 * 这是会话管理的唯一状态来源；live 与否由 `chats` 是否存在 agent 决定。 */
export interface ChatState {
  /** 当前绑定的会话 id；缺省表示下一条消息将新建会话。 */
  sessionId?: string
  /** 每 chat 设置：跨 /new、驱逐与碰撞修复保留。 */
  settings: ChatSettings
  /** 已退役会话，按 retiredAt 倒序。 */
  retired: RetiredSession[]
}

/** Per-chat cap of the switchable list (hard-wired; no config surface). */
const SWITCHABLE_CAP = 20

/** The outcome of a /session switch attempt (the command layer phrases the
 * user-facing reply from `reason`; `message` carries the resume error text). */
export type SessionSwitchOutcome =
  | { ok: true; sessionId: string }
  | { ok: false; reason: 'busy' | 'not-switchable' | 'broken' | 'resume-failed'; message: string }

/** R2: one pending serial-number selection snapshot — the numbered list a
 * bare /workspace|/model|/preset|/session rendered, kept per chat so a
 * following `/cmd <序号>` picks an entry without re-listing. `payload` stores the exact
 * resolved value (workspace path / provider id / preset id / switchable session
 * id; the model level-2 list stores the model id under `provider`). Single
 * shared slot: a fresh bare call of any kind overwrites it, other commands
 * never touch it; expiry is judged lazily at the next numeric reply (commands.ts
 * PENDING_SELECTION_TTL_MS) — no timer, and the field is never persisted. */
export interface PendingSelection {
  kind: 'workspace' | 'model' | 'preset' | 'session'
  /** /model only: 'providers' (level 1) or 'models' (level 2). */
  phase?: 'providers' | 'models'
  /** /model level 2: the provider the listed models belong to. */
  provider?: string
  /** The numbered entries as displayed; payload is what a hit applies. */
  items: Array<{ label: string; payload: string }>
  createdAt: number
}

/** 每 chat 设置：全部字段跨会话重建保留（/new、驱逐、碰撞修复都不清除），
 * 只有 pendingSelection 是惰性过期的界面状态、从不持久化。 */
export interface ChatSettings {
  /** 每 chat 的 workspace 覆盖；下一次为它创建会话时生效。 */
  workspacePath?: string
  /** R2: pending serial-number selection snapshot (see PendingSelection);
   * ephemeral UI state — survives /new like every field here but never
   * persisted, and bounded by the lazy 5-minute TTL instead. */
  pendingSelection?: PendingSelection
  /** 上文水位：上一次注入给模型的最后一条消息（`{ time, id }`）。
   * 随会话映射持久化存储，重启、驱逐、换会话都不丢；窗口据此只注入新内容。 */
  recentWatermark?: RecentWatermark
}

/** 上文水位的持久化形态：秒级时间戳 + message_id。 */
export interface RecentWatermark {
  time: number
  id: string
}

/** `ChatState` 的持久化形态；`retired` 始终存在（空数组也写），作为新格式标记。 */
interface PersistedChatState {
  session?: string
  workspacePath?: string
  recentWatermark?: RecentWatermark
  retired: RetiredSession[]
}

/** 新格式条目判定：`retired` 数组即格式标记。 */
function isPersistedChatState(entry: unknown): entry is PersistedChatState {
  return entry !== null && typeof entry === 'object' && Array.isArray((entry as { retired?: unknown }).retired)
}

/** 旧格式判定：只要有 chat 条目缺少 `retired` 数组，整个文件就按旧格式迁移。 */
function isLegacyMapping(mapping: Record<string, unknown>): boolean {
  return Object.values(mapping).some(entry => !isPersistedChatState(entry))
}

/** 持久化退役条目的类型守卫。 */
function isRetiredSession(entry: unknown): entry is RetiredSession {
  if (entry === null || typeof entry !== 'object') return false
  const item = entry as { id?: unknown; retiredAt?: unknown; kept?: unknown }
  return typeof item.id === 'string' && typeof item.retiredAt === 'number' && typeof item.kept === 'boolean'
}

/** 旧版可切回条目的类型守卫（迁移时读取）。 */
function isSwitchableSession(entry: unknown): entry is SwitchableSession {
  if (entry === null || typeof entry !== 'object') return false
  const item = entry as { id?: unknown; retiredAt?: unknown }
  return typeof item.id === 'string' && typeof item.retiredAt === 'number'
}

/** One live per-chat agent. */
export interface ChatAgent {
  chatId: ChatId
  sessionId: SessionId
  agent: Agent
  dispose(): Promise<void>
  /** B8c: last activity timestamp (creation, dispatchFollowup, turn events);
   * the idle sweep evicts chats idle longer than chatIdleEvictDays. */
  lastActivityAt: number
  /** Whether a turn is currently generating. */
  busy: boolean
  typingTimer: ReturnType<typeof setInterval> | undefined
  lastNickname: string
  /** Roles of dispatched turns not yet opened (FIFO, consumed at turn/start). */
  pendingTurnRoles: UserRole[]
  /** Role of the currently running turn; stays 'member' (fail-closed) until a
   * turn/start assigns the head of pendingTurnRoles. */
  activeTurnRole: UserRole
}

/** The preset id a session's own record names: newest logged selection, else the creation header. */
export function resolveRecordedPreset(
  inspection: { meta: { agentPreset?: string }; events: readonly { type?: string; data?: { agentPreset?: string } }[] },
): string | undefined {
  const events = inspection.events
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'agent-preset/selected' && typeof event.data?.agentPreset === 'string') {
      return event.data.agentPreset
    }
  }
  return inspection.meta.agentPreset
}

/** What the registry touches. Deliberately narrower than BridgeDeps: the
 * agent registry, the persistence/workspace/preset services, the config
 * subset the registry reads, and three bridge-owned hooks — the stop flag,
 * the typing-indicator teardown for a chat leaving the registry, and the
 * channel-scope installer (the qq_* tools call back into the bridge, so the
 * agent setup closure cannot be assembled without it). */
export interface RegistryDeps {
  agents: AgentRegistry
  /** Durable session store: B8c flushes a session before its chat is evicted. */
  sessions: SessionStore
  sessionPersistence: SessionPersistenceLike | undefined
  workspaceRegistry: WorkspaceRegistryLike | undefined
  /** OneBot 动作调用：会话命名要取群名 / 好友昵称。 */
  call(action: string, params: Record<string, unknown>): Promise<unknown>
  /** 宿主会话标题服务（dsh-session-title）的惰性查找；absent = 不命名。 */
  sessionTitle?: (() => SessionTitlePort | undefined) | undefined
  agentPresets: AgentPresetsLike | undefined
  defaultModel: (() => ModelSelection | undefined) | undefined
  /** The only config fields the registry reads. */
  config: Pick<BridgeConfig, 'mediaDir' | 'workspacePath' | 'agentPreset' | 'restrictedMemberPrefix' | 'maxImageBytes' | 'maxVoiceBytes' | 'maxFileBytes' | 'chatIdleEvictDays' | 'thinkingPrivate' | 'thinkingGroup'>
  log(level: 'info' | 'warn' | 'error' | 'debug', message: string): void
  /** Bridge stop flag (guards the resume loop). */
  isStopping(): boolean
  /** Bridge-owned chat runtime teardown when a chat leaves the registry:
   * stop the typing indicator. The chat's `ChatState` stays in the registry
   * (settings and retirement history survive the release). */
  onChatRemoved(chat: ChatAgent): void
  /** Register the QQ platform prompt section + qq_* tools on a new agent's
   * own scope — bridge-owned because the tools call back into the bridge.
   * The chat id selects the group/private extra prompt. */
  installChannelScope(agentCtx: Context, chatId: ChatId): void
}

/**
 * The chat↔session registry: dual index, persistence pair, per-chat settings
 * and the shared create/resume assembly. Created by the ChatBridge
 * constructor; the bridge delegates its same-name registry methods here.
 */
export class ChatRegistry {
  private readonly deps: RegistryDeps
  /** Live chats by chat id. */
  readonly chats = new Map<ChatId, ChatAgent>()
  /** Reverse index: session id → chat id (routes session events to chats). */
  readonly bySession = new Map<string, ChatId>()
  /** 每 chat 的绑定状态；live 与 idle 的会话都记录在这里，是唯一状态源。 */
  private readonly states = new Map<ChatId, ChatState>()
  /** `states[].retired[].id` 的派生索引：判断一个会话 id 是否永久退役。 */
  private readonly retiredIds = new Set<string>()
  /** 会话 id → QQ 侧的显示名（群名 / 昵称），取到就缓存。 */
  private readonly displayNames = new Map<ChatId, string>()
  private mappingSaveTimer: ReturnType<typeof setTimeout> | undefined
  /** Resolves once the on-disk chat mapping has been loaded (wired by the bridge's start()). */
  mappingLoaded: Promise<void> = Promise.resolve()

  constructor(deps: RegistryDeps) {
    this.deps = deps
  }

  /**
   * 取一个 chat 的绑定状态，缺省时建立空状态。
   *
   * Args:
   *   chatId (ChatId): 会话 id。
   *
   * Returns:
   *   ChatState: 该 chat 的状态对象（调用方持有引用，可原地修改）。
   *
   * Callers:
   *   - `getSettings`、`createChat`、`loadMapping` 等注册表内部方法。
   */
  private stateOf(chatId: ChatId): ChatState {
    let state = this.states.get(chatId)
    if (state === undefined) {
      state = { settings: {}, retired: [] }
      this.states.set(chatId, state)
    }
    return state
  }

  /** The (lazy-created) settings entry for one chat. */
  getSettings(chatId: ChatId): ChatSettings {
    return this.stateOf(chatId).settings
  }

  /** 该会话 id 是否已退役（任何状态下的退役都阻止再次创建）。 */
  private isRetired(id: string): boolean {
    return this.retiredIds.has(id)
  }

  /**
   * 把一个会话 id 记入该 chat 的退役历史。
   *
   * Args:
   *   chatId (ChatId): 会话所属 chat。
   *   id (string): 要退役的会话 id。
   *   kept (boolean): true = 历史完好，/session 可切回；false = 不可切回。
   *   retiredAt (number): 退役时间；缺省为当前时刻，迁移时传旧记录值。
   *
   * Returns:
   *   void: 无。
   *
   * Callers:
   *   - `createChat`、`resetChat`、`switchSession`、`healSessionCollision`、`adoptLegacyMapping`。
   */
  private retire(chatId: ChatId, id: string, kept: boolean, retiredAt: number = Date.now()): void {
    const state = this.stateOf(chatId)
    const existing = state.retired.find(entry => entry.id === id)
    if (existing !== undefined) {
      existing.kept = kept
      existing.retiredAt = retiredAt
    } else {
      state.retired.unshift({ id, retiredAt, kept })
      this.retiredIds.add(id)
    }
    this.capSwitchable(state)
  }

  /** kept 条目超过上限时，把最旧的可切回项降级为不可切回（仍阻止复用）。 */
  private capSwitchable(state: ChatState): void {
    let kept = 0
    for (const entry of state.retired) {
      if (!entry.kept) continue
      kept += 1
      if (kept > SWITCHABLE_CAP) entry.kept = false
    }
  }

  /** 一个会话重新成为当前绑定时，从退役历史里移除。 */
  private unretire(chatId: ChatId, id: string): void {
    const state = this.stateOf(chatId)
    state.retired = state.retired.filter(entry => entry.id !== id)
    this.retiredIds.delete(id)
  }

  // ------------------------------------------------------------ chat lifecycle

  /**
   * 新建 / 恢复会话的初始模型选项：部署默认提供 provider / model 与思考强度，
   * 再按会话类型用 thinkingPrivate / thinkingGroup 覆盖；default 表示沿用部署
   * 默认档位。恢复会话时，宿主的持久化选择优先于这些初始选项。
   *
   * Args:
   *   chatId (ChatId): 目标会话；决定取群聊还是私聊的思考强度。
   *
   * Returns:
   *   AgentOptions: 传给 agents.create / agents.resume 的模型选项。
   *
   * Callers:
   *   - `createChat`。
   *   - `resumeChat`。
   */
  private modelWiring(chatId: ChatId): AgentOptions {
    const selection = this.deps.defaultModel?.()
    const agentOptions: AgentOptions = {}
    if (selection !== undefined) {
      agentOptions.provider = selection.provider
      agentOptions.model = selection.model
      if (selection.reasoningEffort !== undefined) agentOptions.reasoningEffort = selection.reasoningEffort
    }
    const configured = splitChatId(chatId).kind === 'group'
      ? this.deps.config.thinkingGroup
      : this.deps.config.thinkingPrivate
    if (configured !== undefined && configured !== 'default') {
      agentOptions.reasoningEffort = ReasoningEffortId(configured)
    }
    return agentOptions
  }

  /** C2: the AgentSetup closure shared by the create and resume assembly
   * paths. The only difference between the callers is the preset: a resumed
   * session rejoins the preset it recorded itself; a fresh create reuses the
   * config/default resolution already recorded in its header meta. */
  private buildSetup(chatId: ChatId, recordedPreset?: string): AgentSetup {
    return async agentCtx => {
      this.deps.installChannelScope(agentCtx, chatId)
      await this.joinPreset(agentCtx, recordedPreset)
      // dsh 0.2.2: host-style unconditional install (single-arg — it only
      // wires the model-switch notice listener; the selection itself lives
      // on agent.model). Ignoring the returned disposer matches the host
      // callers (dsh-api-session-controller/dsh-headless/dsh-acp).
      installModelSelection(agentCtx)
    }
  }

  /** C2: the ChatAgent literal shared by the create and resume assembly
   * paths — every field starts at its neutral initial value. `nickname` is
   * the one deliberate divergence between the callers (create seeds it from
   * the inbound message, resume keeps the pre-C2 hardcoded ''); pinned by
   * the M2-C2 characterization tests in bridge.spec.ts. */
  private createChatAgent(
    chatId: ChatId,
    handle: { agent: Agent; dispose(): Promise<void> },
    nickname: string,
  ): ChatAgent {
    return {
      chatId,
      sessionId: handle.agent.session.id,
      agent: handle.agent,
      dispose: () => handle.dispose(),
      lastActivityAt: Date.now(),
      busy: false,
      typingTimer: undefined,
      lastNickname: nickname,
      pendingTurnRoles: [],
      activeTurnRole: 'member',
    }
  }

  /** B8a: in-flight creates keyed by chat id — concurrent first messages for
   * one chat join a single create instead of racing. */
  private readonly pendingCreates = new Map<ChatId, Promise<ChatAgent>>()

  /** Get (or create) the agent for a chat. */
  async ensureChat(chatId: ChatId, nickname: string): Promise<ChatAgent> {
    const existing = this.chats.get(chatId)
    if (existing !== undefined) return existing
    const pending = this.pendingCreates.get(chatId)
    if (pending !== undefined) return pending
    const creation = this.createChat(chatId, nickname)
    this.pendingCreates.set(chatId, creation)
    void creation.finally(() => {
      this.pendingCreates.delete(chatId)
    }).catch(() => undefined)
    return creation
  }

  private async createChat(chatId: ChatId, nickname: string): Promise<ChatAgent> {
    await this.mappingLoaded
    const state = this.stateOf(chatId)
    // idle 会话有记录就恢复；记录指向退役会话时只清绑定、保留设置。
    const recorded = state.sessionId
    if (recorded !== undefined) {
      if (!this.isRetired(recorded)) {
        try {
          return await this.resumeChat(chatId, recorded)
        } catch (error) {
          this.retire(chatId, recorded, false)
          this.deps.log('warn', 'resume of recorded session failed for ' + chatId + '; falling back to a fresh session: ' + describeError(error))
        }
      }
      state.sessionId = undefined
    }
    let sessionId = makeSessionId(sessionIdForChat(chatId))
    if (this.isRetired(sessionId)) {
      sessionId = this.freshSessionId(chatId)
    } else if (await this.hasPersistedLog(sessionId)) {
      // The bare id still owns a stale on-disk log (e.g. a lost retirement
      // record): reusing it would collide, so retire it NOW and move to a
      // suffixed id instead of failing the chat later.
      this.retire(chatId, sessionId, false)
      sessionId = this.freshSessionId(chatId)
    }
    const agentOptions = this.modelWiring(chatId)
    const cwd = this.effectiveCwd(chatId)
    const presetId = await this.resolvePresetId()
    const meta: { cwd: string; agentPreset?: string } = { cwd }
    if (presetId !== undefined) meta.agentPreset = presetId
    const setup = this.buildSetup(chatId)
    let handle: { agent: Agent; dispose(): Promise<void> }
    try {
      handle = await this.deps.agents.create({
        sessionId,
        meta,
        agentOptions,
        setup,
      })
    } catch (error) {
      // A stale or foreign persisted log under the same id blocks creation
      // (id collision). Recover with a fresh suffixed session id instead of
      // failing the chat.
      this.retire(chatId, sessionId, false)
      const fallbackId = this.freshSessionId(chatId)
      this.deps.log('warn', 'agent create failed (' + describeError(error) + '); retrying with ' + fallbackId)
      handle = await this.deps.agents.create({
        sessionId: fallbackId,
        meta,
        agentOptions,
        setup,
      })
      this.deps.log('info', 'recovered with fresh session ' + fallbackId + ' for ' + chatId)
    }
    // The real session id is authoritative (the fallback path above creates a
    // different id than the one initially attempted); record it everywhere so
    // session events route to this chat and the mapping persists the truth.
    const actualSessionId = handle.agent.session.id
    await this.attachToWorkspace(actualSessionId, handle.agent.session.header?.cwd)
    const chat = this.createChatAgent(chatId, handle, nickname)
    try {
      await handle.agent.whenIdle()
    } catch (error) {
      // B8b: create succeeded but the first idle wait failed — dispose the
      // orphan agent instead of leaking it.
      try {
        await handle.dispose()
      } catch {
        // the whenIdle failure is the cause; a dispose failure must not mask it
      }
      throw error
    }
    this.chats.set(chatId, chat)
    this.bySession.set(actualSessionId, chatId)
    state.sessionId = actualSessionId
    this.deps.log('info', 'agent created for ' + chatId + ' (session ' + actualSessionId + ')')
    void this.saveMapping()
    void this.applySessionTitle(chat, chatId)
    return chat
  }

  /**
   * 会话在 QQ 侧的显示名：群名或好友昵称；取不到时 ''。
   *
   * Args:
   *   chatId (ChatId): 会话 id。
   *
   * Returns:
   *   Promise<string>: 显示名；查询失败时 ''（标题退回号码）。
   *
   * Callers:
   *   - `chatTitle`。
   */
  private async displayName(chatId: ChatId): Promise<string> {
    const cached = this.displayNames.get(chatId)
    if (cached !== undefined) return cached
    const { kind, target } = splitChatId(chatId)
    try {
      let name: string
      if (kind === 'group') {
        const info = await this.deps.call('get_group_info', { group_id: Number(target) }) as { group_name?: unknown } | undefined
        name = typeof info?.group_name === 'string' ? info.group_name : ''
      } else {
        const info = await this.deps.call('get_stranger_info', { user_id: Number(target) }) as { nickname?: unknown } | undefined
        name = typeof info?.nickname === 'string' ? info.nickname : ''
      }
      if (name !== '') this.displayNames.set(chatId, name)
      return name
    } catch (error) {
      this.deps.log('debug', 'chat name lookup failed for ' + chatId + ': ' + describeError(error))
      return ''
    }
  }

  /**
   * 会话标题：「群 <群名> · MM-DD HH:MM」/「私聊 <昵称> · MM-DD HH:MM」，
   * 时间取会话自身的建立时间而不是被挂上的时刻。
   *
   * Args:
   *   chatId (ChatId): 会话 id。
   *   startedAt (number | undefined): 会话建立时间（毫秒）。
   *
   * Returns:
   *   Promise<string>: 标题文本。
   *
   * Callers:
   *   - `applySessionTitle`。
   */
  private async chatTitle(chatId: ChatId, startedAt: number | undefined): Promise<string> {
    const { kind, target } = splitChatId(chatId)
    const name = await this.displayName(chatId)
    const started = new Date(typeof startedAt === 'number' && startedAt > 0 ? startedAt : Date.now())
    const pad = (value: number): string => String(value).padStart(2, '0')
    return (kind === 'group' ? GROUP_TITLE_PREFIX : DM_TITLE_PREFIX)
      + (name !== '' ? name : target)
      + ' · ' + pad(started.getMonth() + 1) + '-' + pad(started.getDate())
      + ' ' + pad(started.getHours()) + ':' + pad(started.getMinutes())
  }

  /**
   * 给会话起名，宿主会话列表不再是一片「未命名」。
   * 只接管空标题与自己生成的名字（「群 」/「私聊 」开头），用户手动改名永不覆盖。
   *
   * Args:
   *   chat (ChatAgent): 刚建立或恢复的会话。
   *   chatId (ChatId): 会话 id。
   *
   * Returns:
   *   Promise<void>: 完成（失败只记日志）。
   *
   * Callers:
   *   - `createChat`、`resumeChat`。
   */
  private async applySessionTitle(chat: ChatAgent, chatId: ChatId): Promise<void> {
    try {
      const service = this.deps.sessionTitle?.()
      if (service === undefined) {
        this.deps.log('debug', 'sessionTitle 服务不可用，跳过会话命名: ' + chatId)
        return
      }
      const session = chat.agent.session
      const current = String(service.get(session)?.title ?? '')
      const title = await this.chatTitle(chatId, session.header?.createdAt)
      if (current === title) return
      if (current !== '' && !current.startsWith(GROUP_TITLE_PREFIX) && !current.startsWith(DM_TITLE_PREFIX)) return
      const snapshot = service.rename(session, title)
      this.deps.log('info', 'session titled for ' + chatId + ': ' + snapshot.title)
    } catch (error) {
      this.deps.log('warn', 'session title failed for ' + chatId + ': ' + describeError(error))
    }
  }

  /**
   * 从映射文件恢复所有 idle 会话；旧格式在这里一次性迁移成新格式。
   *
   * 迁移只发生在旧文件存在时：读取旧映射、旧可切回列表与旧全局退役列表，
   * 合并成 `ChatState` 后立即以新格式重写，旧文件之后不再读取。
   *
   * Args:
   *   无。
   *
   * Returns:
   *   Promise<void>: 完成（映射缺失或损坏时以空状态继续）。
   *
   * Callers:
   *   - `src/bridge/index.ts:start`（ready 链）。
   */
  async loadMapping(): Promise<void> {
    let content: string
    try {
      content = await readFile(this.mappingPath(), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        this.deps.log('warn', 'mapping read failed; starting with no chats: ' + describeError(error))
      }
      return
    }
    let mapping: Record<string, unknown>
    try {
      mapping = JSON.parse(content) as Record<string, unknown>
    } catch (error) {
      this.deps.log('warn', 'mapping file is unparsable; starting with no chats: ' + describeError(error))
      return
    }
    if (isLegacyMapping(mapping)) await this.adoptLegacyMapping(mapping)
    else this.adoptMapping(mapping)
    this.deps.log('debug', 'mapping file has ' + this.states.size + ' chat(s)')

    for (const [chatId, state] of this.states) {
      const sessionId = state.sessionId
      if (sessionId === undefined) continue
      if (this.isRetired(sessionId)) {
        state.sessionId = undefined
        continue
      }
      this.deps.log('debug', 'attempting resume of ' + chatId + ' @ ' + sessionId)
      if (this.deps.isStopping()) return
      try {
        await this.resumeChat(chatId, sessionId)
      } catch (error) {
        this.retire(chatId, sessionId, false)
        state.sessionId = undefined
        this.deps.log('warn', 'resume failed for ' + chatId + ': ' + describeError(error))
      }
    }
    await this.saveMapping()
  }

  /** 把持久化条目写入内存状态（新格式）。 */
  private adoptMapping(mapping: Record<string, unknown>): void {
    for (const [chatId, raw] of Object.entries(mapping)) {
      if (!isPersistedChatState(raw)) continue
      const state = this.stateOf(chatId)
      if (typeof raw.session === 'string' && raw.session !== '') state.sessionId = raw.session
      this.adoptSettings(state, raw)
      for (const entry of raw.retired) {
        if (!isRetiredSession(entry)) continue
        state.retired.push({ id: entry.id, retiredAt: entry.retiredAt, kept: entry.kept })
        this.retiredIds.add(entry.id)
      }
    }
  }

  /**
   * 一次性迁移旧版三文件格式。
   *
   * Args:
   *   mapping (Record<string, unknown>): 旧映射（字符串或 `{ session, … }`）。
   *
   * Returns:
   *   Promise<void>: 迁移完成并以新格式重写映射文件。
   *
   * Callers:
   *   - `loadMapping`（仅当文件仍是旧格式时）。
   */
  private async adoptLegacyMapping(mapping: Record<string, unknown>): Promise<void> {
    const switchable = await this.readLegacyJson(this.mediaPath(LEGACY_SWITCHABLE_FILE))
    const retired = await this.readLegacyJson(this.mediaPath(LEGACY_RETIRED_FILE))
    const retiredIds = new Set(Array.isArray(retired)
      ? retired.filter((id): id is string => typeof id === 'string')
      : [])
    for (const [chatId, raw] of Object.entries(mapping)) {
      let session = ''
      if (typeof raw === 'string') {
        session = raw
      } else if (raw !== null && typeof raw === 'object') {
        const entry = raw as { session?: unknown; workspacePath?: unknown; recentWatermark?: unknown }
        if (typeof entry.session === 'string') session = entry.session
        this.adoptSettings(this.stateOf(chatId), entry)
      }
      if (session === '') continue
      const state = this.stateOf(chatId)
      const history = (switchable as Record<string, unknown> | undefined)?.[chatId]
      if (Array.isArray(history)) {
        // 旧列表是新→旧；retire() 用 unshift 入表，倒序循环才能保持顺序。
        for (const item of [...history].reverse()) {
          if (!isSwitchableSession(item)) continue
          if (!state.retired.some(entry => entry.id === item.id)) this.retire(chatId, item.id, true, item.retiredAt)
        }
      }
      if (retiredIds.has(session)) {
        if (!state.retired.some(entry => entry.id === session)) this.retire(chatId, session, false)
      } else {
        state.sessionId = session
      }
    }
    await this.saveMapping()
  }

  /** 读取旧格式 JSON；缺失或损坏时记录日志并返回 undefined（迁移只用一次）。 */
  private async readLegacyJson(path: string): Promise<unknown> {
    let content: string
    try {
      content = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        this.deps.log('warn', 'legacy file read failed (' + path + '): ' + describeError(error))
      }
      return undefined
    }
    try {
      return JSON.parse(content) as unknown
    } catch (error) {
      this.deps.log('warn', 'legacy file is unparsable (' + path + '): ' + describeError(error))
      return undefined
    }
  }

  /** 把持久化的 workspace 覆盖与水位写进状态（新格式与迁移共用）。 */
  private adoptSettings(state: ChatState, raw: { workspacePath?: unknown; recentWatermark?: unknown }): void {
    if (typeof raw.workspacePath === 'string' && raw.workspacePath !== '') state.settings.workspacePath = raw.workspacePath
    const watermark = raw.recentWatermark as RecentWatermark | undefined
    if (watermark !== undefined && Number.isFinite(watermark.time)) {
      state.settings.recentWatermark = { time: watermark.time, id: String(watermark.id ?? '') }
    }
  }

  /** Resume one persisted chat from its recorded session id. */
  private async resumeChat(chatId: ChatId, sessionId: string): Promise<ChatAgent> {
    const agentOptions = this.modelWiring(chatId)
    const recordedPreset = await this.recordedPresetFor(makeSessionId(sessionId))
    const handle = await this.deps.agents.resume({
      resumeSessionId: makeSessionId(sessionId),
      agentOptions,
      setup: this.buildSetup(chatId, recordedPreset),
    })
    await this.attachToWorkspace(handle.agent.session.id, handle.agent.session.header?.cwd)
    // /workspace persistence across restarts: the per-chat override is
    // in-memory only, but a session's cwd is frozen in its header. When the
    // resumed session's directory differs from what this chat would default
    // to now, restore it as the override so future /new sessions keep using it.
    const headerCwd = handle.agent.session.header?.cwd
    if (headerCwd !== undefined && headerCwd !== '' && headerCwd !== this.effectiveCwd()) {
      this.getSettings(chatId).workspacePath = headerCwd
      this.deps.log('debug', 'workspace override restored for ' + chatId + ': ' + headerCwd)
    }
    const chat = this.createChatAgent(chatId, handle, '')
    try {
      await handle.agent.whenIdle()
    } catch (error) {
      // B8b: same orphan rule as the create path — dispose before rethrowing.
      try {
        await handle.dispose()
      } catch {
        // the whenIdle failure is the cause
      }
      throw error
    }
    this.chats.set(chatId, chat)
    this.bySession.set(handle.agent.session.id, chatId)
    this.stateOf(chatId).sessionId = handle.agent.session.id
    void this.applySessionTitle(chat, chatId)
    return chat
  }

  private mediaPath(name: string): string {
    return this.deps.config.mediaDir.endsWith('/') || this.deps.config.mediaDir.endsWith('\\')
      ? this.deps.config.mediaDir + name
      : this.deps.config.mediaDir + '/' + name
  }

  private mappingPath(): string {
    return this.mediaPath(MAPPING_FILE)
  }

  /**
   * 把全部 chat 状态写回映射文件（临时文件 + rename 原子替换）。
   * 空状态（无当前会话、无设置、无退役历史）不写占位条目。
   *
   * Args:
   *   无。
   *
   * Returns:
   *   Promise<void>: 完成（写失败只记日志）。
   *
   * Callers:
   *   - `createChat`、`loadMapping`、`saveMappingDebounced`、`stop` 等。
   */
  async saveMapping(): Promise<void> {
    try {
      await mkdir(this.deps.config.mediaDir, { recursive: true })
      const mapping: Record<string, PersistedChatState> = {}
      for (const [chatId, state] of this.states) {
        const entry: PersistedChatState = { retired: state.retired }
        if (state.sessionId !== undefined) entry.session = state.sessionId
        const workspacePath = state.settings.workspacePath
        if (workspacePath !== undefined && workspacePath !== '') entry.workspacePath = workspacePath
        const watermark = state.settings.recentWatermark
        if (watermark !== undefined && Number.isFinite(watermark.time)) entry.recentWatermark = watermark
        if (entry.session === undefined && entry.workspacePath === undefined
          && entry.recentWatermark === undefined && entry.retired.length === 0) continue
        mapping[chatId] = entry
      }
      const tmpPath = this.mappingPath() + '.tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
      await writeFile(tmpPath, JSON.stringify(mapping, null, 2), 'utf8')
      await rename(tmpPath, this.mappingPath())
    } catch (error) {
      this.deps.log('warn', 'mapping save failed: ' + describeError(error))
    }
  }

  saveMappingDebounced(): void {
    if (this.mappingSaveTimer !== undefined) clearTimeout(this.mappingSaveTimer)
    this.mappingSaveTimer = setTimeout(() => {
      this.mappingSaveTimer = undefined
      void this.saveMapping()
    }, 2_000).unref()
  }

  /** B8c: dispose chats whose last activity is older than chatIdleEvictDays
   * (0 disables; default 7). Called before each inbound message: the session
   * is flushed, the agent disposed, and the chat removed from
   * chats/bySession — NOT retired, `state.sessionId` keeps the pair so a
   * later message (or a restart) resumes the same session. */
  async sweepIdleChats(): Promise<void> {
    const days = this.deps.config.chatIdleEvictDays ?? 7
    if (days <= 0 || this.deps.isStopping()) return
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
    for (const [chatId, chat] of [...this.chats]) {
      if (chat.lastActivityAt > cutoff) continue
      await this.evictChat(chatId, chat)
    }
  }

  /**
   * 把会话转入 idle：先 flush 保证可恢复，再释放 agent 并移除 live 索引；
   * `state.sessionId` 保留，下一条消息按记录恢复。
   *
   * Args:
   *   chatId (ChatId): 会话 id。
   *   chat (ChatAgent): 活跃 agent。
   *
   * Returns:
   *   Promise<void>: 完成；flush 失败时保留活跃会话，等下次消息再试。
   *
   * Callers:
   *   - `sweepIdleChats`。
   */
  private async evictChat(chatId: ChatId, chat: ChatAgent): Promise<void> {
    // Only evict a session that is durably persisted; a failed flush keeps
    // the chat alive and the sweep retries on the next message.
    try {
      await this.deps.sessions.flush(chat.agent.session)
    } catch (error) {
      this.deps.log('warn', 'idle-evict flush failed for ' + chatId + ' (keeping the chat): ' + describeError(error))
      return
    }
    this.deps.onChatRemoved(chat)
    this.chats.delete(chatId)
    this.bySession.delete(chat.sessionId)
    try {
      await chat.dispose()
    } catch (error) {
      this.deps.log('warn', 'idle-evict dispose failed for ' + describeError(error))
    }
    this.deps.log('info', 'evicted idle chat ' + chatId + ' (session ' + chat.sessionId + ' kept resumable)')
  }

  // ------------------------------------------------------------ retired ids

  /** A suffixed session id for a chat that avoids every retired id. */
  private freshSessionId(chatId: ChatId): SessionId {
    let id: SessionId
    do {
      id = makeSessionId(sessionIdForChat(chatId) + '-' + Date.now().toString(36))
    } while (this.isRetired(id))
    return id
  }

  /** Whether the persistence layer already owns a durable log for this id —
   * true means reusing the id would collide (stale on-disk log or live entry).
   * A read failure counts as no log so the caller falls back to the normal
   * path rather than blocking an id on a transient error. */
  private async hasPersistedLog(id: SessionId): Promise<boolean> {
    const persistence = this.deps.sessionPersistence
    if (persistence === undefined) return false
    try {
      // A snapshot means the id owns a durable log; missing or a read failure
      // counts as no log.
      return (await persistence.stat(id)) !== undefined
    } catch {
      return false
    }
  }

  /**
   * 该 chat 的可切回历史会话（新→旧）。
   *
   * Args:
   *   chatId (ChatId): 会话 id。
   *
   * Returns:
   *   SwitchableSession[]: 历史完好的退役会话副本。
   *
   * Callers:
   *   - `src/bridge/index.ts` 命令上下文（/session 列表）。
   */
  switchableSessions(chatId: ChatId): SwitchableSession[] {
    return this.stateOf(chatId).retired
      .filter(entry => entry.kept)
      .map(entry => ({ id: entry.id, retiredAt: entry.retiredAt }))
  }

  /**
   * /session <序号>: 把 chat 切回历史里一个 kept 的退役会话。
   *
   * 校验按 chat 隔离（别的 chat 的历史不可见）；有活跃会话时先把当前会话
   * 软退役进历史，再恢复目标；成功后目标从历史移除、成为当前绑定。
   * 恢复失败则把目标降级为不可切回、清空当前绑定，下一条消息新建会话。
   *
   * Args:
   *   chatId (ChatId): 会话 id。
   *   targetSessionId (string): 目标会话 id。
   *
   * Returns:
   *   Promise<SessionSwitchOutcome>: 切换结果；失败带原因。
   *
   * Callers:
   *   - `src/bridge/index.ts` 命令上下文（/session <序号>）。
   */
  async switchSession(chatId: ChatId, targetSessionId: string): Promise<SessionSwitchOutcome> {
    const target = targetSessionId.trim()
    const state = this.stateOf(chatId)
    const history = state.retired.find(entry => entry.id === target)
    if (history === undefined) {
      this.deps.log('warn', 'session switch rejected for ' + chatId + ': ' + target + ' is not in the chat switchable list')
      return { ok: false, reason: 'not-switchable', message: '目标会话不在该 chat 的可切回列表中' }
    }
    if (!history.kept) {
      this.deps.log('warn', 'session switch rejected for ' + chatId + ': ' + target + ' is broken')
      return { ok: false, reason: 'broken', message: '目标会话已损坏' }
    }
    const chat = this.chats.get(chatId)
    if (chat !== undefined && chat.busy) {
      return { ok: false, reason: 'busy', message: '当前会话正在生成' }
    }
    if (chat !== undefined) {
      this.retire(chatId, chat.sessionId, true)
      this.chats.delete(chatId)
      this.bySession.delete(chat.sessionId)
      this.deps.onChatRemoved(chat)
      try {
        await chat.dispose()
      } catch (error) {
        this.deps.log('warn', 'session switch dispose failed: ' + describeError(error))
      }
    }
    state.sessionId = undefined
    try {
      await this.resumeChat(chatId, target)
    } catch (error) {
      // The target's log is unusable: mark it dead, drop the binding and let
      // the chat rebuild on a fresh session (never stuck).
      this.retire(chatId, target, false)
      void this.saveMapping()
      this.deps.log('warn', 'session switch resume failed for ' + chatId + ' -> ' + target + '; falling back to a fresh session: ' + describeError(error))
      return { ok: false, reason: 'resume-failed', message: describeError(error) }
    }
    this.unretire(chatId, target)
    void this.saveMapping()
    this.deps.log('info', 'session switch for ' + chatId + ' -> ' + target)
    return { ok: true, sessionId: target }
  }

  /**
   * 会话日志与磁盘不一致时重建：当前与裸 id 都记入退役历史，释放 agent；
   * 下一条消息新建会话。
   *
   * Args:
   *   chatId (ChatId): 会话 id。
   *
   * Returns:
   *   Promise<void>: 完成。
   *
   * Callers:
   *   - `src/bridge/index.ts:onSessionEvent`（turn/end 的错误匹配）。
   */
  async healSessionCollision(chatId: ChatId): Promise<void> {
    const chat = this.chats.get(chatId)
    if (chat === undefined) return
    this.retire(chatId, chat.sessionId, false)
    // The bare derived id shares the chat's stale log; retire it too so the
    // next ensureChat can never pick it again in this run OR after a restart.
    this.retire(chatId, sessionIdForChat(chatId), false)
    this.stateOf(chatId).sessionId = undefined
    this.chats.delete(chatId)
    this.bySession.delete(chat.sessionId)
    this.deps.onChatRemoved(chat)
    try {
      await chat.dispose()
    } catch (error) {
      this.deps.log('warn', 'collision heal dispose failed: ' + describeError(error))
    }
    this.deps.log('warn', 'healed session collision for ' + chatId + '; a fresh session will be created on next message')
    void this.saveMapping()
  }

  // ------------------------------------------------------------ workspace & preset

  /**
   * Effective workspace directory for a chat's sessions: the per-chat
   * /workspace override when set, else the configured workspacePath, falling
   * back to the host process cwd.
   */
  effectiveCwd(chatId?: ChatId): string {
    if (chatId !== undefined) {
      const override = this.getSettings(chatId).workspacePath
      if (override !== undefined && override !== '') return override
    }
    const configured = this.deps.config.workspacePath
    return configured !== undefined && configured !== '' ? configured : process.cwd()
  }

  /**
   * 新会话记录并加入的预设 id：配置优先，否则取部署默认；
   * 与 Web 界面使用同一解析，跨渠道会话的 header 因此一致。
   *
   * Args:
   *   无。
   *
   * Returns:
   *   Promise<string | undefined>: 有效预设 id；预设服务缺失或解析失败时 undefined。
   *
   * Callers:
   *   - `createChat`（写入新会话的 header meta）。
   */
  private async resolvePresetId(): Promise<string | undefined> {
    const presets = this.deps.agentPresets
    if (presets === undefined) return undefined
    const configured = this.deps.config.agentPreset
    const wanted = configured !== undefined && configured !== '' ? configured : presets.defaultId
    try {
      const preset = await presets.resolve(wanted)
      return preset.id
    } catch (error) {
      this.deps.log('warn', 'agent preset resolve failed; session header records no preset: ' + describeError(error))
      return undefined
    }
  }

  /**
   * The preset id a persisted session recorded for itself (newest logged
   * selection wins, else the creation header), or undefined when it recorded
   * none or the record cannot be read — a legacy session resumes under the
   * config/default, preserving its original behavior.
   */
  private async recordedPresetFor(sessionId: SessionId): Promise<string | undefined> {
    const persistence = this.deps.sessionPersistence
    if (persistence === undefined) return undefined
    // 0.1.6 has no `inspect`: read the same record through open('read') — the
    // immutable header carries the creation preset, the full event log the
    // newest `agent-preset/selected`. The handle MUST close even on failure
    // (AsyncDisposable — a leaked read handle pins backend resources).
    let handle: SessionReadHandleLike | undefined
    try {
      handle = await persistence.open(sessionId, 'read')
      return resolveRecordedPreset({
        meta: { agentPreset: handle.header.agentPreset },
        events: (await handle.read()).events,
      })
    } catch (error) {
      this.deps.log('warn', 'preset record read failed for ' + sessionId + ' (falling back to config/default): ' + describeError(error))
      return undefined
    } finally {
      if (handle !== undefined) {
        try {
          await handle.close()
        } catch {
          // Best-effort teardown: the read outcome above already decided.
        }
      }
    }
  }

  /**
   * Join the QQ agent to the configured agent preset (the deployment default
   * when unset) so its tools/prompt sections/skill catalog resolve against the
   * preset composition instead of the empty global layer. `preferred` — the
   * preset the session itself recorded — overrides the config (its history was
   * produced under that composition; replaying it differently would break the
   * recorded tool calls); a conflicting config only logs. Best-effort: a
   * broken preset falls back to the previous behavior rather than failing the
   * chat.
   */
  private async joinPreset(agentCtx: unknown, preferred?: string): Promise<void> {
    if (this.deps.agentPresets === undefined) return
    const configured = this.deps.config.agentPreset
    if (preferred !== undefined && configured !== undefined && configured !== '' && configured !== preferred) {
      this.deps.log('warn', 'session records preset ' + preferred + ' but plugin config names ' + configured + '; resuming under the recorded preset')
    }
    const selected = preferred ?? (configured !== undefined && configured !== '' ? configured : undefined)
    try {
      const preset = await this.deps.agentPresets.mount(agentCtx, selected)
      this.deps.log('debug', 'agent joined preset ' + preset.id)
    } catch (error) {
      this.deps.log('warn', 'agent preset mount failed (tools fall back to the global layer): ' + describeError(error))
    }
  }

  /**
   * Attach a chat session to the workspace owning its header cwd, so QQ
   * sessions group under a workspace in the GUI instead of "Ungrouped".
   * Best-effort: failure only logs.
   *
   * A workspace is auto-created only when the session cwd matches the
   * configured workspacePath (new sessions). A resumed session carrying a
   * foreign cwd (e.g. created under an earlier host cwd) is attached only when
   * a workspace already owns that path — never auto-created, so legacy
   * sessions cannot spawn accidental workspaces.
   */
  private async attachToWorkspace(sessionId: string, headerCwd: string | undefined): Promise<void> {
    const registry = this.deps.workspaceRegistry
    if (registry === undefined) return
    try {
      if (headerCwd === undefined || headerCwd === '') {
        this.deps.log('warn', 'workspace attach skipped: session header carries no cwd')
        return
      }
      const workspace = await registry.resolveByPath(headerCwd)
      if (workspace === undefined) {
        if (headerCwd !== this.effectiveCwd()) {
          this.deps.log('debug', 'workspace attach skipped: no workspace owns ' + headerCwd + ' and it differs from the configured workspacePath')
          return
        }
        const created = await registry.create(headerCwd)
        this.deps.log('info', 'created workspace for ' + headerCwd)
        await created.attachSession(sessionId)
        this.deps.log('info', 'attached session ' + sessionId + ' to workspace ' + headerCwd)
        return
      }
      await workspace.attachSession(sessionId)
      this.deps.log('info', 'attached session ' + sessionId + ' to workspace ' + headerCwd)
    } catch (error) {
      this.deps.log('warn', 'workspace attach failed for ' + sessionId + ': ' + describeError(error))
    }
  }

  /**
   * /new：释放当前 agent，把当前会话软退役进历史，清空绑定；
   * 下一条消息新建会话，旧对话留在 `/session` 可切回列表里。
   *
   * live 与 idle 的绑定都按同一语义退役：idle 会话同样从历史里可见，
   * 不清空绑定的话下一条消息会恢复旧会话。
   *
   * 裸 id 与当前会话不同、且尚未记入历史时额外记为不可切回：它的磁盘日志
   * 会与未来的裸 id 会话碰撞。已在历史里的裸 id 保持原状态（仍是可切回项）。
   * 设置对象原样保留，继续作用于此 chat 的下一个会话。
   *
   * Args:
   *   chatId (ChatId): 会话 id。
   *
   * Returns:
   *   Promise<void>: 完成（无绑定时只写回映射）。
   *
   * Callers:
   *   - `src/bridge/index.ts:resetChat`（/new 命令）。
   */
  async resetChat(chatId: ChatId): Promise<void> {
    const state = this.stateOf(chatId)
    const chat = this.chats.get(chatId)
    const sessionId = chat !== undefined ? chat.sessionId : state.sessionId
    if (sessionId !== undefined) {
      this.retire(chatId, sessionId, true)
      const bareId = sessionIdForChat(chatId)
      if (bareId !== sessionId && !state.retired.some(entry => entry.id === bareId)) {
        this.retire(chatId, bareId, false)
      }
      state.sessionId = undefined
      if (chat !== undefined) {
        this.deps.onChatRemoved(chat)
        this.chats.delete(chatId)
        this.bySession.delete(sessionId)
        try {
          await chat.dispose()
        } catch (error) {
          this.deps.log('warn', 'reset dispose failed: ' + describeError(error))
        }
      }
      this.deps.log('info', 'reset chat ' + chatId + ' (old session ' + sessionId + ' retired)')
    }
    void this.saveMapping()
  }

  /**
   * 该 chat 当前绑定的会话 id：live 与 idle 都记录在 `ChatState`，未绑定时 undefined。
   *
   * Args:
   *   chatId (ChatId): 会话 id。
   *
   * Returns:
   *   string | undefined: 当前绑定的会话 id。
   *
   * Callers:
   *   - `src/bridge/index.ts` 命令上下文（/session 的当前项）。
   */
  currentSessionId(chatId: ChatId): string | undefined {
    return this.states.get(chatId)?.sessionId
  }

  /** Stop everything registry-owned: cancel the debounce timer, save the
   * mapping, dispose every agent, clear both indexes. */
  async stop(): Promise<void> {
    if (this.mappingSaveTimer !== undefined) {
      clearTimeout(this.mappingSaveTimer)
      this.mappingSaveTimer = undefined
    }
    await this.saveMapping()
    for (const chat of this.chats.values()) {
      this.deps.onChatRemoved(chat)
      try {
        await chat.dispose()
      } catch (error) {
        this.deps.log('warn', 'agent dispose failed: ' + String(error))
      }
    }
    this.chats.clear()
    this.bySession.clear()
  }
}
