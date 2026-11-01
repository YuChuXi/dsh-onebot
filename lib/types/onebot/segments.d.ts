import { type MediaKind } from '../media/kinds.js';
export { MEDIA_KINDS, mediaKindOf, mediaLabel } from '../media/kinds.js';
export type { MediaKind, MediaKindSpec, MediaSegmentType } from '../media/kinds.js';
/** 一类媒体段共有的来源字段。 */
export interface MediaData {
    /** 本机路径（解析后回填）或原始缓存令牌。 */
    file?: string;
    /** 远端地址。 */
    url?: string;
    /** 表情包标记（QQ 用 sub_type=1）。 */
    sub_type?: string | number;
    /** QQ 自带说明（贴纸名）。 */
    summary?: string;
}
/** 已知段类型的 data 形状，键即 OneBot 的段类型名。 */
export interface SegmentData {
    text: {
        text: string;
    };
    at: {
        qq: string;
        name?: string;
    };
    /** 引用：展开后被引消息记录放进 message。 */
    reply: {
        id: string;
        message?: unknown;
    };
    /** 合并转发：展开后节点记录放进 messages。 */
    forward: {
        id?: string;
        resId?: string;
        messages?: unknown[];
    };
    image: MediaData;
    record: MediaData;
    video: MediaData;
    file: MediaData & {
        file_id?: string;
        name?: string;
    };
    face: {
        id?: string;
        name?: string;
    };
    mface: {
        summary?: string;
        emoji_id?: string;
        emoji_package_id?: string;
        key?: string;
        url?: string;
    };
    /** 戳一戳：真实戳一戳走 notice，进管线的是桥接合成的段。 */
    poke: {
        qq?: string;
        id?: string;
        name?: string;
    };
    dice: {
        result?: string;
    };
    rps: {
        result?: string;
    };
    json: {
        data?: string;
    };
    xml: {
        data?: string;
    };
    share: {
        url?: string;
        title?: string;
        content?: string;
        image?: string;
    };
    contact: {
        type?: string;
        id?: string;
    };
    location: {
        lat?: string;
        lon?: string;
        title?: string;
        content?: string;
    };
    music: {
        type?: string;
        id?: string;
        url?: string;
        audio?: string;
        title?: string;
        content?: string;
        image?: string;
    };
    node: {
        id?: string;
        user_id?: string;
        nickname?: string;
        content?: unknown;
        time?: string;
    };
    markdown: {
        content?: string;
    };
    tts: {
        text?: string;
    };
    cardimage: {
        file?: string;
    };
}
/** 已知类型名的联合。 */
export type SegmentType = keyof SegmentData;
/** 一个已知段：`type` 与 `data` 绑定，改一处编译器就能发现另一处。 */
export type KnownSegment = {
    [K in SegmentType]: {
        type: K;
        data: SegmentData[K];
    };
}[SegmentType];
/**
 * 未知段：保留原始属性，不做猜测。`$type` 记住原始类型名，
 * 渲染时还原成 OneBot 原形状（模型仍看到 `{type:'foo',data:{…}}`）。
 */
export interface UnknownSegment {
    type: 'unknown';
    data: Record<string, unknown> & {
        $type: string;
    };
}
/** 管线内部的段联合：判别属性 `type` 全是字面量，switch 后可穷尽收窄。 */
export type Segment = KnownSegment | UnknownSegment;
/** 入站事件里段数组的宽松形态（实现之间字段有出入）。 */
export interface IncomingSegment {
    type: string;
    data?: Record<string, unknown>;
}
/** 待取字节的媒体引用：解析产物，交给媒体存储换成本地文件。 */
export interface MediaRef {
    kind: MediaKind;
    url?: string;
    file?: string;
    fileId?: string;
    name?: string;
    subType?: string | number;
    summary?: string;
    /** 该引用在段数组中的下标，回填路径时按位置写回。 */
    segmentIndex: number;
}
/** 一条消息的入站解析产物。 */
export interface ParsedMessage {
    /** 只有文本段贡献的纯文本（命令匹配用）。 */
    text: string;
    /** 还在等本地文件的媒体引用。 */
    media: MediaRef[];
    /** 模型可见的段数组。 */
    segments: Segment[];
}
/**
 * 事件或接口响应里的段数组；不是数组时视为空。
 * 这里没有 CQ 字符串回退：字符串载荷不是段数组，按无段处理。
 *
 * Args:
 *   value (unknown): 事件/响应里的 `message` 字段。
 *
 * Returns:
 *   IncomingSegment[]: 段数组（原样返回，不做拷贝）。
 *
 * Callers:
 *   - `src/inbound/index.ts:InboundPipeline`：expandQuote、expandForward。
 *   - `src/inbound/normalize.ts:normalizeOneBot11`：入站段数组。
 *   - `src/tools/index.ts`：qq_group_history 的文本提取。
 */
