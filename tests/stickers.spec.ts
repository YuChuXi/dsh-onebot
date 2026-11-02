/**
 * 表情包工具族测试：收藏表情列表 / 发送（收藏、图片、商城）/ 收藏。
 *
 * 装配真实 ChatBridge + 记录型连接桩；媒体下载用替身，不触网。
 * @module dsh-onebot/tests/stickers
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, realpathSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'

import { ChatBridge } from '../src/bridge/index.js'
import { registerTools } from '../src/tools/index.js'

interface ToolLike {
  name: string
  execute: (args: unknown, exec: unknown) => Promise<unknown>
}

const STICKERS = ['https://cdn.example/1.png', 'https://cdn.example/2.gif']

/** 注册 qq_* 工具并装配真实 ChatBridge（连接、媒体下载均为替身）。 */
function makeHarness() {
  const calls: Array<{ action: string; params: Record<string, unknown> }> = []
  const mediaDir = mkdtempSync(join(tmpdir(), 'stickers-test-'))
  const connection = {
    connected: true,
    selfId: '10002',
    call: async (action: string, params: Record<string, unknown>) => {
      calls.push({ action, params })
      if (action === 'fetch_custom_face') return [...STICKERS]
      if (action === 'send_msg') return { message_id: 42 }
      return {}
    },
  }
  const media = { downloadUrl: async () => mediaDir + '/sticker.gif' }
  const ctx = new Context()
  const tools: ToolLike[] = []
  ctx.provide('tools' as never, {
    register: (tool: ToolLike) => {
      tools.push(tool)
      return () => undefined
    },
  } as never)

  const bridge = new ChatBridge({
    ctx,
    connection: connection as never,
    media: media as never,
    transcriber: {} as never,
    agents: {} as never,
    sessions: {} as never,
    agentPresets: undefined as never,
    sessionPersistence: undefined,
    workspaceRegistry: undefined as never,
    agentDefaultModel: undefined,
    defaultModel: undefined,
    config: {
      botQQ: '10002', ignoreSelf: false, requireMention: true,
      sendErrorNotice: true, restrictedMemberPrefix: false,
      outboundIntervalBaseMs: 0, outboundIntervalPerCharMs: 0, outboundIntervalJitterPct: 0,
      mediaDir, maxImageBytes: 1_000_000, maxVoiceBytes: 1_000_000, maxFileBytes: 1_000_000,
      agentPreset: 'standard', workspacePath: mediaDir, maxInboundFileBytes: 0,
    },
    policy: {
      dmPolicy: 'open', groupPolicy: 'open', allowFrom: [], groupAllowFrom: [],
      adminUsers: ['10001'], allowAllUsers: false, requireMention: true,
    },
    log: () => undefined,
  })

  registerTools(ctx, bridge, connection as never, {
    maxImageBytes: 1_000_000,
    maxVoiceBytes: 1_000_000,
    maxFileBytes: 1_000_000,
  })
  const tool = (name: string): ToolLike => {
    const found = tools.find(candidate => candidate.name === name)
    if (found === undefined) throw new Error('tool not registered: ' + name)
    return found
  }
  const sent = (): Record<string, unknown> => {
    const send = calls.find(call => call.action === 'send_msg')
    if (send === undefined) throw new Error('no send_msg recorded')
    return send.params
  }
  const exec = (sessionId: string) => ({ agent: { session: { id: sessionId } }, concludeTurn: () => undefined })

  return { calls, mediaDir, tool, sent, exec }
}

describe('qq_sticker_list', () => {
  it('列出收藏表情：序号与 URL，默认不下载', async () => {
    const h = makeHarness()
    const result = await h.tool('qq_sticker_list').execute({}, {}) as { count: number; faces: Array<Record<string, unknown>> }
    expect(result.count).toBe(2)
    expect(result.faces).toEqual([
      { index: 1, url: STICKERS[0] },
      { index: 2, url: STICKERS[1] },
    ])
    expect(h.calls).toEqual([{ action: 'fetch_custom_face', params: { count: 48 } }])
  })

  it('preview：把前 N 张下载到本机并带路径', async () => {
    const h = makeHarness()
    const result = await h.tool('qq_sticker_list').execute({ preview: 1 }, {}) as { faces: Array<Record<string, unknown>> }
    expect(result.faces[0].path).toBe(h.mediaDir + '/sticker.gif')
    expect(result.faces[1].path).toBeUndefined()
  })
})

