/**
 * 表情工具族测试：表情包组织、摘要定位、详细描述检索、整套拼图与批量备注。
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

/** 1x1 PNG。 */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
/** 另一张 1x1 GIF。 */
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

/**
 * 注册 qq_* 工具并装配真实 ChatBridge 与真实本地表情库。
 *
 * Returns:
 *   对象: 工具查询、连接调用、附件记录与执行上下文工厂。
 *
 * Callers:
 *   - 本文件各测试用例。
 */
function makeHarness() {
  const calls: Array<{ action: string; params: Record<string, unknown> }> = []
  const downloads: string[] = []
  const mediaDir = mkdtempSync(join(tmpdir(), 'stickers-test-'))
  const saved: Array<{ data: Uint8Array; mediaType: string; name?: string }> = []
  const connection = {
    connected: true,
    selfId: '10002',
    call: async (action: string, params: Record<string, unknown>) => {
      calls.push({ action, params })
      if (action === 'send_msg') return { message_id: 42 }
      return {}
    },
  }
  const media = {
    downloadUrl: async (url: string, ext: string) => {
      downloads.push(url)
      const path = join(mediaDir, 'download-' + downloads.length + ext)
      await writeFile(path, url.includes('second') ? GIF : PNG)
      return path
    },
  }
  const ctx = new Context()
  const tools: ToolLike[] = []
  ctx.provide('tools' as never, {
    register: (tool: ToolLike) => {
      tools.push(tool)
      return () => undefined
    },
  } as never)
  ctx.provide('attachments' as never, {
    saveImage: async (input: { data: Uint8Array; mediaType: string; name?: string }) => {
      saved.push(input)
      return { attachmentId: 'sheet-1', mediaType: input.mediaType, bytes: input.data.byteLength, width: 960, height: 270, name: input.name }
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
  }, mediaDir)
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
  return { calls, downloads, mediaDir, saved, tool, sent, exec }
}

/**
 * 在媒体目录里放一张图片。
 *
 * Args:
 *   dir (string): 媒体目录。
 *   name (string): 文件名。
 *   data (Buffer): 图片字节。
 *
 * Returns:
 *   Promise<string>: 本机图片路径。
 *
 * Callers:
 *   - 本文件各测试用例。
 */
async function writeImage(dir: string, name: string, data: Buffer = PNG): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, data)
  return path
}

const MFACE = { summary: '[飞天猫猫]', emoji_id: '8', emoji_package_id: '9', key: 'k', url: 'https://cdn.example/m.gif' }
const MFACE_SECOND = { summary: '[带娃]', emoji_id: '10', emoji_package_id: '9', key: 'k2', url: 'https://cdn.example/second.gif' }

