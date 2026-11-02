/**
 * 表情包工具族：收藏表情列表、发送（收藏表情 / 图片 / 商城表情）、收藏。
 *
 * 收藏表情来自 NapCat 的 fetch_custom_face；发送收藏表情走 image 段
 * （URL + sub_type=1），商城表情走 mface 段；收藏走 add_custom_face，
 * 文件必须落在媒体目录内（NapCat 需要能读到该路径）。
 * @module dsh-onebot/tools/stickers
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { isUrl, resolveContainedPath } from '../media/store.js';
import { normalizeSegment } from '../onebot/segments.js';
import { CHAT_ID_PARAM, END_PARAM, mediaRoots, resolveChat, } from './shared.js';
/** 重放商城表情需要的五个字段。 */
const MFACE_FIELDS = ['summary', 'emoji_id', 'emoji_package_id', 'key', 'url'];
/** qq_sticker_list 一次最多读取的数量。 */
const LIST_MAX = 100;
/** 一次最多下载预览的表情数量。 */
const PREVIEW_MAX = 10;
/**
 * 取收藏表情 URL 列表。返回形状由 NapCat 决定，非数组按空列表处理。
 *
 * Args:
 *   connection (OneBotConnection): NapCat 调用通道。
 *   count (number): 读取数量。
 *
 * Returns:
 *   Promise<string[]>: 表情图片 URL。
 *
 * Callers:
 *   - `qq_sticker_list`、`qq_send_sticker`。
 */
async function customFaceUrls(connection, count) {
    const data = await connection.call('fetch_custom_face', { count });
    if (!Array.isArray(data))
        return [];
    return data.filter((item) => typeof item === 'string' && item !== '');
}
/**
 * 校验并取出 mface 五字段；缺字段直接报错，避免把残缺段交给 NapCat。
 *
 * Args:
 *   value (unknown): 工具参数里的 mface 对象。
 *
 * Returns:
 *   Record<string, string | number>: 五字段。
 *
 * Callers:
 *   - `qq_send_sticker`。
 */
function mfaceData(value) {
    if (value === null || typeof value !== 'object')
        throw new Error('qq_send_sticker: mface 需要对象');
    const raw = value;
    const data = {};
    for (const field of MFACE_FIELDS) {
        const item = raw[field];
        if ((typeof item === 'string' && item !== '') || typeof item === 'number')
            data[field] = item;
        else
            throw new Error('qq_send_sticker: mface 缺少 ' + field);
    }
    return data;
}
/**
 * 把发送参数解析成一条表情段：mface 原样重放，其余来源都发 image 段
 * 并标记 sub_type=1（NapCat 视为表情包）。
 *
 * Args:
 *   args (object): 工具参数（index / path / url / mface）。
 *   bridge (ChatBridge): 会话与媒体围栏。
 *   connection (OneBotConnection): 收藏表情列表来源。
 *   exec (ToolRunContext): 工具执行上下文。
 *   limits (MediaLimits): 媒体大小上限。
 *
 * Returns:
 *   Promise<OutboundSegment>: 可发送的表情段。
 *
 * Callers:
 *   - `qq_send_sticker`。
 */
async function stickerSegment(args, bridge, connection, exec, limits) {
    if (args.mface !== undefined && args.mface !== null) {
        return { type: 'mface', data: mfaceData(args.mface) };
    }
    const index = typeof args.index === 'number' ? Math.floor(args.index) : 0;
    const path = typeof args.path === 'string' ? args.path : '';
    const url = typeof args.url === 'string' ? args.url : '';
    if ([index > 0, path !== '', url !== ''].filter(Boolean).length !== 1) {
        throw new Error('qq_send_sticker: index / path / url / mface 需要且只能给一个');
    }
    if (index > 0) {
        const urls = await customFaceUrls(connection, index);
        const target = urls[index - 1];
        if (target === undefined)
            throw new Error('qq_send_sticker: 收藏表情没有第 ' + index + ' 张');
        return { type: 'image', data: { file: target, sub_type: 1 } };
    }
    const source = path !== '' ? path : url;
    const segment = await normalizeSegment({ type: 'image', data: { file: source, sub_type: 1 } }, { allowedRoots: await mediaRoots(bridge, exec), ...limits });
    if (segment === undefined)
        throw new Error('qq_send_sticker: 无法读取 ' + source);
    return segment;
}
/**
 * 注册表情包工具族。
 *
 * Args:
 *   register (RegisterTool): 工具注册回调。
 *   bridge (ChatBridge): 出站发送与媒体下载的桥接对象。
 *   connection (OneBotConnection): NapCat 调用通道。
 *   limits (MediaLimits): 媒体大小上限。
 *
 * Returns:
 *   void
 *
 * Callers:
 *   - `tools/index.ts:registerTools`。
 */
