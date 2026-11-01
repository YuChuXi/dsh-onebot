/**
 * 桥接的运行期配置与宿主端口：BridgeConfig 是插件配置的解析结果，
 * BridgeDeps 是 ChatBridge 依赖的宿主服务切片。
 * @module dsh-onebot/bridge/config
 */
import type { AgentRegistry, ModelSelection } from '@deepseek-ai/dsh-agent';
import type { LlmModelInfo, LlmProviderInfo } from '@deepseek-ai/dsh-llm';
import type { Session, SessionEvent, SessionId, SessionStore } from '@deepseek-ai/dsh-session';
import type { OneBotConnection } from '../onebot/connection.js';
import type { MediaStore } from '../media/store.js';
import type { Transcriber } from '../media/stt.js';
import type { AccessPolicyConfig } from '../chat/index.js';
import type { TraceSink } from '../ops/trace.js';
import type { InboundRecorder } from '../ops/record.js';
import type { InjectChannel } from '../inbound/inject.js';
/** Resolved runtime configuration for the bridge. */
export interface BridgeConfig {
    botQQ: string;
    ignoreSelf: boolean;
    requireMention: boolean;
    sendErrorNotice: boolean;
    /** 出站节流：每条消息的固定间隔（毫秒），默认 300。 */
    outboundIntervalBaseMs: number;
    /** 出站节流：每个字追加的间隔（毫秒），默认 60。 */
    outboundIntervalPerCharMs: number;
    /** 出站节流：间隔随机抖动百分比（0–100），默认 30。 */
    outboundIntervalJitterPct: number;
    /** 每次 @ 注入的记录总条数（含触发消息）；0 = 只注入触发消息，absent → 50。 */
    recentMessages?: number;
    /** W2-② (chatId, message_id) 去重窗口秒数；0 关闭，absent → 300。 */
    dedupWindowSeconds?: number;
    /** 休眠模式：window = 用 sleepStart/sleepEnd 的每日时段；peak = 高峰时段。 */
    sleepMode?: 'window' | 'peak';
    /** 休眠时段起点（HH:MM，Asia/Shanghai 墙钟）；留空 = 不启用。 */
    sleepStart?: string;
    /** 休眠时段终点（HH:MM）；与起点相同视为未启用。 */
    sleepEnd?: string;
    restrictedMemberPrefix: boolean;
    /** 私聊附加提示词：追加在通道提示词末尾；留空不注入。 */
    extraPromptPrivate: string;
    /** 群聊附加提示词：追加在通道提示词末尾；留空不注入。 */
    extraPromptGroup: string;
    mediaDir: string;
    maxImageBytes: number;
    maxVoiceBytes: number;
    maxFileBytes: number;
    agentPreset: string;
    workspacePath: string;
    /** Max inbound file bytes fetched via QQ direct link / base64 (0 = no cap). */
    maxInboundFileBytes: number;
    /** B8c: chats idle longer than this many days are evicted on the next
     * inbound message (0 disables; default 7). Evicted chats keep their
     * chat→session mapping, so a later message resumes the same session. */
    chatIdleEvictDays?: number;
    /** 插话开关（设置面板复选框）：true = 任务运行中收到的新消息插进当前回合。 */
    steerEnabled?: boolean;
    /** 插话资格（设置面板复选框）：true = 所有成员都能插话，false/absent = 仅管理员。 */
    steerAllMembers?: boolean;
    /** 受限成员插话（设置面板复选框）：absent/true = 受限成员也能插话；false = 受限成员始终排队。 */
    steerAllowRestricted?: boolean;
    /** 插话提示（设置面板复选框）：absent/true = 插话成功回一句提交提示；false = 静默插话。 */
    steerNotice?: boolean;
}
/** Observability ports: the trace sink, the inbound recorder and the inject
 * channel ride as optional members; absent = the feature is off. */
export interface TraceBridgeConfig {
    /** Decision-trace sink; absent/disabled = no traceIds and no jsonl. */
    trace?: TraceSink | undefined;
    /** W1/T5: inbound recorder (recordInbound); absent = recording off. */
    recorder?: InboundRecorder | undefined;
    /** W1/T5: inject channel (injectEnabled, DEBUG-ONLY); absent = channel off. */
    inject?: InjectChannel | undefined;
}
/** Agent-preset service (dsh-agent-presets): joins agents to a preset composition. */
export interface AgentPresetsLike {
    /** The preset id a new session gets when none is named (deployment default). */
    readonly defaultId: string;
    /** Resolve one preset by id (undefined = default); throws when no root supplies it. */
    resolve(id?: string): Promise<{
        id: string;
    }>;
    mount(agentCtx: unknown, id?: string): Promise<{
        id: string;
    }>;
}
/** Structural slice of one logged session event the /session preview reads
 * — only the preview's fields are named, and the host's SessionEvent (whose
 * 'user/message' payload is a UserMessage) satisfies it. */
export interface SessionPreviewEvent {
    type?: string;
    data?: {
        agentPreset?: string;
        source?: {
            kind?: string;
        };
        content?: readonly {
            type?: string;
            text?: string;
        }[];
    };
}
/** Narrowed read handle over one stored session (dsh-session-persistence's
 * `SessionHandle` from `open(id, 'read')`): the /session preview reads the
 * immutable header plus a small event prefix and then MUST close the handle
 * (AsyncDisposable — a leaked read handle pins backend resources). */
