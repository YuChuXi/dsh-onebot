/**
 * 段模型与消息记录：解析（OneBot 段数组 → 类型化段）、渲染（模型可见形态）、
 * @ 提及判定、记录序列化与休眠窗口。CQ 字符串层已不存在，本文件不再覆盖它。
 * @module dsh-onebot/tests/segments
 */
import { describe, expect, it } from 'vitest'

import { detectMention, fillMentionNames, MEDIA_KINDS, parseMessage, renderMessage, renderSegment } from '../src/onebot/segments.js'
import { formatRecords, messageRecord, renderRecord, systemRecord } from '../src/onebot/records.js'
import { dormancyKey, isSleeping, sleepWindowKey } from '../src/inbound/sleep.js'
import { faceName } from '../src/onebot/faces.js'

describe('parseMessage', () => {
  it('keeps text segments separate and gives every media ref its segment index', () => {
    const parsed = parseMessage([
      { type: 'text', data: { text: '看图 ' } },
      { type: 'image', data: { url: 'https://x/y.png', sub_type: '1' } },
      { type: 'text', data: { text: ' 谢谢' } },
    ])
    expect(parsed.text).toBe('看图  谢谢')
    expect(parsed.segments).toEqual([
      { type: 'text', data: { text: '看图 ' } },
      { type: 'image', data: {} },
      { type: 'text', data: { text: ' 谢谢' } },
    ])
    expect(parsed.media).toEqual([{ kind: 'image', segmentIndex: 1, url: 'https://x/y.png', subType: '1' }])
  })

  it('gives every documented payload type (record/video/file) a media ref', () => {
    const parsed = parseMessage([
      { type: 'record', data: { url: 'https://x/a.mp3' } },
      { type: 'video', data: { file: 'v.mp4' } },
      { type: 'file', data: { file: '报告.pdf', file_id: 'fid-1' } },
    ])
    expect(parsed.media.map(ref => ref.kind)).toEqual(['voice', 'video', 'file'])
    expect(parsed.media[2]).toMatchObject({ fileId: 'fid-1', name: '报告.pdf' })
  })

  it('fills a classic face name from its id and keeps the id', () => {
    expect(parseMessage([{ type: 'face', data: { id: '14' } }]).segments[0])
      .toEqual({ type: 'face', data: { id: '14', name: '微笑' } })
  })

  it('keeps a market sticker (mface) as a sticker ref with its five fields', () => {
    const parsed = parseMessage([{
      type: 'mface',
      data: { summary: '[美味]', url: 'https://gxh.vip/a.gif', emoji_id: 'abc', emoji_package_id: '3', key: 'k' },
    }])
    expect(parsed.segments).toEqual([{
      type: 'mface',
      data: { summary: '[美味]', url: 'https://gxh.vip/a.gif', emoji_id: 'abc', emoji_package_id: '3', key: 'k' },
    }])
    expect(parsed.media[0]).toMatchObject({
      kind: 'sticker',
      segmentIndex: 0,
      url: 'https://gxh.vip/a.gif',
      summary: '[美味]',
      mface: { summary: '[美味]', url: 'https://gxh.vip/a.gif', emoji_id: 'abc', emoji_package_id: '3', key: 'k' },
    })
  })

  it('keeps an mface without a url as a plain five-field segment', () => {
    const parsed = parseMessage([{ type: 'mface', data: { summary: '[x]', url: 'not-a-url' } }])
    expect(parsed.media[0]).toMatchObject({ kind: 'sticker', url: 'not-a-url' })
    expect(parsed.segments[0]).toMatchObject({ type: 'mface', data: { summary: '[x]', url: 'not-a-url' } })
  })

  it('keeps market-sticker fields carried by an image segment', () => {
    const parsed = parseMessage([{
      type: 'image',
      data: {
        summary: '[飞天猫猫]',
        file: 'f6-a.gif',
        url: 'https://gxh.vip/raw300.gif',
        key: 'd9b8f42a008893aa',
        emoji_id: 'f649853bda4e4d1f0e76c535aad2cd4f',
        emoji_package_id: 241895,
      },
    }])
    expect(parsed.media[0]).toMatchObject({
      kind: 'image',
      summary: '[飞天猫猫]',
      mface: {
        summary: '[飞天猫猫]',
        url: 'https://gxh.vip/raw300.gif',
        key: 'd9b8f42a008893aa',
        emoji_id: 'f649853bda4e4d1f0e76c535aad2cd4f',
        emoji_package_id: '241895',
      },
    })
    // 五字段留在引用里供落盘与重放，渲染给模型的段只带文件与摘要。
    const resolved = MEDIA_KINDS.image.resolved(parsed.media[0], 'media/x.gif')
    expect(resolved).toMatchObject({ file: 'media/x.gif', summary: '[飞天猫猫]' })
    expect(resolved).not.toHaveProperty('emoji_id')
    expect(resolved).not.toHaveProperty('key')
    expect(resolved).not.toHaveProperty('url')
  })

  it('keeps an unknown segment under the exact OneBot type name on render', () => {
    const parsed = parseMessage([{ type: 'foo', data: { a: '1' } }])
    expect(renderMessage(parsed.segments)).toEqual({ type: 'foo', data: { a: '1' } })
  })

  it('keeps only the documented attributes of the remaining segment types', () => {
    const parsed = parseMessage([
      { type: 'share', data: { url: 'https://x', title: '标题', extra: 'drop' } },
      { type: 'location', data: { lat: '1', lon: '2' } },
    ])
    expect(parsed.segments).toEqual([
      { type: 'share', data: { url: 'https://x', title: '标题' } },
      { type: 'location', data: { lat: '1', lon: '2' } },
    ])
  })
})

