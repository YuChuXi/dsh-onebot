/**
 * dsh-onebot: a QQ (OneBot 11 / NapCat) chat channel for DeepSeek Harness.
 *
 * Mounts inside the dsh host process: a reverse- or forward-WebSocket link to
 * NapCat, one Agent per QQ chat, inbound images/voice handled for the model
 * (whisper STT when enabled), outbound sends driven exclusively by qq_* tool
 * calls, merged-forward sending, allowlist/mention access control, and a set
 * of qq_* tools for media and NapCat APIs.
 * @module dsh-onebot
 */
import type { Context as CordisContext } from '@deepseek-ai/cordis';
import type SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import type ToolRuntime from '@deepseek-ai/dsh-tools';
import type { AgentRegistry } from '@deepseek-ai/dsh-agent';
import type { SessionStore } from '@deepseek-ai/dsh-session';
import type { ModelSelection } from '@deepseek-ai/dsh-agent';
import type Z from '@deepseek-ai/schemastery';
type Context = CordisContext & {
    tools: ToolRuntime;
    systemPrompt: SystemPrompt;
    agents: AgentRegistry;
    sessions: SessionStore;
    agentDefaultModel: {
        currentSelection(): ModelSelection | undefined;
        saveSelection(next: ModelSelection): Promise<void>;
    };
    agentPresets: {
        readonly defaultId: string;
        resolve(id?: string): Promise<{
            id: string;
        }>;
        mount(agentCtx: unknown, id?: string): Promise<{
            id: string;
        }>;
    };
    sessionPersistence: {
        /** dsh-session-persistence 0.1.6 `stat`: the stored snapshot, or
         * undefined when the id owns no durable log. */
        stat(id: string): Promise<object | undefined>;
        /** /session list previews: open a stored session read-only (never takes
         * write ownership), read the header + a small event prefix, then close. */
        open(id: string, access: 'read'): Promise<{
            header: {
                createdAt?: number;
                agentPreset?: string;
            };
            read(offset?: number, length?: number): Promise<{
                events: readonly {
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
                }[];
            }>;
            close(): Promise<void>;
        }>;
    };
    workspaceRegistry: {
        resolveByPath(path: string): Promise<{
            id: string;
            path: string;
            sessionIds: readonly string[];
            attachSession(sessionId: string): Promise<void>;
        } | undefined>;
        create(path: string, title?: string): Promise<{
            id: string;
            path: string;
            sessionIds: readonly string[];
            attachSession(sessionId: string): Promise<void>;
        }>;
        list(): Array<{
            id: string;
            path: string;
            sessionIds: readonly string[];
        }>;
    };
    commands: {
        execute(agent: unknown, line: string, submittedAttachments: readonly unknown[], signal: AbortSignal): Promise<{
            kind?: string;
            text?: string;
            result?: {
                kind?: string;
                text?: string;
            };
        }>;
    };
};
export declare const name = "dsh-onebot";
export declare const inject: string[];
/** Plugin configuration (validated by schemastery). */
export interface Config {
    mode: 'reverse' | 'forward';
    host: string;
    port: number;
    url: string;
    accessToken: string;
    /** Forward-mode reconnect attempt limit; 0 = retry forever. */
    reconnectMaxAttempts: number;
    botQQ: string;
    requireMention: boolean;
    /** 插话开关：开=任务运行中的新消息作为补充指令插进当前回合。 */
    steerEnabled: boolean;
    /** 插话资格：开=所有成员都能插话；关（默认）=仅管理员。 */
    steerAllMembers: boolean;
    /** 受限成员插话：开（默认）=群内非管理员的成员也能插话；关=受限成员始终排队。 */
    steerAllowRestricted: boolean;
    /** 插话提示：开（默认）=插话成功回一句提交提示；关=静默插话。 */
    steerNotice: boolean;
    dmPolicy: 'open' | 'allowlist' | 'disabled';
    groupPolicy: 'open' | 'allowlist' | 'disabled';
    allowFrom: string[];
    groupAllowFrom: string[];
    adminUsers: string[];
    allowAllUsers: boolean;
    ignoreSelf: boolean;
    sendErrorNotice: boolean;
    outboundIntervalBaseMs: number;
    outboundIntervalPerCharMs: number;
    outboundIntervalJitterPct: number;
    /** 每次 @ 注入的记录总条数（含触发消息）；0 = 只注入触发消息。 */
    recentMessages: number;
    sleepMode: 'window' | 'peak';
    sleepStart: string;
    sleepEnd: string;
    restrictedMemberPrefix: boolean;
    /** 私聊附加提示词：人设、背景、语言风格等，原样注入系统提示词；留空不注入。 */
    extraPromptPrivate: string;
    /** 群聊附加提示词：人设、背景、语言风格等，原样注入系统提示词；留空不注入。 */
    extraPromptGroup: string;
    /** 私聊新建会话的思考强度；default = 跟随部署默认。 */
    thinkingPrivate: 'off' | 'low' | 'high' | 'max' | 'default';
    /** 群聊新建会话的思考强度；default = 跟随部署默认。 */
    thinkingGroup: 'off' | 'low' | 'high' | 'max' | 'default';
    /** 私聊使用的模型：`provider/model`；留空 = 部署默认。 */
    modelPrivate: string;
    /** 群聊使用的模型：`provider/model`；留空 = 部署默认。 */
    modelGroup: string;
    mediaDir: string;
    tempTtlHours: number;
    outboundImageMaxBytes: number;
    maxVoiceBytes: number;
    maxFileBytes: number;
    inboundImageMaxPx: number;
    sttEnabled: boolean;
    sttEngine: 'auto' | 'openai' | 'whisper-cpp' | 'custom';
    sttCommand: string;
    sttArgs: string[];
    sttModel: string;
    sttTimeoutMs: number;
    agentPreset: string;
    workspacePath: string;
    inboundFileMaxBytes: number;
    /** B8c: chats idle longer than this many days are evicted (0 disables). */
    chatIdleEvictDays: number;
    /** Escape hatch: skip the download private-address check (local reverse proxy). */
    allowPrivateHosts: boolean;
    /** W2-②: inbound (chatId, message_id) dedup window in seconds; 0 disables. */
    dedupWindowSeconds: number;
    /** W1: decision-trace jsonl (mediaDir/qq-trace.jsonl); default off. */
    traceEnabled: boolean;
    /** W1: trace level; 'warn' records only ok:false (rejected/failed/dropped) events. */
    traceLevel: 'debug' | 'warn';
    /** W1/T5: record every inbound event into mediaDir/qq-inbox.jsonl (default off). */
    recordInbound: boolean;
    /** W1/T5: mask 6+ digit runs (QQ/group numbers) in the recording (default off). */
    inboxRedact: boolean;
    /** W1/T5 (DEBUG-ONLY): enable the qq-inject.jsonl injection channel (default off). */
    injectEnabled: boolean;
    /** W1/T5: intercept all outbound writes of injected rounds (default true). */
    injectDryRun: boolean;
    /** W1/T5: inject queue poll interval in ms (min 500). */
    injectIntervalMs: number;
    /** Console log gate: messages below this level are dropped (debug < info < warn < error). */
    logLevel: 'debug' | 'info' | 'warn' | 'error';
}
/** Default media dir: <dsh-home>/media/onebot (dsh-home = $DSH_HOME or ~/.dsh). */
export declare function defaultMediaDir(): string;
/** The dsh data home ($DSH_HOME or ~/.dsh); source of the .agent-presets dir. */
export declare function dshHome(): string;
export declare const Config: Z<Config>;
/** Mount the plugin. */
export declare function apply(ctx: Context, config: Config): void;
export {};
