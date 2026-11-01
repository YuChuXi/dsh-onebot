/**
 * 发送工具族：把一条或多条消息发到 QQ 会话。七个工具只描述参数与
 * 「参数 → 发送计划」，会话解析、媒体围栏、写闸与 end 收尾由统一工厂处理。
 * @module dsh-onebot/tools/send
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { isUrl } from '../media/store.js';
import { normalizeSegment } from '../onebot/segments.js';
import { mediaRoots, resolveChat } from './shared.js';
/** Output projection shared by the send tools (unconstrained JSON value). */
function sendOutput() {
    return {
        schema: { type: 'json' },
        render: (_args, value) => {
            const v = value;
            return [{ type: 'text', text: v.messageId != null ? '已发送（message_id=' + v.messageId + '）' : '已发送' }];
        },
    };
}
/** 发送工具共享的 end 参数：最后一条发完立即结束回合。 */
const END_PARAM = {
    type: 'boolean',
    description: '本条是最后一条：发完立即结束回合，省掉一次收尾的模型调用',
};
/** 所有发送工具共用的会话参数。 */
const CHAT_ID_PARAM = {
    type: 'string',
    description: '目标会话（private:<QQ号> 或 group:<群号>）；省略时默认当前会话',
};
/**
 * 把模型给的 segments 参数交给段类型注册表归一化，得到可发送的段数组。
 *
 * 每个段类型的入站解析与出站转换写在同一个适配器里；这里只负责接受
 * 字符串 / 单段 / 混合数组三种输入形状，并收集无法发送的段名。
 *
 * Args:
 *   value (unknown): 工具参数里的 segments（或 text）。
 *   limits (MediaLimits): 各媒体类型的大小上限。
 *   allowedRoots (string[]): 允许读取的媒体根目录。
 *
 * Returns:
 *   Promise<{ segments: OutboundSegment[]; dropped: string[] }>: 可发送段与被忽略段的说明。
 *
 * Callers:
 *   - `qq_send_message` 工具。
 */
async function outboundSegments(value, limits, allowedRoots) {
    const items = typeof value === 'string'
        ? [value]
        : Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
    const ctx = { allowedRoots, ...limits };
    const segments = [];
    const dropped = [];
    for (const item of items) {
        if (typeof item === 'string') {
            if (item !== '')
                segments.push({ type: 'text', data: { text: item } });
            continue;
        }
        if (item === null || typeof item !== 'object') {
            dropped.push(String(item));
            continue;
        }
        const raw = item;
        const type = typeof raw.type === 'string' ? raw.type : '';
        if (type === '') {
            dropped.push('未知段');
            continue;
        }
        const data = typeof raw.data === 'object' && raw.data !== null ? raw.data : {};
        const segment = await normalizeSegment({ type, data }, ctx);
        if (segment === undefined) {
            dropped.push(type);
            continue;
        }
        segments.push(segment);
    }
    return { segments, dropped };
}
/**
 * 注册全部发送工具。每个工具只描述参数与发送计划；会话解析、媒体根目录、
 * 写闸、end 收尾与返回值统一在这里处理。
 *
 * Args:
 *   register (RegisterTool): 工具注册回调。
 *   bridge (ChatBridge): 出站发送与回合收尾的桥接对象。
 *   limits (MediaLimits): 各媒体类型的大小上限。
 *
 * Returns:
 *   void
 *
 * Callers:
 *   - `tools/index.ts:registerTools`。
 */
