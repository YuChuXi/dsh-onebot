/**
 * 表情工具族：以“表情包 / 表情摘要”定位，以详细描述辅助理解与检索。
 *
 * 表情只保存在插件媒体目录内。普通图片默认进入“我的收藏”；商城表情使用
 * 固有 summary 作为摘要，并按 emoji_package_id 归属同一个表情包。发送时本地
 * 图片读成 base64，商城表情按五字段原样重放。
 * @module dsh-onebot/tools/stickers
 */
import { readFile, stat } from 'node:fs/promises';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { DEFAULT_STICKER_PACK, } from '../media/stickers.js';
import { isUrl, resolveContainedPath } from '../media/store.js';
import { normalizeSegment } from '../onebot/segments.js';
import { CHAT_ID_PARAM, END_PARAM, mediaRoots, resolveChat, } from './shared.js';
/** 商城表情五字段。 */
const MFACE_FIELDS = ['summary', 'emoji_id', 'emoji_package_id', 'key', 'url'];
/** 一次最多列出的表情数。 */
const LIST_MAX = 100;
/** 一套 QQ 表情的张数，也是预览拼图的上限。 */
const PREVIEW_MAX = 16;
/** 预览拼图列数；16 张正好排成 4×4。 */
const PREVIEW_COLUMNS = 4;
/** 预览单元格尺寸，与 QQ 表情的 300×300 规格一致。 */
const CELL_SIZE = 300;
/** 单元格下方的摘要文字区高度。 */
const CELL_LABEL_HEIGHT = 40;
/** 预览单元格总高度。 */
const CELL_HEIGHT = CELL_SIZE + CELL_LABEL_HEIGHT;
/**
 * 校验并取出商城表情五字段；缺字段直接报错。
 *
 * Args:
 *   value (unknown): 工具参数里的 mface 对象。
 *   action (string): 调用方名称，用于错误信息。
 *
 * Returns:
 *   StickerMark: 完整的五字段。
 *
 * Callers:
 *   - `stickerSegment`、`collectSources`。
 */
function stickerMark(value, action) {
    if (value === null || typeof value !== 'object')
        throw new Error(action + ': mface 需要对象');
    const raw = value;
    const mark = {};
    for (const field of MFACE_FIELDS) {
        const item = raw[field];
        if (typeof item === 'string' && item !== '')
            mark[field] = item;
        else if (typeof item === 'number' && Number.isFinite(item))
            mark[field] = String(item);
        else
            throw new Error(action + ': mface 缺少 ' + field);
    }
    return mark;
}
/**
 * 按表情包与摘要精确定位记录；省略表情包时要求全库只命中一条。
 *
 * Args:
 *   records (StickerRecord[]): 本地表情库全部记录。
 *   pack (string): 表情包名称；空串表示不限定。
 *   summary (string): 表情摘要。
 *
 * Returns:
 *   StickerRecord: 唯一命中的记录。
 *
 * Callers:
 *   - `stickerSegment`。
 */
function pickSticker(records, pack, summary) {
    const pool = records.filter(record => (pack === '' || record.pack === pack) && record.summary === summary);
    if (pool.length === 1)
        return pool[0];
    if (pool.length === 0) {
        const location = pack === '' ? '表情库' : '表情包「' + pack + '」';
        throw new Error('qq_send_sticker: ' + location + '没有摘要「' + summary + '」');
    }
    const packs = [...new Set(pool.map(record => record.pack))];
    throw new Error('qq_send_sticker: 摘要「' + summary + '」存在于多个表情包，请给 pack：' + packs.join('、'));
}
/**
 * 把发送参数解析成一条表情段。
 *
 * Args:
 *   args (object): 工具参数（pack+summary / path / url / mface）。
 *   library (StickerLibrary): 本地表情库。
 *   bridge (ChatBridge): 媒体围栏根来源。
 *   exec (ToolRunContext): 工具执行上下文。
 *   limits (MediaLimits): 媒体大小上限。
 *
 * Returns:
 *   Promise<OutboundSegment>: 可发送的表情段。
 *
 * Callers:
 *   - `qq_send_sticker`。
 */
