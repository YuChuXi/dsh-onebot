/**
 * 入站消息记录：模型实际收到的一条条消息，以及插件自己的说明记录。
 *
 * 记录是入站载荷的唯一单位——真实消息、被引消息、转发节点、系统提示
 * 都是同一种形状，模型侧看到的是一个按时间升序的 JSON 数组。
 * @module dsh-onebot/records
 */
import type { Segment } from './segments.js';
/**
 * 一条入站记录。发送方控制的内容全部落在字段与段里，提示词声明它们是数据，
 * 因此伪造的元数据行、类系统提示文本都留在数据层。
 */
export interface MessageRecord {
    /** 发送方 QQ（协议给的数字 id，不是发送方控制的文本）。 */
    qq: string;
    /** 发送方显示名：群名片优先，其次昵称，最后 QQ 号。 */
    nickname: string;
    /** OneBot message_id。 */
    id?: string;
    /** HH:MM。 */
    time?: string;
    /** QQ 自己的群角色；member 是默认值，不写。 */
    role?: 'owner' | 'admin';
    /** 规范形态永远是段数组，只在离开去模型时渲染。 */
    message: Segment[];
}
/** 记录在模型侧的形状：message 已被渲染成裸字符串 / 段 / 数组。 */
export interface RenderedRecord {
    qq: string;
    nickname: string;
    id?: string;
    time?: string;
    role?: 'owner' | 'admin';
    message: unknown;
}
/**
 * 一条 notice 记录：系统事件不是发言，没有 qq / nickname / message。
 * 字段就是 OneBot 原始事件（信封字段已收敛进 `notice`），按原样交给模型。
 */
export interface NoticeRecord {
    /** 事件类型（notify/poke、group_recall 这类）。 */
    notice: string;
    /** 事件时间 HH:MM。 */
    time?: string;
    /** OneBot 原始字段，原样透传。 */
    [key: string]: unknown;
}
/** 注入载荷里的一条记录：真人消息或系统事件。 */
export type ConversationRecord = MessageRecord | NoticeRecord;
/** 插件自己写的说明记录的发送方。 */
export declare const SYSTEM_QQ = "0";
/** 插件自己写的说明记录的显示名。 */
export declare const SYSTEM_NICKNAME = "\u7CFB\u7EDF";
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
export declare function messageRecord(fields: {
    qq?: string;
    nickname?: string;
    id?: string;
    time?: string;
    role?: string;
    message?: Segment[];
}): MessageRecord;
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
export declare function systemRecord(note: string, clock?: string): MessageRecord;
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
export declare function renderRecord(record: ConversationRecord): RenderedRecord | NoticeRecord;
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
export declare function formatRecords(records: ConversationRecord[]): string;