describe('qq_collect_sticker', () => {
  it('普通图片进入我的收藏，摘要与详细描述分别保存', async () => {
    const h = makeHarness()
    const file = await writeImage(h.mediaDir, 'collect.png')
    const result = await h.tool('qq_collect_sticker').execute({
      items: [{ path: file, summary: '趴鱼', caption: '一条鱼趴在地上流泪，适合表达委屈' }],
    }, h.exec('s')) as { collected: Array<Record<string, unknown>> }
    expect(result.collected[0]).toMatchObject({
      pack: '我的收藏',
      summary: '趴鱼',
      caption: '一条鱼趴在地上流泪，适合表达委屈',
    })
    expect(result.collected[0].file).toBe(join(realpathSync(h.mediaDir), 'stickers', '我的收藏', '趴鱼.png'))
    expect(h.calls).toEqual([])
  })

  it('普通图片缺摘要或详细描述时整批拒绝', async () => {
    const h = makeHarness()
    const file = await writeImage(h.mediaDir, 'a.png')
    await expect(h.tool('qq_collect_sticker').execute({
      items: [{ path: file, summary: '有摘要', caption: '有描述' }, { path: file, summary: '缺描述' }],
    }, h.exec('s'))).rejects.toThrow(/第 2 项 缺少 caption/)
    const list = await h.tool('qq_list_stickers').execute({}, {}) as { count: number }
    expect(list.count).toBe(0)
  })

  it('整套商城表情使用固有摘要与指定包名，详细描述可后补', async () => {
    const h = makeHarness()
    const result = await h.tool('qq_collect_sticker').execute({
      pack: '柰子鱼3', items: [{ mface: MFACE }, { mface: MFACE_SECOND }],
    }, h.exec('s')) as { collected: Array<Record<string, unknown>> }
    expect(result.collected.map(item => item.summary)).toEqual(['[飞天猫猫]', '[带娃]'])
    expect(result.collected.map(item => item.pack)).toEqual(['柰子鱼3', '柰子鱼3'])
    expect(result.collected.map(item => item.caption)).toEqual(['', ''])
    expect(result.collected[0].mark).toEqual(MFACE)
  })

  it('已认识的商城包按 emoji_package_id 自动复用包名', async () => {
    const h = makeHarness()
    await h.tool('qq_collect_sticker').execute({ pack: '柰子鱼3', items: [{ mface: MFACE }] }, h.exec('s'))
    const result = await h.tool('qq_collect_sticker').execute({ items: [{ mface: MFACE_SECOND }] }, h.exec('s')) as {
      collected: Array<Record<string, unknown>>
    }
    expect(result.collected[0]).toMatchObject({ pack: '柰子鱼3', summary: '[带娃]' })
  })

  it('新商城包缺包名时拒绝', async () => {
    const h = makeHarness()
    await expect(h.tool('qq_collect_sticker').execute({ items: [{ mface: MFACE }] }, h.exec('s')))
      .rejects.toThrow(/新商城表情包必须给 pack/)
  })

  it('同一表情包内同一摘要重复收藏时幂等，保留第一次的图片', async () => {
    const h = makeHarness()
    const first = await writeImage(h.mediaDir, 'a.png')
    const second = await writeImage(h.mediaDir, 'b.gif', GIF)
    const before = await h.tool('qq_collect_sticker').execute({
      items: [{ path: first, summary: '重复', caption: '第一张' }],
    }, h.exec('s')) as { collected: Array<Record<string, unknown>> }
    const after = await h.tool('qq_collect_sticker').execute({
      items: [{ path: second, summary: '重复', caption: '第二张' }],
    }, h.exec('s')) as { collected: Array<Record<string, unknown>> }
    expect(after.collected[0].file).toBe(before.collected[0].file)
    expect(after.collected[0].caption).toBe('第一张')
  })

  it('入站商城表情按落盘元数据自动识别，模型只给 path', async () => {
    const h = makeHarness()
    const file = await writeImage(h.mediaDir, 'inbound.gif', GIF)
    await writeFile(file + '.json', JSON.stringify(MFACE))
    const result = await h.tool('qq_collect_sticker').execute({
      pack: '柰子鱼3', items: [{ path: file }],
    }, h.exec('s')) as { collected: Array<Record<string, unknown>> }
    expect(result.collected[0]).toMatchObject({ pack: '柰子鱼3', summary: '[飞天猫猫]', mark: MFACE })
  })

  it('入站商城表情带已落盘文件收藏：不重新下载，保留五字段', async () => {
    const h = makeHarness()
    const file = await writeImage(h.mediaDir, 'inbound.gif', GIF)
    const result = await h.tool('qq_collect_sticker').execute({
      pack: '柰子鱼3', items: [{ mface: MFACE, path: file }],
    }, h.exec('s')) as { collected: Array<Record<string, unknown>> }
    expect(result.collected[0]).toMatchObject({ pack: '柰子鱼3', summary: '[飞天猫猫]', mark: MFACE })
    expect(h.downloads).toEqual([])
  })

  it('同一张图用不同摘要收藏时各存一份', async () => {
    const h = makeHarness()
    const file = await writeImage(h.mediaDir, 'a.png')
    await h.tool('qq_collect_sticker').execute({ items: [{ path: file, summary: '开心', caption: '第一次' }] }, h.exec('s'))
    await h.tool('qq_collect_sticker').execute({ items: [{ path: file, summary: '高兴', caption: '第二次' }] }, h.exec('s'))
    const list = await h.tool('qq_list_stickers').execute({}, {}) as { faces: Array<Record<string, unknown>> }
    expect(list.faces.map(face => face.summary)).toEqual(['开心', '高兴'])
  })

  it('越界路径拒绝，不写库', async () => {
    const h = makeHarness()
    await expect(h.tool('qq_collect_sticker').execute({ items: [{ path: '/etc/passwd', summary: '越界', caption: 'x' }] }, h.exec('s')))
      .rejects.toThrow(/不在允许的媒体目录内/)
    const list = await h.tool('qq_list_stickers').execute({}, {}) as { count: number }
    expect(list.count).toBe(0)
  })
})