async function stickerSegment(args, library, bridge, exec, limits) {
    if (args.mface !== undefined && args.mface !== null) {
        return { type: 'mface', data: stickerMark(args.mface, 'qq_send_sticker') };
    }
    const pack = typeof args.pack === 'string' ? args.pack.trim() : '';
    const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
    const path = typeof args.path === 'string' ? args.path : '';
    const url = typeof args.url === 'string' ? args.url : '';
    if (pack !== '' && summary === '')
        throw new Error('qq_send_sticker: pack 必须与 summary 一起使用');
    if ([summary !== '', path !== '', url !== ''].filter(Boolean).length !== 1) {
        throw new Error('qq_send_sticker: pack+summary / path / url / mface 需要且只能给一个');
    }
    if (summary !== '') {
        const record = pickSticker(await library.list(), pack, summary);
        if (record.mark !== undefined)
            return { type: 'mface', data: record.mark };
        return await localImageSegment(record.file, bridge, exec, limits);
    }
    if (path !== '')
        return await localImageSegment(path, bridge, exec, limits);
    if (!isUrl(url))
        throw new Error('qq_send_sticker: url 不是 http(s) 地址');
    return { type: 'image', data: { file: url, sub_type: 1 } };
}
/**
 * 本机图片路径归一成可发送的 image 段（带表情标记）。
 *
 * Args:
 *   source (string): 本机图片路径。
 *   bridge (ChatBridge): 媒体围栏根来源。
 *   exec (ToolRunContext): 工具执行上下文。
 *   limits (MediaLimits): 媒体大小上限。
 *
 * Returns:
 *   Promise<OutboundSegment>: 可发送段。
 *
 * Callers:
 *   - `stickerSegment`。
 */
async function localImageSegment(source, bridge, exec, limits) {
    const segment = await normalizeSegment({ type: 'image', data: { file: source, sub_type: 1 } }, { allowedRoots: await mediaRoots(bridge, exec), ...limits });
    if (segment === undefined)
        throw new Error('qq_send_sticker: 无法读取 ' + source);
    return segment;
}
/**
 * 将一套表情拼成一张 PNG，每格 300×300 并在下方标注摘要。
 *
 * Args:
 *   records (StickerRecord[]): 要预览的记录，最多 16 条。
 *   labelPack (boolean): 是否在标签前加表情包名，用于跨包预览。
 *
 * Returns:
 *   Promise<Buffer>: PNG 图片字节。
 *
 * Callers:
 *   - `qq_list_stickers`。
 */
async function stickerSheet(records, labelPack) {
    const rows = Math.ceil(records.length / PREVIEW_COLUMNS);
    const canvas = createCanvas(PREVIEW_COLUMNS * CELL_SIZE, rows * CELL_HEIGHT);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#202124';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '22px sans-serif';
    for (let position = 0; position < records.length; position += 1) {
        const record = records[position];
        const column = position % PREVIEW_COLUMNS;
        const row = Math.floor(position / PREVIEW_COLUMNS);
        const x = column * CELL_SIZE;
        const y = row * CELL_HEIGHT;
        const image = await loadImage(await readFile(record.file));
        const scale = Math.min(CELL_SIZE / image.width, CELL_SIZE / image.height, 1);
        const width = Math.max(1, Math.round(image.width * scale));
        const height = Math.max(1, Math.round(image.height * scale));
        ctx.drawImage(image, x + (CELL_SIZE - width) / 2, y + (CELL_SIZE - height) / 2, width, height);
        ctx.fillStyle = '#f1f3f4';
        ctx.fillText(labelPack ? record.pack + '·' + record.summary : record.summary, x + CELL_SIZE / 2, y + CELL_SIZE + CELL_LABEL_HEIGHT / 2, CELL_SIZE - 12);
    }
    return canvas.toBuffer('image/png');
}
/**
 * 渲染表情列表及整套预览拼图：按表情包分组，组内逐条给出摘要与详细描述。
 *
 * Args:
 *   value (StickerList): 工具返回值。
 *
 * Returns:
 *   ContentBlock[]: 分组文本与一张预览图。
 *
 * Callers:
 *   - `qq_list_stickers` 的 `output.render`。
 */
