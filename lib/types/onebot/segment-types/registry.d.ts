/**
 * 段类型注册表：入站解析（segment）与出站归一化（normalize）由每个类型
 * 自己提供，管线只查表，不认识任何具体类型。
 * @module dsh-onebot/segment-types/registry
 */
import type { IncomingSegment, Segment } from '../segments.js';
import type { OutboundSegment } from '../../outbound/index.js';
/** 出站归一化的上下文：媒体围栏根与各媒体类型的大小上限。 */
export interface SegmentSendContext {
    allowedRoots: string[];
    maxImageBytes: number;
    maxVoiceBytes: number;
    maxFileBytes: number;
}
/** 出站归一化的完整上下文：在发送上下文之外，附带渲染值的逆还原。 */
export interface SegmentRestoreContext extends SegmentSendContext {
    /**
     * 把模型抄回来的渲染值还原成可发送段数组（`reply.message` / `forward.messages` 用）。
     *
     * 实现与入站渲染对称：解包成段后逐段走同一张注册表。
     *
     * Args:
     *   value (unknown): 渲染后的消息体。
     *
     * Returns:
     *   Promise<OutboundSegment[]>: 还原出的可发送段。
     */
    restore(value: unknown): Promise<OutboundSegment[]>;
}
/** 入站渲染的上下文：把嵌套消息体继续交给注册表渲染。 */
export interface SegmentRenderContext {
    /**
     * 渲染一条消息（段数组 → 模型可见值）。
     *
     * Args:
     *   segments (Segment[]): 段数组。
     *
     * Returns:
     *   unknown: 渲染后的消息体。
     */
    renderMessage(segments: Segment[]): unknown;
    /**
     * 渲染一条记录（`reply.message` / `forward.messages` 的单项）。
     *
     * Args:
     *   value (unknown): 记录。
     *
     * Returns:
     *   unknown: 渲染后的记录。
     */
    renderRecord(value: unknown): unknown;
}
/** 一个段类型的双向转换；两个方向都可缺席。 */
export interface SegmentTypeAdapter {
    /**
     * 入站：原始段 → 模型可见段；`undefined` 表示该类型无法解析。
     *
     * Args:
     *   raw (IncomingSegment): 事件里的原始段。
     *
     * Returns:
     *   Segment | undefined: 内部段。
     */
    segment?(raw: IncomingSegment): Segment | undefined;
    /**
     * 入站：内部段 → 模型可见值（渲染）。
     *
     * Args:
     *   segment (Segment): 内部段。
     *   ctx (SegmentRenderContext): 嵌套消息体的递归渲染。
     *
     * Returns:
     *   unknown: 模型看到的值。
     */
    render?(segment: Segment, ctx: SegmentRenderContext): unknown;
    /**
     * 入站：这一段是否唤醒机器人（@本人、@全体、戳一戳等）。
     *
     * Args:
     *   segment (Segment): 内部段。
     *   selfId (string): 已学习的机器人 QQ（未知为 ''）。
     *   botQQ (string): 配置的机器人 QQ（未配置为 ''）。
     *
     * Returns:
     *   boolean: 是否唤醒。
     */
    wakes?(segment: Segment, selfId: string, botQQ: string): boolean;
    /**
     * 出站：模型给出的段 → 可发送段；`undefined` 表示该段不可发送。
     *
     * Args:
     *   data (Record<string, unknown>): 模型给出的 data。
     *   ctx (SegmentRestoreContext): 媒体围栏、大小上限与渲染值逆还原。
     *
     * Returns:
     *   Promise<OutboundSegment | undefined> | OutboundSegment | undefined: 可发送段。
     */
    normalize?(data: Record<string, unknown>, ctx: SegmentRestoreContext): Promise<OutboundSegment | undefined> | OutboundSegment | undefined;
}
/**
 * 注册一个段类型的双向转换。
 *
 * Args:
 *   type (string): OneBot 段类型名。
 *   adapter (SegmentTypeAdapter): 入站与出站转换。
 *
 * Returns:
 *   无。
 *
 * Callers:
 *   - `segment-types/basic.ts`、`face.ts`、`mface.ts`、`media.ts` 的模块顶层。
 */
export declare function registerSegmentType(type: string, adapter: SegmentTypeAdapter): void;
/**
 * 按类型名取适配器。
 *
 * Args:
 *   type (string): OneBot 段类型名。
 *
 * Returns:
 *   SegmentTypeAdapter | undefined: 未注册的类型返回 undefined。
 *
 * Callers:
 *   - `src/onebot/segments.ts:parseSegment`、`normalizeSegment`。
 */
export declare function segmentTypeOf(type: string): SegmentTypeAdapter | undefined;
