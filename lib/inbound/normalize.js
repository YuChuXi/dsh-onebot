/**
 * 入站事件的规范化：把 OneBot 11 事件收缩成中性入站事件。纯函数，无 I/O。
 * @module dsh-onebot/inbound/normalize
 */
import { incomingSegments } from '../onebot/segments.js';
import { buildChatId, displayName } from '../chat/index.js';
import { renderNotice } from './notice.js';
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
export function normalizeOneBot11(event) {
    const messageType = event.message_type;
    if (messageType !== 'private' && messageType !== 'group')
        return null;
    const userId = String(event.user_id ?? '');
    if (userId === '')
        return null;
    const kind = messageType === 'private' ? 'private' : 'group';
    const groupId = kind === 'group' ? String(event.group_id ?? '') : '';
    const chatId = buildChatId(kind, kind === 'private' ? userId : groupId);
    const segments = incomingSegments(event.message);
    const messageId = event.message_id === undefined || event.message_id === null
        ? undefined
        : String(event.message_id);
    const nickname = displayName(event.sender, userId);
    return {
        kind,
        userId,
        groupId,
        chatId,
        segments,
        message: event,
        messageId,
        nickname,
        wakes: true,
    };
}
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
export function normalizeEvent(event, selfId) {
    if (event.post_type === 'message' || event.message_type !== undefined)
        return normalizeOneBot11(event);
    if (event.post_type !== 'notice')
        return null;
    const record = renderNotice(event, selfId);
    if (record === null)
        return null;
    const groupId = String(event.group_id ?? '');
    const kind = groupId !== '' ? 'group' : 'private';
    const userId = record.from;
    if (userId === '')
        return null;
    const chatId = buildChatId(kind, kind === 'private' ? userId : groupId);
    const time = event.time === undefined ? undefined : Number(event.time);
    const message = {
        user_id: userId,
        time,
        sender: { user_id: userId },
        message: record.segments,
    };
    return {
        kind,
        userId,
        groupId,
        chatId,
        segments: record.segments,
        message,
        nickname: '',
        wakes: record.wakes,
    };
}
