/**
 * 群/私聊定时任务：接口与 dsh 的 schedule_* 工具一致（同一套规则与校验），
 * 唯一差别是绑定目标为 chatId 而不是 sessionId——/new、/session 切换会话后，
 * 到点仍然唤醒同一个群或私聊。
 *
 * 记录持久化在 `<mediaDir>/timers.json`；启动时重新装载，已过期的立即触发，
 * 循环任务只补发最近一次漏掉的触发，然后计算下一次。
 * @module dsh-onebot/timers
 */
import type { AtInput, CronInput, DailyInput, ScheduleRecord, WeeklyInput } from '@deepseek-ai/dsh-schedule';
import type { ChatId } from '../chat/index.js';
/** 定时任务：dsh 的 ScheduleRecord 加上 QQ 的 chatId 绑定。 */
export interface TimerEntry {
    chatId: ChatId;
    record: ScheduleRecord;
}
/** 创建任务的时间规则，与 dsh `schedule_create` 的六个选择器一一对应。 */
export interface TimerTiming {
    afterSeconds?: number;
    at?: AtInput;
    everySeconds?: number;
    daily?: DailyInput;
    weekly?: WeeklyInput;
    cron?: CronInput;
}
/** 创建或更新的内容字段。 */
export interface TimerContent {
    title: string;
    prompt: string;
}
/** 定时器依赖。 */
export interface TimerRunnerOptions {
    /** 持久化目录（媒体目录）。 */
    dir: string;
    /** 到点投递：唤醒该群/私聊的回合，并附上提醒文本。 */
    deliver(chatId: ChatId, note: string): Promise<void>;
    /** 日志。 */
    log?(level: 'info' | 'warn' | 'error' | 'debug', message: string): void;
    /** 时钟（测试注入）。 */
    now?(): number;
}
/**
 * 群/私聊定时任务集合。
 */
export declare class TimerRunner {
    private readonly entries;
    private readonly dir;
    private readonly deliver;
    private readonly log;
    private readonly now;
    constructor(options: TimerRunnerOptions);
    /**
     * 装载持久化任务；损坏的记录跳过并记 warn，已过期的立即触发。
     *
     * Returns:
     *   Promise<void>: 装载完成。
     *
     * Callers:
     *   - `src/bridge/index.ts:start`。
     */
    load(): Promise<void>;
    /**
     * 创建一条任务。
     *
     * Args:
     *   chatId (ChatId): 绑定的群或私聊。
     *   content (TimerContent): 标题与提醒内容。
     *   timing (TimerTiming): 六个时间选择器中恰好一个。
     *
     * Returns:
     *   Promise<TimerEntry>: 已挂载并持久化的任务。
     *
     * Callers:
     *   - `src/tools/schedule.ts` 的 qq_create_schedule。
     */
    create(chatId: ChatId, content: TimerContent, timing: TimerTiming): Promise<TimerEntry>;
    /**
     * 列出任务，按下次触发时间升序。
     *
     * Args:
     *   chatId (ChatId | undefined): 只列该群/私聊；省略则列全部。
     *
     * Returns:
     *   TimerEntry[]: 任务列表。
     *
     * Callers:
     *   - `src/tools/schedule.ts` 的 qq_list_schedules。
     */
    list(chatId?: ChatId): TimerEntry[];
    /**
     * 删除一条任务。
     *
     * Args:
     *   chatId (ChatId): 任务所属群/私聊。
     *   id (string): 任务 id。
     *
     * Returns:
     *   Promise<boolean>: false 表示该会话下没有这个 id。
     *
     * Callers:
     *   - `src/tools/schedule.ts` 的 qq_delete_schedule。
     */
    remove(chatId: ChatId, id: string): Promise<boolean>;
    /**
     * 原地更新任务：保留 id，未给出的字段沿用存储值。
     *
     * Args:
     *   chatId (ChatId): 任务所属群/私聊。
     *   id (string): 任务 id。
     *   content (Partial<TimerContent>): 新的标题或提醒内容。
     *   timing (TimerTiming): 至多一个时间选择器；after_seconds 不能用于更新。
     *
     * Returns:
     *   Promise<TimerEntry | undefined>: 更新后的任务；不属于该会话时 undefined。
     *
     * Callers:
     *   - `src/tools/schedule.ts` 的 qq_update_schedule。
     */
    update(chatId: ChatId, id: string, content: Partial<TimerContent>, timing: TimerTiming): Promise<TimerEntry | undefined>;
    /**
     * 停止所有内存句柄；持久化副本保留给下次启动。
     *
     * Callers:
     *   - `src/bridge/index.ts:stop`。
     */
    stop(): void;
    /** 持久化文件路径。 */
    private path;
    /**
     * 挂载 setTimeout；超过 32 位上限时先短睡再重新挂载。
     *
     * Args:
     *   entry (ArmedEntry): 任务条目。
     *
     * Callers:
     *   - `load`、`create`、`update`。
     */
    private arm;
    /**
     * 到点：一次性任务先移除、循环任务先推进到下一次，持久化后再唤醒会话。
     *
     * Args:
     *   id (string): 任务 id。
     *
     * Callers:
     *   - `arm` 的到点回调。
     */
    private fire;
    /** 从索引与句柄中移除一条任务。 */
    private drop;
    /**
     * 把当前任务列表写入磁盘。
     *
     * Callers:
     *   - `load` 后的变更路径：`create`、`update`、`remove`、`fire`。
     */
    private persist;
}
