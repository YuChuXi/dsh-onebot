/**
 * The chat↔agent bridge: one Agent per QQ chat, inbound message pipeline
 * (policy → parse → media → STT → quote/forward expansion → followup),
 * outbound delivery driven by session events (assistant/message, turn/end),
 * typing indicator, per-chat send ordering, and chat→session mapping
 * persistence for restart resume. Ported from the Hermes OneBotAdapter
 * gateway-interaction half onto the dsh headless-runner agent pattern.
 * @module dsh-onebot/bridge
 */
import type { ModelSelection } from '@deepseek-ai/dsh-agent';
import type { AgentDefaultModelLike, BridgeDeps } from './config.js';
import type { OneBotEvent } from '../onebot/connection.js';
import type { ChatId } from '../chat/index.js';
import type { OutboundSegment, SendOptions } from '../outbound/index.js';
import type { ChatAgent } from '../registry/index.js';
/** T2 (P1): the queue notice sent to a chat when a message arrives while its
 * task is running under the default 'queue' policy — at most ONE per running
 * turn (the flag resets at turn/end) so a burst of queued messages never
 * spams the chat. Exported for the deterministic text wait in tests. */
export declare const QUEUE_NOTICE_TEXT = "\u23F3 \u5F53\u524D\u4EFB\u52A1\u8FD0\u884C\u4E2D\uFF0C\u65B0\u6D88\u606F\u5DF2\u6392\u961F\uFF0C\u5C06\u5728\u5F53\u524D\u4EFB\u52A1\u7ED3\u675F\u540E\u4F9D\u6B21\u5904\u7406\u3002";
/** 插话成功提示：自动插话与语音转写共用同一句。 */
export declare const STEER_ACCEPTED_NOTICE = "\u2705 \u5DF2\u4F5C\u4E3A\u8865\u5145\u6307\u4EE4\u63D0\u4EA4\u7ED9\u5F53\u524D\u4EFB\u52A1\uFF0C\u6A21\u578B\u5C06\u5728\u4E0B\u4E00\u6B65\u8BFB\u53D6\u3002";
/**
 * Bridge between OneBot events and dsh agents. Create via the constructor and
 * call start() from the plugin's effect; call stop() on disposal.
 */
