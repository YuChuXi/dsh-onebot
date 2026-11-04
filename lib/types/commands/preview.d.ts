/**
 * /session 列表的会话预览：从持久化日志冷读每段会话的第一条真实用户输入。
 * 与命令路由分离，便于独立测试与复用。
 * @module dsh-onebot/commands/preview
 */
import type { SessionPersistenceLike, SessionPreviewEvent } from '../bridge/config.js';
/** 预览冷读只需要持久化端口与日志回调。 */
export interface PreviewContext {
    readonly sessionPersistence: SessionPersistenceLike | undefined;
    log(level: 'info' | 'warn' | 'error' | 'debug', message: string): void;
}
/** /session list-item preview bound, in code points (emoji-safe — see
 * truncatePreview). */
export declare const SESSION_PREVIEW_MAX_CHARS = 40;
/** Item text when the log carries no readable user input. */
export declare const PREVIEW_NO_CONTENT = "\uFF08\u65E0\u5BF9\u8BDD\u5185\u5BB9\uFF09";
/** Item text when the stored log is missing, unreadable or corrupt — the
 * degradation must never break the list or the switch-back flow. */
export declare const PREVIEW_UNREADABLE = "\uFF08\u5185\u5BB9\u4E0D\u53EF\u8BFB\uFF09";
/** Whether a logged user-message source names a real queued user prompt (the
 * message a turn claimed) rather than a synthetic agent.inject() context or a
 * goal continuation round. Direct prompts carry kind 'user'; QQ chats
 * attribute their own inbound messages to this plugin (platform-source
 * logging), so the plugin-owned kind 'plugin:dsh-onebot' is the chat's real
 * user input too. */
export declare function isRealUserMessageSource(source: {
    kind?: string;
} | undefined): boolean;
/** Code-point-safe truncation (never splits a surrogate pair — the §3.1
 * emoji lesson): at most `maxLength` code points, the last one '…' when cut. */
export declare function truncatePreview(text: string, maxLength: number): string;
/** The one-line preview of a session's event log (events in log order):
 * the first REAL user input (queued user prompt — kind 'user', or this
 * plugin's attributed QQ message) with non-empty text; when the log has
 * none, the first user/message of ANY source with text (synthetic
 * agent.inject context / goal continuation fallback); '' when the log
 * carries no user input at all. */
export declare function sessionPreviewFromEvents(events: readonly SessionPreviewEvent[], maxLength?: number): string;
/** Cold-read one retired session's preview through the persistence port:
 * open a 'read' handle (never takes write ownership, works beside a live
 * writer), read a small event prefix, then close the handle — always, even
 * when the read failed (AsyncDisposable: a leaked handle pins backend
 * resources). Returns undefined when the log is missing, unreadable or
 * corrupt; the caller renders 「（内容不可读）」 and neither the rest of the
 * list nor the switch-back flow is affected. */
export declare function sessionPreviewFor(ctx: PreviewContext, sessionId: string): Promise<string | undefined>;
