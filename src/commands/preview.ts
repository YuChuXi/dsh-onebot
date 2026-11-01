/**
 * /session 列表的会话预览：从持久化日志冷读每段会话的第一条真实用户输入。
 * 与命令路由分离，便于独立测试与复用。
 * @module dsh-onebot/commands/preview
 */

import { SessionId as makeSessionId } from '@deepseek-ai/dsh-session'

import type { SessionPersistenceLike, SessionPreviewEvent, SessionReadHandleLike } from '../bridge/config.js'
import { describeError } from '../shared/errors.js'

/** 预览冷读只需要持久化端口与日志回调。 */
export interface PreviewContext {
  readonly sessionPersistence: SessionPersistenceLike | undefined
  log(level: 'info' | 'warn' | 'error' | 'debug', message: string): void
}

// ------------------------------------------------------------ /session previews

/** /session list-item preview bound, in code points (emoji-safe — see
 * truncatePreview). */
export const SESSION_PREVIEW_MAX_CHARS = 40

/** How many leading events of a stored log the preview cold-reads. The first
 * real user input of a session sits within the first handful of events
 * (turn/start, the claimed user/message, the surface system message), so a
 * bounded prefix read keeps a 20-item list cheap where a full inspect would
 * decode the entire log per item. A log whose prefix holds no user/message
 * at all degrades to 「（无对话内容）」 like an empty one. */
const SESSION_PREVIEW_EVENT_PREFIX = 24

/** Item text when the log carries no readable user input. */
export const PREVIEW_NO_CONTENT = '（无对话内容）'
/** Item text when the stored log is missing, unreadable or corrupt — the
 * degradation must never break the list or the switch-back flow. */
export const PREVIEW_UNREADABLE = '（内容不可读）'

/** Whether a logged user-message source names a real queued user prompt (the
 * message a turn claimed) rather than a synthetic agent.inject() context or a
 * goal continuation round. Direct prompts carry kind 'user'; QQ chats
 * attribute their own inbound messages to this plugin (platform-source
 * logging), so the plugin-owned kind 'plugin:dsh-onebot' is the chat's real
 * user input too. */
export function isRealUserMessageSource(source: { kind?: string } | undefined): boolean {
  if (source === undefined || typeof source !== 'object') return false
  if (source.kind === 'user') return true
  return source.kind === 'plugin:dsh-onebot'
}

/** Code-point-safe truncation (never splits a surrogate pair — the §3.1
 * emoji lesson): at most `maxLength` code points, the last one '…' when cut. */
export function truncatePreview(text: string, maxLength: number): string {
  if (maxLength <= 0) return ''
  const chars = Array.from(text)
  if (chars.length <= maxLength) return text
  return chars.slice(0, maxLength - 1).join('') + '…'
}

/** QQ 入站消息的载荷是记录数组（onebot/records.ts formatRecords），末条即本轮触发
 * 消息。预览取末条记录的文本；不是记录数组的输入（命令注入、宿主合成文本）
 * 原样返回，由调用方的常规预览路径处理。 */
function unwrapUserMessageText(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return text
  let records: unknown
  try {
    records = JSON.parse(trimmed)
  } catch {
    // 载荷不是 JSON：它本来就不是记录数组，按原文返回即是正确结果。
    return text
  }
  if (!Array.isArray(records) || records.length === 0) return text
  const last = records[records.length - 1] as { message?: unknown } | null
  const body = renderedRecordText(last?.message)
  return body.trim() === '' ? text : body
}

/** 渲染后的记录 message（裸字符串 / 段 / 数组）里的纯文本。 */
function renderedRecordText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(renderedRecordText).join('')
  if (value !== null && typeof value === 'object' && (value as { type?: unknown }).type === 'text') {
    const data = (value as { data?: { text?: unknown } }).data
    return typeof data?.text === 'string' ? data.text : ''
  }
  return ''
}

/** One-line preview text of one logged user message: every text block
 * concatenated, whitespace runs (newlines included) collapsed so the result
 * always stays single-line. Non-text blocks are ignored. A wrapped QQ
 * inbound message contributes its unwrapped body (unwrapUserMessageText). */
function userMessagePreviewText(data: unknown): string {
  const content = (data as { content?: unknown } | null | undefined)?.content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block !== null && typeof block === 'object'
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string') {
      parts.push((block as { text: string }).text)
    }
  }
  return unwrapUserMessageText(parts.join('')).replace(/\s+/g, ' ').trim()
}

/** The one-line preview of a session's event log (events in log order):
 * the first REAL user input (queued user prompt — kind 'user', or this
 * plugin's attributed QQ message) with non-empty text; when the log has
 * none, the first user/message of ANY source with text (synthetic
 * agent.inject context / goal continuation fallback); '' when the log
 * carries no user input at all. */
export function sessionPreviewFromEvents(events: readonly SessionPreviewEvent[], maxLength: number = SESSION_PREVIEW_MAX_CHARS): string {
  let fallback = ''
  for (const event of events) {
    if (event === null || typeof event !== 'object' || event.type !== 'user/message') continue
    const text = userMessagePreviewText(event.data)
    if (text === '') continue
    const source = (event.data as { source?: { kind?: string } } | null | undefined)?.source
    if (isRealUserMessageSource(source)) return truncatePreview(text, maxLength)
    if (fallback === '') fallback = text
  }
  return fallback === '' ? '' : truncatePreview(fallback, maxLength)
}

/** Shorten a session id for the one-line list while keeping BOTH ends: every
 * onebot id shares the `onebot-…` head, so head-only truncation (e.g. the
 * first 12 characters) would render every entry of a chat identically — the
 * unique tail must survive for the id to stay recognizable. */
export function shortSessionId(id: string): string {
  if (id.length <= 20) return id
  return id.slice(0, 8) + '…' + id.slice(-8)
}

/** Cold-read one retired session's preview through the persistence port:
 * open a 'read' handle (never takes write ownership, works beside a live
 * writer), take the header's createdAt plus a small event prefix, then close
 * the handle — always, even when the read failed (AsyncDisposable: a leaked
 * handle pins backend resources). Returns undefined when the log is missing,
 * unreadable or corrupt; the caller renders 「（内容不可读）」 and neither
 * the rest of the list nor the switch-back flow is affected. */
export async function sessionPreviewFor(ctx: PreviewContext, sessionId: string): Promise<{ createdAt: number | undefined; text: string } | undefined> {
  const persistence = ctx.sessionPersistence
  if (persistence === undefined) return { createdAt: undefined, text: '' }
  let handle: SessionReadHandleLike | undefined
  try {
    handle = await persistence.open(makeSessionId(sessionId), 'read')
    const prefix = await handle.read(0, SESSION_PREVIEW_EVENT_PREFIX)
    const createdAt = typeof handle.header?.createdAt === 'number' && Number.isFinite(handle.header.createdAt) && handle.header.createdAt > 0
      ? handle.header.createdAt
      : undefined
    return { createdAt, text: sessionPreviewFromEvents(prefix.events) }
  } catch (error) {
    ctx.log('warn', 'session preview read failed for ' + sessionId + ' (the list still renders): ' + describeError(error))
    return undefined
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close()
      } catch (closeError) {
        ctx.log('debug', 'session preview handle close failed for ' + sessionId + ': ' + describeError(closeError))
      }
    }
  }
}
