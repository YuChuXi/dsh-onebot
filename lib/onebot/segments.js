/**
 * OneBot 11 消息段：类型化的段模型、入站解析、模型可见渲染与 @ 提及判定。
 *
 * 内部一律使用 OneBot 的段数组形态（`{ type, data }`），但每个已知类型的
 * `data` 都有独立类型，按 `type` 判别后可穷尽处理——新增段类型时编译器会
 * 指出每一处需要照顾的分支，而不是在运行时查表。
 *
 * 这里没有 CQ 字符串层：消息只按段数组进出。
 * @module dsh-onebot/segments
 */
import { faceId, faceName } from './faces.js';
import { mediaKindOf, mediaLabel } from '../media/kinds.js';
export { MEDIA_KINDS, mediaKindOf, mediaLabel } from '../media/kinds.js';
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
export function incomingSegments(value) {
    return Array.isArray(value) ? value : [];
}
/** 段 data 里取字符串，空值归为 undefined。 */
function text(value) {
    return typeof value === 'string' && value !== '' ? value : undefined;
}
/** 段 data 里取标量（字符串或数字）。 */
function scalar(value) {
    return typeof value === 'string' || typeof value === 'number' ? value : undefined;
}
/** 只保留指定属性，空值（undefined / null / ''）丢弃。 */
function pickFields(data, fields) {
    const out = {};
    for (const key of fields) {
        const value = data[key];
        if (value !== undefined && value !== null && value !== '')
            out[key] = value;
    }
    return out;
}
/** mface 段保留的属性（重放商城表情需要的五件套）。 */
const MFACE_FIELDS = ['summary', 'emoji_id', 'emoji_package_id', 'key', 'url'];
/** 已知段类型 → 模型可见段保留的字段。text / face / mface / 媒体段由各自分支处理。 */
const SEGMENT_FIELDS = {
    forward: ['id', 'resId'],
    poke: ['qq', 'id', 'name'],
    dice: ['result'],
    rps: ['result'],
    json: ['data'],
    xml: ['data'],
    share: ['url', 'title', 'content', 'image'],
    contact: ['type', 'id'],
    location: ['lat', 'lon', 'title', 'content'],
    music: ['type', 'id', 'url', 'audio', 'title', 'content', 'image'],
    node: ['id', 'user_id', 'nickname', 'content', 'time'],
    markdown: ['content'],
    tts: ['text'],
    cardimage: ['file'],
};
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
export function parseSegment(raw) {
    const data = raw.data ?? {};
    // 媒体段先占位：段顺序与发送方一致，字节到手后按同一位置回填。
    if (mediaKindOf({ type: raw.type }) !== undefined)
        return { type: raw.type, data: {} };
    switch (raw.type) {
        case 'text':
            return { type: 'text', data: { text: String(data.text ?? '') } };
        case 'at':
            return { type: 'at', data: { qq: String(data.qq ?? ''), ...pickFields(data, ['name']) } };
        case 'reply':
            return { type: 'reply', data: { id: String(data.id ?? '') } };
        case 'face': {
            const id = text(data.id) ?? (data.id !== undefined && data.id !== '' ? String(data.id) : undefined);
            const name = text(data.name) ?? (id !== undefined ? faceName(id) : undefined);
            return { type: 'face', data: { ...(id !== undefined ? { id } : {}), ...(name !== undefined ? { name } : {}) } };
        }
        case 'mface':
            return { type: 'mface', data: pickFields(data, MFACE_FIELDS) };
        default: {
            const fields = SEGMENT_FIELDS[raw.type];
            if (fields === undefined)
                return { type: 'unknown', data: { ...data, $type: raw.type } };
            return { type: raw.type, data: pickFields(data, fields) };
        }
    }
}
/**
 * 从媒体段造出待解析的媒体引用。
 *
 * Args:
 *   segment (Segment): 媒体段（空壳 data）。
 *   raw (IncomingSegment): 原始段（来源字段都在它的 data 里）。
 *   index (number): 段在数组中的下标。
 *
 * Returns:
 *   MediaRef: 媒体引用。
 *
 * Callers:
 *   - `parseMessage`。
 */