function listContent(value) {
    const faces = Array.isArray(value.faces) ? value.faces : [];
    const packs = new Map();
    for (const face of faces) {
        const bucket = packs.get(face.pack);
        if (bucket === undefined)
            packs.set(face.pack, [face]);
        else
            bucket.push(face);
    }
    const lines = ['共 ' + value.count + ' 张，' + packs.size + ' 个表情包'];
    if (value.attachment !== undefined && faces.length > PREVIEW_MAX) {
        lines.push('拼图只含前 ' + PREVIEW_MAX + ' 张');
    }
    for (const [pack, items] of packs) {
        lines.push('【' + pack + '】' + items.length + ' 张');
        for (const face of items) {
            lines.push('- ' + face.summary + (face.caption === '' ? '（未填写详细描述）' : ' — ' + face.caption));
        }
    }
    const blocks = [{ type: 'text', text: lines.join('\n') }];
    if (value.attachment !== undefined)
        blocks.push({ type: 'image', attachment: value.attachment });
    return blocks;
}
/**
 * 读取入站时随表情图片落盘的五字段元数据；普通图片没有旁路文件。
 *
 * Args:
 *   file (string): 图片的绝对路径（已通过媒体围栏校验）。
 *
 * Returns:
 *   Promise<StickerMark | undefined>: 商城表情元数据；普通图片返回 undefined。
 *
 * Callers:
 *   - `collectSources`。
 */
async function stickerMetaOf(file) {
    let raw;
    try {
        raw = await readFile(file + '.json', 'utf8');
    }
    catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
            return undefined;
        throw error;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new Error('qq_collect_sticker: 表情元数据损坏：' + file + '.json');
    }
    return stickerMark(parsed, 'qq_collect_sticker');
}
/**
 * 把收藏参数逐项下载或解析为待入库来源，全部校验通过后才写库。
 *
 * Args:
 *   items (unknown[]): 收藏项数组。
 *   requestedPack (string): 调用方指定的表情包；空串表示自动确定。
 *   records (StickerRecord[]): 当前记录，用于复用商城包名。
 *   bridge (ChatBridge): 图片下载与媒体围栏根来源。
 *   exec (ToolRunContext): 工具执行上下文。
 *   limits (MediaLimits): 媒体大小上限。
 *
 * Returns:
 *   Promise<StickerSource[]>: 完整的待入库来源。
 *
 * Callers:
 *   - `qq_collect_sticker`。
 */
async function collectSources(items, requestedPack, records, bridge, exec, limits) {
    const roots = await mediaRoots(bridge, exec);
    const sources = [];
    for (let position = 0; position < items.length; position += 1) {
        const label = 'qq_collect_sticker: 第 ' + (position + 1) + ' 项';
        const item = items[position];
        if (item === null || typeof item !== 'object')
            throw new Error(label + ' 需要对象');
        const entry = item;
        const path = typeof entry.path === 'string' ? entry.path : '';
        const url = typeof entry.url === 'string' ? entry.url : '';
        const hasMface = entry.mface !== undefined && entry.mface !== null;
        if (hasMface) {
            if (url !== '')
                throw new Error(label + ': mface 已含 url，不要再单独给 url');
        }
        else if ((path !== '') === (url !== '')) {
            throw new Error(label + ': path / url 需要且只能给一个');
        }
        const caption = typeof entry.caption === 'string' ? entry.caption.trim() : '';
        let file = '';
        if (path !== '') {
            const resolved = await resolveContainedPath(roots, path);
            if (resolved === null)
                throw new Error(label + ': path 不在允许的媒体目录内');
            file = resolved;
        }
        // 入站时商城表情的五字段随图片落盘；这里按文件读取，模型不必搬运。
        const meta = hasMface ? undefined : file !== '' ? await stickerMetaOf(file) : undefined;
        let pack = requestedPack;
        let summary = typeof entry.summary === 'string' ? entry.summary.trim() : '';
        let mark;
        if (hasMface || meta !== undefined) {
            mark = stickerMark(hasMface ? entry.mface : meta, label);
            if (!isUrl(mark.url))
                throw new Error(label + ': 商城表情 url 不是 http(s) 地址');
            summary = mark.summary.trim();
            if (summary === '')
                throw new Error(label + ': 商城表情 summary 为空');
            if (pack === '') {
                const packs = [...new Set(records.filter(record => record.mark?.emoji_package_id === mark?.emoji_package_id).map(record => record.pack))];
                if (packs.length === 1)
                    pack = packs[0];
                else if (packs.length > 1)
                    throw new Error(label + ': emoji_package_id 对应多个表情包，请显式给 pack');
            }
            if (pack === '')
                throw new Error(label + ': 新商城表情包必须给 pack（例如「柰子鱼3」）');
            if (file === '')
                file = await bridge.saveSticker(mark.url);
        }
        else {
            if (summary === '')
                throw new Error(label + ' 缺少 summary（普通图片需要简短摘要）');
            if (caption === '')
                throw new Error(label + ' 缺少 caption（普通图片需要详细描述）');
            if (pack === '')
                pack = DEFAULT_STICKER_PACK;
            if (file === '') {
                if (!isUrl(url))
                    throw new Error(label + ': url 不是 http(s) 地址');
                file = await bridge.saveSticker(url);
            }
        }
        const info = await stat(file);
        if (info.size > limits.maxImageBytes)
            throw new Error(label + ': 表情图片超过 ' + limits.maxImageBytes + ' 字节');
        sources.push({ file, pack, summary, caption, ...(mark === undefined ? {} : { mark }) });
    }
    return sources;
}
/**
 * 注册表情工具族。
 *
 * Args:
 *   register (RegisterTool): 工具注册回调。
 *   bridge (ChatBridge): 出站发送、媒体下载与围栏根来源。
 *   library (StickerLibrary): 本地表情库。
 *   limits (MediaLimits): 媒体大小上限。
 *   images (() => StickerImageStore | undefined): 宿主附件服务访问器。
 *
 * Returns:
 *   void
 *
 * Callers:
 *   - `tools/index.ts:registerTools`。
 */