export declare function incomingSegments(value: unknown): IncomingSegment[];
/**
 * 把一个入站段解析成管线段：媒体段换成空壳 data（等字节回填），
 * 表情补中文名，其余已知类型按字段表挑属性，未知类型整段保留。
 *
 * Args:
 *   raw (IncomingSegment): OneBot 原始段。
 *
 * Returns:
 *   Segment: 类型化的段。
 *
 * Callers:
 *   - `parseMessage`。
 */
export declare function parseSegment(raw: IncomingSegment): Segment;
/**
 * 解析一条入站消息：得到模型可见段数组、待取字节的媒体引用与纯文本。
 *
 * Args:
 *   segments (IncomingSegment[] | undefined): 消息段数组。
 *
 * Returns:
 *   ParsedMessage: 纯文本（仅文本段）、媒体引用（带段下标）与模型可见段数组。
 *
 * Callers:
 *   - `src/inbound/index.ts:InboundPipeline.parseOf`：每条消息只解析一次。
 */
export declare function parseMessage(segments: IncomingSegment[] | undefined): ParsedMessage;
/**
 * 把一段文本按表情名/表情 id 规范化成 face 段（模型写出时用）。
 *
 * Args:
 *   id (string | undefined): 表情 id。
 *   name (string | undefined): 表情中文名。
 *
 * Returns:
 *   SegmentData['face'] | undefined: 两端至少有一个可用的表情数据。
 *
 * Callers:
 *   - `src/onebot/segments.ts:faceData`：工具参数里的 face 段。
 */
export declare function faceData(id: string | undefined, name: string | undefined): SegmentData['face'] | undefined;
/**
 * 给 @ 提及段补显示名；未知 id 保持裸号码。
 *
 * Args:
 *   segments (Segment[]): 模型可见段数组（原地修改）。
 *   names (Map<string, string>): QQ → 显示名。
 *
 * Returns:
 *   无。
 *
 * Callers:
 *   - `src/inbound/index.ts:InboundPipeline.fillSegmentAtNames`。
 */
export declare function fillMentionNames(segments: Segment[], names: Map<string, string>): void;
/**
 * 判断消息是否提到了机器人（@ 或 @全体成员）。机器人 id 未知且未配置时一律 false。
 *
 * Args:
 *   segments (Segment[] | undefined): 段数组。
 *   selfId (string): 已学习的机器人 QQ（未知为 ''）。
 *   botQQ (string): 配置的机器人 QQ（未配置为 ''）。
 *
 * Returns:
 *   boolean: 是否有指向机器人的 at 段。
 *
 * Callers:
 *   - `src/inbound/index.ts:InboundPipeline.processInbound`：群聊提及闸门。
 */
export declare function detectMention(segments: Segment[] | undefined, selfId: string, botQQ: string): boolean;
/**
 * 把一个段渲染成模型可见形态：媒体段没有本地文件时变成明确的「未取到」说明，
 * 引用的被引消息与转发的节点列表递归渲染。
 *
 * Args:
 *   segment (Segment): 段。
 *
 * Returns:
 *   unknown: 文本 → 裸字符串；其余 → 段对象（内嵌消息已渲染）。
 *
 * Callers:
 *   - `renderMessage`。
 */
export declare function renderSegment(segment: Segment): unknown;
/**
 * 渲染一条消息。文本段不留外壳——每个文本段是独立的裸字符串，不合并；
 * 只剩一个元素时解包成该元素。
 *
 * Args:
 *   segments (Segment[]): 段数组。
 *
 * Returns:
 *   unknown: 裸字符串、单个段，或段/字符串混合数组。
 *
 * Callers:
 *   - `renderSegment`（引用与转发内嵌消息）。
 *   - `src/onebot/records.ts:renderRecord`。
 */
export declare function renderMessage(segments: Segment[]): unknown;
