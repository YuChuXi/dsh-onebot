/**
 * notice 事件的归一化：把 OneBot 11 / NapCat 的各类通知收缩成与会话消息
 * 完全相同的形状（会话、发送方、段数组、是否指向机器人），因此下游只有一条
 * 处理路径，不为每种 notice_type 增加分支。
 * @module dsh-onebot/inbound/notice
 */
import type { OneBotEvent } from '../onebot/connection.js';
import type { IncomingSegment } from '../onebot/segments.js';
/** 一条 notice 归一化后的会话事件。 */
export interface NoticeRecord {
    /** 发送方（动作发起者或事件涉及者）QQ 号；无归属成员时为空串。 */
    from: string;
    /** 注入载荷时展示的段数组，与普通消息同构。 */
    segments: IncomingSegment[];
    /** 是否指向机器人本人（等同一次 @，需要唤醒回合）。 */
    wakes: boolean;
}
/**
 * 把一条 notice 渲染成会话事件。
 *
 * 未知类型与「不构成会话内容」的类型（正在输入、头像点赞、机器人离线）
 * 返回 null，由调用方决定只记日志。
 *
 * Args:
 *   event (OneBotEvent): 原始 notice 事件。
 *   selfId (string): 机器人自身 QQ，用于判定事件是否指向机器人。
 *
 * Returns:
 *   NoticeRecord | null: 归一化结果；无会话语义时为 null。
 *
 * Callers:
 *   - `src/inbound/normalize.ts:normalizeEvent`。
 */
export declare function renderNotice(event: OneBotEvent, selfId: string): NoticeRecord | null;
