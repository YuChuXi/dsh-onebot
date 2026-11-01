/**
 * 斜杠命令面：/new、/session、/model、/compact。
 * 路由器只认管理员，未匹配的命令原样落回模型（不拦截、不做相近词建议）。
 * @module dsh-onebot/commands
 */
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { ChatId } from '../chat/index.js';
import type { AgentDefaultModelLike, BridgeDeps, LlmCatalogPort, SessionPersistenceLike } from '../bridge/config.js';
import type { PendingSelection, SessionSwitchOutcome, SwitchableSession } from '../registry/index.js';
/** 命令处理器可读的活跃会话视图（registry.ChatAgent 的结构子集）。 */
export interface CommandChatView {
    agent: Agent;
    sessionId: SessionId;
    busy: boolean;
}
/** 命令面触碰的桥接能力。 */
export interface CommandContext {
    /** 出站发送（命令唯一的回复路径）。 */
    sendToChat(chatId: ChatId, text: string): Promise<string[]>;
    /** 桥接日志。 */
    log(level: 'info' | 'warn' | 'error' | 'debug', message: string): void;
    /** 路由入口的管理员校验。 */
    isAdmin(userId: string): boolean;
    /** 活跃会话查找。 */
    getChat(chatId: ChatId): CommandChatView | undefined;
    /** /new：销毁会话并退役其 id。 */
    resetChat(chatId: ChatId): Promise<void>;
    /** 无活跃会话时从映射文件读 session id（/session 的当前项）。 */
    sessionIdFromMapping(chatId: ChatId): Promise<string | undefined>;
    /** /session：可切回的历史会话（新→旧）。 */
    switchableSessions(chatId: ChatId): SwitchableSession[];
    /** /session <序号>：切回历史会话。 */
    switchSession(chatId: ChatId, targetSessionId: string): Promise<SessionSwitchOutcome>;
    /** /session 列表预览的持久化读端口。 */
    sessionPersistence: SessionPersistenceLike | undefined;
    /** 序号选择快照（/model 与 /session 共用）。 */
    pendingSelection(chatId: ChatId): PendingSelection | undefined;
    setPendingSelection(chatId: ChatId, value: PendingSelection | undefined): void;
    /** /model：实时模型目录。 */
    llmCatalog: LlmCatalogPort | undefined;
    /** /model --default：部署默认模型存储。 */
    agentDefaultModel: AgentDefaultModelLike | undefined;
    /** /compact：转发给宿主命令运行时。 */
    commands: BridgeDeps['commands'];
}
/** 一条斜杠命令：命令名 + 处理器。 */
export interface CommandDefinition {
    /** 斜杠后的命令词（大小写不敏感）。 */
    name: string;
    handler(ctx: CommandContext, chatId: ChatId, arg: string): Promise<void>;
}
/** 路由表。 */
export declare const COMMANDS: CommandDefinition[];
/**
 * 斜杠命令路由：只在首个词形如 `/word` 时接管；管理员之外一律拒绝，
 * 未匹配的命令返回 false，由入站管线交给模型。
 *
 * Args:
 *   ctx (CommandContext): 桥接能力。
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
export declare function tryHandleCommand(ctx: CommandContext, chatId: ChatId, text: string, userId: string): Promise<boolean>;