export declare class ChatBridge {
    private readonly deps;
    /** Outbound pipeline (D1-PR2): the same-name bridge methods below delegate here. */
    private readonly outbound;
    /** The chat↔session registry (D1-PR3): chats/bySession dual index, the
     * persistence pair, per-chat settings and the create/resume assembly. */
    private readonly registry;
    /** Inbound pipeline (D1-PR4): normalizeOneBot11 + the policy→media→quote→
     * dispatch path; the same-name bridge methods below delegate here. */
    private readonly inbound;
    /** Live registry indexes — the inbound/outbound/turn links keep reading
     * them through these same-name views. */
    private get chats();
    private get bySession();
    private sessionEventOff;
    private sessionFlushOff;
    /** W1: chat-level traceId association table — session events arrive on a
     * different async chain than the inbound pipeline, so dispatchFollowup
     * records the initiating traceId per chat here and onSessionEvent reads it
     * back (agent 回复事件归属发起 traceId). Last dispatch wins; entries are
     * dropped when the chat is removed. Never cleared at turn/end: tool sends
     * run on the agent's chain and may land after the turn closed. One entry
     * per chat id (bounded by the chat population), so growth is not a
     * concern. */
    private readonly traceByChat;
    /** W1/T5: chatId → the traceId of the chat's unsettled INJECTED round
     * (independent of the trace sink, so the dry-run guard covers the async
     * agent reply even with tracing off). Cleared by a real dispatch to the
     * chat or when the chat is removed. */
    private readonly injectRoundByChat;
    /** T2 (P1): chats that already got the QUEUE_NOTICE_TEXT for their current
     * running turn (one notice per turn; cleared at turn/end and on chat
     * removal — bounded by the chat population). */
    private readonly queueNoticeChats;
    /** Plugin version + git commit, read once for /ver. */
    private pluginVersion;
    private pluginCommit;
    private stopping;
    constructor(deps: BridgeDeps);
    /** Start listening: wire connection handlers and the session event feed. */
    start(): void;
    /** Stop everything: dispose agents, save mapping, cancel timers. */
    stop(): Promise<void>;
    /** Map an agent session id back to its chat (for model tools). */
    chatForSession(sessionId: string): ChatId | undefined;
    /** Whether a caller backing an agent session may perform file edits. QQ chats
     * require the currently running turn's initiator to be an admin (role frozen
     * from the dispatch queue at turn/start); non-QQ sessions (Web and other
     * channels) are trusted by default (A1 scoping). Unknown states fail closed
     * as member. */
    canEditFiles(sessionId: string): boolean;
    /** qq_thinking: the live agent of one chat — the agent-owned model selection
     * (dsh 0.2.2 `agent.model`) is the only live view of a chat's thinking level.
     *
     * Args:
     *   chatId (ChatId): 目标会话。
     *
     * Returns:
     *   ChatAgent['agent'] | undefined: 会话在线时返回该会话的 agent，否则 undefined。
     *
     * Callers:
     *   - `src/tools/index.ts:registerTools`（qq_thinking 的 get/set 路径）。
     */
    agentOf(chatId: ChatId): ChatAgent['agent'] | undefined;
    /** qq_thinking: the deployment default model selection.
     *
     * Returns:
     *   ModelSelection | undefined: 部署默认选择；未配置默认模型时 undefined。
     *
     * Callers:
     *   - `src/tools/index.ts:registerTools`（qq_thinking 的 get 与 set default 路径）。
     */
    deploymentModel(): ModelSelection | undefined;
    /** qq_thinking: the deployment default-model store (saveSelection port).
     *
     * Returns:
     *   AgentDefaultModelLike | undefined: 宿主未提供该服务时 undefined。
     *
     * Callers:
     *   - `src/tools/index.ts:registerTools`（qq_thinking 的 set default 路径）。
     */
    defaultModelStore(): AgentDefaultModelLike | undefined;
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
    mediaSendRoots(sessionId: string | undefined): Promise<{
        roots: string[];
        isTurnAdmin: boolean;
    }>;
    /** Whether the connection is usable for sends. */
    get connected(): boolean;
    /**
     * Send plugin-authored plain text to a chat (command replies, notices,
     * error notices).
     * @param chatId - target chat.
     * @param text - plugin-authored plain text.
     * @param options - optional reply target.
     * @returns the sent message ids.
     */
    sendToChat(chatId: ChatId, text: string, options?: SendOptions): Promise<string[]>;
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
     *   - `src/tools/stickers.ts`（qq_sticker_list 预览、qq_collect_sticker 的 URL / 商城表情）。
     */
    saveSticker(url: string): Promise<string>;
    /**
     * Send raw OneBot segments (used by the media tools).
     * @param chatId - target chat.
     * @param segments - outbound segments.
     * @returns the sent message id.
     */
    sendSegments(chatId: ChatId, segments: OutboundSegment[], options?: SendOptions): Promise<string | undefined>;
    /**
     * Wait for the loader's complete application (model selection, settings,
     * persistence) before reading the default model — the same gate the
     * headless runner uses, so the pinned selection is never a half-loaded
     * default.
     */
    private ready;
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
    handleInbound(event: OneBotEvent, opts?: {
        injected?: boolean;
    }): Promise<void>;
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
    private observeNonMessageEvent;
    private handleInboundOnce;
    /** W1: mint the inbound traceId + scope and record the first (收到消息)
     * event; undefined when tracing is off (zero overhead, zero difference).
     * W1/T5: an injected event REUSES its inject round's traceId, so the whole
     * injected round (pipeline decisions + intercepted outbound calls) shares
     * one traceId in the trace stream. */
    private beginInboundTrace;
    private processInbound;
    /** Feed one user message into a chat's agent (create on demand) and queue
     * the initiator's turn role. */
    private dispatchFollowup;
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
    private tryHandleCommand;
    /**
     * 命令面可用的桥接能力：只暴露 /new、/session、/model、/compact 需要的部分，
     * 每次调用实时解析（模型目录必须走活服务）。
     */
    private get commandCtx();
    /** M3-D4c: steer a completed voice transcript into the chat's agent — the
     * running turn consumes it at its nearest step boundary; an idle agent
     * opens a turn. No live chat (dispatch dropped/never happened) drops it. */
    private steerTranscript;
    /** T2 (P1): the single agent.steer write point — one createUserMessage with
     * the producer-owned source kind (the session-v4 guard counts the source
     * write points; this and dispatchFollowup are the only two). Shared by the
     * voice transcript path (steerTranscript) and the busy-turn steer policy.
     * Returns false when the chat has no live agent (nothing was steered). */
    private steerMessage;
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
    private interceptBusyTurn;
    /** Send forward nodes as a merged-forward message. */
    sendForward(chatId: ChatId, nodes: Array<{
        name: string;
        content: string;
    }>): Promise<void>;
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
    private guardedConnectionCall;
    private onSessionEvent;
    /** W1: the trace scope for one chat's session events, resolved through the
     * chat-level association table; undefined when tracing is off or the chat
     * has no recorded dispatch (host-initiated turns stay untraced). */
    private traceForChat;
    private onSessionFlush;
    /** Same-name delegations to the chat registry (D1-PR3): the command table's
     * ctx and the session-event links keep calling the bridge exactly as before
     * the split. */
    /** Get (or create) the agent for a chat. */
    private ensureChat;
    private effectiveCwd;
    private saveMappingDebounced;
    private healSessionCollision;
    /**
     * /new: the registry disposes the agent and retires its session id so the
     * next inbound message creates a brand-new session (fresh history; the old
     * conversation stays on disk). The confirmation is sent directly through
     * the outbound pipeline since no agent is left to reply.
     */
    private resetChat;
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
    private installChannelScope;
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
    private installChannelSkill;
    /** Start the NapCat typing indicator (private chats only). */
    private startTyping;
    /** Stop the typing indicator. */
    private stopTyping;
}
export { OneBotNotConnectedError, OneBotActionError } from '../onebot/connection.js';
