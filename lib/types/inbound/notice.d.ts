/**
 * notice 事件的归一化：所有类型共用一条变换。
 *
 * 去掉 OneBot 协议信封（post_type / notice_type / sub_type / self_id），把
 * `notice_type[/sub_type]` 收敛成 `notice`，其余字段原样保留，时间统一成 HH:MM。
 * 不按类型挑字段、不拼中文句子：事件是什么样，模型看到的就是什么样。
 * @module dsh-onebot/inbound/notice
 */
import type { OneBotEvent } from '../onebot/connection.js';
import type { NoticeRecord } from '../onebot/records.js';
/** 一条 notice 的归一化结果。 */
export interface NoticeEvent {
    /** 进入上下文的记录。 */
    record: NoticeRecord;
    /** 是否指向机器人本人（等同一次 @）。 */
    wakes: boolean;
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
export declare function renderNotice(event: OneBotEvent, selfId: string): NoticeEvent | null;
