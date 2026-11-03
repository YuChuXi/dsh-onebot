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
import type { Agent, AgentRegistry, ModelSelection } from '@deepseek-ai/dsh-agent';
import type { SessionId, SessionStore } from '@deepseek-ai/dsh-session';
import type { Context } from '@deepseek-ai/cordis';
import type { ChatId, UserRole } from '../chat/index.js';
import type { AgentPresetsLike, BridgeConfig, ChatModelBinding, SessionPersistenceLike, SessionTitlePort, WorkspaceRegistryLike } from '../bridge/config.js';
/** `/session` 列表的一项：一个历史完好、可切回的退役会话。 */
export interface SwitchableSession {
    id: string;
    retiredAt: number;
}
/** 一个已退役的会话 id。`kept` 表示历史完好、/session 可以切回；
 * 所有条目（含 kept=false）都阻止该 id 被再次创建。 */
export interface RetiredSession {
    id: string;
    retiredAt: number;
    kept: boolean;
}
/** 一个 chat 的绑定状态：当前会话、跨会话保留的设置、已退役历史。
 * 这是会话管理的唯一状态来源；live 与否由 `chats` 是否存在 agent 决定。 */
export interface ChatState {
    /** 当前绑定的会话 id；缺省表示下一条消息将新建会话。 */
    sessionId?: string;
    /** 每 chat 设置：跨 /new、驱逐与碰撞修复保留。 */
    settings: ChatSettings;
    /** 已退役会话，按 retiredAt 倒序。 */
    retired: RetiredSession[];
}
/** The outcome of a /session switch attempt (the command layer phrases the
 * user-facing reply from `reason`; `message` carries the resume error text). */
export type SessionSwitchOutcome = {
    ok: true;
    sessionId: string;
} | {
    ok: false;
    reason: 'busy' | 'not-switchable' | 'broken' | 'resume-failed';
    message: string;
};
/** R2: one pending serial-number selection snapshot — the numbered list a
 * bare /workspace|/model|/preset|/session rendered, kept per chat so a
 * following `/cmd <序号>` picks an entry without re-listing. `payload` stores the exact
 * resolved value (workspace path / provider id / preset id / switchable session
 * id; the model level-2 list stores the model id under `provider`). Single
 * shared slot: a fresh bare call of any kind overwrites it, other commands
 * never touch it; expiry is judged lazily at the next numeric reply (commands.ts
 * PENDING_SELECTION_TTL_MS) — no timer, and the field is never persisted. */
export interface PendingSelection {
    kind: 'workspace' | 'model' | 'preset' | 'session';
    /** /model only: 'providers' (level 1) or 'models' (level 2). */
    phase?: 'providers' | 'models';
    /** /model level 2: the provider the listed models belong to. */
    provider?: string;
    /** The numbered entries as displayed; payload is what a hit applies. */
    items: Array<{
        label: string;
        payload: string;
    }>;
    createdAt: number;
}
/** 每 chat 设置：全部字段跨会话重建保留（/new、驱逐、碰撞修复都不清除），
 * 只有 pendingSelection 是惰性过期的界面状态、从不持久化。 */
export interface ChatSettings {
    /** 每 chat 的 workspace 覆盖；下一次为它创建会话时生效。 */
    workspacePath?: string;
    /** R2: pending serial-number selection snapshot (see PendingSelection);
     * ephemeral UI state — survives /new like every field here but never
     * persisted, and bounded by the lazy 5-minute TTL instead. */
    pendingSelection?: PendingSelection;
    /** 上文水位：上一次注入给模型的最后一条消息（`{ time, id }`）。
     * 随会话映射持久化存储，重启、驱逐、换会话都不丢；窗口据此只注入新内容。 */
    recentWatermark?: RecentWatermark;
}
/** 上文水位的持久化形态：秒级时间戳 + message_id。 */
export interface RecentWatermark {
    time: number;
    id: string;
}
/** One live per-chat agent. */
export interface ChatAgent {
    chatId: ChatId;
    sessionId: SessionId;
    agent: Agent;
    dispose(): Promise<void>;
    /** B8c: last activity timestamp (creation, dispatchFollowup, turn events);
     * the idle sweep evicts chats idle longer than chatIdleEvictDays. */
    lastActivityAt: number;
    /** Whether a turn is currently generating. */
    busy: boolean;
    typingTimer: ReturnType<typeof setInterval> | undefined;
    lastNickname: string;
    /** Roles of dispatched turns not yet opened (FIFO, consumed at turn/start). */
    pendingTurnRoles: UserRole[];
    /** Role of the currently running turn; stays 'member' (fail-closed) until a
     * turn/start assigns the head of pendingTurnRoles. */
    activeTurnRole: UserRole;
}
/** The preset id a session's own record names: newest logged selection, else the creation header. */
export declare function resolveRecordedPreset(inspection: {
    meta: {
        agentPreset?: string;
    };
    events: readonly {
        type?: string;
        data?: {
            agentPreset?: string;
        };
    }[];
}): string | undefined;
/** What the registry touches. Deliberately narrower than BridgeDeps: the
 * agent registry, the persistence/workspace/preset services, the config
 * subset the registry reads, and three bridge-owned hooks — the stop flag,
 * the typing-indicator teardown for a chat leaving the registry, and the
 * channel-scope installer (the qq_* tools call back into the bridge, so the
 * agent setup closure cannot be assembled without it). */