function mediaRefOf(segment, raw, index) {
    const kind = mediaKindOf(segment);
    if (kind === undefined)
        return undefined;
    const data = raw.data ?? {};
    const file = text(data.file);
    return {
        kind,
        segmentIndex: index,
        ...(text(data.url) !== undefined ? { url: text(data.url) } : {}),
        ...(file !== undefined ? { file } : {}),
        ...(text(data.file_id) !== undefined ? { fileId: text(data.file_id) } : {}),
        ...(text(data.name) !== undefined ? { name: text(data.name) } : file !== undefined ? { name: file } : {}),
        ...(scalar(data.sub_type) !== undefined ? { subType: scalar(data.sub_type) } : {}),
        ...(scalar(data['sub-type']) !== undefined ? { subType: scalar(data['sub-type']) } : {}),
        ...(text(data.summary) !== undefined ? { summary: text(data.summary) } : {}),
    };
}
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
export function parseMessage(segments) {
    const textParts = [];
    const media = [];
    const parsed = [];
    for (const raw of Array.isArray(segments) ? segments : []) {
        const segment = parseSegment(raw);
        // 表情包（mface）带图片地址时按图片处理：模型拿到本地文件与 QQ 的说明。
        if (segment.type === 'mface') {
            const url = segment.data.url;
            if (url !== undefined && /^https?:\/\//.test(url)) {
                const index = parsed.length;
                parsed.push({ type: 'image', data: {} });
                media.push({
                    kind: 'image',
                    segmentIndex: index,
                    url,
                    ...(segment.data.summary !== undefined ? { summary: segment.data.summary } : {}),
                });
                continue;
            }
        }
        if (segment.type === 'text') {
            if (segment.data.text === '')
                continue;
            textParts.push(segment.data.text);
        }
        const ref = mediaRefOf(segment, raw, parsed.length);
        if (ref !== undefined)
            media.push(ref);
        parsed.push(segment);
    }
    return { text: textParts.join('').trim(), media, segments: parsed };
}
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
export function faceData(id, name) {
    const resolvedId = id !== undefined && id !== '' ? id : (name !== undefined ? faceId(name) : undefined);
    if (resolvedId === undefined)
        return name !== undefined ? { name } : undefined;
    const resolvedName = name !== undefined && name !== '' ? name : faceName(resolvedId);
    return { id: resolvedId, ...(resolvedName !== undefined ? { name: resolvedName } : {}) };
}
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
export function fillMentionNames(segments, names) {
    for (const segment of segments) {
        if (segment.type !== 'at')
            continue;
        if (segment.data.name !== undefined && segment.data.name !== '')
            continue;
        const name = names.get(segment.data.qq);
        if (name !== undefined && name !== '')
            segment.data.name = name;
    }
}
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
export function detectMention(segments, selfId, botQQ) {
    const bot = selfId !== '' ? selfId : botQQ;
    if (bot === '' || !Array.isArray(segments))
        return false;
    return segments.some(segment => segment.type === 'at'
        && (String(segment.data.qq) === bot || String(segment.data.qq) === 'all'));
}
/** 段是否带本地文件（媒体是否已取到）。 */
function hasFile(segment) {
    if (mediaKindOf(segment) === undefined)
        return true;
    const data = segment.data;
    return data.file !== undefined && data.file !== '';
}
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
export function renderSegment(segment) {
    if (segment.type === 'text')
        return segment.data.text;
    if (segment.type === 'unknown') {
        // 还原 OneBot 原形状：模型拿到的是它认识的段类型名与全部原始属性。
        const { $type, ...rest } = segment.data;
        return { type: $type, data: rest };
    }
    if (!hasFile(segment)) {
        const kind = mediaKindOf(segment);
        return '(' + (kind !== undefined ? mediaLabel(kind) : '媒体') + '未取到)';
    }
    if (segment.type === 'reply' && segment.data.message !== undefined) {
        return { type: 'reply', data: { ...segment.data, message: renderRecordValue(segment.data.message) } };
    }
    if (segment.type === 'forward' && Array.isArray(segment.data.messages)) {
        return {
            type: 'forward',
            data: { ...segment.data, messages: segment.data.messages.map(renderRecordValue) },
        };
    }
    return segment;
}
/**
 * 渲染内嵌的一条记录：记录的 `message` 是段数组，递归渲染成模型可见值。
 * 不是记录（没有段数组 message）的值原样返回。
 *
 * Args:
 *   value (unknown): 引用的被引消息记录或转发节点记录。
 *
 * Returns:
 *   unknown: 渲染后的记录。
 *
 * Callers:
 *   - `renderSegment`（引用与合并转发）。
 */
function renderRecordValue(value) {
    if (value === null || typeof value !== 'object')
        return value;
    const record = value;
    if (!Array.isArray(record.message))
        return value;
    return { ...value, message: renderMessage(record.message) };
}
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
export function renderMessage(segments) {
    const items = segments.map(renderSegment).filter(item => item !== '');
    return items.length === 1 ? items[0] : items;
}
