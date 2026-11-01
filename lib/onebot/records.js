import { renderMessage } from './segments.js';
/** 插件自己写的说明记录的发送方。 */
export const SYSTEM_QQ = '0';
/** 插件自己写的说明记录的显示名。 */
export const SYSTEM_NICKNAME = '系统';
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
export function messageRecord(fields) {
    const record = {
        qq: String(fields.qq ?? ''),
        nickname: fields.nickname ?? '',
        message: Array.isArray(fields.message) ? fields.message : [],
    };
    if (fields.id !== undefined && fields.id !== '')
        record.id = String(fields.id);
    if (typeof fields.time === 'string' && fields.time !== '')
        record.time = fields.time;
    if (fields.role === 'owner' || fields.role === 'admin')
        record.role = fields.role;
    return record;
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
export function systemRecord(note, clock) {
    return messageRecord({
        qq: SYSTEM_QQ,
        nickname: SYSTEM_NICKNAME,
        time: clock,
        message: [{ type: 'text', data: { text: note } }],
    });
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
export function renderRecord(record) {
    return { ...record, message: renderMessage(record.message) };
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
export function formatRecords(records) {
    return JSON.stringify(records.map(renderRecord));
}
