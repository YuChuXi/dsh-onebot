/**
 * 定时任务：绑定 chatId（群/私聊）、六个时间选择器、循环推进与持久化。
 * @module dsh-onebot/tests/schedule
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { TimerRunner } from '../src/timers/index.js'

const dirs: string[] = []

/** 临时媒体目录。 */
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-timers-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('TimerRunner', () => {
  it('fires a one-shot timer into the chat that created it', async () => {
    const dir = await tempDir()
    const delivered: Array<{ chatId: string; note: string }> = []
    const runner = new TimerRunner({ dir, deliver: async (chatId, note) => { delivered.push({ chatId, note }) } })
    const entry = await runner.create('group:888', { title: '喝水提醒', prompt: '喝水' }, { afterSeconds: 1 })
    expect(entry.chatId).toBe('group:888')
    expect(runner.list('private:10001')).toEqual([])
    expect(runner.list('group:888')).toHaveLength(1)
    await vi.waitFor(() => expect(delivered).toEqual([{ chatId: 'group:888', note: '喝水' }]), { timeout: 4000 })
    expect(runner.list('group:888')).toEqual([])
    runner.stop()
  })

  it('scopes delete/update to the owning chat', async () => {
    const dir = await tempDir()
    const runner = new TimerRunner({ dir, deliver: async () => undefined })
    const entry = await runner.create('group:888', { title: '巡视', prompt: '巡视' }, {
      cron: { expression: '*/30 * * * *', time_zone: 'Asia/Shanghai' },
    })
    expect(await runner.remove('private:10001', entry.record.id)).toBe(false)
    expect(await runner.update('private:10001', entry.record.id, {}, {})).toBeUndefined()
    const updated = await runner.update('group:888', entry.record.id, { title: '新名字' }, {})
    expect(updated?.record.title).toBe('新名字')
    expect(updated?.record.id).toBe(entry.record.id)
    expect(await runner.remove('group:888', entry.record.id)).toBe(true)
    runner.stop()
  })

  it('reloads persisted timers and keeps chat binding', async () => {
    const dir = await tempDir()
    const first = new TimerRunner({ dir, deliver: async () => undefined })
    const entry = await first.create('private:10001', { title: '周报', prompt: '写周报' }, {
      weekly: { time: '09:00:00', time_zone: 'Asia/Shanghai', weekdays: [1] },
    })
    first.stop()
    const second = new TimerRunner({ dir, deliver: async () => undefined })
    await second.load()
    expect(second.list('private:10001').map(item => item.record.id)).toEqual([entry.record.id])
    second.stop()
  })
})
