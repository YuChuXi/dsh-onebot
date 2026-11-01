/**
 * notice 事件的归一化：所有类型共用一条信封变换，类型特有的整理走注册表。
 *
 * 去掉 OneBot 协议信封（post_type / notice_type / sub_type / self_id）与会话归属
 * 字段（group_id——会话已经由 chatId 表达），把 `notice_type[/sub_type]` 收敛成
 * `notice`，其余字段原样保留，时间统一成 HH:MM。未注册专用处理器的类型到此为止；
 * 注册过的（目前是戳一戳）只整理该类型自己的字段，不改写语义、不拼插件自己的句子。
 * @module dsh-onebot/inbound/notice
 */
import { formatClock } from '../shared/clock.js';
/** 协议信封与会话归属字段：已收敛进 `notice` 与 chatId，记录里不再重复。 */
const ENVELOPE_KEYS = new Set(['post_type', 'notice_type', 'sub_type', 'self_id', 'time', 'group_id']);
/**
 * 戳一戳：把 `raw_info`（NapCat 的 pokedetail = `json.items`）整理成一句原文案。
 *
 * 条目分三类：`qq` 是参与者的内部 uid（按出现顺序对应发起者、被戳者，记录里只留
 * QQ 号）、`nor` 是文案片段、其余（图片等装饰）丢弃。`qq` 条目自带的 `nm` 优先，
 * 空则按 QQ 号取名。整理后 `raw_info` 不再单独携带。
 *
 * Args:
 *   record (NoticeRecord): 已带 `raw_info` 的记录（原地写入 `text`、删除 `raw_info`）。
 *   event (OneBotEvent): 原始 notice 事件。
 *   context (NoticeHandlerContext): 会话归属与取名。
 *
 * Returns:
 *   Promise<void>: 整理完成。
 *
 * Callers:
 *   - `renderNotice`（经 `NOTICE_HANDLERS`）。
 */
async function pokeHandler(record, event, context) {
    const items = Array.isArray(event.raw_info) ? event.raw_info : [];
    const participants = [text(event.user_id), text(event.target_id)];
    const parts = [];
    let participant = 0;
    for (const item of items) {
        if (item === null || typeof item !== 'object')
            continue;
        const entry = item;
        if (entry.type === 'nor') {
            if (typeof entry.txt === 'string' && entry.txt !== '')
                parts.push(entry.txt);
            continue;
        }
        if (entry.type !== 'qq')
            continue;
        const qq = participants[participant] ?? '';
        participant += 1;
        const carried = typeof entry.nm === 'string' ? entry.nm : '';
        const name = carried !== '' ? carried : (qq !== '' ? await context.resolveName(qq, context.groupId) : '');
        parts.push(name !== '' ? name : qq);
    }
    const line = parts.join(' ');
    if (line !== '')
        record.text = line;
    delete record.raw_info;
}
/** 类型 → 专用处理器；键与记录的 `notice` 字段一致。 */
const NOTICE_HANDLERS = {
    'notify/poke': pokeHandler,
};
/** 字段的标量文本；缺失或非标量时 ''。 */
function text(value) {
    return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}
/**
 * 把一条 notice 收敛成事件记录与唤醒判定。
 *
 * Args:
 *   event (OneBotEvent): 原始 notice 事件。
 *   selfId (string): 机器人自身 QQ，缺省时取事件里的 self_id。
 *   resolveName (NameResolver): QQ → 显示名（专用处理器用）。
 *
 * Returns:
 *   Promise<NoticeEvent | null>: 记录与唤醒判定；缺 notice_type 时 null。
 *
 * Callers:
 *   - `src/inbound/normalize.ts:normalizeEvent`。
 */
export async function renderNotice(event, selfId, resolveName) {
    const noticeType = text(event.notice_type);
    if (noticeType === '')
        return null;
    const subType = text(event.sub_type);
    const kind = subType === '' ? noticeType : noticeType + '/' + subType;
    const record = { notice: kind };
    for (const [key, value] of Object.entries(event)) {
        if (ENVELOPE_KEYS.has(key) || value === undefined || value === null || value === '')
            continue;
        record[key] = value;
    }
    const time = Number(event.time ?? 0);
    if (time > 0)
        record.time = formatClock(time * 1000);
    await NOTICE_HANDLERS[kind]?.(record, event, { groupId: text(event.group_id), resolveName });
    const self = selfId !== '' ? selfId : text(event.self_id);
    // 事件的主体或对象是机器人本人：戳一戳的 target_id、入群/退群/禁言的 user_id。
    const wakes = self !== '' && (text(event.target_id) === self || text(event.user_id) === self);
    return { record, wakes };
}
