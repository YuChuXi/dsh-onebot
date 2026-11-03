/**
 * The chat↔agent bridge: one Agent per QQ chat, inbound message pipeline
 * (policy → parse → media → STT → quote/forward expansion → followup),
 * outbound delivery driven by session events (assistant/message, turn/end),
 * typing indicator, per-chat send ordering, and chat→session mapping
 * persistence for restart resume. Ported from the Hermes OneBotAdapter
 * gateway-interaction half onto the dsh headless-runner agent pattern.
 * @module dsh-onebot/bridge
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { readFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extForUrl } from '../media/store.js';
import { transcriptLabel } from '../media/stt.js';
import { classifyUserRole, splitChatId } from '../chat/index.js';
import { buildPlatformPrompt } from './prompt.js';
import { registerTools } from '../tools/index.js';
import { tryHandleCommand as routeCommand } from '../commands/index.js';
import { OutboundPipeline } from '../outbound/index.js';
import { ChatRegistry } from '../registry/index.js';
import { InboundPipeline } from '../inbound/index.js';
import { TimerRunner } from '../timers/index.js';
import { describeError, errorStack } from '../shared/errors.js';
import { currentTrace, newTraceId, runWithTrace, TRACE_REASONS } from '../ops/trace.js';
import { runInjectRound, currentInjectRound, isWriteAction } from '../inbound/inject.js';
/** 渠道技能的资源目录：包内 assets，随插件发布与更新。 */
const CHANNEL_SKILL_DIR = fileURLToPath(new URL('../../assets/qq-chat/', import.meta.url)).replace(/[\\/]+$/, '');
/** 渠道技能名。 */
const CHANNEL_SKILL_NAME = 'qq-chat';
/** T2 (P1): the queue notice sent to a chat when a message arrives while its
 * task is running under the default 'queue' policy — at most ONE per running
 * turn (the flag resets at turn/end) so a burst of queued messages never
 * spams the chat. Exported for the deterministic text wait in tests. */
export const QUEUE_NOTICE_TEXT = '⏳ 当前任务运行中，新消息已排队，将在当前任务结束后依次处理。';
/** 插话成功提示：自动插话与语音转写共用同一句。 */
export const STEER_ACCEPTED_NOTICE = '✅ 已作为补充指令提交给当前任务，模型将在下一步读取。';
/**
 * Bridge between OneBot events and dsh agents. Create via the constructor and
 * call start() from the plugin's effect; call stop() on disposal.
 */