export interface RegistryDeps {
    agents: AgentRegistry;
    /** Durable session store: B8c flushes a session before its chat is evicted. */
    sessions: SessionStore;
    sessionPersistence: SessionPersistenceLike | undefined;
    workspaceRegistry: WorkspaceRegistryLike | undefined;
    /** OneBot 动作调用：会话命名要取群名 / 好友昵称。 */
    call(action: string, params: Record<string, unknown>): Promise<unknown>;
    /** 宿主会话标题服务（dsh-session-title）的惰性查找；absent = 不命名。 */
    sessionTitle?: (() => SessionTitlePort | undefined) | undefined;
    agentPresets: AgentPresetsLike | undefined;
    defaultModel: (() => ModelSelection | undefined) | undefined;
    /** The only config fields the registry reads. */
    config: Pick<BridgeConfig, 'mediaDir' | 'workspacePath' | 'agentPreset' | 'restrictedMemberPrefix' | 'maxImageBytes' | 'maxVoiceBytes' | 'maxFileBytes' | 'chatIdleEvictDays' | 'thinkingPrivate' | 'thinkingGroup' | 'modelPrivate' | 'modelGroup'>;
    log(level: 'info' | 'warn' | 'error' | 'debug', message: string): void;
    /** Bridge stop flag (guards the resume loop). */
    isStopping(): boolean;
    /** Bridge-owned chat runtime teardown when a chat leaves the registry:
     * stop the typing indicator. The chat's `ChatState` stays in the registry
     * (settings and retirement history survive the release). */
    onChatRemoved(chat: ChatAgent): void;
    /** Register the QQ platform prompt section + qq_* tools on a new agent's
     * own scope — bridge-owned because the tools call back into the bridge.
     * The chat id selects the group/private extra prompt. */
    installChannelScope(agentCtx: Context, chatId: ChatId): void;
}
/**
 * The chat↔session registry: dual index, persistence pair, per-chat settings
 * and the shared create/resume assembly. Created by the ChatBridge
 * constructor; the bridge delegates its same-name registry methods here.
 */
