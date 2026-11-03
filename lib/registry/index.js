import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { SessionId as makeSessionId } from '@deepseek-ai/dsh-session';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { sessionIdForChat, splitChatId } from '../chat/index.js';
import { describeError } from '../shared/errors.js';
/** 会话映射文件名（媒体目录内）：映射、每 chat 设置与退役历史的唯一持久化文件。 */
const MAPPING_FILE = 'chat-sessions.json';
/** 旧版独立退役 id 文件；仅在一次性迁移时读取。 */
const LEGACY_RETIRED_FILE = 'retired-sessions.json';
/** 旧版每 chat 可切回列表文件；仅在一次性迁移时读取。 */
const LEGACY_SWITCHABLE_FILE = 'switchable-sessions.json';
/** 群会话标题的前缀；同时用来识别「本插件生成的名字」。 */
const GROUP_TITLE_PREFIX = '群 ';
/** 私聊会话标题的前缀；同时用来识别「本插件生成的名字」。 */
const DM_TITLE_PREFIX = '私聊 ';
/** Per-chat cap of the switchable list (hard-wired; no config surface). */
const SWITCHABLE_CAP = 20;
/** 新格式条目判定：`retired` 数组即格式标记。 */
function isPersistedChatState(entry) {
    return entry !== null && typeof entry === 'object' && Array.isArray(entry.retired);
}
/** 旧格式判定：只要有 chat 条目缺少 `retired` 数组，整个文件就按旧格式迁移。 */
function isLegacyMapping(mapping) {
    return Object.values(mapping).some(entry => !isPersistedChatState(entry));
}
/** 持久化退役条目的类型守卫。 */
function isRetiredSession(entry) {
    if (entry === null || typeof entry !== 'object')
        return false;
    const item = entry;
    return typeof item.id === 'string' && typeof item.retiredAt === 'number' && typeof item.kept === 'boolean';
}
/** 旧版可切回条目的类型守卫（迁移时读取）。 */
function isSwitchableSession(entry) {
    if (entry === null || typeof entry !== 'object')
        return false;
    const item = entry;
    return typeof item.id === 'string' && typeof item.retiredAt === 'number';
}
/** The preset id a session's own record names: newest logged selection, else the creation header. */
export function resolveRecordedPreset(inspection) {
    const events = inspection.events;
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event?.type === 'agent-preset/selected' && typeof event.data?.agentPreset === 'string') {
            return event.data.agentPreset;
        }
    }
    return inspection.meta.agentPreset;
}
/**
 * The chat↔session registry: dual index, persistence pair, per-chat settings
 * and the shared create/resume assembly. Created by the ChatBridge
 * constructor; the bridge delegates its same-name registry methods here.
 */