describe('qq_list_stickers', () => {
  it('按包筛选并按详细描述检索', async () => {
    const h = makeHarness()
    const file = await writeImage(h.mediaDir, 'a.png')
    await h.tool('qq_collect_sticker').execute({
      items: [{ path: file, summary: '趴鱼', caption: 'Fish crying on the floor' }],
    }, h.exec('s'))
    const result = await h.tool('qq_list_stickers').execute({ pack: '我的收藏', query: 'fish' }, {}) as {
      count: number; faces: Array<Record<string, unknown>>
    }
    expect(result.count).toBe(1)
    expect(result.faces[0]).toMatchObject({ pack: '我的收藏', summary: '趴鱼', caption: 'Fish crying on the floor' })
  })

  it('整套预览只生成一张 PNG 拼图', async () => {
    const h = makeHarness()
    await h.tool('qq_collect_sticker').execute({ pack: '柰子鱼3', items: [{ mface: MFACE }, { mface: MFACE_SECOND }] }, h.exec('s'))
    const result = await h.tool('qq_list_stickers').execute({ pack: '柰子鱼3', preview: true }, {}) as {
      faces: unknown[]; attachment: Record<string, unknown>
    }
    expect(result.faces).toHaveLength(2)
    expect(result.attachment).toMatchObject({ attachmentId: 'sheet-1', mediaType: 'image/png', name: '柰子鱼3预览.png' })
    expect(h.saved).toHaveLength(1)
    expect(h.saved[0].data.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  })
})

describe('qq_remark_sticker', () => {
  it('整套批量补写详细描述并保留各自摘要', async () => {
    const h = makeHarness()
    await h.tool('qq_collect_sticker').execute({ pack: '柰子鱼3', items: [{ mface: MFACE }, { mface: MFACE_SECOND }] }, h.exec('s'))
    await h.tool('qq_remark_sticker').execute({ items: [
      { pack: '柰子鱼3', summary: '[飞天猫猫]', caption: '角色被蓝色尾巴带着飞起，开心大笑' },
      { pack: '柰子鱼3', summary: '[带娃]', caption: '大角色头顶小角色，周围有黄色星星' },
    ] }, {})
    const list = await h.tool('qq_list_stickers').execute({ pack: '柰子鱼3' }, {}) as { faces: Array<Record<string, unknown>> }
    expect(list.faces.map(face => face.caption)).toEqual([
      '角色被蓝色尾巴带着飞起，开心大笑', '大角色头顶小角色，周围有黄色星星',
    ])
    expect(list.faces.map(face => face.summary)).toEqual(['[飞天猫猫]', '[带娃]'])
  })

  it('可按 pack+summary 改名并保留详细描述', async () => {
    const h = makeHarness()
    await h.tool('qq_collect_sticker').execute({ pack: '柰子鱼3', items: [{ mface: MFACE, caption: '在飞' }] }, h.exec('s'))
    await h.tool('qq_remark_sticker').execute({ items: [
      { pack: '柰子鱼3', summary: '[飞天猫猫]', newSummary: '[飞天猫]' },
    ] }, {})
    const list = await h.tool('qq_list_stickers').execute({ pack: '柰子鱼3' }, {}) as { faces: Array<Record<string, unknown>> }
    expect(list.faces[0]).toMatchObject({ summary: '[飞天猫]', caption: '在飞' })
  })

  it('批量修改产生重复摘要时整批拒绝', async () => {
    const h = makeHarness()
    await h.tool('qq_collect_sticker').execute({ pack: '柰子鱼3', items: [{ mface: MFACE }, { mface: MFACE_SECOND }] }, h.exec('s'))
    await expect(h.tool('qq_remark_sticker').execute({ items: [
      { pack: '柰子鱼3', summary: '[飞天猫猫]', newSummary: '相同' },
      { pack: '柰子鱼3', summary: '[带娃]', newSummary: '相同' },
    ] }, {})).rejects.toThrow(/已有摘要/)
    const list = await h.tool('qq_list_stickers').execute({}, {}) as { faces: Array<Record<string, unknown>> }
    expect(list.faces.map(face => face.summary)).toEqual(['[飞天猫猫]', '[带娃]'])
  })

  it('摘要不存在时拒绝', async () => {
    const h = makeHarness()
    await h.tool('qq_collect_sticker').execute({ pack: '柰子鱼3', items: [{ mface: MFACE }] }, h.exec('s'))
    await expect(h.tool('qq_remark_sticker').execute({ items: [
      { pack: '柰子鱼3', summary: '不存在', caption: 'x' },
    ] }, {})).rejects.toThrow(/没有摘要/)
  })
})

describe('qq_send_sticker', () => {
  it('按表情包加摘要发送普通图片', async () => {
    const h = makeHarness()
    const file = await writeImage(h.mediaDir, 'a.png')
    await h.tool('qq_collect_sticker').execute({ items: [{ path: file, summary: '趴鱼', caption: '很长的详细描述' }] }, h.exec('s'))
    await h.tool('qq_send_sticker').execute({ pack: '我的收藏', summary: '趴鱼', chat_id: 'private:10001' }, h.exec('s'))
    expect(h.sent().message).toEqual([{ type: 'image', data: { file: 'base64://' + PNG.toString('base64'), sub_type: 1 } }])
  })

  it('详细描述不是发送定位字段', async () => {
    const h = makeHarness()
    const file = await writeImage(h.mediaDir, 'a.png')
    await h.tool('qq_collect_sticker').execute({ items: [{ path: file, summary: '趴鱼', caption: '很长的详细描述' }] }, h.exec('s'))
    await expect(h.tool('qq_send_sticker').execute({ summary: '很长的详细描述', chat_id: 'private:10001' }, h.exec('s')))
      .rejects.toThrow(/没有摘要/)
  })

  it('同摘要跨包存在时要求给表情包', async () => {
    const h = makeHarness()
    const file = await writeImage(h.mediaDir, 'a.png')
    await h.tool('qq_collect_sticker').execute({ pack: '甲', items: [{ path: file, summary: '开心', caption: '甲包' }] }, h.exec('s'))
    await h.tool('qq_collect_sticker').execute({ pack: '乙', items: [{ path: file, summary: '开心', caption: '乙包' }] }, h.exec('s'))
    await expect(h.tool('qq_send_sticker').execute({ summary: '开心', chat_id: 'private:10001' }, h.exec('s')))
      .rejects.toThrow(/请给 pack：甲、乙/)
  })

  it('按表情包加摘要重放商城五字段', async () => {
    const h = makeHarness()
    await h.tool('qq_collect_sticker').execute({ pack: '柰子鱼3', items: [{ mface: MFACE }] }, h.exec('s'))
    await h.tool('qq_send_sticker').execute({ pack: '柰子鱼3', summary: '[飞天猫猫]', chat_id: 'private:10001' }, h.exec('s'))
    expect(h.sent().message).toEqual([{ type: 'mface', data: MFACE }])
  })

  it('摘要按固有原值精确定位，缺少方括号时不命中', async () => {
    const h = makeHarness()
    await h.tool('qq_collect_sticker').execute({ pack: '柰子鱼3', items: [{ mface: MFACE }] }, h.exec('s'))
    await expect(h.tool('qq_send_sticker').execute({ pack: '柰子鱼3', summary: '飞天猫猫', chat_id: 'private:10001' }, h.exec('s')))
      .rejects.toThrow(/没有摘要/)
  })

  it('按表情包加摘要发送商城表情；省略包名时按全库唯一摘要命中', async () => {
    const h = makeHarness()
    await h.tool('qq_collect_sticker').execute({ pack: '柰子鱼3', items: [{ mface: MFACE }] }, h.exec('s'))
    await h.tool('qq_send_sticker').execute({ summary: '[飞天猫猫]', chat_id: 'private:10001' }, h.exec('s'))
    expect(h.sent().message).toEqual([{ type: 'mface', data: MFACE }])
  })
})

describe('qq_napcat_api 白名单', () => {
  it('get_msg 放行，用于取原始消息段', async () => {
    const h = makeHarness()
    await expect(h.tool('qq_napcat_api').execute({ action: 'get_msg', params: { message_id: 1 } }, {})).resolves.toBeDefined()
  })

  it('QQ 收藏接口不直通', async () => {
    const h = makeHarness()
    await expect(h.tool('qq_napcat_api').execute({ action: 'fetch_custom_face', params: { count: 1 } }, {}))
      .rejects.toThrow(/不在白名单内/)
  })
})
