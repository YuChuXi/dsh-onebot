/**
 * 群/私聊定时任务：接口与 dsh 的 schedule_* 工具一致（同一套规则与校验），
 * 唯一差别是绑定目标为 chatId 而不是 sessionId——/new、/session 切换会话后，
 * 到点仍然唤醒同一个群或私聊。
 *
 * 记录持久化在 `<mediaDir>/timers.json`；启动时重新装载，已过期的立即触发，
 * 循环任务只补发最近一次漏掉的触发，然后计算下一次。
 * @module dsh-onebot/timers
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  ScheduleId,
  createAfterScheduleRecord,
  createAtScheduleRecord,
  createCronScheduleRecord,
  createDailyScheduleRecord,
  createEveryScheduleRecord,
  createWeeklyScheduleRecord,
  decodeScheduleRecord,
  isRecurringScheduleRecord,
  resolveRecurringOccurrence,
} from '@deepseek-ai/dsh-schedule'
import type {
  AtInput,
  CronInput,
  DailyInput,
  ScheduleRecord,
  WeeklyInput,
} from '@deepseek-ai/dsh-schedule'

import type { ChatId } from '../chat/index.js'

/** 持久化文件名，位于媒体目录。 */
const TIMER_FILE = 'timers.json'
/** setTimeout 的延迟上限是 32 位有符号整数；更长的等待到点后重新挂载。 */
const MAX_DELAY_MS = 2 ** 31 - 1

/** 定时任务：dsh 的 ScheduleRecord 加上 QQ 的 chatId 绑定。 */
export interface TimerEntry {
  chatId: ChatId
  record: ScheduleRecord
}

/** 创建任务的时间规则，与 dsh `schedule_create` 的六个选择器一一对应。 */
export interface TimerTiming {
  afterSeconds?: number
  at?: AtInput
  everySeconds?: number
  daily?: DailyInput
  weekly?: WeeklyInput
  cron?: CronInput
}

/** 创建或更新的内容字段。 */
export interface TimerContent {
  title: string
  prompt: string
}

/** 定时器依赖。 */
export interface TimerRunnerOptions {
  /** 持久化目录（媒体目录）。 */
  dir: string
  /** 到点投递：唤醒该群/私聊的回合，并附上提醒文本。 */
  deliver(chatId: ChatId, note: string): Promise<void>
  /** 日志。 */
  log?(level: 'info' | 'warn' | 'error' | 'debug', message: string): void
  /** 时钟（测试注入）。 */
  now?(): number
}

/** 计时器在内存中的条目加 setTimeout 句柄。 */
interface ArmedEntry extends TimerEntry {
  handle?: ReturnType<typeof setTimeout>
}

/**
 * 群/私聊定时任务集合。
 */
export class TimerRunner {
  private readonly entries = new Map<string, ArmedEntry>()
  private readonly dir: string
  private readonly deliver: (chatId: ChatId, note: string) => Promise<void>
  private readonly log: (level: 'info' | 'warn' | 'error' | 'debug', message: string) => void
  private readonly now: () => number

  constructor(options: TimerRunnerOptions) {
    this.dir = options.dir
    this.deliver = options.deliver
    this.log = options.log ?? (() => undefined)
    this.now = options.now ?? Date.now
  }

