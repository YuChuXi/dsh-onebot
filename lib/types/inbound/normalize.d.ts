/**
 * 入站事件的规范化：把 OneBot 11 事件收缩成中性入站事件。纯函数，无 I/O。
 * @module dsh-onebot/inbound/normalize
 */
import type { OneBotEvent } from '../onebot/connection.js';
import type { IncomingSegment } from '../onebot/segments.js';
import type { ChatId } from '../chat/index.js';
/** 一条 OneBot 消息对象里管线会读的字段（实现之间略有出入）。 */
export interface RawMessage {
    user_id?: string | number;
    message_id?: string | number;
    time?: string | number;
    message?: IncomingSegment[];
    role?: string;
    sender?: {
        user_id?: string | number;
        nickname?: string;
        card?: string;
        role?: string;
    };
}
/**
 * normalizeOneBot11 从一条消息事件里收缩出的中性入站事件：
 * 只保留管线用的字段，事件形状的差异（message_type / user_id / group_id、
 * 段数组、发送方原始昵称）在边界处就地解决。null = 不是可处理的消息事件。
 */
export interface NormalizedInbound {
    /** 'private' | 'group' — message_type 闸门。 */
    kind: 'private' | 'group';
    /** 发送方 QQ（'' 已在 normalize 时被拒绝）。 */
    userId: string;
    /** 群号；私聊为 ''。 */
    groupId: string;
    /** 会话 id（private:<qq> | group:<群号>）。 */
    chatId: ChatId;
    /** 段数组：入站消息的唯一形态。 */
    segments: IncomingSegment[];
    /** 原始消息对象：recordOf 会解析它。 */
    message: RawMessage;
    /** 事件自身的 message_id（没有就不做去重）。 */
    messageId?: string;
    /** 发送方原始显示名（尚未清洗）。 */
    nickname: string;
    /** 是否指向机器人本人（等同一次 @）；不指向的事件只进入上下文，不唤醒回合。 */
    wakes: boolean;
}
/**
 * 把一条 OneBot 11 事件收缩成中性入站事件；不是可处理的消息事件时返回 null。
 * 纯函数：无 I/O、无状态。
 *
 * Args:
 *   event (OneBotEvent): 原始事件。
 *
 * Returns:
 *   NormalizedInbound | null: 中性事件；notice/meta/未知类型/缺发送方时为 null。
 *
 * Callers:
 *   - `src/bridge/index.ts:handleInbound`。
 */
export declare function normalizeOneBot11(event: OneBotEvent): NormalizedInbound | null;
/**
 * 把任意入站事件归一化成同一种形状。
 *
 * 消息事件直接使用自身字段；notice 事件由 `renderNotice` 渲染成同一形状的
 * 会话记录（会话由 group_id / user_id 决定，段数组描述发生了什么），
 * 因此「是否唤醒、进入哪个会话」在归一化之后只有一个判定点。
 *
 * Args:
 *   event (OneBotEvent): 原始事件。
 *   selfId (string): 机器人自身 QQ，用于判定事件是否指向机器人。
 *
 * Returns:
 *   NormalizedInbound | null: 归一化结果；不构成会话内容时为 null。
 *
 * Callers:
 *   - `src/bridge/index.ts:handleInbound`。
 */
export declare function normalizeEvent(event: OneBotEvent, selfId: string): NormalizedInbound | null;
