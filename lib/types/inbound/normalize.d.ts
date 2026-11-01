/**
 * 入站事件的规范化：把 OneBot 11 事件收缩成中性入站事件。纯函数，无 I/O。
 * @module dsh-onebot/inbound/normalize
 */
import type { OneBotEvent } from '../onebot/connection.js';
import type { IncomingSegment } from '../onebot/segments.js';
import type { ChatId } from '../chat/index.js';
import type { NoticeRecord } from '../onebot/records.js';
import type { NameResolver } from './notice.js';
/** 一条 OneBot 消息对象里管线会读的字段（实现之间略有出入）。 */
export interface RawMessage {
    user_id?: string | number;
    message_id?: string | number;
    /** 历史消息的短 id，get_group_msg_history 的翻页游标；事件推送里没有该字段。 */
    message_seq?: string | number;
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
    /** 发言方 QQ；群 notice 没有发言方时为空。 */
    userId: string;
    /** 群号；私聊为 ''。 */
    groupId: string;
    /** 会话 id（private:<qq> | group:<群号>）。 */
    chatId: ChatId;
    /** 段数组：入站消息的唯一形态；notice 为空。 */
    segments: IncomingSegment[];
    /** 原始消息对象：recordOf 会解析它；notice 只填 user_id 与 time。 */
    message: RawMessage;
    /** 事件自身的 message_id（没有就不做去重）。 */
    messageId?: string;
    /** 发送方原始显示名（尚未清洗）；notice 为空。 */
    nickname: string;
    /** 是否指向机器人本人（等同一次 @）；不指向的 notice 只进入上下文，不唤醒回合。 */
    wakes: boolean;
    /** notice 来源的事件记录；普通消息没有这一项。 */
    notice?: NoticeRecord;
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
 * 消息事件直接使用自身字段；notice 事件由 `renderNotice` 收敛成事件记录
 * （类型 + OneBot 原始字段），会话由 group_id / user_id 决定——于是
 * 「进入哪个会话、是否唤醒」在归一化之后只有一个判定点。
 *
 * Args:
 *   event (OneBotEvent): 原始事件。
 *   selfId (string): 机器人自身 QQ，用于判定事件是否指向机器人。
 *   resolveName (NameResolver): QQ → 显示名；notice 专用处理器整理文案时用。
 *
 * Returns:
 *   Promise<NormalizedInbound | null>: 归一化结果；不构成会话内容时为 null。
 *
 * Callers:
 *   - `src/bridge/index.ts:handleInbound`。
 */
export declare function normalizeEvent(event: OneBotEvent, selfId: string, resolveName: NameResolver): Promise<NormalizedInbound | null>;
