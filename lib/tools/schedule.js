/**
 * 定时任务工具：与 dsh 的 schedule_create / list / delete / update 同一套参数，
 * 唯一的差别是绑定目标为 chat_id（群/私聊）而不是 session。
 * @module dsh-onebot/tools/schedule
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { ScheduleInputError, scheduleView } from '@deepseek-ai/dsh-schedule';
import { END_PARAM, resolveChat } from './shared.js';
/** 四个工具共用的聊天参数。 */
const CHAT_PARAM = {
    type: 'string',
    description: '目标群/私聊（private:<QQ号> 或 group:<群号>）；省略时默认当前会话',
};
/** 创建与更新共用的时间选择器，与 dsh 的 SELECTOR_PARAMETERS 一致。 */
const SELECTOR_PARAMETERS = {
    every_seconds: {
        type: 'number',
        description: '固定间隔秒数（至少 60），对齐创建时间；更新时重新对齐到保存时间',
    },
    daily: {
        type: 'object',
        additionalProperties: false,
        description: '每天固定本地时刻',
        properties: {
            time: { type: 'string', required: true, description: 'HH:mm:ss，可带 1-3 位小数' },
            time_zone: { type: 'string', required: true, description: 'UTC 或 IANA 时区，如 Asia/Shanghai' },
        },
    },
    weekly: {
        type: 'object',
        additionalProperties: false,
        description: '每周指定星期的固定本地时刻',
        properties: {
            time: { type: 'string', required: true, description: 'HH:mm:ss，可带 1-3 位小数' },
            time_zone: { type: 'string', required: true, description: 'UTC 或 IANA 时区' },
            weekdays: {
                type: 'array',
                required: true,
                description: 'ISO 星期：周一 1 到周日 7，不重复',
                items: { type: 'integer' },
            },
        },
    },
    cron: {
        type: 'object',
        additionalProperties: false,
        description: '五段 Vixie cron 表达式与时区',
        properties: {
            expression: { type: 'string', required: true, description: '分 时 日 月 周，如 "*/15 9-17 * * 1-5"' },
            time_zone: { type: 'string', required: true, description: 'UTC 或 IANA 时区' },
        },
    },
    at: {
        description: '绝对时刻：带偏移的 RFC 3339 时间，或 {date, time, time_zone} 本地日历值',
        oneOf: [
            { type: 'string' },
            {
                type: 'object',
                additionalProperties: false,
                properties: {
                    date: { type: 'string', required: true, description: 'YYYY-MM-DD' },
                    time: { type: 'string', required: true, description: 'HH:mm:ss，可带 1-3 位小数' },
                    time_zone: { type: 'string', required: true, description: 'UTC 或 IANA 时区' },
                },
            },
        ],
    },
};
/**
 * 把时间选择器从参数中提取出来，并校验数量。
 *
 * Args:
 *   a (ScheduleArgs): 工具参数。
 *   allowAfter (boolean): 是否接受 after_seconds（create 接受，update 不接受）。
 *
 * Returns:
 *   TimerTiming: 至多一个已给出的选择器。
 *
 * Callers:
 *   - `registerScheduleTools` 的 create / update 执行体。
 */
function pickTiming(a, allowAfter) {
    const timing = {};
    const given = [];
    if (a.after_seconds !== undefined) {
        if (!allowAfter)
            throw new Error('invalid_selector: 更新不支持 after_seconds，请新建一条');
        given.push('after_seconds');
        timing.afterSeconds = a.after_seconds;
    }
    if (a.at !== undefined) {
        given.push('at');
        timing.at = a.at;
    }
    if (a.every_seconds !== undefined) {
        given.push('every_seconds');
        timing.everySeconds = a.every_seconds;
    }
    if (a.daily !== undefined) {
        given.push('daily');
        timing.daily = a.daily;
    }
    if (a.weekly !== undefined) {
        given.push('weekly');
        timing.weekly = a.weekly;
    }
    if (a.cron !== undefined) {
        given.push('cron');
        timing.cron = a.cron;
    }
    if (given.length > 1)
        throw new Error('invalid_selector: 时间参数只能给一个（' + given.join(' / ') + '）');
    return timing;
}
/**
 * 把领域层的输入错误转成工具错误文本。
 *
 * Args:
 *   error (unknown): 领域函数抛出的错误。
 *
 * Returns:
 *   Error: 带稳定 code 的错误。
 *
 * Callers:
 *   - 四个工具的执行体。
 */
function asToolError(error) {
    if (error instanceof ScheduleInputError)
        return new Error(error.code + ': ' + error.message);
    return error instanceof Error ? error : new Error(String(error));
}
/**
 * 任务条目转成模型可见的视图。
 *
 * Args:
 *   entry (TimerEntry): 任务。
 *   now (number): 当前时间。
 *
 * Returns:
 *   Record<string, JsonValue>: dsh 的 scheduleView 加上 chat_id。
 *
 * Callers:
 *   - 四个工具的执行体。
 */
function view(entry, now) {
    return { ...scheduleView(entry.record, now), chat_id: entry.chatId };
}
/**
 * 注册四个定时任务工具。
 *
 * Args:
 *   register (RegisterTool): 工具注册入口。
 *   bridge (ChatBridge): 定时器集合与当前会话解析。
 *
 * Returns:
 *   void
 *
 * Callers:
 *   - `src/tools/index.ts:registerTools`。
 */