describe('renderMessage', () => {
  it('renders text as bare strings and unwraps a single element', () => {
    expect(renderMessage([{ type: 'text', data: { text: '你好' } }])).toBe('你好')
    expect(renderMessage([
      { type: 'text', data: { text: '你好' } },
      { type: 'face', data: { id: '14', name: '微笑' } },
    ])).toEqual(['你好', { type: 'face', data: { id: '14', name: '微笑' } }])
  })

  it('never sends an empty media shell: a missing file becomes an explicit note', () => {
    expect(renderSegment({ type: 'image', data: {} })).toBe('(图片未取到)')
    expect(renderSegment({ type: 'record', data: {} })).toBe('(语音未取到)')
    expect(renderSegment({ type: 'image', data: { file: '/tmp/a.png' } }))
      .toEqual({ type: 'image', data: { file: '/tmp/a.png' } })
  })

  it('renders the quoted record carried by a reply segment', () => {
    const rendered = renderSegment({
      type: 'reply',
      data: {
        id: '9',
        message: messageRecord({
          qq: '20002', nickname: '小红', time: '09:30',
          message: [{ type: 'text', data: { text: '原话' } }],
        }),
      },
    }) as { data: { message: { qq: string; message: string } } }
    expect(rendered.data.message).toMatchObject({ qq: '20002', message: '原话' })
  })

  it('renders every forwarded node record', () => {
    const rendered = renderSegment({
      type: 'forward',
      data: {
        id: 'f1',
        messages: [
          messageRecord({ qq: '20002', nickname: '小红', message: [{ type: 'text', data: { text: '一' } }] }),
          messageRecord({ qq: '20003', nickname: '小刚', message: [{ type: 'text', data: { text: '二' } }] }),
        ],
      },
    }) as { data: { messages: Array<{ message: string }> } }
    expect(rendered.data.messages.map(node => node.message)).toEqual(['一', '二'])
  })
})