export class ChatBridge {
    deps;
    /** Outbound pipeline (D1-PR2): the same-name bridge methods below delegate here. */
    outbound;
    /** The chat↔session registry (D1-PR3): chats/bySession dual index, the
     * persistence pair, per-chat settings and the create/resume assembly. */
    registry;
    /** Inbound pipeline (D1-PR4): normalizeOneBot11 + the policy→media→quote→
     * dispatch path; the same-name bridge methods below delegate here. */
    inbound;
    /** 会话定时器：挂在群/私聊上，到点走 wakeWithNote 唤醒回合。 */
    timers;
    /** Live registry indexes — the inbound/outbound/turn links keep reading
     * them through these same-name views. */
    get chats() { return this.registry.chats; }
    get bySession() { return this.registry.bySession; }
    sessionEventOff;
    sessionFlushOff;
    /** W1: chat-level traceId association table — session events arrive on a
     * different async chain than the inbound pipeline, so dispatchFollowup
     * records the initiating traceId per chat here and onSessionEvent reads it
     * back (agent 回复事件归属发起 traceId). Last dispatch wins; entries are
     * dropped when the chat is removed. Never cleared at turn/end: tool sends
     * run on the agent's chain and may land after the turn closed. One entry
     * per chat id (bounded by the chat population), so growth is not a
     * concern. */
    traceByChat = new Map();
    /** W1/T5: chatId → the traceId of the chat's unsettled INJECTED round
     * (independent of the trace sink, so the dry-run guard covers the async
     * agent reply even with tracing off). Cleared by a real dispatch to the
     * chat or when the chat is removed. */
    injectRoundByChat = new Map();
    /** T2 (P1): chats that already got the QUEUE_NOTICE_TEXT for their current
     * running turn (one notice per turn; cleared at turn/end and on chat
     * removal — bounded by the chat population). */
    queueNoticeChats = new Set();
    /** Plugin version + git commit, read once for /ver. */
    pluginVersion;
    pluginCommit;
    stopping = false;
    constructor(deps) {
        this.deps = deps;
        this.registry = new ChatRegistry({
            agents: deps.agents,
            sessions: deps.sessions,
            sessionPersistence: deps.sessionPersistence,
            workspaceRegistry: deps.workspaceRegistry,
            call: (action, params) => deps.connection.call(action, params),
            sessionTitle: deps.sessionTitle,
            agentPresets: deps.agentPresets,
            defaultModel: deps.defaultModel,
            config: deps.config,
            log: (level, message) => deps.log(level, message),
            isStopping: () => this.stopping,
            onChatRemoved: chat => {
                this.stopTyping(chat);
                // W1/T5: forget the chat's injected round (and its trace mapping).
                this.deps.config.inject?.clearChat(chat.chatId);
                this.traceByChat.delete(chat.chatId);
                this.injectRoundByChat.delete(chat.chatId);
                this.queueNoticeChats.delete(chat.chatId);
            },
            installChannelScope: (agentCtx, chatId) => this.installChannelScope(agentCtx, chatId),
        });
        this.outbound = new OutboundPipeline({
            connected: () => this.deps.connection.connected,
            selfId: () => this.deps.connection.selfId,
            call: (action, params, chatId) => this.guardedConnectionCall(action, params, chatId),
            isStopping: () => this.stopping,
            log: (level, message) => this.deps.log(level, message),
            config: deps.config,
            // W1: outbound decision events ride the chat's initiating traceId; a
            // write with no mapped trace (proactive tool sends) starts a fresh one.
            trace: (chatId, event) => {
                const sink = deps.config.trace;
                if (sink === undefined || !sink.enabled)
                    return;
                const mapped = this.traceByChat.get(chatId);
                sink.emit({ traceId: mapped ?? newTraceId(sink.now()), chatId, ...event });
            },
        });
        this.inbound = new InboundPipeline({
            call: (action, params) => this.guardedConnectionCall(action, params),
            selfId: () => this.deps.connection.selfId,
            policy: deps.policy,
            getSettings: chatId => this.registry.getSettings(chatId),
            saveMapping: () => { void this.registry.saveMapping(); },
            sweepIdleChats: () => this.registry.sweepIdleChats(),
            media: deps.media,
            transcriber: deps.transcriber,
            steerTranscript: (chatId, text) => this.steerTranscript(chatId, text),
            tryHandleCommand: (chatId, text, userId) => this.tryHandleCommand(chatId, text, userId),
            dispatchFollowup: (chatId, text, role, nickname) => this.dispatchFollowup(chatId, text, role, nickname),
            interceptBusyTurn: (chatId, text, role, nickname) => this.interceptBusyTurn(chatId, text, role, nickname),
            log: (level, message) => this.deps.log(level, message),
            config: deps.config,
        });
        this.timers = new TimerRunner({
            dir: deps.config.mediaDir,
            now: Date.now,
            log: (level, message) => this.deps.log(level, message),
            deliver: (chatId, note) => this.inbound.wakeWithNote(chatId, note),
        });
    }
    /** Start listening: wire connection handlers and the session event feed. */
    start() {
        const { connection, ctx: sessionEvents } = this.deps;
        connection.selfId = this.deps.config.botQQ;
        this.sessionEventOff = sessionEvents.on('session/event', (session, event) => {
            this.onSessionEvent(session, event);
        });
        this.sessionFlushOff = sessionEvents.on('session/flush', (session) => {
            void this.onSessionFlush(session);
        });
        connection.onStatus = (connected) => {
            this.deps.log(connected ? 'info' : 'warn', 'OneBot ' + (connected ? 'connected' : 'disconnected'));
            if (connected)
                this.outbound.drainPendingSends();
        };
        this.registry.mappingLoaded = this.ready().then(async () => {
            await this.registry.loadMapping();
            await this.timers.load();
        }).then(() => {
            if (this.stopping)
                return;
            this.deps.log('info', 'bridge ready (' + this.registry.chats.size + ' resumed chat(s))');
        });
    }
    /** Stop everything: dispose agents, save mapping, cancel timers. */
    async stop() {
        this.stopping = true;
        if (this.sessionEventOff !== undefined) {
            this.sessionEventOff();
            this.sessionEventOff = undefined;
        }
        if (this.sessionFlushOff !== undefined) {
            this.sessionFlushOff();
            this.sessionFlushOff = undefined;
        }
        await this.registry.stop();
        this.timers.stop();
    }
    /** Map an agent session id back to its chat (for model tools). */
    chatForSession(sessionId) {
        return this.bySession.get(sessionId);
    }
    /** Whether a caller backing an agent session may perform file edits. QQ chats
     * require the currently running turn's initiator to be an admin (role frozen
     * from the dispatch queue at turn/start); non-QQ sessions (Web and other
     * channels) are trusted by default (A1 scoping). Unknown states fail closed
     * as member. */
    canEditFiles(sessionId) {
        const chatId = this.bySession.get(sessionId);
        if (chatId === undefined)
            return true;
        return this.chats.get(chatId)?.activeTurnRole === 'admin';
    }
    /** qq_model: the live agent of one chat — the agent-owned model selection
     * (dsh 0.2.2 `agent.model`) is the only live view of a chat's model route
     * and thinking level.
     *
     * Args:
     *   chatId (ChatId): 目标会话。
     *
     * Returns:
     *   ChatAgent['agent'] | undefined: 会话在线时返回该会话的 agent，否则 undefined。
     *
     * Callers:
     *   - `src/tools/index.ts:registerTools`（qq_model 的 get/set 路径）。
     */
    agentOf(chatId) {
        return this.chats.get(chatId)?.agent;
    }
    /** qq_model: the deployment default model selection.
     *
     * Returns:
     *   ModelSelection | undefined: 部署默认选择；未配置默认模型时 undefined。
     *
     * Callers:
     *   - `src/tools/index.ts:registerTools`（qq_model 的 get 与 set default 路径）。
     */
    deploymentModel() {
        return this.deps.defaultModel?.();
    }
    /** qq_model: the deployment default-model store (saveSelection port).
     *
     * Returns:
     *   AgentDefaultModelLike | undefined: 宿主未提供该服务时 undefined。
     *
     * Callers:
     *   - `src/tools/index.ts:registerTools`（qq_model 的 set default 路径）。
     */
    defaultModelStore() {
        return this.deps.agentDefaultModel;
    }
    /**
     * 该 provider/model 接受的思考强度 id；undefined = 能力未知（调用方不据此
     * 拒绝）。
     *
     * Args:
     *   provider (string): 提供商路由。
     *   model (string): 模型 id。
     *
     * Returns:
     *   Promise<readonly string[] | undefined>: 可用档位；空数组 = 不支持思考强度。
     *
     * Callers:
     *   - `src/tools/index.ts:registerTools`（qq_model 的 get/set 校验）。
     */
    reasoningEfforts(provider, model) {
        const catalog = this.deps.llmCatalog;
        return catalog === undefined ? Promise.resolve(undefined) : catalog.resolveReasoningEfforts(provider, model);
    }
    /**
     * qq_model: 配置里为该 chat 指定的模型（精确键优先于类型通配键）。
     *
     * Args:
     *   chatId (ChatId): 目标会话。
     *
     * Returns:
     *   ChatModelBinding | undefined: 配置未指定时 undefined。
     *
     * Callers:
     *   - `src/tools/index.ts:registerTools`（qq_model 的 get）。
     */
    configuredModel(chatId) {
        return this.registry.configuredModel(chatId);
    }
    /**
     * Outbound media fence roots for one agent session's current turn (M1-A3b):
     * the plugin media dir always, plus the chat's workspace directory when the
     * running turn's initiator is an admin. The role reuses the M1-A2 turn-level
     * semantics (canEditFiles: frozen at turn/start, fail-closed member); a
     * session with no known chat stays mediaDir-only even though canEditFiles
     * would trust it — the media gate itself fails closed. Roots are
     * realpath-normalized here; the MediaStore fence re-checks containment
     * (the double check is harmless).
     */
    async mediaSendRoots(sessionId) {
        const isTurnAdmin = sessionId !== undefined && this.canEditFiles(sessionId);
        const chatId = sessionId !== undefined ? this.bySession.get(sessionId) : undefined;
        const candidates = [this.deps.config.mediaDir];
        if (chatId !== undefined && isTurnAdmin)
            candidates.push(this.effectiveCwd(chatId));
        const roots = [];
        for (const root of candidates) {
            try {
                roots.push(await realpath(root));
            }
            catch {
                roots.push(root); // missing root: kept as-is; the fence skips it (cannot contain anything)
            }
        }
        return { roots, isTurnAdmin };
    }
    /** Whether the connection is usable for sends. */
    get connected() {
        return this.deps.connection.connected;
    }
    /**
     * Send plugin-authored plain text to a chat (command replies, notices,
     * error notices).
     * @param chatId - target chat.
     * @param text - plugin-authored plain text.
     * @param options - optional reply target.
     * @returns the sent message ids.
     */
    sendToChat(chatId, text, options = {}) {
        return this.outbound.sendToChat(chatId, text, options);
    }
    /**
     * 把远程表情图片下载到插件媒体目录，返回本机路径。
     * 表情预览与 add_custom_face 都需要 NapCat / 模型可访问的本地文件。
     *
     * Args:
     *   url (string): 表情图片 URL。
     *
     * Returns:
     *   Promise<string>: 下载后的本机路径。
     *
     * Callers:
     *   - `src/tools/stickers.ts`（qq_list_stickers 预览、qq_collect_sticker 的 URL / 商城表情）。
     */
    async saveSticker(url) {
        return await this.deps.media.downloadUrl(url, extForUrl(url, 'image'), this.deps.config.maxImageBytes);
    }
    /**
     * Send raw OneBot segments (used by the media tools).
     * @param chatId - target chat.
     * @param segments - outbound segments.
     * @returns the sent message id.
     */
    sendSegments(chatId, segments, options) {
        return this.outbound.sendSegments(chatId, segments, options);
    }
    /**
     * Wait for the loader's complete application (model selection, settings,
     * persistence) before reading the default model — the same gate the
     * headless runner uses, so the pinned selection is never a half-loaded
     * default.
     */
    async ready() {
        await this.deps.hostReady?.();
    }
    // ------------------------------------------------------------ inbound
    /**
     * Inbound OneBot message event → agent turn. All policy and media work is
     * contained: a failure here logs and drops the message, never the host.
     * W1: the whole inbound chain runs inside one trace scope (ALS), so every
     * pipeline decision point can attribute its event to this message's
     * traceId; disabled = no scope, no id. W1/T5: injected
     * events (opts.injected) run inside their inject round (ALS) so the
     * dry-run guard covers the whole synchronous chain, and real events are
     * recorded by the inbound recorder when recordInbound is on (injected
     * events are never recorded — no inject→record→replay feedback loop).
     */
    async handleInbound(event, opts = {}) {
        const inbound = await this.inbound.normalize(event);
        if (inbound === null) {
            this.observeNonMessageEvent(event);
            return;
        }
        const run = () => this.handleInboundOnce(event, inbound, opts.injected === true);
        return opts.injected === true
            ? runInjectRound({ traceId: newTraceId(), intercepted: 0 }, run)
            : run();
    }
    /**
     * 记录不构成会话内容的事件（meta / request / 无会话归属的 notice / 未知类型），
     * 并保持各自的日志级别。这类事件不丢弃语义：它们由本层明确判定为「不产生回复」，
     * 而不是在连接层消失。
     *
     * Args:
     *   event (OneBotEvent): 已到达业务层、但未归一化成会话内容的事件。
     *
     * Returns:
     *   void: 无返回值。
     *
     * Callers:
     *   - `handleInbound`（归一化结果为 null）。
     */
    observeNonMessageEvent(event) {
        const postType = String(event.post_type ?? '');
        if (postType === 'meta_event') {
            const metaType = typeof event.meta_event_type === 'string' ? event.meta_event_type : '';
            if (metaType !== 'heartbeat') {
                this.deps.log('info', 'meta event; bot QQ: ' + (this.deps.connection.selfId || this.deps.config.botQQ) + '; ' + metaType);
            }
            return;
        }
        if (postType === 'request') {
            this.deps.log('info', 'request event observed (request_type=' + String(event.request_type ?? '') + ', sub_type=' + String(event.sub_type ?? '') + '); no approval path configured');
            return;
        }
        this.deps.log('debug', 'unhandled event type: ' + postType);
    }
    async handleInboundOnce(event, inbound, injected) {
        // Recording: skipped for injected events (they would otherwise feed the
        // injector again through replay) and skipped when no recorder exists.
        const recorder = injected ? undefined : this.deps.config.recorder;
        const session = recorder?.begin(event) ?? undefined;
        const trace = this.beginInboundTrace(inbound);
        const scope = trace !== undefined
            ? (session !== undefined ? session.wrapScope(trace) : trace)
            : session?.captureScope();
        try {
            await runWithTrace(scope, async () => {
                if (this.stopping) {
                    this.deps.log('debug', '插件停止中，入站消息丢弃');
                    scope?.emit('inbound', { ok: false, reason: TRACE_REASONS.inboundStopping });
                    return;
                }
                await this.processInbound(inbound);
            });
        }
        catch (error) {
            scope?.emit('dispatch', { ok: false, reason: '入站处理失败: ' + describeError(error) });
            this.deps.log('error', 'inbound handling failed: ' + describeError(error) + errorStack(error));
        }
        finally {
            session?.end();
        }
    }
    /** W1: mint the inbound traceId + scope and record the first (收到消息)
     * event; undefined when tracing is off (zero overhead, zero difference).
     * W1/T5: an injected event REUSES its inject round's traceId, so the whole
     * injected round (pipeline decisions + intercepted outbound calls) shares
     * one traceId in the trace stream. */
    beginInboundTrace(inbound) {
        const sink = this.deps.config.trace;
        if (sink === undefined || !sink.enabled)
            return undefined;
        const traceId = currentInjectRound()?.traceId ?? newTraceId(sink.now());
        const scope = sink.scope(traceId, inbound.chatId, inbound.messageId);
        sink.emit({ traceId: scope.traceId, stage: 'inbound', ok: true, chatId: inbound.chatId, messageId: inbound.messageId, data: { messageType: inbound.kind } });
        return scope;
    }
    async processInbound(inbound) {
        await this.inbound.processInbound(inbound);
    }
    /** Feed one user message into a chat's agent (create on demand) and queue
     * the initiator's turn role. */
    async dispatchFollowup(chatId, text, role, nickname) {
        const final = text.trim();
        const fallback = this.chats.get(chatId)?.lastNickname ?? '';
        const chat = await this.ensureChat(chatId, nickname ?? fallback);
        if (nickname !== undefined && nickname !== '')
            chat.lastNickname = nickname;
        chat.lastActivityAt = Date.now();
        // Queue this turn's initiator role; the host's turn/start freezes it as
        // the running turn's role (M1-A2). Push and followup happen synchronously,
        // so the role cannot interleave with another dispatch.
        chat.pendingTurnRoles.push(role);
        this.deps.log('info', 'followup from ' + chatId + ': ' + final.slice(0, 120));
        // Plugin-originated user message: the session log attributes QQ inbound
        // messages to this plugin's own producer-owned source kind, keeping them
        // distinguishable from host/web UI inputs.
        chat.agent.followup(createUserMessage({
            content: [{ type: 'text', text: final }],
            source: { kind: 'plugin:dsh-onebot' },
        }));
        // W1 cross-stream join: the turn's session events arrive on a different
        // async chain, so record this dispatch's traceId per chat for
        // onSessionEvent to pick up (runs inside the inbound ALS scope — command
        // dispatches reach here through the same await chain).
        const trace = currentTrace();
        if (trace !== undefined) {
            this.traceByChat.set(chatId, trace.traceId);
            trace.emit('dispatch', { ok: true, reason: '消息已投递给模型' });
        }
        // W1/T5 inject bookkeeping: an injected dispatch registers its round for
        // this chat (the async reply stays attributable — INDEPENDENT of tracing,
        // so the dry-run guard also works with the trace sink off); a real
        // dispatch clears any leftover injected round so real users are never
        // collaterally intercepted by the dry-run guard.
        const injectedRound = currentInjectRound();
        if (injectedRound !== undefined)
            this.injectRoundByChat.set(chatId, injectedRound.traceId);
        else
            this.injectRoundByChat.delete(chatId);
        this.deps.config.inject?.noteDispatch(chatId);
        this.startTyping(chat);
    }
    /**
     * 斜杠命令路由器：首个词形如 `/word` 时接管，其余落回模型。
     *
     * Args:
     *   chatId (ChatId): 命令到达的会话。
     *   text (string): 入站文本。
     *   userId (string): 发送方 QQ。
     *
     * Returns:
     *   Promise<boolean>: true = 已被命令消费。
     *
     * Callers:
     *   - `src/inbound/index.ts:InboundPipeline.processInbound`。
     */
    tryHandleCommand(chatId, text, userId) {
        return routeCommand(this.commandCtx, chatId, text, userId);
    }
    /**
     * 命令面可用的桥接能力：只暴露 /new、/session、/model、/compact 需要的部分，
     * 每次调用实时解析（模型目录必须走活服务）。
     */
    get commandCtx() {
        const bridge = this;
        return {
            sendToChat: (chatId, text) => bridge.sendToChat(chatId, text),
            log: (level, message) => bridge.deps.log(level, message),
            isAdmin: userId => classifyUserRole(userId, bridge.deps.policy.adminUsers) === 'admin',
            getChat: chatId => bridge.chats.get(chatId),
            resetChat: chatId => bridge.resetChat(chatId),
            currentSessionId: chatId => bridge.registry.currentSessionId(chatId),
            switchableSessions: chatId => bridge.registry.switchableSessions(chatId),
            switchSession: (chatId, targetSessionId) => bridge.registry.switchSession(chatId, targetSessionId),
            sessionPersistence: bridge.deps.sessionPersistence,
            pendingSelection: chatId => bridge.registry.getSettings(chatId).pendingSelection,
            setPendingSelection: (chatId, value) => { bridge.registry.getSettings(chatId).pendingSelection = value; },
            llmCatalog: bridge.deps.llmCatalog,
            agentDefaultModel: bridge.deps.agentDefaultModel,
            commands: bridge.deps.commands,
        };
    }
    /** M3-D4c: steer a completed voice transcript into the chat's agent — the
     * running turn consumes it at its nearest step boundary; an idle agent
     * opens a turn. No live chat (dispatch dropped/never happened) drops it. */
    steerTranscript(chatId, text) {
        if (this.steerMessage(chatId, transcriptLabel(text)))
            return;
        this.deps.log('debug', 'voice transcript dropped (no live chat): ' + chatId);
        currentTrace()?.emit('dispatch', { ok: false, reason: TRACE_REASONS.transcriptNoChat });
    }
    /** T2 (P1): the single agent.steer write point — one createUserMessage with
     * the producer-owned source kind (the session-v4 guard counts the source
     * write points; this and dispatchFollowup are the only two). Shared by the
     * voice transcript path (steerTranscript) and the busy-turn steer policy.
     * Returns false when the chat has no live agent (nothing was steered). */
    steerMessage(chatId, text) {
        const chat = this.chats.get(chatId);
        if (chat === undefined)
            return false;
        chat.agent.steer(createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'plugin:dsh-onebot' },
        }));
        return true;
    }
    /**
     * T2 (P1): the busy-turn policy seam (inbound ctx.interceptBusyTurn).
     * Called for every non-command message AFTER all gates, only when deciding
     * what to do with it while the chat's task is running:
     * - no running turn → false (caller dispatches normally; also the path for
     *   idle traffic);
     * - 插话开关打开（steerEnabled）且发送者具备资格（steerAllMembers，缺省仅管理员），
     *   受限成员还须 steerAllowRestricted 未关 → 消息经 steerMessage 内核提交进
     *   运行中的回合（在最近 step 边界被读取，不新开回合）；steerNotice 未关时
     *   回一句提交提示；
     * - otherwise（插话关闭 / 不具备资格 / 受限成员且该项已关）→ the dispatch
     *   path (agent.followup queues it as the next turn: consumed after the current
     *   turn ends, in arrival order) plus the queue notice at most once per
     *   running turn.
     * 消息形态不再限制插话：进入这里的 text 已是完整载荷（带图/语音/引用的消息
     * 在入站管线里已完成媒体归一化与引用展开），插话只是把它塞进运行中的回合。
     * The running check reads the agent's own lifecycle state — the same
     * authoritative signal /stop uses; chat.busy (turn/start..turn/end view)
     * can lag the host driver and is deliberately NOT consulted.
     */
    async interceptBusyTurn(chatId, text, role, nickname) {
        const chat = this.chats.get(chatId);
        if (chat === undefined || chat.agent.status !== 'running')
            return false;
        const cfg = this.deps.config;
        // 插话两个开关：开 + 具备资格才插进当前回合。
        const steerOn = cfg.steerEnabled === true;
        const anyMember = cfg.steerAllMembers === true;
        const steerAllowRestricted = cfg.steerAllowRestricted !== false;
        // 受限成员（role 非 owner/admin）默认也允许插话（steerAllowRestricted 默认开）；
        // 关掉该项后他们一律排队。判据与入站管线的 RESTRICTED_PREFIX 一致。
        const restricted = splitChatId(chatId).kind === 'group'
            && role !== 'admin' && cfg.restrictedMemberPrefix;
        const autoSteerAllowed = anyMember || role === 'admin';
        if (steerOn && autoSteerAllowed && (!restricted || steerAllowRestricted)) {
            this.steerMessage(chatId, text);
            currentTrace()?.emit('dispatch', { ok: true, reason: TRACE_REASONS.busyTurnSteered });
            if (cfg.steerNotice !== false) {
                this.sendToChat(chatId, STEER_ACCEPTED_NOTICE).catch((error) => {
                    this.deps.log('debug', '插话提交提示发送失败: ' + describeError(error));
                    currentTrace()?.emit('notice', { ok: false, reason: '插话提交提示发送失败: ' + describeError(error) });
                });
            }
            return true;
        }
        await this.dispatchFollowup(chatId, text, role, nickname);
        currentTrace()?.emit('dispatch', { ok: true, reason: TRACE_REASONS.busyTurnQueued });
        if (!this.queueNoticeChats.has(chatId)) {
            this.queueNoticeChats.add(chatId);
            this.sendToChat(chatId, QUEUE_NOTICE_TEXT).catch((error) => {
                this.deps.log('debug', '排队提示发送失败: ' + describeError(error));
                currentTrace()?.emit('notice', { ok: false, reason: '排队提示发送失败: ' + describeError(error) });
            });
        }
        return true;
    }
    // ------------------------------------------------------------ outbound
    /** Send forward nodes as a merged-forward message. */
    async sendForward(chatId, nodes) {
        return this.outbound.sendForward(chatId, nodes);
    }
    // ------------------------------------------------------------ inject dry-run guard
    /**
     * W1/T5: the single connection-call gate every bridge pipeline
     * (inbound/outbound/typing) routes through. In inject dry-run mode, WRITE
     * actions of an injected round are intercepted at this outbound action
     * layer: counted, traced with the original text, resolved with the marker
     * message id — the real OneBot connection never sees them. Attribution:
     * (a) the synchronous chain via the inject round's ALS, (b) the async agent
     * reply via the chat→round association (injectRoundByChat, independent of
     * the trace sink).
     */
    guardedConnectionCall(action, params, chatId) {
        const inject = this.deps.config.inject;
        if (inject === undefined || !inject.intercepting || !isWriteAction(action)) {
            return this.deps.connection.call(action, params);
        }
        const alsRound = currentInjectRound();
        if (alsRound !== undefined)
            return inject.intercept(alsRound, action, params);
        if (chatId !== undefined) {
            const round = inject.activeRoundFor(chatId);
            if (round !== undefined && this.injectRoundByChat.get(chatId) === round.traceId) {
                return inject.intercept(round, action, params);
            }
        }
        return this.deps.connection.call(action, params);
    }
    // ------------------------------------------------------------ session events
    onSessionEvent(session, event) {
        if (this.stopping)
            return;
        const chatId = this.bySession.get(session.id);
        if (chatId === undefined) {
            // pipeline-hooks.md #20: non-QQ sessions (web/host) ride this same bus;
            // keep the early exit visible at debug without emitting any trace.
            this.deps.log('debug', 'session 事件早退：无 chat 映射（session=' + session.id + ' type=' + String(event.type) + '）');
            return;
        }
        const chat = this.chats.get(chatId);
        if (chat === undefined || chat.sessionId !== session.id)
            return;
        const trace = this.traceForChat(chatId);
        if (event.type === 'turn/start') {
            trace?.emit('agent', { ok: true, reason: '模型回合开始' });
            // Freeze the running turn's initiator role from the dispatch FIFO
            // (M1-A2): turns the plugin did not dispatch (host/web input) find an
            // empty queue and fail closed as member.
            chat.activeTurnRole = chat.pendingTurnRoles.shift() ?? 'member';
            chat.lastActivityAt = Date.now();
            chat.busy = true;
            return;
        }
        if (event.type === 'turn/end') {
            const reason = event.data.reason;
            if (reason.kind === 'error') {
                trace?.emit('agent', { ok: false, reason: '模型回合出错: ' + reason.error.message });
            }
            else {
                trace?.emit('agent', { ok: true, reason: '模型回合结束（' + reason.kind + '）' });
            }
            if (reason.kind === 'error') {
                const message = reason.error.message;
                // 会话日志与磁盘不一致时重建会话；重建由 sendErrorNotice 开关控制。
                if (this.deps.config.sendErrorNotice
                    && /persisted log on disk that does not match this live session|id collision/i.test(message)) {
                    void this.healSessionCollision(chatId);
                }
                if (this.deps.config.sendErrorNotice) {
                    this.sendToChat(chatId, '⚠️ 运行出错：' + message, { queuable: true }).catch((error) => {
                        this.deps.log('debug', '错误通知发送失败: ' + describeError(error));
                        trace?.emit('notice', { ok: false, reason: TRACE_REASONS.noticeErrorSendFailed });
                    });
                }
            }
            this.stopTyping(chat);
            chat.lastActivityAt = Date.now();
            chat.busy = false;
            // T2 (P1): the turn that armed the queue notice is over — a later
            // running turn notifies again.
            this.queueNoticeChats.delete(chatId);
            this.deps.log('info', 'turn/end for ' + chatId + ': ' + event.data.reason.kind);
            // Durable: flush the session so a later restart can resume it.
            void this.deps.sessions.flush(chat.agent.session).catch((error) => {
                this.deps.log('warn', 'session flush failed: ' + String(error));
                trace?.emit('notice', { ok: false, reason: '会话落盘失败: ' + String(error) });
            });
            void this.saveMappingDebounced();
        }
    }
    /** W1: the trace scope for one chat's session events, resolved through the
     * chat-level association table; undefined when tracing is off or the chat
     * has no recorded dispatch (host-initiated turns stay untraced). */
    traceForChat(chatId) {
        const sink = this.deps.config.trace;
        if (sink === undefined || !sink.enabled)
            return undefined;
        const traceId = this.traceByChat.get(chatId);
        return traceId !== undefined ? sink.scope(traceId, chatId) : undefined;
    }
    async onSessionFlush(session) {
        if (this.stopping)
            return;
        const chatId = this.bySession.get(session.id);
        if (chatId === undefined)
            return;
        // M1-E2: arbitrary session flushes debounce like turn/end — stop() still
        // forces the final saveMapping directly.
        this.saveMappingDebounced();
    }
    // ------------------------------------------------------------ registry facades
    /** Same-name delegations to the chat registry (D1-PR3): the command table's
     * ctx and the session-event links keep calling the bridge exactly as before
     * the split. */
    /** Get (or create) the agent for a chat. */
    ensureChat(chatId, nickname) {
        return this.registry.ensureChat(chatId, nickname);
    }
    effectiveCwd(chatId) {
        return this.registry.effectiveCwd(chatId);
    }
    saveMappingDebounced() {
        this.registry.saveMappingDebounced();
    }
    healSessionCollision(chatId) {
        return this.registry.healSessionCollision(chatId);
    }
    /**
     * /new: the registry disposes the agent and retires its session id so the
     * next inbound message creates a brand-new session (fresh history; the old
     * conversation stays on disk). The confirmation is sent directly through
     * the outbound pipeline since no agent is left to reply.
     */
    async resetChat(chatId) {
        await this.registry.resetChat(chatId);
        this.sendToChat(chatId, '✅ 已开启新会话，下一条消息将进入全新会话，旧对话历史保留在之前的会话中。').catch((error) => {
            this.deps.log('warn', 'reset notice send failed: ' + String(error));
        });
    }
    /**
     * Compose the QQ channel's scoped world for one agent: the QQ platform
     * prompt section and the qq_* tools. Registered on `agentCtx` (the agent's
     * own scope) instead of the plugin context, so Web/local sessions never see
     * the channel instructions or the media tools — they cannot (and should
     * not) push messages to QQ.
     *
     * Args:
     *   agentCtx (Context): 新会话 agent 的作用域。
     *   chatId (ChatId): 该 agent 所属的 QQ 会话，决定群聊/私聊附加提示词。
     *
     * Returns:
     *   无。
     *
     * Callers:
     *   - `src/registry/index.ts:buildSetup`（创建与恢复会话的组装路径）。
     */
    installChannelScope(agentCtx, chatId) {
        const extraPrompt = splitChatId(chatId).kind === 'group'
            ? this.deps.config.extraPromptGroup
            : this.deps.config.extraPromptPrivate;
        agentCtx.systemPrompt.section({
            name: 'channel:dsh-onebot',
            order: 90,
            text: buildPlatformPrompt(chatId, this.deps.config.restrictedMemberPrefix, extraPrompt),
        });
        this.installChannelSkill(agentCtx);
        registerTools(agentCtx, this, this.deps.connection, {
            maxImageBytes: this.deps.config.maxImageBytes,
            maxVoiceBytes: this.deps.config.maxVoiceBytes,
            maxFileBytes: this.deps.config.maxFileBytes,
        });
    }
    /**
     * 给 QQ 会话注册渠道技能：正文与 references 都来自包内 assets，
     * 注册落在 agent 作用域，其他会话看不到这个技能。
     *
     * Args:
     *   agentCtx (Context): 会话的 agent 作用域。
     *
     * Returns:
     *   无。
     *
     * Callers:
     *   - `installChannelScope`。
     */
    installChannelSkill(agentCtx) {
        const path = join(CHANNEL_SKILL_DIR, 'SKILL.md');
        const raw = readFileSync(path, 'utf8');
        const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw);
        if (frontmatter?.[1] === undefined)
            throw new Error('dsh-onebot: ' + path + ' 缺少 frontmatter');
        const description = /^description:\s*(.+)$/m.exec(frontmatter[1])?.[1]?.trim();
        if (description === undefined || description === '')
            throw new Error('dsh-onebot: ' + path + ' 缺少 description');
        // agent 作用域的 inject 由宿主组装，不含 skills；ctx.get 绕开属性注入限制，
        // 返回的服务仍按调用上下文（agent 作用域）落到对应技能层。
        const skills = agentCtx.get('skills');
        if (skills === undefined)
            throw new Error('dsh-onebot: 宿主未提供 skills 服务，无法注册渠道技能');
        skills.register({
            name: CHANNEL_SKILL_NAME,
            description,
            content: raw.slice(frontmatter[0].length).trim(),
            source: 'bundled',
            resourceBase: { kind: 'directory', path: CHANNEL_SKILL_DIR.split(sep).join('/') },
        });
    }
    // ------------------------------------------------------------ typing
    /** Start the NapCat typing indicator (private chats only). */
    startTyping(chat) {
        const ref = splitChatId(chat.chatId);
        if (ref.kind !== 'private')
            return;
        this.stopTyping(chat);
        const pulse = () => {
            if (this.stopping)
                return;
            void this.guardedConnectionCall('set_input_status', {
                user_id: Number(ref.target),
                event_type: 1,
            }, chat.chatId).catch(() => undefined);
        };
        pulse();
        chat.typingTimer = setInterval(pulse, 5_000).unref();
    }
    /** Stop the typing indicator. */
    stopTyping(chat) {
        if (chat.typingTimer !== undefined) {
            clearInterval(chat.typingTimer);
            chat.typingTimer = undefined;
        }
        const ref = splitChatId(chat.chatId);
        if (ref.kind !== 'private')
            return;
        void this.guardedConnectionCall('set_input_status', {
            user_id: Number(ref.target),
            event_type: 0,
        }, chat.chatId).catch(() => undefined);
    }
}
export { OneBotNotConnectedError, OneBotActionError } from '../onebot/connection.js';