export function registerScheduleTools(register, bridge) {
    register(defineTool({
        name: 'qq_create_schedule',
        description: '在当前群/私聊创建定时任务，到点后在新回合里收到 prompt（由你决定发什么消息）。'
            + '时间参数六选一：after_seconds、at、every_seconds、daily、weekly、cron。'
            + '时区里不存在或重复的本地时刻按 dsh 规则处理：跳过不存在的，后者取较早的一次。'
            + '停机恢复后循环任务只补发最近一次漏掉的触发。',
        parameters: {
            chat_id: CHAT_PARAM,
            prompt: { type: 'string', required: true, description: '到点后投递给你的提醒内容' },
            title: { type: 'string', required: true, description: '任务名（≤120 字，只写动作与对象，不含频率与时间）' },
            after_seconds: { type: 'number', description: '相对当前时间的秒数，正整数' },
            ...SELECTOR_PARAMETERS,
            end: END_PARAM,
        },
        output: {
            schema: { type: 'json' },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        isConcurrencySafe: () => false,
        execute: async (args, exec) => {
            const a = args;
            const chatId = resolveChat(bridge, exec, a.chat_id);
            try {
                const timing = pickTiming(a, true);
                const prompt = String(a.prompt ?? '').trim();
                const title = String(a.title ?? '').trim();
                if (prompt === '')
                    throw new ScheduleInputError('invalid_prompt', 'prompt 不能为空');
                if (title === '')
                    throw new ScheduleInputError('invalid_prompt', 'title 不能为空');
                if (Object.keys(timing).length === 0)
                    throw new ScheduleInputError('invalid_selector', '必须给出一个时间参数');
                const entry = await bridge.timers.create(chatId, { title, prompt }, timing);
                if (a.end === true)
                    exec.concludeTurn();
                return view(entry, Date.now());
            }
            catch (error) {
                throw asToolError(error);
            }
        },
    }));
    register(defineTool({
        name: 'qq_list_schedules',
        description: '列出当前群/私聊的定时任务（省略 chat_id 时只看当前会话）。',
        parameters: { chat_id: CHAT_PARAM, end: END_PARAM },
        output: {
            schema: { type: 'json' },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            const chatId = resolveChat(bridge, exec, a.chat_id);
            const now = Date.now();
            const timers = bridge.timers.list(chatId).map(entry => view(entry, now));
            if (a.end === true)
                exec.concludeTurn();
            return timers;
        },
    }));
    register(defineTool({
        name: 'qq_delete_schedule',
        description: '删除当前群/私聊的一条定时任务；已进入队列的提醒不会被撤回。',
        parameters: {
            chat_id: CHAT_PARAM,
            id: { type: 'string', required: true, description: 'schedule_list 返回的 id' },
            end: END_PARAM,
        },
        output: {
            schema: { type: 'json' },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        isConcurrencySafe: () => false,
        execute: async (args, exec) => {
            const a = args;
            const id = String(a.id ?? '');
            if (id === '' || id.trim() !== id)
                throw new Error('invalid_rule: id 不能为空且不能带首尾空白');
            const chatId = resolveChat(bridge, exec, a.chat_id);
            const removed = await bridge.timers.remove(chatId, id);
            if (!removed)
                throw new Error('schedule_not_found: 当前会话没有这个 id');
            if (a.end === true)
                exec.concludeTurn();
            return { id, deleted: true };
        },
    }));
    register(defineTool({
        name: 'qq_update_schedule',
        description: '原地修改一条定时任务（保留 id）：给新的 title、prompt 或至多一个时间参数，未给出的字段沿用存储值。'
            + '相对延时不能改，需要新的 after_seconds 时请新建。',
        parameters: {
            chat_id: CHAT_PARAM,
            id: { type: 'string', required: true, description: 'schedule_list 返回的 id' },
            title: { type: 'string', description: '新的任务名' },
            prompt: { type: 'string', description: '新的提醒内容' },
            ...SELECTOR_PARAMETERS,
            end: END_PARAM,
        },
        output: {
            schema: { type: 'json' },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        isConcurrencySafe: () => false,
        execute: async (args, exec) => {
            const a = args;
            const id = String(a.id ?? '');
            if (id === '' || id.trim() !== id)
                throw new Error('invalid_rule: id 不能为空且不能带首尾空白');
            const chatId = resolveChat(bridge, exec, a.chat_id);
            try {
                const timing = pickTiming(a, false);
                const content = {};
                if (a.title !== undefined) {
                    content.title = String(a.title).trim();
                    if (content.title === '')
                        throw new ScheduleInputError('invalid_prompt', 'title 不能为空');
                }
                if (a.prompt !== undefined) {
                    content.prompt = String(a.prompt).trim();
                    if (content.prompt === '')
                        throw new ScheduleInputError('invalid_prompt', 'prompt 不能为空');
                }
                const entry = await bridge.timers.update(chatId, id, content, timing);
                if (entry === undefined)
                    throw new Error('schedule_not_found: 当前会话没有这个 id');
                if (a.end === true)
                    exec.concludeTurn();
                return view(entry, Date.now());
            }
            catch (error) {
                throw asToolError(error);
            }
        },
    }));
}
