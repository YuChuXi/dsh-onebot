/**
 * notice 事件的归一化：所有类型共用一条信封变换，类型特有的整理走注册表。
 *
 * 去掉 OneBot 协议信封（post_type / notice_type / sub_type / self_id）与会话归属
 * 字段（group_id——会话已经由 chatId 表达），把 `notice_type[/sub_type]` 收敛成
 * `notice`，其余字段原样保留，时间统一成 HH:MM。未注册专用处理器的类型到此为止；
 * 注册过的（目前是戳一戳）只整理该类型自己的字段，不改写语义、不拼插件自己的句子。
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
 * QQ 号 → 显示名：群事件读群成员表，私聊事件查陌生人信息；取不到时 ''。
 *
 * Args:
 *   qq (string): 要取名的 QQ。
 *   groupId (string): 事件所属群；私聊为 ''。
 *
 * Returns:
 *   Promise<string>: 显示名；查不到时 ''。
 *
 * Callers:
 *   - `src/inbound/notice.ts:pokeHandler`（经 `NoticeHandlerContext`）。
 */
export type NameResolver = (qq: string, groupId: string) => Promise<string>;
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
export declare function renderNotice(event: OneBotEvent, selfId: string, resolveName: NameResolver): Promise<NoticeEvent | null>;