export function registerStickerTools(register, bridge, library, limits, images) {
    register(defineTool({
        name: 'qq_list_stickers',
        description: '列出表情包及其中每张表情的摘要与详细描述。可按表情包或关键词筛选；preview=true 时把命中结果拼成一张总览图，便于一次看完整套表情后批量补写描述。',
        parameters: {
            pack: { type: 'string', description: '只看指定表情包，例如「柰子鱼3」或「我的收藏」' },
            query: { type: 'string', description: '在表情包、摘要、详细描述中做子串检索，忽略大小写' },
            count: { type: 'number', description: '返回数量（默认 100，最多 100）' },
            preview: { type: 'boolean', description: '生成一张 4×4 的整套预览拼图（最多 16 张）；默认 false' },
        },
        output: { schema: { type: 'json' }, render: (_args, value) => listContent(value) },
        isConcurrencySafe: () => true,
        execute: async (args) => {
            const a = args;
            const pack = typeof a.pack === 'string' ? a.pack.trim() : '';
            const query = typeof a.query === 'string' ? a.query.trim().toLowerCase() : '';
            const count = Math.min(Math.max(typeof a.count === 'number' ? Math.floor(a.count) : LIST_MAX, 1), LIST_MAX);
            const preview = a.preview === true;
            const all = await library.list();
            const matched = all.filter(record => (pack === '' || record.pack === pack) &&
                (query === '' || (record.pack + '\n' + record.summary + '\n' + record.caption).toLowerCase().includes(query)));
            const records = matched.slice(0, count);
            const result = {
                count: matched.length,
                faces: records.map(record => ({
                    pack: record.pack,
                    summary: record.summary,
                    caption: record.caption,
                    market: record.mark !== undefined,
                })),
            };
            if (preview && records.length > 0) {
                const store = images();
                if (store === undefined)
                    throw new Error('qq_list_stickers: 宿主未挂载附件服务，无法生成预览');
                const shown = records.slice(0, PREVIEW_MAX);
                const packs = new Set(shown.map(record => record.pack));
                result.attachment = await store.saveImage({
                    data: await stickerSheet(shown, packs.size > 1),
                    mediaType: 'image/png',
                    name: (pack || '表情库') + '预览.png',
                });
            }
            return result;
        },
    }));
    register(defineTool({
        name: 'qq_send_sticker',
        description: '发送表情。库内表情用 pack+summary 定位（例如 pack=柰子鱼3、summary=飞天猫猫）；全库摘要唯一时可省略 pack。详细描述 caption 不参与发送定位。另支持本地路径、URL 或 mface 五字段。',
        parameters: {
            chat_id: CHAT_ID_PARAM,
            pack: { type: 'string', description: '表情包名称；与 summary 配合使用。全库摘要唯一时可省略' },
            summary: { type: 'string', description: '表情摘要，例如「飞天猫猫」；不是详细描述' },
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
            const segment = await stickerSegment(a, library, bridge, exec, limits);
            const messageId = await bridge.sendSegments(chatId, [segment]);
            if (a.end === true)
                exec.concludeTurn();
            return { sent: true, messageId: messageId ?? null };
        },
    }));
    register(defineTool({
        name: 'qq_collect_sticker',
        description: '批量收藏到同一个表情包。每项给本地图片 path；收到的是商城表情时，插件会读取入站时随图片保存的元数据，自动按表情重放，不必重复传 emoji_id/key/url。普通图片必须给 summary（简短摘要）与 caption（详细描述），默认进「我的收藏」。',
        parameters: {
            pack: { type: 'string', description: '表情包名称。新商城表情包必填；已收录的商城包按 emoji_package_id 自动复用；普通图片省略时为「我的收藏」' },
            items: {
                type: 'array',
                required: true,
                description: '每项 {path, caption?}：商城表情图片会自动识别，caption 可先看拼图后补写；普通图片另需 summary 与 caption',
                items: { type: 'object', additionalProperties: true },
            },
        },
        output: {
            schema: { type: 'json' },
            render: (_args, value) => {
                const v = value;
                const lines = (v.collected ?? []).map(item => '【' + String(item.pack ?? '') + '】' + String(item.summary ?? ''));
                return [{ type: 'text', text: '已收藏 ' + lines.length + ' 张：' + lines.join('，') }];
            },
        },
        isConcurrencySafe: () => false,
        execute: async (args, exec) => {
            const a = args;
            if (!Array.isArray(a.items) || a.items.length === 0)
                throw new Error('qq_collect_sticker: items 需要非空数组');
            const pack = typeof a.pack === 'string' ? a.pack.trim() : '';
            const records = await library.list();
            const sources = await collectSources(a.items, pack, records, bridge, exec, limits);
            const collected = await library.addMany(sources);
            return {
                count: collected.length,
                collected: collected.map(record => ({
                    pack: record.pack,
                    summary: record.summary,
                    caption: record.caption,
                    file: record.file,
                    ...(record.mark === undefined ? {} : { mark: record.mark }),
                })),
            };
        },
    }));
    register(defineTool({
        name: 'qq_remark_sticker',
        description: '按 pack+summary 批量修改表情摘要或详细描述。summary 是定位用的现有短摘要，newSummary 用于改名，caption 是画面、情绪和语境的详细描述；未给的字段保持不变。',
        parameters: {
            items: {
                type: 'array',
                required: true,
                description: '每项 {pack, summary, newSummary?, caption?}，至少给 newSummary 或 caption；caption 可为空串表示清除',
                items: { type: 'object', additionalProperties: true },
            },
        },
        output: {
            schema: { type: 'json' },
            render: (_args, value) => {
                const v = value;
                const lines = (v.updated ?? []).map(item => '【' + String(item.pack ?? '') + '】' + String(item.summary ?? ''));
                return [{ type: 'text', text: '已更新 ' + lines.length + ' 张：' + lines.join('，') }];
            },
        },
        isConcurrencySafe: () => false,
        execute: async (args) => {
            const a = args;
            if (!Array.isArray(a.items) || a.items.length === 0)
                throw new Error('qq_remark_sticker: items 需要非空数组');
            const records = await library.list();
            const changes = [];
            const located = new Set();
            for (let position = 0; position < a.items.length; position += 1) {
                const item = a.items[position];
                const label = 'qq_remark_sticker: 第 ' + (position + 1) + ' 项';
                if (item === null || typeof item !== 'object')
                    throw new Error(label + ' 需要对象');
                const entry = item;
                const pack = typeof entry.pack === 'string' ? entry.pack.trim() : '';
                const summary = typeof entry.summary === 'string' ? entry.summary.trim() : '';
                if (pack === '')
                    throw new Error(label + ' 需要 pack');
                if (summary === '')
                    throw new Error(label + ' 需要 summary');
                if (entry.newSummary === undefined && entry.caption === undefined)
                    throw new Error(label + ' 需要 newSummary 或 caption');
                const key = pack + '\0' + summary;
                if (located.has(key))
                    throw new Error(label + ': 同一次调用重复定位「' + pack + ' / ' + summary + '」');
                located.add(key);
                if (!records.some(record => record.pack === pack && record.summary === summary)) {
                    throw new Error(label + ': 表情包「' + pack + '」没有摘要「' + summary + '」');
                }
                const newSummary = entry.newSummary === undefined ? undefined : typeof entry.newSummary === 'string' ? entry.newSummary.trim() : '';
                if (newSummary === '')
                    throw new Error(label + ' newSummary 不能为空');
                const caption = entry.caption === undefined ? undefined : typeof entry.caption === 'string' ? entry.caption.trim() : '';
                changes.push({ pack, summary, ...(newSummary === undefined ? {} : { newSummary }), ...(caption === undefined ? {} : { caption }) });
            }
            const updated = await library.remarkMany(changes);
            return {
                count: updated.length,
                updated: updated.map(record => ({ pack: record.pack, summary: record.summary, caption: record.caption })),
            };
        },
    }));
}