export class ChatRegistry {
    deps;
    /** Live chats by chat id. */
    chats = new Map();
    /** Reverse index: session id → chat id (routes session events to chats). */
    bySession = new Map();
    /** 每 chat 的绑定状态；live 与 idle 的会话都记录在这里，是唯一状态源。 */
    states = new Map();
    /** `states[].retired[].id` 的派生索引：判断一个会话 id 是否永久退役。 */
    retiredIds = new Set();
    /** 会话 id → QQ 侧的显示名（群名 / 昵称），取到就缓存。 */
    displayNames = new Map();
    mappingSaveTimer;
    /** Resolves once the on-disk chat mapping has been loaded (wired by the bridge's start()). */
    mappingLoaded = Promise.resolve();
    constructor(deps) {
        this.deps = deps;
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
    stateOf(chatId) {
        let state = this.states.get(chatId);
        if (state === undefined) {
            state = { settings: {}, retired: [] };
            this.states.set(chatId, state);
        }
        return state;
    }
    /** The (lazy-created) settings entry for one chat. */
    getSettings(chatId) {
        return this.stateOf(chatId).settings;
    }
    /** 该会话 id 是否已退役（任何状态下的退役都阻止再次创建）。 */
    isRetired(id) {
        return this.retiredIds.has(id);
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
    retire(chatId, id, kept, retiredAt = Date.now()) {
        const state = this.stateOf(chatId);
        const existing = state.retired.find(entry => entry.id === id);
        if (existing !== undefined) {
            existing.kept = kept;
            existing.retiredAt = retiredAt;
        }
        else {
            state.retired.unshift({ id, retiredAt, kept });
            this.retiredIds.add(id);
        }
        this.capSwitchable(state);
    }
    /** kept 条目超过上限时，把最旧的可切回项降级为不可切回（仍阻止复用）。 */
    capSwitchable(state) {
        let kept = 0;
        for (const entry of state.retired) {
            if (!entry.kept)
                continue;
            kept += 1;
            if (kept > SWITCHABLE_CAP)
                entry.kept = false;
        }
    }
    /** 一个会话重新成为当前绑定时，从退役历史里移除。 */
    unretire(chatId, id) {
        const state = this.stateOf(chatId);
        state.retired = state.retired.filter(entry => entry.id !== id);
        this.retiredIds.delete(id);
    }
    // ------------------------------------------------------------ chat lifecycle
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
    configuredModel(chatId) {
        const group = splitChatId(chatId).kind === 'group';
        const route = group ? this.deps.config.modelGroup : this.deps.config.modelPrivate;
        const thinking = group ? this.deps.config.thinkingGroup : this.deps.config.thinkingPrivate;
        const reasoningEffort = thinking === undefined || thinking === 'default' ? undefined : thinking;
        if (route === undefined && reasoningEffort === undefined)
            return undefined;
        return {
            ...(route === undefined ? {} : { provider: route.provider, model: route.model }),
            ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        };
    }
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
    modelWiring(chatId) {
        const selection = this.deps.defaultModel?.();
        const binding = this.configuredModel(chatId);
        const agentOptions = {};
        if (selection !== undefined) {
            agentOptions.provider = selection.provider;
            agentOptions.model = selection.model;
            if (selection.reasoningEffort !== undefined)
                agentOptions.reasoningEffort = selection.reasoningEffort;
        }
        if (binding?.provider !== undefined && binding.model !== undefined) {
            agentOptions.provider = binding.provider;
            agentOptions.model = binding.model;
        }
        if (binding?.reasoningEffort !== undefined) {
            agentOptions.reasoningEffort = ReasoningEffortId(binding.reasoningEffort);
        }
        return agentOptions;
    }
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
    applyConfiguredModel(chatId) {
        const chat = this.chats.get(chatId);
        const binding = this.configuredModel(chatId);
        if (chat === undefined || binding?.provider === undefined || binding.model === undefined)
            return;
        const effort = binding.reasoningEffort;
        chat.agent.model.select({
            provider: binding.provider,
            model: binding.model,
            ...(effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) }),
        });
    }
    /** C2: the AgentSetup closure shared by the create and resume assembly
     * paths. The only difference between the callers is the preset: a resumed
     * session rejoins the preset it recorded itself; a fresh create reuses the
     * config/default resolution already recorded in its header meta. */
    buildSetup(chatId, recordedPreset) {
        return async (agentCtx) => {
            this.deps.installChannelScope(agentCtx, chatId);
            await this.joinPreset(agentCtx, recordedPreset);
            // dsh 0.2.2: host-style unconditional install (single-arg — it only
            // wires the model-switch notice listener; the selection itself lives
            // on agent.model). Ignoring the returned disposer matches the host
            // callers (dsh-api-session-controller/dsh-headless/dsh-acp).
            installModelSelection(agentCtx);
        };
    }
    /** C2: the ChatAgent literal shared by the create and resume assembly
     * paths — every field starts at its neutral initial value. `nickname` is
     * the one deliberate divergence between the callers (create seeds it from
     * the inbound message, resume keeps the pre-C2 hardcoded ''); pinned by
     * the M2-C2 characterization tests in bridge.spec.ts. */
    createChatAgent(chatId, handle, nickname) {
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
        };
    }
    /** B8a: in-flight creates keyed by chat id — concurrent first messages for
     * one chat join a single create instead of racing. */
    pendingCreates = new Map();
    /** Get (or create) the agent for a chat. */
    async ensureChat(chatId, nickname) {
        const existing = this.chats.get(chatId);
        if (existing !== undefined)
            return existing;
        const pending = this.pendingCreates.get(chatId);
        if (pending !== undefined)
            return pending;
        const creation = this.createChat(chatId, nickname);
        this.pendingCreates.set(chatId, creation);
        void creation.finally(() => {
            this.pendingCreates.delete(chatId);
        }).catch(() => undefined);
        return creation;
    }
    async createChat(chatId, nickname) {
        await this.mappingLoaded;
        const state = this.stateOf(chatId);
        // idle 会话有记录就恢复；记录指向退役会话时只清绑定、保留设置。
        const recorded = state.sessionId;
        if (recorded !== undefined) {
            if (!this.isRetired(recorded)) {
                try {
                    return await this.resumeChat(chatId, recorded);
                }
                catch (error) {
                    this.retire(chatId, recorded, false);
                    this.deps.log('warn', 'resume of recorded session failed for ' + chatId + '; falling back to a fresh session: ' + describeError(error));
                }
            }
            state.sessionId = undefined;
        }
        let sessionId = makeSessionId(sessionIdForChat(chatId));
        if (this.isRetired(sessionId)) {
            sessionId = this.freshSessionId(chatId);
        }
        else if (await this.hasPersistedLog(sessionId)) {
            // The bare id still owns a stale on-disk log (e.g. a lost retirement
            // record): reusing it would collide, so retire it NOW and move to a
            // suffixed id instead of failing the chat later.
            this.retire(chatId, sessionId, false);
            sessionId = this.freshSessionId(chatId);
        }
        const agentOptions = this.modelWiring(chatId);
        const cwd = this.effectiveCwd(chatId);
        const presetId = await this.resolvePresetId();
        const meta = { cwd };
        if (presetId !== undefined)
            meta.agentPreset = presetId;
        const setup = this.buildSetup(chatId);
        let handle;
        try {
            handle = await this.deps.agents.create({
                sessionId,
                meta,
                agentOptions,
                setup,
            });
        }
        catch (error) {
            // A stale or foreign persisted log under the same id blocks creation
            // (id collision). Recover with a fresh suffixed session id instead of
            // failing the chat.
            this.retire(chatId, sessionId, false);
            const fallbackId = this.freshSessionId(chatId);
            this.deps.log('warn', 'agent create failed (' + describeError(error) + '); retrying with ' + fallbackId);
            handle = await this.deps.agents.create({
                sessionId: fallbackId,
                meta,
                agentOptions,
                setup,
            });
            this.deps.log('info', 'recovered with fresh session ' + fallbackId + ' for ' + chatId);
        }
        // The real session id is authoritative (the fallback path above creates a
        // different id than the one initially attempted); record it everywhere so
        // session events route to this chat and the mapping persists the truth.
        const actualSessionId = handle.agent.session.id;
        await this.attachToWorkspace(actualSessionId, handle.agent.session.header?.cwd);
        const chat = this.createChatAgent(chatId, handle, nickname);
        try {
            await handle.agent.whenIdle();
        }
        catch (error) {
            // B8b: create succeeded but the first idle wait failed — dispose the
            // orphan agent instead of leaking it.
            try {
                await handle.dispose();
            }
            catch {
                // the whenIdle failure is the cause; a dispose failure must not mask it
            }
            throw error;
        }
        this.chats.set(chatId, chat);
        this.bySession.set(actualSessionId, chatId);
        state.sessionId = actualSessionId;
        this.deps.log('info', 'agent created for ' + chatId + ' (session ' + actualSessionId + ')');
        void this.saveMapping();
        void this.applySessionTitle(chat, chatId);
        return chat;
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
    async displayName(chatId) {
        const cached = this.displayNames.get(chatId);
        if (cached !== undefined)
            return cached;
        const { kind, target } = splitChatId(chatId);
        try {
            let name;
            if (kind === 'group') {
                const info = await this.deps.call('get_group_info', { group_id: Number(target) });
                name = typeof info?.group_name === 'string' ? info.group_name : '';
            }
            else {
                const info = await this.deps.call('get_stranger_info', { user_id: Number(target) });
                name = typeof info?.nickname === 'string' ? info.nickname : '';
            }
            if (name !== '')
                this.displayNames.set(chatId, name);
            return name;
        }
        catch (error) {
            this.deps.log('debug', 'chat name lookup failed for ' + chatId + ': ' + describeError(error));
            return '';
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
    async chatTitle(chatId, startedAt) {
        const { kind, target } = splitChatId(chatId);
        const name = await this.displayName(chatId);
        const started = new Date(typeof startedAt === 'number' && startedAt > 0 ? startedAt : Date.now());
        const pad = (value) => String(value).padStart(2, '0');
        return (kind === 'group' ? GROUP_TITLE_PREFIX : DM_TITLE_PREFIX)
            + (name !== '' ? name : target)
            + ' · ' + pad(started.getMonth() + 1) + '-' + pad(started.getDate())
            + ' ' + pad(started.getHours()) + ':' + pad(started.getMinutes());
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
    async applySessionTitle(chat, chatId) {
        try {
            const service = this.deps.sessionTitle?.();
            if (service === undefined) {
                this.deps.log('debug', 'sessionTitle 服务不可用，跳过会话命名: ' + chatId);
                return;
            }
            const session = chat.agent.session;
            const current = String(service.get(session)?.title ?? '');
            const title = await this.chatTitle(chatId, session.header?.createdAt);
            if (current === title)
                return;
            if (current !== '' && !current.startsWith(GROUP_TITLE_PREFIX) && !current.startsWith(DM_TITLE_PREFIX))
                return;
            const snapshot = service.rename(session, title);
            this.deps.log('info', 'session titled for ' + chatId + ': ' + snapshot.title);
        }
        catch (error) {
            this.deps.log('warn', 'session title failed for ' + chatId + ': ' + describeError(error));
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
    async loadMapping() {
        let content;
        try {
            content = await readFile(this.mappingPath(), 'utf8');
        }
        catch (error) {
            if (error?.code !== 'ENOENT') {
                this.deps.log('warn', 'mapping read failed; starting with no chats: ' + describeError(error));
            }
            return;
        }
        let mapping;
        try {
            mapping = JSON.parse(content);
        }
        catch (error) {
            this.deps.log('warn', 'mapping file is unparsable; starting with no chats: ' + describeError(error));
            return;
        }
        if (isLegacyMapping(mapping))
            await this.adoptLegacyMapping(mapping);
        else
            this.adoptMapping(mapping);
        this.deps.log('debug', 'mapping file has ' + this.states.size + ' chat(s)');
        for (const [chatId, state] of this.states) {
            const sessionId = state.sessionId;
            if (sessionId === undefined)
                continue;
            if (this.isRetired(sessionId)) {
                state.sessionId = undefined;
                continue;
            }
            this.deps.log('debug', 'attempting resume of ' + chatId + ' @ ' + sessionId);
            if (this.deps.isStopping())
                return;
            try {
                await this.resumeChat(chatId, sessionId);
            }
            catch (error) {
                this.retire(chatId, sessionId, false);
                state.sessionId = undefined;
                this.deps.log('warn', 'resume failed for ' + chatId + ': ' + describeError(error));
            }
        }
        await this.saveMapping();
    }
    /** 把持久化条目写入内存状态（新格式）。 */
    adoptMapping(mapping) {
        for (const [chatId, raw] of Object.entries(mapping)) {
            if (!isPersistedChatState(raw))
                continue;
            const state = this.stateOf(chatId);
            if (typeof raw.session === 'string' && raw.session !== '')
                state.sessionId = raw.session;
            this.adoptSettings(state, raw);
            for (const entry of raw.retired) {
                if (!isRetiredSession(entry))
                    continue;
                state.retired.push({ id: entry.id, retiredAt: entry.retiredAt, kept: entry.kept });
                this.retiredIds.add(entry.id);
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
    async adoptLegacyMapping(mapping) {
        const switchable = await this.readLegacyJson(this.mediaPath(LEGACY_SWITCHABLE_FILE));
        const retired = await this.readLegacyJson(this.mediaPath(LEGACY_RETIRED_FILE));
        const retiredIds = new Set(Array.isArray(retired)
            ? retired.filter((id) => typeof id === 'string')
            : []);
        for (const [chatId, raw] of Object.entries(mapping)) {
            let session = '';
            if (typeof raw === 'string') {
                session = raw;
            }
            else if (raw !== null && typeof raw === 'object') {
                const entry = raw;
                if (typeof entry.session === 'string')
                    session = entry.session;
                this.adoptSettings(this.stateOf(chatId), entry);
            }
            if (session === '')
                continue;
            const state = this.stateOf(chatId);
            const history = switchable?.[chatId];
            if (Array.isArray(history)) {
                // 旧列表是新→旧；retire() 用 unshift 入表，倒序循环才能保持顺序。
                for (const item of [...history].reverse()) {
                    if (!isSwitchableSession(item))
                        continue;
                    if (!state.retired.some(entry => entry.id === item.id))
                        this.retire(chatId, item.id, true, item.retiredAt);
                }
            }
            if (retiredIds.has(session)) {
                if (!state.retired.some(entry => entry.id === session))
                    this.retire(chatId, session, false);
            }
            else {
                state.sessionId = session;
            }
        }
        await this.saveMapping();
    }
    /** 读取旧格式 JSON；缺失或损坏时记录日志并返回 undefined（迁移只用一次）。 */
    async readLegacyJson(path) {
        let content;
        try {
            content = await readFile(path, 'utf8');
        }
        catch (error) {
            if (error?.code !== 'ENOENT') {
                this.deps.log('warn', 'legacy file read failed (' + path + '): ' + describeError(error));
            }
            return undefined;
        }
        try {
            return JSON.parse(content);
        }
        catch (error) {
            this.deps.log('warn', 'legacy file is unparsable (' + path + '): ' + describeError(error));
            return undefined;
        }
    }
    /** 把持久化的 workspace 覆盖与水位写进状态（新格式与迁移共用）。 */
    adoptSettings(state, raw) {
        if (typeof raw.workspacePath === 'string' && raw.workspacePath !== '')
            state.settings.workspacePath = raw.workspacePath;
        const watermark = raw.recentWatermark;
        if (watermark !== undefined && Number.isFinite(watermark.time)) {
            state.settings.recentWatermark = { time: watermark.time, id: String(watermark.id ?? '') };
        }
    }
    /** Resume one persisted chat from its recorded session id. */
    async resumeChat(chatId, sessionId) {
        const agentOptions = this.modelWiring(chatId);
        const recordedPreset = await this.recordedPresetFor(makeSessionId(sessionId));
        const handle = await this.deps.agents.resume({
            resumeSessionId: makeSessionId(sessionId),
            agentOptions,
            setup: this.buildSetup(chatId, recordedPreset),
        });
        await this.attachToWorkspace(handle.agent.session.id, handle.agent.session.header?.cwd);
        // /workspace persistence across restarts: the per-chat override is
        // in-memory only, but a session's cwd is frozen in its header. When the
        // resumed session's directory differs from what this chat would default
        // to now, restore it as the override so future /new sessions keep using it.
        const headerCwd = handle.agent.session.header?.cwd;
        if (headerCwd !== undefined && headerCwd !== '' && headerCwd !== this.effectiveCwd()) {
            this.getSettings(chatId).workspacePath = headerCwd;
            this.deps.log('debug', 'workspace override restored for ' + chatId + ': ' + headerCwd);
        }
        const chat = this.createChatAgent(chatId, handle, '');
        try {
            await handle.agent.whenIdle();
        }
        catch (error) {
            // B8b: same orphan rule as the create path — dispose before rethrowing.
            try {
                await handle.dispose();
            }
            catch {
                // the whenIdle failure is the cause
            }
            throw error;
        }
        this.chats.set(chatId, chat);
        this.bySession.set(handle.agent.session.id, chatId);
        this.stateOf(chatId).sessionId = handle.agent.session.id;
        this.applyConfiguredModel(chatId);
        void this.applySessionTitle(chat, chatId);
        return chat;
    }
    mediaPath(name) {
        return this.deps.config.mediaDir.endsWith('/') || this.deps.config.mediaDir.endsWith('\\')
            ? this.deps.config.mediaDir + name
            : this.deps.config.mediaDir + '/' + name;
    }
    mappingPath() {
        return this.mediaPath(MAPPING_FILE);
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
    async saveMapping() {
        try {
            await mkdir(this.deps.config.mediaDir, { recursive: true });
            const mapping = {};
            for (const [chatId, state] of this.states) {
                const entry = { retired: state.retired };
                if (state.sessionId !== undefined)
                    entry.session = state.sessionId;
                const workspacePath = state.settings.workspacePath;
                if (workspacePath !== undefined && workspacePath !== '')
                    entry.workspacePath = workspacePath;
                const watermark = state.settings.recentWatermark;
                if (watermark !== undefined && Number.isFinite(watermark.time))
                    entry.recentWatermark = watermark;
                if (entry.session === undefined && entry.workspacePath === undefined
                    && entry.recentWatermark === undefined && entry.retired.length === 0)
                    continue;
                mapping[chatId] = entry;
            }
            const tmpPath = this.mappingPath() + '.tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
            await writeFile(tmpPath, JSON.stringify(mapping, null, 2), 'utf8');
            await rename(tmpPath, this.mappingPath());
        }
        catch (error) {
            this.deps.log('warn', 'mapping save failed: ' + describeError(error));
        }
    }
    saveMappingDebounced() {
        if (this.mappingSaveTimer !== undefined)
            clearTimeout(this.mappingSaveTimer);
        this.mappingSaveTimer = setTimeout(() => {
            this.mappingSaveTimer = undefined;
            void this.saveMapping();
        }, 2_000).unref();
    }
    /** B8c: dispose chats whose last activity is older than chatIdleEvictDays
     * (0 disables; default 7). Called before each inbound message: the session
     * is flushed, the agent disposed, and the chat removed from
     * chats/bySession — NOT retired, `state.sessionId` keeps the pair so a
     * later message (or a restart) resumes the same session. */
    async sweepIdleChats() {
        const days = this.deps.config.chatIdleEvictDays ?? 7;
        if (days <= 0 || this.deps.isStopping())
            return;
        const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
        for (const [chatId, chat] of [...this.chats]) {
            if (chat.lastActivityAt > cutoff)
                continue;
            await this.evictChat(chatId, chat);
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
    async evictChat(chatId, chat) {
        // Only evict a session that is durably persisted; a failed flush keeps
        // the chat alive and the sweep retries on the next message.
        try {
            await this.deps.sessions.flush(chat.agent.session);
        }
        catch (error) {
            this.deps.log('warn', 'idle-evict flush failed for ' + chatId + ' (keeping the chat): ' + describeError(error));
            return;
        }
        this.deps.onChatRemoved(chat);
        this.chats.delete(chatId);
        this.bySession.delete(chat.sessionId);
        try {
            await chat.dispose();
        }
        catch (error) {
            this.deps.log('warn', 'idle-evict dispose failed for ' + describeError(error));
        }
        this.deps.log('info', 'evicted idle chat ' + chatId + ' (session ' + chat.sessionId + ' kept resumable)');
    }
    // ------------------------------------------------------------ retired ids
    /** A suffixed session id for a chat that avoids every retired id. */
    freshSessionId(chatId) {
        let id;
        do {
            id = makeSessionId(sessionIdForChat(chatId) + '-' + Date.now().toString(36));
        } while (this.isRetired(id));
        return id;
    }
    /** Whether the persistence layer already owns a durable log for this id —
     * true means reusing the id would collide (stale on-disk log or live entry).
     * A read failure counts as no log so the caller falls back to the normal
     * path rather than blocking an id on a transient error. */
    async hasPersistedLog(id) {
        const persistence = this.deps.sessionPersistence;
        if (persistence === undefined)
            return false;
        try {
            // A snapshot means the id owns a durable log; missing or a read failure
            // counts as no log.
            return (await persistence.stat(id)) !== undefined;
        }
        catch {
            return false;
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
    switchableSessions(chatId) {
        return this.stateOf(chatId).retired
            .filter(entry => entry.kept)
            .map(entry => ({ id: entry.id, retiredAt: entry.retiredAt }));
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
    async switchSession(chatId, targetSessionId) {
        const target = targetSessionId.trim();
        const state = this.stateOf(chatId);
        const history = state.retired.find(entry => entry.id === target);
        if (history === undefined) {
            this.deps.log('warn', 'session switch rejected for ' + chatId + ': ' + target + ' is not in the chat switchable list');
            return { ok: false, reason: 'not-switchable', message: '目标会话不在该 chat 的可切回列表中' };
        }
        if (!history.kept) {
            this.deps.log('warn', 'session switch rejected for ' + chatId + ': ' + target + ' is broken');
            return { ok: false, reason: 'broken', message: '目标会话已损坏' };
        }
        const chat = this.chats.get(chatId);
        if (chat !== undefined && chat.busy) {
            return { ok: false, reason: 'busy', message: '当前会话正在生成' };
        }
        if (chat !== undefined) {
            this.retire(chatId, chat.sessionId, true);
            this.chats.delete(chatId);
            this.bySession.delete(chat.sessionId);
            this.deps.onChatRemoved(chat);
            try {
                await chat.dispose();
            }
            catch (error) {
                this.deps.log('warn', 'session switch dispose failed: ' + describeError(error));
            }
        }
        state.sessionId = undefined;
        try {
            await this.resumeChat(chatId, target);
        }
        catch (error) {
            // The target's log is unusable: mark it dead, drop the binding and let
            // the chat rebuild on a fresh session (never stuck).
            this.retire(chatId, target, false);
            void this.saveMapping();
            this.deps.log('warn', 'session switch resume failed for ' + chatId + ' -> ' + target + '; falling back to a fresh session: ' + describeError(error));
            return { ok: false, reason: 'resume-failed', message: describeError(error) };
        }
        this.unretire(chatId, target);
        void this.saveMapping();
        this.deps.log('info', 'session switch for ' + chatId + ' -> ' + target);
        return { ok: true, sessionId: target };
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
    async healSessionCollision(chatId) {
        const chat = this.chats.get(chatId);
        if (chat === undefined)
            return;
        this.retire(chatId, chat.sessionId, false);
        // The bare derived id shares the chat's stale log; retire it too so the
        // next ensureChat can never pick it again in this run OR after a restart.
        this.retire(chatId, sessionIdForChat(chatId), false);
        this.stateOf(chatId).sessionId = undefined;
        this.chats.delete(chatId);
        this.bySession.delete(chat.sessionId);
        this.deps.onChatRemoved(chat);
        try {
            await chat.dispose();
        }
        catch (error) {
            this.deps.log('warn', 'collision heal dispose failed: ' + describeError(error));
        }
        this.deps.log('warn', 'healed session collision for ' + chatId + '; a fresh session will be created on next message');
        void this.saveMapping();
    }
    // ------------------------------------------------------------ workspace & preset
    /**
     * Effective workspace directory for a chat's sessions: the per-chat
     * /workspace override when set, else the configured workspacePath, falling
     * back to the host process cwd.
     */
    effectiveCwd(chatId) {
        if (chatId !== undefined) {
            const override = this.getSettings(chatId).workspacePath;
            if (override !== undefined && override !== '')
                return override;
        }
        const configured = this.deps.config.workspacePath;
        return configured !== undefined && configured !== '' ? configured : process.cwd();
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
    async resolvePresetId() {
        const presets = this.deps.agentPresets;
        if (presets === undefined)
            return undefined;
        const configured = this.deps.config.agentPreset;
        const wanted = configured !== undefined && configured !== '' ? configured : presets.defaultId;
        try {
            const preset = await presets.resolve(wanted);
            return preset.id;
        }
        catch (error) {
            this.deps.log('warn', 'agent preset resolve failed; session header records no preset: ' + describeError(error));
            return undefined;
        }
    }
    /**
     * The preset id a persisted session recorded for itself (newest logged
     * selection wins, else the creation header), or undefined when it recorded
     * none or the record cannot be read — a legacy session resumes under the
     * config/default, preserving its original behavior.
     */
    async recordedPresetFor(sessionId) {
        const persistence = this.deps.sessionPersistence;
        if (persistence === undefined)
            return undefined;
        // 0.1.6 has no `inspect`: read the same record through open('read') — the
        // immutable header carries the creation preset, the full event log the
        // newest `agent-preset/selected`. The handle MUST close even on failure
        // (AsyncDisposable — a leaked read handle pins backend resources).
        let handle;
        try {
            handle = await persistence.open(sessionId, 'read');
            return resolveRecordedPreset({
                meta: { agentPreset: handle.header.agentPreset },
                events: (await handle.read()).events,
            });
        }
        catch (error) {
            this.deps.log('warn', 'preset record read failed for ' + sessionId + ' (falling back to config/default): ' + describeError(error));
            return undefined;
        }
        finally {
            if (handle !== undefined) {
                try {
                    await handle.close();
                }
                catch {
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
    async joinPreset(agentCtx, preferred) {
        if (this.deps.agentPresets === undefined)
            return;
        const configured = this.deps.config.agentPreset;
        if (preferred !== undefined && configured !== undefined && configured !== '' && configured !== preferred) {
            this.deps.log('warn', 'session records preset ' + preferred + ' but plugin config names ' + configured + '; resuming under the recorded preset');
        }
        const selected = preferred ?? (configured !== undefined && configured !== '' ? configured : undefined);
        try {
            const preset = await this.deps.agentPresets.mount(agentCtx, selected);
            this.deps.log('debug', 'agent joined preset ' + preset.id);
        }
        catch (error) {
            this.deps.log('warn', 'agent preset mount failed (tools fall back to the global layer): ' + describeError(error));
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
    async attachToWorkspace(sessionId, headerCwd) {
        const registry = this.deps.workspaceRegistry;
        if (registry === undefined)
            return;
        try {
            if (headerCwd === undefined || headerCwd === '') {
                this.deps.log('warn', 'workspace attach skipped: session header carries no cwd');
                return;
            }
            const workspace = await registry.resolveByPath(headerCwd);
            if (workspace === undefined) {
                if (headerCwd !== this.effectiveCwd()) {
                    this.deps.log('debug', 'workspace attach skipped: no workspace owns ' + headerCwd + ' and it differs from the configured workspacePath');
                    return;
                }
                const created = await registry.create(headerCwd);
                this.deps.log('info', 'created workspace for ' + headerCwd);
                await created.attachSession(sessionId);
                this.deps.log('info', 'attached session ' + sessionId + ' to workspace ' + headerCwd);
                return;
            }
            await workspace.attachSession(sessionId);
            this.deps.log('info', 'attached session ' + sessionId + ' to workspace ' + headerCwd);
        }
        catch (error) {
            this.deps.log('warn', 'workspace attach failed for ' + sessionId + ': ' + describeError(error));
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
    async resetChat(chatId) {
        const state = this.stateOf(chatId);
        const chat = this.chats.get(chatId);
        const sessionId = chat !== undefined ? chat.sessionId : state.sessionId;
        if (sessionId !== undefined) {
            this.retire(chatId, sessionId, true);
            const bareId = sessionIdForChat(chatId);
            if (bareId !== sessionId && !state.retired.some(entry => entry.id === bareId)) {
                this.retire(chatId, bareId, false);
            }
            state.sessionId = undefined;
            if (chat !== undefined) {
                this.deps.onChatRemoved(chat);
                this.chats.delete(chatId);
                this.bySession.delete(sessionId);
                try {
                    await chat.dispose();
                }
                catch (error) {
                    this.deps.log('warn', 'reset dispose failed: ' + describeError(error));
                }
            }
            this.deps.log('info', 'reset chat ' + chatId + ' (old session ' + sessionId + ' retired)');
        }
        void this.saveMapping();
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
    currentSessionId(chatId) {
        return this.states.get(chatId)?.sessionId;
    }
    /** Stop everything registry-owned: cancel the debounce timer, save the
     * mapping, dispose every agent, clear both indexes. */
    async stop() {
        if (this.mappingSaveTimer !== undefined) {
            clearTimeout(this.mappingSaveTimer);
            this.mappingSaveTimer = undefined;
        }
        await this.saveMapping();
        for (const chat of this.chats.values()) {
            this.deps.onChatRemoved(chat);
            try {
                await chat.dispose();
            }
            catch (error) {
                this.deps.log('warn', 'agent dispose failed: ' + String(error));
            }
        }
        this.chats.clear();
        this.bySession.clear();
    }
}