  /**
   * 装载持久化任务；损坏的记录跳过并记 warn，已过期的立即触发。
   *
   * Returns:
   *   Promise<void>: 装载完成。
   *
   * Callers:
   *   - `src/bridge/index.ts:start`。
   */
  async load(): Promise<void> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(this.path(), 'utf8'))
    } catch (error) {
      this.log('debug', 'timers load skipped: ' + (error instanceof Error ? error.message : String(error)))
      return
    }
    if (!Array.isArray(parsed)) return
    for (const raw of parsed as unknown[]) {
      if (raw === null || typeof raw !== 'object') continue
      const { chatId, record } = raw as { chatId?: unknown; record?: unknown }
      if (typeof chatId !== 'string') continue
      try {
        const decoded = decodeScheduleRecord(record)
        this.entries.set(decoded.id, { chatId, record: decoded })
      } catch (error) {
        this.log('warn', 'timer record skipped: ' + (error instanceof Error ? error.message : String(error)))
      }
    }
    for (const entry of this.entries.values()) this.arm(entry)
    if (this.entries.size > 0) this.log('info', 'timers restored: ' + this.entries.size)
  }

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
  async create(chatId: ChatId, content: TimerContent, timing: TimerTiming): Promise<TimerEntry> {
    const id = ScheduleId(randomUUID().slice(0, 8))
    const now = this.now()
    let record: ScheduleRecord
    if (timing.afterSeconds !== undefined) {
      record = createAfterScheduleRecord(id, content.prompt, timing.afterSeconds, now, content.title)
    } else if (timing.at !== undefined) {
      record = createAtScheduleRecord(id, content.prompt, timing.at, now, content.title)
    } else if (timing.everySeconds !== undefined) {
      record = createEveryScheduleRecord(id, content.prompt, timing.everySeconds, now, content.title)
    } else if (timing.daily !== undefined) {
      record = createDailyScheduleRecord(id, content.prompt, timing.daily, now, content.title)
    } else if (timing.weekly !== undefined) {
      record = createWeeklyScheduleRecord(id, content.prompt, timing.weekly, now, content.title)
    } else if (timing.cron !== undefined) {
      record = createCronScheduleRecord(id, content.prompt, timing.cron, now, content.title)
    } else {
      throw new Error('invalid_selector: 需要且只能给一个时间参数')
    }
    const entry: ArmedEntry = { chatId, record }
    this.entries.set(record.id, entry)
    this.arm(entry)
    await this.persist()
    return entry
  }

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
  list(chatId?: ChatId): TimerEntry[] {
    return [...this.entries.values()]
      .filter(entry => chatId === undefined || entry.chatId === chatId)
      .sort((a, b) => Date.parse(a.record.scheduledAt) - Date.parse(b.record.scheduledAt))
  }

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
  async remove(chatId: ChatId, id: string): Promise<boolean> {
    const entry = this.entries.get(id)
    if (entry === undefined || entry.chatId !== chatId) return false
    this.drop(entry)
    await this.persist()
    return true
  }

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
  async update(
    chatId: ChatId,
    id: string,
    content: Partial<TimerContent>,
    timing: TimerTiming,
  ): Promise<TimerEntry | undefined> {
    const entry = this.entries.get(id)
    if (entry === undefined || entry.chatId !== chatId) return undefined
    const previous = entry.record
    const title = content.title ?? previous.title
    const prompt = content.prompt ?? previous.prompt
    const now = this.now()
    let record: ScheduleRecord
    if (timing.at !== undefined) {
      record = createAtScheduleRecord(previous.id, prompt, timing.at, now, title)
    } else if (timing.everySeconds !== undefined) {
      record = createEveryScheduleRecord(previous.id, prompt, timing.everySeconds, now, title)
    } else if (timing.daily !== undefined) {
      record = createDailyScheduleRecord(previous.id, prompt, timing.daily, now, title)
    } else if (timing.weekly !== undefined) {
      record = createWeeklyScheduleRecord(previous.id, prompt, timing.weekly, now, title)
    } else if (timing.cron !== undefined) {
      record = createCronScheduleRecord(previous.id, prompt, timing.cron, now, title)
    } else if (content.title !== undefined || content.prompt !== undefined) {
      record = { ...previous, title, prompt }
    } else {
      throw new Error('invalid_rule: 更新需要新的 title、prompt 或一个时间参数')
    }
    if (record.scheduledAt !== previous.scheduledAt && Date.parse(record.scheduledAt) <= now) {
      throw new Error('not_future: 新的时间必须晚于当前时间')
    }
    entry.record = record
    this.arm(entry)
    await this.persist()
    return entry
  }

  /**
   * 停止所有内存句柄；持久化副本保留给下次启动。
   *
   * Callers:
   *   - `src/bridge/index.ts:stop`。
   */
  stop(): void {
    for (const entry of this.entries.values()) {
      if (entry.handle !== undefined) clearTimeout(entry.handle)
      entry.handle = undefined
    }
  }

  /** 持久化文件路径。 */
  private path(): string {
    return join(this.dir, TIMER_FILE)
  }

  /**
   * 挂载 setTimeout；超过 32 位上限时先短睡再重新挂载。
   *
   * Args:
   *   entry (ArmedEntry): 任务条目。
   *
   * Callers:
   *   - `load`、`create`、`update`。
   */
  private arm(entry: ArmedEntry): void {
    if (entry.handle !== undefined) clearTimeout(entry.handle)
    const target = Date.parse(entry.record.scheduledAt)
    const delay = Number.isFinite(target) ? Math.max(0, target - this.now()) : MAX_DELAY_MS
    entry.handle = setTimeout(() => {
      entry.handle = undefined
      if (this.now() < target) {
        this.arm(entry)
        return
      }
      void this.fire(entry.record.id)
    }, Math.min(delay, MAX_DELAY_MS))
    entry.handle.unref?.()
  }

  /**
   * 到点：一次性任务先移除、循环任务先推进到下一次，持久化后再唤醒会话。
   *
   * Args:
   *   id (string): 任务 id。
   *
   * Callers:
   *   - `arm` 的到点回调。
   */
  private async fire(id: string): Promise<void> {
    const entry = this.entries.get(id)
    if (entry === undefined) return
    const now = this.now()
    let next: ArmedEntry | undefined
    if (isRecurringScheduleRecord(entry.record)) {
      const decision = resolveRecurringOccurrence(entry.record, now)
      if (decision.nextScheduledAt !== undefined) {
        next = { chatId: entry.chatId, record: { ...entry.record, scheduledAt: decision.nextScheduledAt } }
        this.entries.set(id, next)
      } else {
        this.entries.delete(id)
      }
    } else {
      this.entries.delete(id)
    }
    await this.persist()
    try {
      await this.deliver(entry.chatId, entry.record.prompt)
      this.log('info', 'timer fired for ' + entry.chatId + ': ' + entry.record.title)
    } catch (error) {
      this.log('warn', 'timer delivery failed for ' + entry.chatId + ': ' + (error instanceof Error ? error.message : String(error)))
    }
    if (next !== undefined) this.arm(next)
  }

  /** 从索引与句柄中移除一条任务。 */
  private drop(entry: ArmedEntry): void {
    if (entry.handle !== undefined) clearTimeout(entry.handle)
    this.entries.delete(entry.record.id)
  }

  /**
   * 把当前任务列表写入磁盘。
   *
   * Callers:
   *   - `load` 后的变更路径：`create`、`update`、`remove`、`fire`。
   */
  private async persist(): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true })
      const payload = [...this.entries.values()].map(entry => ({ chatId: entry.chatId, record: entry.record }))
      await writeFile(this.path(), JSON.stringify(payload, null, 2), 'utf8')
    } catch (error) {
      this.log('warn', 'timer persist failed: ' + (error instanceof Error ? error.message : String(error)))
    }
  }
}