describe('qq_send_sticker', () => {
  it('按收藏表情序号发送：image 段带 URL 与 sub_type=1', async () => {
    const h = makeHarness()
    const result = await h.tool('qq_send_sticker').execute({ index: 2, chat_id: 'private:10001' }, h.exec('s')) as { sent: boolean; messageId: string }
    expect(result).toEqual({ sent: true, messageId: '42' })
    expect(h.sent().message).toEqual([{ type: 'image', data: { file: STICKERS[1], sub_type: 1 } }])
    expect(h.calls.some(call => call.action === 'fetch_custom_face')).toBe(true)
  })

  it('发送商城表情：mface 五字段原样重放', async () => {
    const h = makeHarness()
    const mface = { summary: '[表情]', emoji_id: '1', emoji_package_id: 2, key: 'k', url: 'https://cdn.example/m.gif' }
    await h.tool('qq_send_sticker').execute({ mface, chat_id: 'private:10001' }, h.exec('s'))
    expect(h.sent().message).toEqual([{ type: 'mface', data: mface }])
  })

  it('mface 缺字段时拒绝，不发请求', async () => {
    const h = makeHarness()
    await expect(h.tool('qq_send_sticker').execute({
      mface: { summary: '[表情]', emoji_id: '1' },
      chat_id: 'private:10001',
    }, h.exec('s'))).rejects.toThrow(/mface 缺少/)
    expect(h.calls).toHaveLength(0)
  })

  it('多个来源同时给出时拒绝', async () => {
    const h = makeHarness()
    await expect(h.tool('qq_send_sticker').execute({ index: 1, url: STICKERS[0], chat_id: 'private:10001' }, h.exec('s')))
      .rejects.toThrow(/需要且只能给一个/)
  })

  it('本地图片路径读成 base64 发送（媒体目录内）', async () => {
    const h = makeHarness()
    const file = join(h.mediaDir, 'sticker.png')
    await writeFile(file, 'png-bytes')
    await h.tool('qq_send_sticker').execute({ path: file, chat_id: 'private:10001' }, h.exec('s'))
    expect(h.sent().message).toEqual([{
      type: 'image',
      data: { file: 'base64://' + Buffer.from('png-bytes').toString('base64'), sub_type: 1 },
    }])
  })
})

describe('qq_collect_sticker', () => {
  it('收藏本地图片：add_custom_face 带媒体目录内的规范路径', async () => {
    const h = makeHarness()
    const file = join(h.mediaDir, 'collect.png')
    await writeFile(file, 'png-bytes')
    const result = await h.tool('qq_collect_sticker').execute({ path: file }, h.exec('s')) as { collected: boolean }
    expect(result.collected).toBe(true)
    const call = h.calls.find(item => item.action === 'add_custom_face')
    expect(call?.params).toEqual({ file: join(realpathSync(h.mediaDir), 'collect.png') })
  })

  it('收藏商城表情：下载后带 package_id / emoji_id / is_mark_face', async () => {
    const h = makeHarness()
    await h.tool('qq_collect_sticker').execute({
      mface: { url: 'https://cdn.example/m.gif', emoji_id: '8', emoji_package_id: 9 },
    }, h.exec('s'))
    const call = h.calls.find(item => item.action === 'add_custom_face')
    expect(call?.params).toEqual({
      file: h.mediaDir + '/sticker.gif',
      emoji_id: '8',
      package_id: 9,
      is_mark_face: true,
    })
  })

  it('越界路径拒绝，不发请求', async () => {
    const h = makeHarness()
    await expect(h.tool('qq_collect_sticker').execute({ path: '/etc/passwd' }, h.exec('s')))
      .rejects.toThrow(/不在允许的媒体目录内/)
    expect(h.calls).toHaveLength(0)
  })
})

describe('表情 API 白名单', () => {
  it('fetch_custom_face / add_custom_face 可直通', async () => {
    const h = makeHarness()
    await h.tool('qq_napcat_api').execute({ action: 'fetch_custom_face', params: { count: 1 } }, {})
    await h.tool('qq_napcat_api').execute({ action: 'add_custom_face', params: { file: '/tmp/a.png' } }, {})
    expect(h.calls.map(call => call.action)).toEqual(['fetch_custom_face', 'add_custom_face'])
  })
})
