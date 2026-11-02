import { renderMessage } from './segments.js';
/** 插件自己写的说明记录的发送方。 */
export const SYSTEM_QQ = '0';
/** 插件自己写的说明记录的显示名。 */
export const SYSTEM_NICKNAME = '系统';
/**
 * 由原始字段造一条记录。显示名按调用方给的值写入；群角色只保留 owner / admin。
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
 * 渲染一条记录：消息的 message 变成模型可见值，事件记录原样输出。幂等。
 *
 * Args:
 *   record (ConversationRecord): 一条记录。
 *
 * Returns:
 *   RenderedRecord | NoticeRecord: 模型侧记录。
 *
 * Callers:
 *   - `formatRecords`。
 */
export function renderRecord(record) {
    if ('notice' in record)
        return record;
    return { ...record, message: renderMessage(record.message) };
}
/**
 * 把一次回合的全部记录序列化成模型收到的唯一载荷。
 *
 * Args:
 *   records (ConversationRecord[]): 按时间升序的记录。
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
