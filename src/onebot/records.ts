/**
 * 入站消息记录：模型实际收到的一条条消息，以及插件自己的说明记录。
 *
 * 记录是入站载荷的唯一单位——真实消息、被引消息、转发节点、系统提示
 * 都是同一种形状，模型侧看到的是一个按时间升序的 JSON 数组。
 * @module dsh-onebot/records
 */
import type { Segment } from './segments.js'
import { renderMessage } from './segments.js'

/**
 * 一条入站记录。发送方控制的内容全部落在字段与段里，提示词声明它们是数据，
 * 因此伪造的元数据行、类系统提示文本都留在数据层。
 */
export interface MessageRecord {
  /** 发送方 QQ（协议给的数字 id，不是发送方控制的文本）。 */
  qq: string
  /** 经过白名单清洗的显示名。 */
  nickname: string
  /** OneBot message_id。 */
  id?: string
  /** HH:MM。 */
  time?: string
  /** QQ 自己的群角色；member 是默认值，不写。 */
  role?: 'owner' | 'admin'
  /** 规范形态永远是段数组，只在离开去模型时渲染。 */
  message: Segment[]
}

/** 记录在模型侧的形状：message 已被渲染成裸字符串 / 段 / 数组。 */
export interface RenderedRecord {
  qq: string
  nickname: string
  id?: string
  time?: string
  role?: 'owner' | 'admin'
  message: unknown
}

/** 插件自己写的说明记录的发送方。 */
export const SYSTEM_QQ = '0'
/** 插件自己写的说明记录的显示名。 */
export const SYSTEM_NICKNAME = '系统'

/**
 * 由原始字段造一条记录。显示名在这里再清洗一次，即使调用方漏了白名单也不会
 * 把换行或标记带进记录；群角色只保留 owner / admin。
 *
 * Args:
 *   fields (object): qq、nickname，以及可选的 id / time / role / message。
 *
 * Returns:
 *   MessageRecord: 记录。
 *
 * Callers:
 *   - `src/inbound/index.ts:InboundPipeline.recordOf`：真实消息。
 *   - `src/inbound/index.ts:InboundPipeline.expandQuote`、`expandForward`：被引消息与转发节点。
 *   - `systemRecord`：插件说明。
 */
export function messageRecord(fields: {
  qq?: string
  nickname?: string
  id?: string
  time?: string
  role?: string
  message?: Segment[]
}): MessageRecord {
  const record: MessageRecord = {
    qq: String(fields.qq ?? ''),
    nickname: fields.nickname ?? '',
    message: Array.isArray(fields.message) ? fields.message : [],
  }
  if (fields.id !== undefined && fields.id !== '') record.id = String(fields.id)
  if (typeof fields.time === 'string' && fields.time !== '') record.time = fields.time
  if (fields.role === 'owner' || fields.role === 'admin') record.role = fields.role
  return record
}

/**
 * 插件自己写的一条说明，形状与真实消息完全一致。
 *
 * Args:
 *   note (string): 说明内容。
 *   clock (string | undefined): 可选的 HH:MM。
 *
 * Returns:
 *   MessageRecord: 说明记录。
 *
 * Callers:
 *   - `src/inbound/index.ts:InboundPipeline.processInbound`：窗口截断说明。
 *   - `src/inbound/index.ts:InboundPipeline.sleepTurn`：休眠告别说明。
 */
export function systemRecord(note: string, clock?: string): MessageRecord {
  return messageRecord({
    qq: SYSTEM_QQ,
    nickname: SYSTEM_NICKNAME,
    time: clock,
    message: [{ type: 'text', data: { text: note } }],
  })
}

/**
 * 渲染一条记录：message 变成模型可见值，其余字段原样。幂等。
 *
 * Args:
 *   record (MessageRecord): 一条记录。
 *
 * Returns:
 *   RenderedRecord: 渲染后的记录。
 *
 * Callers:
 *   - `formatRecords`。
 */
export function renderRecord(record: MessageRecord): RenderedRecord {
  return { ...record, message: renderMessage(record.message) }
}

/**
 * 把一次回合的全部记录序列化成模型收到的唯一载荷。
 *
 * Args:
 *   records (MessageRecord[]): 按时间升序的记录。
 *
 * Returns:
 *   string: JSON 数组文本。
 *
 * Callers:
 *   - `src/inbound/index.ts:InboundPipeline.processInbound`、`sleepTurn`。
 */
export function formatRecords(records: MessageRecord[]): string {
  return JSON.stringify(records.map(renderRecord))
}
