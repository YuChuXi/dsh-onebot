/**
 * 每日休眠窗口：一个全局墙钟区间，期间机器人不回答任何消息。
 *
 * 窗口每天在固定时区（Asia/Shanghai）重复：宿主自身时区不得决定机器人何时睡觉。
 * 窗口可以跨午夜（`23:30`–`08:00`）：start > end 表示跨越，02:00 在内、12:00 在外。
 * 本模块只回答「在不在窗口内」与「这是哪一个窗口实例」，闸门与「该睡了」的提示在入站管线。
 * @module dsh-onebot/sleep
 */

/** 所有休眠窗口的求值时区。 */
export const SLEEP_TIME_ZONE = 'Asia/Shanghai'

/** 只构造一次：Intl 构造开销大，而这段代码每条消息都会跑。 */
const CLOCK = new Intl.DateTimeFormat('en-CA', {
  timeZone: SLEEP_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

/**
 * 取一个时刻的墙钟分量（与 locale 无关）。
 *
 * Args:
 *   at (number): 毫秒时间戳。
 *
 * Returns:
 *   Record<string, string>: year/month/day/hour/minute 分量。
 *
 * Callers:
 *   - 本模块的 `sleepWindowKey`、`isPeakTime`、`dormancyKey`、`minutesAt`。
 */
function clockParts(at: number): Record<string, string> {
  const parts: Record<string, string> = {}
  for (const part of CLOCK.formatToParts(new Date(at))) parts[part.type] = part.value
  return parts
}

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
export function clockMinutes(text: string): number | undefined {
  if (typeof text !== 'string') return undefined
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim())
  if (match === null) return undefined
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return undefined
  return hour * 60 + minute
}

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
export function sleepRange(startText: string, endText: string): { start: number; end: number } | undefined {
  const start = clockMinutes(startText)
  const end = clockMinutes(endText)
  if (start === undefined || end === undefined || start === end) return undefined
  return { start, end }
}

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
export function isSleeping(startText: string, endText: string, at: number = Date.now()): boolean {
  const range = sleepRange(startText, endText)
  if (range === undefined) return false
  const minutes = minutesAt(at)
  return range.start < range.end
    ? minutes >= range.start && minutes < range.end
    : minutes >= range.start || minutes < range.end
}

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
export function sleepWindowKey(startText: string, endText: string, at: number = Date.now()): string {
  const range = sleepRange(startText, endText)
  if (range === undefined) return ''
  const parts = clockParts(at)
  const minutes = Number(parts.hour) * 60 + Number(parts.minute)
  const date = parts.year + '-' + parts.month + '-' + parts.day
  // 跨午夜窗口若尚未到达终点，它开始于昨天。
  const startDate = range.start < range.end || minutes >= range.start ? date : previousDate(date)
  const hh = String(Math.floor(range.start / 60)).padStart(2, '0')
  const mm = String(range.start % 60).padStart(2, '0')
  return startDate + 'T' + hh + ':' + mm
}

/** 高峰时段（当日分钟数）：9:00–12:00 与 14:00–18:00。 */
const PEAK_BLOCKS: Array<[number, number]> = [[540, 720], [840, 1080]]

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
export function isPeakTime(at: number = Date.now()): boolean {
  const parts = clockParts(at)
  const weekday = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day))).getUTCDay()
  if (weekday === 0 || weekday === 6) return false
  const minutes = Number(parts.hour) * 60 + Number(parts.minute)
  return PEAK_BLOCKS.some(([from, to]) => minutes >= from && minutes < to)
}

/** 休眠判定只需要这三个配置键。 */
export interface SleepConfig {
  sleepMode?: string
  sleepStart?: string
  sleepEnd?: string
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
export function sleepingNow(config: SleepConfig | undefined, at: number = Date.now()): boolean {
  if (config?.sleepMode === 'peak') return isPeakTime(at)
  return isSleeping(config?.sleepStart ?? '', config?.sleepEnd ?? '', at)
}

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
export function dormancyKey(config: SleepConfig | undefined, at: number = Date.now()): string {
  if (config?.sleepMode !== 'peak') return sleepWindowKey(config?.sleepStart ?? '', config?.sleepEnd ?? '', at)
  if (!isPeakTime(at)) return ''
  const parts = clockParts(at)
  const minutes = Number(parts.hour) * 60 + Number(parts.minute)
  const date = parts.year + '-' + parts.month + '-' + parts.day
  return date + 'T' + (minutes < 720 ? '09:00' : '14:00')
}

/**
 * 某个时刻在休眠时区的墙钟分钟数（0–1439）。
 *
 * Args:
 *   at (number): 毫秒时间戳。
 *
 * Returns:
 *   number: 当日分钟数。
 *
 * Callers:
 *   - `isSleeping`。
 */
function minutesAt(at: number): number {
  const parts = clockParts(at)
  return Number(parts.hour) * 60 + Number(parts.minute)
}

/**
 * `YYYY-MM-DD` 减一天（纯日历运算，不涉及时区）。
 *
 * Args:
 *   dateText (string): 日期文本。
 *
 * Returns:
 *   string: 前一天。
 *
 * Callers:
 *   - `sleepWindowKey`。
 */
function previousDate(dateText: string): string {
  const [year, month, day] = dateText.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day) - 86_400_000)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return String(date.getUTCFullYear()) + '-' + pad(date.getUTCMonth() + 1) + '-' + pad(date.getUTCDate())
}