export interface SessionReadHandleLike {
    readonly header: {
        createdAt?: number;
        agentPreset?: string;
    };
    read(offset?: number, length?: number): Promise<{
        events: readonly SessionPreviewEvent[];
    }>;
    close(): Promise<void>;
}
/** Durable session persistence (dsh-session-persistence): cold-read what a session recorded. */
export interface SessionPersistenceLike {
    /** Existence probe (dsh-session-persistence `stat`): resolves the stored
     * snapshot, or undefined when the id owns no durable log. */
    stat(id: SessionId): Promise<object | undefined>;
    /** Open an existing stored session for reading: 'read' never takes write
     * ownership and works while a live writer holds the session. */
    open(id: SessionId, access: 'read'): Promise<SessionReadHandleLike>;
}
/** Workspace registry (dsh-workspace): durable workspace membership. */
export interface WorkspaceLike {
    id: string;
    path: string;
    sessionIds: readonly string[];
    attachSession(sessionId: string): Promise<void>;
}
/** Workspace registry (dsh-workspace): durable workspace membership. */
export interface WorkspaceRegistryLike {
    resolveByPath(path: string): Promise<WorkspaceLike | undefined>;
    create(path: string, title?: string): Promise<WorkspaceLike>;
    list(): WorkspaceLike[];
}
/** Session-title service (dsh-session-title): the host session list's names. */
export interface SessionTitlePort {
    /** The folded title of one live session; undefined before the first title. */
    get(session: Session): {
        title?: string;
    } | undefined;
    /** Pin an explicit title (a `session/title` event with source `user`). */
    rename(session: Session, title: string): {
        title: string;
    };
}
/** Default model service (dsh-agent-default-model): read/save the default selection. */
export interface AgentDefaultModelLike {
    currentSelection(): ModelSelection | undefined;
    saveSelection(next: ModelSelection): Promise<void>;
}
/** Live model-catalog port (M2-C5b): the only llm surface the command domain
 * reads (/model). index.ts implements it over a live llm-service lookup so
 * late-registered providers stay visible; commands never touch Context. */
export interface LlmCatalogPort {
    listProviders(): LlmProviderInfo[];
    listModels(provider: string): Promise<LlmModelInfo[]>;
}
/** Session-event feed port (M2-C5b): the narrowed event-bus surface the bridge
 * subscribes to, replacing the whole-plugin Context. index.ts satisfies it
 * with the host context itself (its event-bus `on` IS the implementation). */
export interface SessionEventPort {
    on(type: 'session/event', handler: (session: Session, event: SessionEvent) => void): () => void;
    on(type: 'session/flush', handler: (session: Session) => void): () => void;
}
/** Services the bridge needs (M2-C5b: the plugin Context enters only through
 * the two explicit ports below — session events and the /model catalog). */
export interface BridgeDeps {
    ctx: SessionEventPort;
    /** Resolves once the host's boot-time configuration (the loader service) is
     * fully applied; index.ts owns the 'loader' lookup and swallows its errors.
     * Absent in test assemblies = no gate (matches the previously swallowed
     * lookup). Must not reject. */
    hostReady?: (() => Promise<void>) | undefined;
    /** Live model-catalog port for /model (M2-C5b); index.ts implements it over
     * the live llm service. Absent only in assemblies that never route /model. */
    llmCatalog?: LlmCatalogPort | undefined;
    connection: OneBotConnection;
    /** The dsh data home (default <home>/.dsh); used to enumerate agent presets. */
    dshHome?: string | undefined;
    media: MediaStore;
    transcriber: Transcriber;
    agents: AgentRegistry;
    sessions: SessionStore;
    agentPresets: AgentPresetsLike | undefined;
    /** Host command runtime: forwards native slash commands. `submittedAttachments`
     * (always pass an empty array) and `signal` are both required (the host reads
     * `.length` / `.aborted` unconditionally); the settled return is the
     * `{ commandId, result: { kind, text } }` wrapper. */
    commands?: {
        execute(agent: unknown, line: string, submittedAttachments: readonly unknown[], signal: AbortSignal): Promise<{
            kind?: string;
            text?: string;
            result?: {
                kind?: string;
                text?: string;
            };
        }>;
    } | undefined;
    /** Durable persistence for cold reads: the recorded preset at resume and
     * the /session list's per-item content previews; absent = config/default
     * fallback and preview-less list items. */
    sessionPersistence: SessionPersistenceLike | undefined;
    workspaceRegistry: WorkspaceRegistryLike | undefined;
    /** Live lookup of the host's session-title service: the service registers
     * after the plugin mounts, so it is resolved per use. Absent = no titles. */
    sessionTitle?: (() => SessionTitlePort | undefined) | undefined;
    agentDefaultModel: AgentDefaultModelLike | undefined;
    defaultModel: (() => ModelSelection | undefined) | undefined;
    config: BridgeConfig & TraceBridgeConfig;
    policy: AccessPolicyConfig;
    /** Log line callback (level, message). */
    log(level: 'info' | 'warn' | 'error' | 'debug', message: string): void;
}
