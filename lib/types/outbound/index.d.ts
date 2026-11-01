/**
 * 出站管线：每会话串行发送链、纯文本发送（sendToChat）、原始段发送、
 * 合并转发与断线待发队列。
 * 频率控制只有一个落点：按字数的发送间隔（throttleSend）。
 * @module dsh-onebot/outbound
 */
import type { BridgeConfig } from '../bridge/config.js';
import type { ChatId } from '../chat/index.js';
import type { TraceStage } from '../ops/trace.js';
/** One OneBot message segment for outbound sends. */
export interface OutboundSegment {
    type: string;
    data: Record<string, unknown>;
}
/** Options for an explicit outbound send (from tools or command replies). */
export interface SendOptions {
    replyTo?: string;
    /** Queue the send for resend on reconnect instead of failing while the
     * connection is down (error notices). Tool sends never queue: the model
     * sees the failure and decides whether to retry. */
    queuable?: boolean;
}
/** The bridge capabilities the outbound pipeline touches. Deliberately
 * narrower than BridgeDeps: the connection call gate, the stop flag guarding
 * the B6 drain, and the config subset the pipeline reads — never the agent
 * registry, media store, or policy. */
export interface OutboundContext {
    /** Whether the OneBot connection currently accepts sends. */
    connected(): boolean;
    /** The connection's own QQ id (forward-node uin). */
    selfId(): string;
    /** Raw OneBot action invocation (send_msg / send_*_forward_msg). W1/T5:
     * the target chatId rides along when known so the bridge's inject dry-run
     * guard can attribute the call to a chat's injected round. */
    call(action: string, params: Record<string, unknown>, chatId?: ChatId): Promise<unknown>;
    /** Bridge stop flag: the B6 drain must never run while stopping. */
    isStopping(): boolean;
    /** Bridge log line callback. */
    log(level: 'info' | 'warn' | 'error' | 'debug', message: string): void;
    /** W1: emit one outbound/queue decision event for a chat. The bridge owns
     * the traceId resolution (chat-level association table; unmapped proactive
     * writes mint a fresh id) — absent = tracing off, zero cost. */
    trace?: (chatId: ChatId, event: {
        stage: TraceStage;
        ok?: boolean;
        reason?: string;
        data?: Record<string, unknown>;
    }) => void;
    /** 出站管线读取的配置子集（发送间隔键可选，缺席用默认值）。 */
    config: Pick<BridgeConfig, 'botQQ'> & Partial<{
        /** 每条消息的固定间隔（毫秒）。 */
        outboundIntervalBaseMs: number;
        /** 每个字追加的间隔（毫秒）。 */
        outboundIntervalPerCharMs: number;
        /** 间隔的随机抖动百分比（0–100）。 */
        outboundIntervalJitterPct: number;
    }>;
}
/** 发送间隔默认值：每秒级基础间隔 + 每字追加 + ±30% 抖动。 */
export declare const DEFAULT_OUTBOUND_INTERVAL_BASE_MS = 300;
export declare const DEFAULT_OUTBOUND_INTERVAL_PER_CHAR_MS = 60;
export declare const DEFAULT_OUTBOUND_INTERVAL_JITTER_PCT = 30;
/**
 * 一条出站消息的字数：文本段算字符数，引用段不计，其余段各计 1。
 *
 * Args:
 *   message (OutboundSegment[]): 出站段数组。
 *
 * Returns:
 *   number: 用于节流的字数。
 */
export declare function outboundTextLength(message: OutboundSegment[]): number;
/**
 * The outbound pipeline. Owns the B6 pendingSends state; the bridge keeps
 * same-name delegating facades and wires the reconnect drain trigger.
 */
export declare class OutboundPipeline {
    private readonly ctx;
    /** Clock override (tests); behavior-affecting timestamps (send chains,
     * offline queue, write gate) all read it — never the wall clock directly. */
    private readonly now;
    /** Per-chat FIFO of model final replies parked while disconnected; drained
     * oldest-first on reconnect (M1-B6). */
    private readonly pendingSends;
    /** 每会话上一条消息的发送时刻（按字数节流的基准）。 */
    private readonly lastSendAtByChat;
    constructor(ctx: OutboundContext, options?: {
        now?: () => number;
    });
    /**
     * 发送插件自产的纯文本（命令回执、通知、错误提示）。
     *
     * 模型回复不走这里：模型的发言出口是 `qq_send_message` 等工具，
     * 工具把结构化消息段直接交给 `sendSegments`。
     *
     * Args:
     *   chatId (ChatId): 目标会话。
     *   text (string): 要发送的纯文本。
     *   options (SendOptions): 引用与排队选项。
     *
     * Returns:
     *   Promise<string[]>: 发出的 message_id 列表（空正文时为空数组）。
     *
     * Callers:
     *   - `commands/index.ts`：命令回执。
     *   - `bridge/index.ts`：固定通知、错误通知、新会话回执。
     *   - `outbound/index.ts:drainPendingSends`：断线排队补发。
     */
    sendToChat(chatId: ChatId, text: string, options?: SendOptions): Promise<string[]>;
    /** Park one queuable send for a chat while disconnected (M1-B6):
     * per-chat FIFO, capped — the oldest entry is dropped beyond the cap. */
    private queuePendingSend;
    /**
     * 按字数排队：同一会话相邻两条消息至少间隔 base + perChar × 字数，
     * 再乘一个随机抖动，避免机器人的发送节奏完全固定。
     *
     * Args:
     *   chatId (ChatId): 目标会话。
     *   chars (number): 本条消息的字数（outboundTextLength）。
     *
     * Returns:
     *   Promise<void>: 等够间隔后返回。
     */
    private throttleSend;
    /** Resend parked final replies oldest-first after a reconnect (M1-B6).
     * Per-chat send chains keep the order; a send that hits a fresh
     * disconnection re-queues itself via the queuable gate. Expired entries
     * (TTL) are dropped. Never runs while stopping. Wired from the bridge's
     * onStatus(true) handler (bridge.start). */
    drainPendingSends(): void;
    /**
     * Send raw OneBot segments (used by the media tools).
     *
     * Args:
     *   chatId (ChatId): 目标会话。
     *   segments (OutboundSegment[]): 出站段。
     *   options (SendOptions): 引用与排队选项。
     *
     * Returns:
     *   Promise<string | undefined>: 发出的 message_id。
     */
    sendSegments(chatId: ChatId, segments: OutboundSegment[], options?: SendOptions): Promise<string | undefined>;
    /** B8d: per-chat send chains owned by the pipeline (decoupled from the
     * registry's chat lifecycle — unregistered chats serialize too, the
     * original C6b ask). Entries clean themselves up once settled so evicted
     * chats do not accumulate. */
    private readonly sendChains;
    /** Serialize work on one chat's send chain. */
    private enqueue;
    /** Send one message to a chat and return its message id. */
    sendMsg(chatId: ChatId, segments: OutboundSegment[], options: SendOptions): Promise<string | undefined>;
    /**
     * Send forward nodes as a merged-forward message.
     *
     * Args:
     *   chatId (ChatId): 目标会话。
     *   nodes (Array<{ name: string; content: string }>): 转发节点。
     *
     * Returns:
     *   Promise<void>
     */
    sendForward(chatId: ChatId, nodes: Array<{
        name: string;
        content: string;
    }>): Promise<void>;
    /** 发送合并转发（`qq_send_forward` 工具的唯一落点）。 */
    private sendForwardNodes;
}
