/**
 * notice 事件的归一化：所有类型共用一条变换。
 *
 * 去掉 OneBot 协议信封（post_type / notice_type / sub_type / self_id），把
 * `notice_type[/sub_type]` 收敛成 `notice`，其余字段原样保留，时间统一成 HH:MM。
 * 不按类型挑字段、不拼中文句子：事件是什么样，模型看到的就是什么样。
 * @module dsh-onebot/inbound/notice
 */

import type { OneBotEvent } from '../onebot/connection.js'
import type { NoticeRecord } from '../onebot/records.js'
import { formatClock } from '../shared/clock.js'

/** 协议信封字段：已收敛进 `notice`，或只用于归属判定。 */
const ENVELOPE_KEYS = new Set(['post_type', 'notice_type', 'sub_type', 'self_id', 'time'])

/** 一条 notice 的归一化结果。 */
export interface NoticeEvent {
  /** 进入上下文的记录。 */
  record: NoticeRecord
  /** 是否指向机器人本人（等同一次 @）。 */
  wakes: boolean
}

/** 字段的标量文本；缺失或非标量时 ''。 */
function text(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

/**
 * 把一条 notice 收敛成事件记录与唤醒判定。
 *
 * Args:
 *   event (OneBotEvent): 原始 notice 事件。
 *   selfId (string): 机器人自身 QQ，缺省时取事件里的 self_id。
 *
 * Returns:
 *   NoticeEvent | null: 记录与唤醒判定；缺 notice_type 时 null。
 *
 * Callers:
 *   - `src/inbound/normalize.ts:normalizeEvent`。
 */
export function renderNotice(event: OneBotEvent, selfId: string): NoticeEvent | null {
  const noticeType = text(event.notice_type)
  if (noticeType === '') return null
  const subType = text(event.sub_type)
  const record: NoticeRecord = { notice: subType === '' ? noticeType : noticeType + '/' + subType }
  for (const [key, value] of Object.entries(event)) {
    if (ENVELOPE_KEYS.has(key) || value === undefined || value === null || value === '') continue
    record[key] = value
  }
  const time = Number(event.time ?? 0)
  if (time > 0) record.time = formatClock(time * 1000)
  const self = selfId !== '' ? selfId : text(event.self_id)
  // 事件的主体或对象是机器人本人：戳一戳的 target_id、入群/退群/禁言的 user_id。
  const wakes = self !== '' && (text(event.target_id) === self || text(event.user_id) === self)
  return { record, wakes }
}
