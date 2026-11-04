/**
 * 排队/插话语义回归测试（P1）：任务运行中收到新消息的处理。
 *
 * 语义定案（计划 §P1 + dsh-agent 契约）：
 * - 排队（默认，steerEnabled 未开）：门控后的新消息保持 0.8.1 的 dispatch 路径 ——
 *   agent.followup 的宿主契约是「Queue an ordinary follow-up turn… becomes
 *   the sole ordinary message of its own turn」（runtime-types.d.ts:189-193），
 *   即入队并在当前回合结束后按到达顺序各自成为独立回合；插件不发任何提示。
 * - 插话（steerEnabled=true）：消息经 bridge 单一 steerMessage 写点
 *   （agent.steer + plugin:dsh-onebot source）作为补充指令进当前任务，在最近
 *   step 边界被读取，不新开回合；插件不发任何回执。
 * - 资格：steerAllMembers=false（默认）仅管理员可插话；受限成员是否放行由
 *   steerAllowRestricted 控制（默认放行）。不具备资格的消息走排队行为。
 * - 消息形态不设限：带图/语音/引用的消息在入站管线完成媒体归一化与引用展开
 *   后同样是完整载荷，进入插话路径。
 * - 无运行中任务时全部路径与 0.8.1 逐字节等价（零提示、零 steer）。
 * - /steer 已不是命令：以斜杠开头的未知消息落回模型路径，运行中按插话/排队策略处理。
 * @module dsh-onebot/tests/steer-queue
 */
import { describe, expect, it, vi } from 'vitest'

import { makeCmdHarness, sentTexts } from './helpers/bridge-harness.js'

/** 把指定 chat 的假 agent 置于运行态（真实宿主中由回合驱动自动切换）。 */
function setRunning(h: Awaited<ReturnType<typeof makeCmdHarness>>, chatId = 'private:10001'): void {
  const chat = h.chats().get(chatId)
  expect(chat, 'chat 未创建').toBeDefined()
  chat!.agent.status = 'running'
}

describe('排队（默认，steerEnabled 未开）', () => {
  it('运行回合中收到 2 条新消息：按序入队 dispatch、零 steer、零出站提示', async () => {
    const h = await makeCmdHarness() // 不传 steerEnabled = 缺省排队
    h.sendText('启动任务')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    setRunning(h)

    h.sendText('排队消息一')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    h.sendText('排队消息二')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(3))

    // 按到达顺序入队（宿主契约：各成下一回合，当前回合结束后按序执行）
    const texts = h.captured.followups.map(f => f.text)
    expect(texts[1]).toContain('排队消息一')
    expect(texts[2]).toContain('排队消息二')
    expect(h.captured.steers).toHaveLength(0)
    expect(sentTexts(h.outbound)).toHaveLength(0)

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)
})

