/**
 * 出站管线测试：发送、断线待发队列，以及按字数的发送节流。
 * @module dsh-onebot/tests/outbound
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { OneBotNotConnectedError } from '../src/onebot/connection.js'
import { OutboundPipeline, outboundTextLength } from '../src/outbound/index.js'

import { inboundAndDisconnect, makeEvent, makeHarness, reconnect, sentTexts } from './helpers/bridge-harness.js'

// Test isolation: a test failing mid-way must never leak fake timers.
afterEach(() => {
  vi.useRealTimers()
})

describe('outbound pipeline', () => {
  it('sends a long reply as one plain-text message', async () => {
    const h = await makeHarness()
    h.sendText('hi')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const longText = '这是一段非常长的回复内容，长度远超任何阈值，仍然以纯文本发送。'.repeat(3)
    await h.say(longText)
    await vi.waitFor(() => {
      expect(h.outbound.filter(f => f.action === 'send_msg')).toHaveLength(1)
    })
    const textFrame = h.outbound.find(f => f.action === 'send_msg')!
    const segments = textFrame.params.message as Array<{ type: string; data: { text: string } }>
    expect(segments.filter(s => s.type === 'text').map(s => s.data.text).join('')).toBe(longText)
    expect(h.outbound.some(f => JSON.stringify(f.params).includes('base64://'))).toBe(false)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)

  it('queues queuable sends while disconnected and resends them in order on reconnect', async () => {
    const h = await makeHarness()
    await inboundAndDisconnect(h)
    await h.bridge.sendToChat('private:10001', '最终回复一', { queuable: true })
    await h.bridge.sendToChat('private:10001', '最终回复二', { queuable: true })
    const { client: client2, outbound: outbound2 } = await reconnect(h)
    await vi.waitFor(() => {
      const texts = sentTexts(outbound2)
      expect(texts.some(t => t.includes('最终回复一'))).toBe(true)
      expect(texts.some(t => t.includes('最终回复二'))).toBe(true)
    })
    const texts = sentTexts(outbound2)
    expect(texts.findIndex(t => t.includes('最终回复一'))).toBeLessThan(texts.findIndex(t => t.includes('最终回复二')))
    client2.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('queues error notices while disconnected and resends them in order', async () => {
    const h = await makeHarness()
    const session = await inboundAndDisconnect(h)
    await h.bridge.sendToChat('private:10001', '最终答案', { queuable: true })
    h.ctx.emit('session/event', session as never, makeEvent('turn/end', {
      turn: 1, reason: { kind: 'error', error: { code: 'E_TEST', message: '模型炸了' } },
    }))
    const { client: client2, outbound: outbound2 } = await reconnect(h)
    await vi.waitFor(() => {
      const texts = sentTexts(outbound2)
      expect(texts.some(t => t.includes('最终答案'))).toBe(true)
      expect(texts.some(t => t.includes('运行出错'))).toBe(true)
    })
    const texts = sentTexts(outbound2)
    expect(texts.findIndex(t => t.includes('最终答案'))).toBeLessThan(texts.findIndex(t => t.includes('运行出错')))
    client2.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('caps the per-chat queue at 20 and drops the oldest while disconnected', async () => {
    const h = await makeHarness()
    await inboundAndDisconnect(h)
    for (let i = 1; i <= 21; i++) {
      await h.bridge.sendToChat('private:10001', '最终答案' + i, { queuable: true })
    }
    const { client: client2, outbound: outbound2 } = await reconnect(h)
    await vi.waitFor(() => expect(sentTexts(outbound2).some(t => t.includes('最终答案21"'))).toBe(true))
    await new Promise(resolve => setTimeout(resolve, 200))
    const finals = sentTexts(outbound2).filter(t => t.includes('最终答案'))
    expect(finals).toHaveLength(20)
    expect(finals.some(t => t.includes('最终答案1"'))).toBe(false)
    expect(finals[0].includes('最终答案2"')).toBe(true)
    client2.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('drops queued sends older than the TTL instead of resending them', async () => {
    const h = await makeHarness()
    await inboundAndDisconnect(h)
    await h.bridge.sendToChat('private:10001', '过期回复', { queuable: true })
    const parkedTexts = (): string[] =>
      ((h.bridge as unknown as { outbound: { pendingSends: Map<string, Array<{ text: string }>> } }).outbound)
        .pendingSends.get('private:10001')?.map(item => item.text) ?? []
    await vi.waitFor(() => expect(parkedTexts().some(t => t.includes('过期回复'))).toBe(true))
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      vi.advanceTimersByTime(5 * 60_000 + 1_000)
      const { client: client2, outbound: outbound2 } = await reconnect(h)
      await new Promise(resolve => setTimeout(resolve, 200))
      expect(sentTexts(outbound2).some(t => t.includes('过期回复'))).toBe(false)
      client2.close()
    } finally {
      vi.useRealTimers()
    }
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('sendToChat while disconnected: queuable parks, non-queuable throws', async () => {
    const h = await makeHarness()
    await inboundAndDisconnect(h)
    await expect(h.bridge.sendToChat('private:10001', '排队最终回复', { queuable: true })).resolves.toEqual([])
    await expect(h.bridge.sendToChat('private:10001', '即时回复')).rejects.toThrow(OneBotNotConnectedError)
    const { client: client2, outbound: outbound2 } = await reconnect(h)
    await vi.waitFor(() => {
      expect(sentTexts(outbound2).some(t => t.includes('排队最终回复'))).toBe(true)
    })
    expect(sentTexts(outbound2).some(t => t.includes('即时回复'))).toBe(false)
    client2.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 30_000)
})

describe('outbound pacing (按字数节流)', () => {
  const makePipeline = (config: { base: number; perChar: number; jitter: number }): {
    pipeline: OutboundPipeline
    stamps: number[]
  } => {
    const stamps: number[] = []
    const pipeline = new OutboundPipeline({
      connected: () => true,
      selfId: () => '10002',
      call: async () => {
        stamps.push(Date.now())
        return { message_id: 7 }
      },
      isStopping: () => false,
      log: () => undefined,
      config: {
        botQQ: '10002', maxImageBytes: 8 * 1024 * 1024,
        outboundIntervalBaseMs: config.base,
        outboundIntervalPerCharMs: config.perChar,
        outboundIntervalJitterPct: config.jitter,
      },
    })
    return { pipeline, stamps }
  }

  it('outboundTextLength counts text chars, skips reply, and counts other segments as one', () => {
    expect(outboundTextLength([
      { type: 'reply', data: { id: '1' } },
      { type: 'text', data: { text: '你好啊' } },
      { type: 'image', data: { file: '/a.png' } },
    ])).toBe(4)
  })

  it('waits base + perChar × chars between two sends to the same chat', async () => {
    const { pipeline, stamps } = makePipeline({ base: 50, perChar: 0, jitter: 0 })
    await pipeline.sendSegments('group:888', [{ type: 'text', data: { text: '第一条' } }])
    await pipeline.sendSegments('group:888', [{ type: 'text', data: { text: '第二条' } }])
    expect(stamps).toHaveLength(2)
    expect(stamps[1] - stamps[0]).toBeGreaterThanOrEqual(40)
  })

  it('does not delay the first send of a chat', async () => {
    const { pipeline, stamps } = makePipeline({ base: 5_000, perChar: 0, jitter: 0 })
    const started = Date.now()
    await pipeline.sendSegments('group:888', [{ type: 'text', data: { text: '首条' } }])
    expect(stamps).toHaveLength(1)
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})
