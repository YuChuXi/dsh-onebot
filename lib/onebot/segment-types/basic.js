import { pickFields, scalar, text } from './primitives.js';
import { registerSegmentType } from './registry.js';
/** 类型 → 双向保留的属性。递归字段（reply.message / forward.messages）两向都保留。 */
const PLAIN = {
    node: { inbound: ['id', 'user_id', 'nickname', 'content', 'time'] },
    dice: { inbound: ['result'] },
    rps: { inbound: ['result'] },
    json: { inbound: ['data'] },
    xml: { inbound: ['data'] },
    share: { inbound: ['url', 'title', 'content', 'image'] },
    contact: { inbound: ['type', 'id'] },
    location: { inbound: ['lat', 'lon', 'title', 'content'] },
    music: { inbound: ['type', 'id', 'url', 'audio', 'title', 'content', 'image'] },
    markdown: { inbound: ['content'] },
    tts: { inbound: ['text'] },
    cardimage: { inbound: ['file'] },
};
for (const [type, spec] of Object.entries(PLAIN)) {
    const outbound = spec.outbound ?? spec.inbound;
    registerSegmentType(type, {
        segment: (raw) => {
            const picked = pickFields(raw.data ?? {}, spec.inbound);
            return Object.keys(picked).length === 0 ? undefined : { type, data: picked };
        },
        normalize: data => {
            const picked = pickFields(data, outbound);
            return Object.keys(picked).length === 0 ? undefined : { type, data: picked };
        },
    });
}
/**
 * 一条记录里 `message` 的逆还原：渲染值是字符串或段对象时还原成段数组。
 *
 * Args:
 *   value (unknown): 记录。
 *   restore ((value: unknown) => Promise<OutboundSegment[]>): 消息体逆还原。
 *
 * Returns:
 *   Promise<unknown>: message 已还原的记录；非记录原样返回。
 *
 * Callers:
 *   - `reply` 与 `forward` 的 normalize。
 */
async function restoreRecord(value, restore) {
    if (value === null || typeof value !== 'object')
        return value;
    const record = value;
    if (record.message === undefined)
        return value;
    return { ...value, message: await restore(record.message) };
}
registerSegmentType('reply', {
    // id 一律以字符串进入管线：下游比较、上报与渲染都按字符串处理。
    segment: (raw) => ({
        type: 'reply',
        data: {
            id: String(raw.data?.id ?? ''),
            ...(raw.data?.message !== undefined ? { message: raw.data.message } : {}),
        },
    }),
    normalize: async (data, ctx) => {
        const id = scalar(data.id);
        if (id === undefined || String(id) === '')
            return undefined;
        const message = data.message !== undefined ? await restoreRecord(data.message, ctx.restore) : undefined;
        return {
            type: 'reply',
            data: { id: String(id), ...(message !== undefined ? { message } : {}) },
        };
    },
    render: (segment, ctx) => {
        if (segment.type !== 'reply' || segment.data.message === undefined)
            return segment;
        return { type: 'reply', data: { ...segment.data, message: ctx.renderRecord(segment.data.message) } };
    },
});
registerSegmentType('forward', {
    segment: (raw) => {
        const picked = pickFields(raw.data ?? {}, ['id', 'resId', 'messages']);
        return Object.keys(picked).length === 0 ? undefined : { type: 'forward', data: picked };
    },
    normalize: async (data, ctx) => {
        const picked = pickFields(data, ['id', 'resId']);
        const messages = Array.isArray(data.messages)
            ? await Promise.all(data.messages.map(node => restoreRecord(node, ctx.restore)))
            : undefined;
        if (Object.keys(picked).length === 0 && messages === undefined)
            return undefined;
        return { type: 'forward', data: { ...picked, ...(messages !== undefined ? { messages } : {}) } };
    },
    render: (segment, ctx) => {
        if (segment.type !== 'forward' || !Array.isArray(segment.data.messages))
            return segment;
        return { type: 'forward', data: { ...segment.data, messages: segment.data.messages.map(ctx.renderRecord) } };
    },
});
registerSegmentType('text', {
    segment: (raw) => ({
        type: 'text',
        data: { text: typeof raw.data?.text === 'string' ? raw.data.text : '' },
    }),
    normalize: data => {
        const value = typeof data.text === 'string' ? data.text : '';
        return value === '' ? undefined : { type: 'text', data: { text: value } };
    },
    render: segment => (segment.type === 'text' ? segment.data.text : segment),
});
registerSegmentType('at', {
    segment: (raw) => {
        const qq = scalar(raw.data?.qq);
        if (qq === undefined)
            return undefined;
        const name = text(raw.data?.name);
        return { type: 'at', data: { qq: String(qq), ...(name !== undefined ? { name } : {}) } };
    },
    // 出站同样保留 name：它是语义的一部分，NapCat 读取时忽略也不会出错。
    normalize: data => {
        const qq = scalar(data.qq);
        if (qq === undefined)
            return undefined;
        const name = text(data.name);
        return { type: 'at', data: { qq: String(qq), ...(name !== undefined ? { name } : {}) } };
    },
    // 唤醒条件属于 at 类型自己的语义：指向机器人本人或 @全体。
    wakes: (segment, selfId, botQQ) => {
        if (segment.type !== 'at')
            return false;
        const bot = selfId !== '' ? selfId : botQQ;
        if (bot === '')
            return false;
        return segment.data.qq === bot || segment.data.qq === 'all';
    },
});