describe('detectMention', () => {
  it('accepts an at for the bot itself or @all, and nothing else', () => {
    expect(detectMention([{ type: 'at', data: { qq: '10002' } }], '10002', '')).toBe(true)
    expect(detectMention([{ type: 'at', data: { qq: 'all' } }], '', '10002')).toBe(true)
    expect(detectMention([{ type: 'at', data: { qq: '999' } }], '', '10002')).toBe(false)
    expect(detectMention([{ type: 'text', data: { text: '@10002' } }], '', '10002')).toBe(false)
  })

  it('stays fail-closed when the bot id is unknown', () => {
    expect(detectMention([{ type: 'at', data: { qq: '10002' } }], '', '')).toBe(false)
    expect(detectMention(undefined, '10002', '')).toBe(false)
  })
})

describe('fillMentionNames', () => {
  it('fills missing at names from the roster and keeps unknown ids bare', () => {
    const segments = [
      { type: 'at' as const, data: { qq: '1' } },
      { type: 'at' as const, data: { qq: '2' } },
      { type: 'at' as const, data: { qq: '3', name: '已有' } },
    ]
    fillMentionNames(segments, new Map([['1', '小明'], ['2', '']]))
    expect(segments).toEqual([
      { type: 'at', data: { qq: '1', name: '小明' } },
      { type: 'at', data: { qq: '2' } },
      { type: 'at', data: { qq: '3', name: '已有' } },
    ])
  })
})

describe('faces', () => {
  it('maps ids to names without guessing', () => {
    expect(faceName('14')).toBe('微笑')
    expect(faceName('999999')).toBeUndefined()
  })
})

describe('records', () => {
  it('keeps the QQ nickname verbatim and keeps owner/admin roles only', () => {
    const record = messageRecord({
      qq: 10001, nickname: 'Foo\n<bar>', id: '7', time: '09:30', role: 'member',
      message: [{ type: 'text', data: { text: 'hi' } }],
    })
    expect(record).toEqual({
      qq: '10001', nickname: 'Foo\n<bar>', id: '7', time: '09:30',
      message: [{ type: 'text', data: { text: 'hi' } }],
    })
    expect(messageRecord({ qq: '1', nickname: 'a', role: 'owner', message: [] }).role).toBe('owner')
    expect(messageRecord({ qq: '1', nickname: 'a', role: 'admin', message: [] }).role).toBe('admin')
  })

  it('serializes the whole payload as one JSON array of rendered records', () => {
    const records = [
      systemRecord('更早的消息已省略'),
      messageRecord({ qq: '10001', nickname: '小明', id: '1', time: '09:30', message: [{ type: 'text', data: { text: 'hi' } }] }),
    ]
    expect(JSON.parse(formatRecords(records))).toEqual([
      { qq: '0', nickname: '系统', message: '更早的消息已省略' },
      { qq: '10001', nickname: '小明', id: '1', time: '09:30', message: 'hi' },
    ])
  })

  it('renderRecord is idempotent', () => {
    const record = messageRecord({ qq: '1', nickname: 'a', message: [{ type: 'text', data: { text: 'x' } }] })
    const once = renderRecord(record)
    expect(once.message).toBe('x')
    expect(renderRecord(record).message).toBe('x')
  })
})

describe('sleep window', () => {
  it('supports a window crossing midnight', () => {
    const at = (h: number, m: number): number => Date.UTC(2026, 9, 26, h - 8, m)
    expect(isSleeping('23:30', '08:00', at(2, 0))).toBe(true)
    expect(isSleeping('23:30', '08:00', at(12, 0))).toBe(false)
    expect(isSleeping('13:00', '14:00', at(13, 30))).toBe(true)
    expect(isSleeping('', '', at(13, 30))).toBe(false)
    expect(isSleeping('14:00', '14:00', at(14, 0))).toBe(false)
  })

  it('keys the window instance so one notice per window is possible', () => {
    const at = Date.UTC(2026, 9, 26, 2 - 8, 0)
    expect(sleepWindowKey('23:30', '08:00', at)).toBe('2026-10-25T23:30')
    expect(sleepWindowKey('', '', at)).toBe('')
    expect(dormancyKey({ sleepMode: 'window', sleepStart: '23:30', sleepEnd: '08:00' }, at)).toBe('2026-10-25T23:30')
  })
})