describe('插话（steerEnabled=true）', () => {
  it('运行回合中的消息经 agent.steer 补充进当前任务：不新开回合、无出站提示', async () => {
    const h = await makeCmdHarness({ steerEnabled: true })
    h.sendText('启动任务')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    setRunning(h)

    h.sendText('补充指令 A')
    await vi.waitFor(() => expect(h.captured.steers).toHaveLength(1))
    // 补充指令文本进入 steer，且保留记录载荷的数据边界（注入安全面）
    expect(h.captured.steers[0].text).toContain('补充指令 A')
    expect((JSON.parse(h.captured.steers[0].text) as Array<Record<string, unknown>>)[0])
      .toMatchObject({ qq: '10001', nickname: '小明' })
    // 不新开回合：followup 只有一条（最初的任务消息）
    expect(h.captured.followups).toHaveLength(1)

    h.sendText('补充指令 B')
    await vi.waitFor(() => expect(h.captured.steers).toHaveLength(2))
    expect(h.captured.steers[1].text).toContain('补充指令 B')
    expect(sentTexts(h.outbound)).toHaveLength(0)

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)

  it('无运行中任务时与 0.8.1 逐字节等价：直接 dispatch、零 steer、零提示', async () => {
    const h = await makeCmdHarness({ steerEnabled: true })
    h.sendText('普通消息')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    expect(h.captured.followups[0].text).toContain('普通消息')
    expect(h.captured.steers).toHaveLength(0)
    expect(sentTexts(h.outbound)).toHaveLength(0)

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)

  it('带引用的消息同样插话：引用展开照常进入载荷', async () => {
    const h = await makeCmdHarness({ steerEnabled: true })
    h.sendText('启动任务')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    setRunning(h)

    h.client.send(JSON.stringify({
      post_type: 'message', message_type: 'private', user_id: 10001, self_id: 10002,
      message: [{ type: 'reply', data: { id: '7' } }, { type: 'text', data: { text: '针对引用的补充' } }],
      raw_message: '[CQ:reply,id=7]针对引用的补充',
      sender: { user_id: 10001, nickname: '小明' },
    }))
    await vi.waitFor(() => expect(h.captured.steers).toHaveLength(1))
    expect(h.captured.steers[0].text).toContain('针对引用的补充')
    expect(h.captured.followups).toHaveLength(1)
    expect(sentTexts(h.outbound)).toHaveLength(0)

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)

  it('图片消息同样插话：媒体管线完成归一化后整条载荷进 steer', async () => {
    const h = await makeCmdHarness({ steerEnabled: true })
    h.sendText('启动任务')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    setRunning(h)

    h.client.send(JSON.stringify({
      post_type: 'message', message_type: 'private', user_id: 10001, self_id: 10002,
      message: [{ type: 'image', data: { file: 'abc.image' } }],
      raw_message: '[CQ:image,file=abc.image]',
      sender: { user_id: 10001, nickname: '小明' },
    }))
    await vi.waitFor(() => expect(h.captured.steers).toHaveLength(1))
    // 媒体段原样进入载荷：取到字节是带路径的 image 段，取不到是明确的说明文本。
    expect(JSON.stringify((JSON.parse(h.captured.steers[0].text) as Array<{ message: unknown }>)[0].message))
      .toMatch(/image|未取到/)
    expect(h.captured.followups).toHaveLength(1)

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)
})

describe('插话资格（steerAllMembers / steerAllowRestricted）', () => {
  it('缺省仅管理员：普通群成员的消息不自动插话，按排队处理', async () => {
    const h = await makeCmdHarness({ steerEnabled: true })
    h.sendGroupTextAs('启动群任务', 10001) // 管理员开任务
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    setRunning(h, 'group:888')

    h.sendGroupTextAs('普通成员的补充', 20003)
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    expect(h.captured.steers).toHaveLength(0)
    expect(h.captured.followups[1].text).toContain('普通成员的补充')
    expect(sentTexts(h.outbound)).toHaveLength(0)

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)

  it('steerAllMembers=true：普通群成员放行自动插话', async () => {
    const h = await makeCmdHarness({ steerEnabled: true, steerAllMembers: true })
    h.sendGroupTextAs('启动群任务', 10001)
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    setRunning(h, 'group:888')

    h.sendGroupTextAs('普通成员的补充', 20003)
    await vi.waitFor(() => expect(h.captured.steers).toHaveLength(1))
    expect(h.captured.steers[0].text).toContain('普通成员的补充')
    expect((JSON.parse(h.captured.steers[0].text) as Array<Record<string, unknown>>)[0]).toMatchObject({ qq: '20003' })
    expect(h.captured.followups).toHaveLength(1) // 不新开回合
    expect(sentTexts(h.outbound)).toHaveLength(0)

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)

  it('受限成员默认放行：steerAllowRestricted 缺省下受限群成员消息也插话', async () => {
    const h = await makeCmdHarness({ steerEnabled: true, steerAllMembers: true, restrictedMemberPrefix: true })
    h.sendGroupTextAs('启动群任务', 10001)
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    setRunning(h, 'group:888')

    h.sendGroupTextAs('受限成员的补充', 20003)
    await vi.waitFor(() => expect(h.captured.steers).toHaveLength(1))
    // 受限身份不在文本里伪造：记录只有 qq/nickname 等数据字段，没有 admin role。
    expect((JSON.parse(h.captured.steers[0].text) as Array<Record<string, unknown>>)[0]).not.toHaveProperty('role')
    expect(h.captured.steers[0].text).toContain('受限成员的补充')
    expect(h.captured.followups).toHaveLength(1)
    expect(sentTexts(h.outbound)).toHaveLength(0)

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)

  it('steerAllowRestricted=false：受限成员一律排队、零 steer、零提示', async () => {
    const h = await makeCmdHarness({ steerEnabled: true, steerAllMembers: true, steerAllowRestricted: false, restrictedMemberPrefix: true })
    h.sendGroupTextAs('启动群任务', 10001)
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    setRunning(h, 'group:888')

    h.sendGroupTextAs('受限成员的补充', 20003)
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    expect(h.captured.steers).toHaveLength(0)
    expect(h.captured.followups[1].text).toContain('受限成员的补充')
    expect(sentTexts(h.outbound)).toHaveLength(0)

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)
})

describe('/steer 已不是命令', () => {
  it('运行中发送 /steer 落到普通消息路径：按插话策略提交', async () => {
    const h = await makeCmdHarness({ steerEnabled: true })
    h.sendText('启动任务')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    setRunning(h)

    h.sendText('/steer 看看进度')
    await vi.waitFor(() => expect(h.captured.steers).toHaveLength(1))
    expect(h.captured.steers[0].text).toContain('/steer 看看进度')
    expect(h.captured.followups).toHaveLength(1)
    expect(sentTexts(h.outbound).some(t => t.includes('未知命令'))).toBe(false)

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)
})
