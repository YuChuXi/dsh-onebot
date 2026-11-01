/**
 * STT 非阻塞（M3-D4c）：语音消息先把带本机路径的 `record` 段交给模型，
 * 转写在后台进行；完成后把带标注的转写插进会话（运行中的回合在步骤边界插话，
 * 空闲时开新回合）。失败、超时与空转写都保持 record 段为最终状态。
 * @module dsh-onebot/tests/stt-nonblocking
 */
import { describe, expect, it, vi } from 'vitest'

import { makeHarness } from './helpers/bridge-harness.js'

/** 可控的一次性 promise。 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 载荷末条记录的 message（本轮触发消息）。 */
function lastRecordMessage(payload: string): unknown {
  const records = JSON.parse(payload) as Array<{ message?: unknown }>
  return records[records.length - 1]?.message
}

describe('STT non-blocking (M3-D4c)', () => {
  it('dispatches the record segment first and steers the transcript after it completes', async () => {
    const slow = deferred<string>()
    const steers: Array<{ text: string; sessionId: string }> = []
    const h = await makeHarness({
      transcriber: { enabled: true, transcribe: vi.fn(() => slow.promise) } as never,
    })
    h.captured.steers = steers
    const voiceBase64 = Buffer.from('fake-mp3-bytes').toString('base64')
    h.client.send(JSON.stringify({
      post_type: 'message', message_type: 'private', user_id: 10001, self_id: 10002,
      message: [{ type: 'record', data: { file: 'base64://' + voiceBase64 } }],
      sender: { user_id: 10001, nickname: '小明' },
    }))
    // 转写还在进行时，语音段已经带着本机路径到达模型。
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    expect(lastRecordMessage(h.captured.followups[0].text)).toEqual(
      { type: 'record', data: { file: expect.stringMatching(/\.(mp3|amr|wav|silk)$/) } },
    )
    expect(h.captured.followups[0].text).not.toContain('语音转写')
    expect(steers).toEqual([])

    // 转写完成 → 以标注文本插进同一个会话。
    slow.resolve('好了')
    await vi.waitFor(() => expect(steers).toHaveLength(1))
    expect(steers[0]).toEqual({ text: '（语音转写：好了）', sessionId: h.sessionIds[0] })
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('keeps the record segment as final when the transcription fails (no steer)', async () => {
    const failing = deferred<string>()
    const h = await makeHarness({
      transcriber: { enabled: true, transcribe: vi.fn(() => failing.promise) } as never,
    })
    h.captured.steers = []
    h.client.send(JSON.stringify({
      post_type: 'message', message_type: 'private', user_id: 10001, self_id: 10002,
      message: [{ type: 'record', data: { file: 'base64://' + Buffer.from('fake-mp3-bytes').toString('base64') } }],
      sender: { user_id: 10001, nickname: '小明' },
    }))
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    failing.reject(new Error('boom'))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.captured.followups).toHaveLength(1)
    expect(h.captured.steers).toEqual([])
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('does not steer an empty transcript (silence leaves the record segment)', async () => {
    const silent = deferred<string>()
    const h = await makeHarness({
      transcriber: { enabled: true, transcribe: vi.fn(() => silent.promise) } as never,
    })
    h.captured.steers = []
    h.client.send(JSON.stringify({
      post_type: 'message', message_type: 'private', user_id: 10001, self_id: 10002,
      message: [{ type: 'record', data: { file: 'base64://' + Buffer.from('fake-mp3-bytes').toString('base64') } }],
      sender: { user_id: 10001, nickname: '小明' },
    }))
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    silent.resolve('')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.captured.steers).toEqual([])
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })
})