export function registerStickerTools(register, bridge, connection, limits) {
    register(defineTool({
        name: 'qq_sticker_list',
        description: '列出收藏表情（自定义表情）：返回序号与图片 URL；preview 可把前几张下载到本机供查看内容。',
        parameters: {
            count: { type: 'number', description: '读取数量（默认 48，最多 100）' },
            preview: { type: 'number', description: '把前 N 张下载到本机并返回路径，便于查看；默认 0，最多 10' },
        },
        output: {
            schema: { type: 'json' },
            render: (_args, value) => {
                const v = value;
                const total = Array.isArray(v.faces) ? v.faces.length : 0;
                return [{ type: 'text', text: '收藏表情 ' + total + ' 张' }];
            },
        },
        isConcurrencySafe: () => true,
        execute: async (args) => {
            const a = args;
            const count = Math.min(Math.max(typeof a.count === 'number' ? Math.floor(a.count) : 48, 1), LIST_MAX);
            const urls = await customFaceUrls(connection, count);
            const preview = Math.min(Math.max(typeof a.preview === 'number' ? Math.floor(a.preview) : 0, 0), PREVIEW_MAX, urls.length);
            const faces = [];
            for (let i = 0; i < urls.length; i += 1) {
                faces.push(i < preview
                    ? { index: i + 1, url: urls[i], path: await bridge.saveSticker(urls[i]) }
                    : { index: i + 1, url: urls[i] });
            }
            return { count: faces.length, faces };
        },
    }));
    register(defineTool({
        name: 'qq_send_sticker',
        description: '发送表情：收藏表情按序号（先看 qq_sticker_list）、本地图片路径、图片 URL，或商城表情 mface 对象。',
        parameters: {
            chat_id: CHAT_ID_PARAM,
            index: { type: 'number', description: '收藏表情序号（从 1 开始，见 qq_sticker_list）' },
            path: { type: 'string', description: '本地表情图片路径（须在允许的媒体目录内）' },
            url: { type: 'string', description: '表情图片 URL，由 NapCat 下载后发送' },
            mface: { type: 'object', additionalProperties: true, description: '商城表情五字段：summary、emoji_id、emoji_package_id、key、url' },
            end: END_PARAM,
        },
        output: {
            schema: { type: 'json' },
            render: (_args, value) => {
                const v = value;
                return [{ type: 'text', text: v.messageId != null ? '已发送表情（message_id=' + String(v.messageId) + '）' : '已发送表情' }];
            },
        },
        isConcurrencySafe: () => false,
        execute: async (args, exec) => {
            const a = args;
            const chatId = resolveChat(bridge, exec, a.chat_id);
            const segment = await stickerSegment(a, bridge, connection, exec, limits);
            const messageId = await bridge.sendSegments(chatId, [segment]);
            if (a.end === true)
                exec.concludeTurn();
            return { sent: true, messageId: messageId ?? null };
        },
    }));
    register(defineTool({
        name: 'qq_collect_sticker',
        description: '收藏表情：把本地图片、图片 URL 或收到的商城表情加入自定义表情。NapCat 必须能读到最后的本机路径。',
        parameters: {
            path: { type: 'string', description: '本地图片路径（须在允许的媒体目录内）' },
            url: { type: 'string', description: '图片 URL（先下载到媒体目录再收藏）' },
            mface: { type: 'object', additionalProperties: true, description: '商城表情：至少给 url，emoji_id / emoji_package_id 用于标记来源' },
            name: { type: 'string', description: '收藏后的文件名（可选）' },
        },
        output: {
            schema: { type: 'json' },
            render: () => [{ type: 'text', text: '已收藏表情' }],
        },
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            const mface = a.mface !== null && typeof a.mface === 'object' ? a.mface : undefined;
            const path = typeof a.path === 'string' ? a.path : '';
            const url = typeof a.url === 'string' ? a.url : '';
            if ([mface !== undefined, path !== '', url !== ''].filter(Boolean).length !== 1) {
                throw new Error('qq_collect_sticker: path / url / mface 需要且只能给一个');
            }
            let file = '';
            let emojiId = '';
            let packageId = 0;
            let isMarkFace = false;
            if (mface !== undefined) {
                const faceUrl = typeof mface.url === 'string' ? mface.url : '';
                if (!isUrl(faceUrl))
                    throw new Error('qq_collect_sticker: mface.url 不是有效 URL');
                file = await bridge.saveSticker(faceUrl);
                emojiId = mface.emoji_id !== undefined && mface.emoji_id !== null ? String(mface.emoji_id) : '';
                const packageRaw = mface.emoji_package_id;
                packageId = typeof packageRaw === 'number' && Number.isFinite(packageRaw) ? packageRaw
                    : typeof packageRaw === 'string' && /^\d+$/.test(packageRaw) ? Number(packageRaw) : 0;
                isMarkFace = true;
            }
            else if (url !== '') {
                if (!isUrl(url))
                    throw new Error('qq_collect_sticker: url 不是有效 URL');
                file = await bridge.saveSticker(url);
            }
            else {
                const resolved = await resolveContainedPath(await mediaRoots(bridge, exec), path);
                if (resolved === null)
                    throw new Error('qq_collect_sticker: path 不在允许的媒体目录内');
                file = resolved;
            }
            const params = { file };
            if (emojiId !== '')
                params.emoji_id = emojiId;
            if (packageId !== 0)
                params.package_id = packageId;
            if (isMarkFace)
                params.is_mark_face = true;
            if (typeof a.name === 'string' && a.name !== '')
                params.file_name = a.name;
            await connection.call('add_custom_face', params);
            return { collected: true, file, emojiId, packageId, isMarkFace };
        },
    }));
}