export function registerSendTools(register, bridge, limits) {
    const send = (spec) => {
        register(defineTool({
            name: spec.name,
            description: spec.description,
            parameters: { chat_id: CHAT_ID_PARAM, ...spec.parameters, end: END_PARAM },
            output: sendOutput(),
            isConcurrencySafe: () => spec.concurrencySafe ?? true,
            execute: async (args, exec) => {
                const chatId = resolveChat(bridge, exec, args.chat_id);
                const roots = await mediaRoots(bridge, exec);
                const plan = await spec.build(args, { bridge, limits, chatId, roots });
                if (plan.kind === 'forward') {
                    await bridge.sendForward(chatId, plan.nodes);
                    if (args.end === true)
                        exec.concludeTurn();
                    return { sent: true, messageId: null };
                }
                if (plan.messages.every(message => message.length === 0)) {
                    throw new Error(spec.name + ': 没有可发送的消息段' + (plan.note !== undefined ? '（' + plan.note + '）' : ''));
                }
                const options = typeof args.reply_to === 'string' && args.reply_to !== '' ? { replyTo: args.reply_to } : {};
                let messageId;
                for (const message of plan.messages)
                    messageId = await bridge.sendSegments(chatId, message, options);
                if (args.end === true)
                    exec.concludeTurn();
                return { sent: true, messageId: messageId ?? null, ...(plan.note !== undefined ? { note: plan.note } : {}) };
            },
        }));
    };
    send({
        name: 'qq_send_message',
        description: '把一条消息发到 QQ 会话（对话的唯一出口，回合最终文本不会自动发送）。正文是 OneBot 11 消息段数组；本机媒体文件会自动转 base64。',
        concurrencySafe: false,
        parameters: {
            segments: {
                description: '消息段数组，例如 [{"type":"text","data":{"text":"你好"}},{"type":"image","data":{"file":"/path/a.png"}}]；文字也可以直接写成字符串，单段消息可以直接给那一段',
                oneOf: [
                    {
                        type: 'array',
                        items: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'string' }] },
                    },
                    { type: 'object', additionalProperties: true },
                    { type: 'string' },
                ],
            },
            text: { type: 'string', description: '纯文本快捷方式：只发一段文字时可省略 segments' },
            reply_to: { type: 'string', description: '要引用的消息 id（可选）' },
        },
        build: async (a, env) => {
            const { segments, dropped } = await outboundSegments(a.segments !== undefined ? a.segments : a.text, env.limits, env.roots);
            return {
                kind: 'segments',
                messages: [segments],
                ...(dropped.length > 0 ? { note: '已忽略这些段：' + dropped.join('、') } : {}),
            };
        },
    });
    send({
        name: 'qq_send_text',
        description: '批量发纯文字：texts 里每条各发一条消息（最常用的出口，等价于 qq_send_message 只发 text）。',
        parameters: {
            texts: { type: 'array', items: { type: 'string' }, required: true, description: '每条各发一条消息，按顺序发送' },
        },
        build: async (a) => {
            const texts = Array.isArray(a.texts)
                ? a.texts.filter((item) => typeof item === 'string' && item !== '')
                : [];
            return { kind: 'segments', messages: texts.map(text => [{ type: 'text', data: { text } }]) };
        },
    });
    send({
        name: 'qq_send_image',
        description: '向 QQ 会话发送一张或多张图片（本地文件路径或 http(s) URL，最多 9 张）。用于回复用户时附带截图/生成图等。',
        parameters: {
            sources: {
                type: 'array',
                items: { type: 'string' },
                required: true,
                description: '图片来源：本地绝对路径或 http(s) URL，最多 9 个',
            },
            caption: { type: 'string', description: '图片说明文字（可选，作为图片前的文本发送）' },
        },
        build: async (a, env) => {
            const sources = Array.isArray(a.sources) ? a.sources.filter((s) => typeof s === 'string') : [];
            if (sources.length === 0)
                throw new Error('qq_send_image: sources 不能为空');
            if (sources.length > 9)
                throw new Error('qq_send_image: 一次最多 9 张图片');
            const ctx = { allowedRoots: env.roots, ...env.limits };
            const segments = [];
            if (typeof a.caption === 'string' && a.caption !== '') {
                segments.push({ type: 'text', data: { text: a.caption } });
            }
            for (const source of sources) {
                const segment = await normalizeSegment(isUrl(source) ? { type: 'image', data: { url: source } } : { type: 'image', data: { file: source } }, ctx);
                if (segment === undefined)
                    throw new Error('qq_send_image: 无法读取图片 ' + source);
                segments.push(segment);
            }
            return { kind: 'segments', messages: [segments] };
        },
    });
    send({
        name: 'qq_send_voice',
        description: '向 QQ 会话发送一条语音消息（本地音频文件路径，mp3/wav/silk 等；NapCat 负责转码）。',
        parameters: {
            path: { type: 'string', required: true, description: '本地音频文件绝对路径' },
        },
        build: async (a, env) => {
            const path = typeof a.path === 'string' ? a.path : '';
            if (path === '')
                throw new Error('qq_send_voice: path 必填');
            const segment = await normalizeSegment({ type: 'record', data: { file: path } }, { allowedRoots: env.roots, ...env.limits });
            if (segment === undefined)
                throw new Error('qq_send_voice: 无法读取音频 ' + path);
            return { kind: 'segments', messages: [[segment]] };
        },
    });
    send({
        name: 'qq_send_video',
        description: '向 QQ 会话发送一条视频消息（本地视频文件绝对路径）。',
        parameters: {
            path: { type: 'string', required: true, description: '本地视频文件绝对路径' },
        },
        build: async (a, env) => {
            const path = typeof a.path === 'string' ? a.path : '';
            if (path === '')
                throw new Error('qq_send_video: path 必填');
            const segment = await normalizeSegment({ type: 'video', data: { file: path } }, { allowedRoots: env.roots, ...env.limits });
            if (segment === undefined)
                throw new Error('qq_send_video: 无法读取视频 ' + path);
            return { kind: 'segments', messages: [[segment]] };
        },
    });
    send({
        name: 'qq_send_file',
        description: '向 QQ 会话发送一个文件（本地文件绝对路径）。',
        parameters: {
            path: { type: 'string', required: true, description: '本地文件绝对路径' },
            name: { type: 'string', description: '文件名（默认取路径文件名）' },
        },
        build: async (a, env) => {
            const path = typeof a.path === 'string' ? a.path : '';
            if (path === '')
                throw new Error('qq_send_file: path 必填');
            const name = typeof a.name === 'string' && a.name !== '' ? a.name : path.split('/').pop() ?? 'file';
            const segment = await normalizeSegment({ type: 'file', data: { file: path, name } }, { allowedRoots: env.roots, ...env.limits });
            if (segment === undefined)
                throw new Error('qq_send_file: 无法读取文件 ' + path);
            return { kind: 'segments', messages: [[segment]] };
        },
    });
    send({
        name: 'qq_send_forward',
        description: '以「合并转发」形式向 QQ 会话发送多条消息（每条含发送者名和内容，适合代码+说明、分步报告等）。',
        parameters: {
            messages: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: '显示名（≤24 字）' },
                        content: { type: 'string', description: '消息内容（≤500 字，必填）' },
                    },
                    additionalProperties: true,
                },
                required: true,
                description: '合并转发的消息节点列表',
            },
        },
        build: async (a) => {
            if (!Array.isArray(a.messages) || a.messages.length === 0)
                throw new Error('qq_send_forward: messages 不能为空');
            const nodes = a.messages.map(item => {
                const node = item;
                return {
                    name: typeof node.name === 'string' && node.name !== '' ? node.name : '助手',
                    content: typeof node.content === 'string' ? node.content : '',
                };
            });
            if (nodes.some(node => node.content === ''))
                throw new Error('qq_send_forward: 每条消息都需要 content');
            return { kind: 'forward', nodes };
        },
    });
}
