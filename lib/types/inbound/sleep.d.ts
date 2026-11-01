/**
 * 每日休眠窗口：一个全局墙钟区间，期间机器人不回答任何消息。
 *
 * 窗口每天在固定时区（Asia/Shanghai）重复：宿主自身时区不得决定机器人何时睡觉。
 * 窗口可以跨午夜（`23:30`–`08:00`）：start > end 表示跨越，02:00 在内、12:00 在外。
 * 本模块只回答「在不在窗口内」与「这是哪一个窗口实例」，闸门与「该睡了」的提示在入站管线。
 * @module dsh-onebot/sleep
 */
/** 所有休眠窗口的求值时区。 */
export declare const SLEEP_TIME_ZONE = "Asia/Shanghai";
/**
 * 把 `HH:MM` 解析成当日分钟数。
 *
 * Args:
 *   text (string): 配置里的时钟文本。
 *
 * Returns:
 *   number | undefined: 0–1439；格式非法返回 undefined。
 *
 * Callers:
 *   - `sleepRange`。
 */
export declare function clockMinutes(text: string): number | undefined;
/**
 * 解析配置的窗口；禁用或格式非法时返回 undefined。
 * 两端都必须可解析且不相等：零长度区间是「关」，不是「一直睡」。
 *
 * Args:
 *   startText (string): 窗口起点（HH:MM）。
 *   endText (string): 窗口终点（HH:MM）。
 *
 * Returns:
 *   { start: number; end: number } | undefined: 分钟区间。
 *
 * Callers:
 *   - `isSleeping`、`sleepWindowKey`。
 */
export declare function sleepRange(startText: string, endText: string): {
    start: number;
    end: number;
} | undefined;
/**
 * 判断某个时刻是否落在窗口内（按休眠时区）。
 *
 * Args:
 *   startText (string): 窗口起点；空/非法 = 禁用。
 *   endText (string): 窗口终点；空/非法 = 禁用。
 *   at (number): 待判断时刻。
 *
 * Returns:
 *   boolean: 是否在窗口内。
 *
 * Callers:
 *   - `src/inbound/index.ts:InboundPipeline.sleeping`。
 */
export declare function isSleeping(startText: string, endText: string, at?: number): boolean;
/**
 * 某个时刻所属窗口实例的标识——让「睡着了」的提示每聊天每夜只有一次。
 *
 * Args:
 *   startText (string): 窗口起点。
 *   endText (string): 窗口终点。
 *   at (number): 待判断时刻。
 *
 * Returns:
 *   string: 例如 `2026-10-25T02:00`；未配置窗口时返回 ''。
 *
 * Callers:
 *   - `dormancyKey`。
 */
export declare function sleepWindowKey(startText: string, endText: string, at?: number): string;
/**
 * 判断某个时刻是否处于高峰时段：周一至周五 9:00–12:00、14:00–18:00（休眠时区）。
 * 周末永远不是高峰。
 *
 * Args:
 *   at (number): 待判断时刻。
 *
 * Returns:
 *   boolean: 是否高峰。
 *
 * Callers:
 *   - `sleepingNow`、`dormancyKey`。
 */
export declare function isPeakTime(at?: number): boolean;
/** 休眠判定只需要这三个配置键。 */
export interface SleepConfig {
    sleepMode?: string;
    sleepStart?: string;
    sleepEnd?: string;
}
/**
 * 当前是否休眠（两种模式任一）。
 *
 * Args:
 *   config (SleepConfig): 休眠配置。
 *   at (number): 待判断时刻。
 *
 * Returns:
 *   boolean: 是否休眠。
 *
 * Callers:
 *   - `src/inbound/index.ts:InboundPipeline.sleeping`。
 */
export declare function sleepingNow(config: SleepConfig | undefined, at?: number): boolean;
/**
 * 某个时刻所属休眠段落的标识——让「睡着了」的提示每聊天每段只有一次。
 * 高峰模式按当日 09:00 / 14:00 起算；窗口模式按窗口起点。
 *
 * Args:
 *   config (SleepConfig): 休眠配置。
 *   at (number): 待判断时刻。
 *
 * Returns:
 *   string: 段落标识；未休眠时返回 ''。
 *
 * Callers:
 *   - `src/inbound/index.ts:InboundPipeline.sleepTurn`。
 */
export declare function dormancyKey(config: SleepConfig | undefined, at?: number): string;