export declare class ChatRegistry {
    private readonly deps;
    /** Live chats by chat id. */
    readonly chats: Map<string, ChatAgent>;
    /** Reverse index: session id → chat id (routes session events to chats). */
    readonly bySession: Map<string, string>;
    /** 每 chat 的绑定状态；live 与 idle 的会话都记录在这里，是唯一状态源。 */
    private readonly states;
    /** `states[].retired[].id` 的派生索引：判断一个会话 id 是否永久退役。 */
    private readonly retiredIds;
    /** 会话 id → QQ 侧的显示名（群名 / 昵称），取到就缓存。 */
    private readonly displayNames;
    private mappingSaveTimer;
    /** Resolves once the on-disk chat mapping has been loaded (wired by the bridge's start()). */
    mappingLoaded: Promise<void>;
    constructor(deps: RegistryDeps);
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
    private stateOf;
    /** The (lazy-created) settings entry for one chat. */
    getSettings(chatId: ChatId): ChatSettings;
    /** 该会话 id 是否已退役（任何状态下的退役都阻止再次创建）。 */
    private isRetired;
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
    private retire;
    /** kept 条目超过上限时，把最旧的可切回项降级为不可切回（仍阻止复用）。 */
    private capSwitchable;
    /** 一个会话重新成为当前绑定时，从退役历史里移除。 */
    private unretire;
    /**
     * 配置里为该会话类型指定的模型与思考强度：`modelGroup`/`modelPrivate` 提供
     * 路由，`thinkingGroup`/`thinkingPrivate` 提供档位；两者各自可缺省。
     *
     * Args:
     *   chatId (ChatId): 目标会话；只区分群聊与私聊。
     *
     * Returns:
     *   ChatModelBinding | undefined: 两者都未配置时 undefined。
     *
     * Callers:
     *   - `modelWiring`（新建/恢复会话的初始选项）。
     *   - `applyConfiguredModel`（恢复后重新声明）。
     *   - `bridge/index.ts:configuredModel`（qq_model 的 get）。
     */
    configuredModel(chatId: ChatId): ChatModelBinding | undefined;
    /**
     * 新建会话的初始模型选项：部署默认提供 provider / model 与思考强度，
     * 再被该会话类型的配置覆盖（路由与档位各自独立覆盖）。
     *
     * Args:
     *   chatId (ChatId): 目标会话；决定取群聊还是私聊的配置。
     *
     * Returns:
     *   AgentOptions: 传给 agents.create / agents.resume 的模型选项。
     *
     * Callers:
     *   - `createChat`。
     *   - `resumeChat`。
     */
    private modelWiring;
    /**
     * 恢复的会话带着自己的历史选择，宿主的记录优先于创建选项；该会话类型
     * 配置了模型路由时，在恢复后重新声明，保证配置权威（只配思考强度时
     * 不改写已有会话的选择）。
     *
     * Args:
     *   chatId (ChatId): 目标会话；没有配置指定路由时什么都不做。
     *
     * Returns:
     *   void: 无。
     *
     * Callers:
     *   - `resumeChat`（恢复完成后）。
     */
    private applyConfiguredModel;
    /** C2: the AgentSetup closure shared by the create and resume assembly
     * paths. The only difference between the callers is the preset: a resumed
     * session rejoins the preset it recorded itself; a fresh create reuses the
     * config/default resolution already recorded in its header meta. */
    private buildSetup;
    /** C2: the ChatAgent literal shared by the create and resume assembly
     * paths — every field starts at its neutral initial value. `nickname` is
     * the one deliberate divergence between the callers (create seeds it from
     * the inbound message, resume keeps the pre-C2 hardcoded ''); pinned by
     * the M2-C2 characterization tests in bridge.spec.ts. */
    private createChatAgent;
    /** B8a: in-flight creates keyed by chat id — concurrent first messages for
     * one chat join a single create instead of racing. */
    private readonly pendingCreates;
    /** Get (or create) the agent for a chat. */
    ensureChat(chatId: ChatId, nickname: string): Promise<ChatAgent>;
    private createChat;
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
    private displayName;
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
    private chatTitle;
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
    private applySessionTitle;
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
    loadMapping(): Promise<void>;
    /** 把持久化条目写入内存状态（新格式）。 */
    private adoptMapping;
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
    private adoptLegacyMapping;
    /** 读取旧格式 JSON；缺失或损坏时记录日志并返回 undefined（迁移只用一次）。 */
    private readLegacyJson;
    /** 把持久化的 workspace 覆盖与水位写进状态（新格式与迁移共用）。 */
    private adoptSettings;
    /** Resume one persisted chat from its recorded session id. */
    private resumeChat;
    private mediaPath;
    private mappingPath;
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
    saveMapping(): Promise<void>;
    saveMappingDebounced(): void;
    /** B8c: dispose chats whose last activity is older than chatIdleEvictDays
     * (0 disables; default 7). Called before each inbound message: the session
     * is flushed, the agent disposed, and the chat removed from
     * chats/bySession — NOT retired, `state.sessionId` keeps the pair so a
     * later message (or a restart) resumes the same session. */
    sweepIdleChats(): Promise<void>;
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
    private evictChat;
    /** A suffixed session id for a chat that avoids every retired id. */
    private freshSessionId;
    /** Whether the persistence layer already owns a durable log for this id —
     * true means reusing the id would collide (stale on-disk log or live entry).
     * A read failure counts as no log so the caller falls back to the normal
     * path rather than blocking an id on a transient error. */
    private hasPersistedLog;
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
    switchableSessions(chatId: ChatId): SwitchableSession[];
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
    switchSession(chatId: ChatId, targetSessionId: string): Promise<SessionSwitchOutcome>;
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
    healSessionCollision(chatId: ChatId): Promise<void>;
    /**
     * Effective workspace directory for a chat's sessions: the per-chat
     * /workspace override when set, else the configured workspacePath, falling
     * back to the host process cwd.
     */
    effectiveCwd(chatId?: ChatId): string;
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
    private resolvePresetId;
    /**
     * The preset id a persisted session recorded for itself (newest logged
     * selection wins, else the creation header), or undefined when it recorded
     * none or the record cannot be read — a legacy session resumes under the
     * config/default, preserving its original behavior.
     */
    private recordedPresetFor;
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
    private joinPreset;
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
    private attachToWorkspace;
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
    resetChat(chatId: ChatId): Promise<void>;
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
    currentSessionId(chatId: ChatId): string | undefined;
    /** Stop everything registry-owned: cancel the debounce timer, save the
     * mapping, dispose every agent, clear both indexes. */
    stop(): Promise<void>;
}
