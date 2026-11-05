/**
 * OneBot 11 消息段：类型化的段模型、入站解析、模型可见渲染与 @ 提及判定。
 *
 * 内部一律使用 OneBot 的段数组形态（`{ type, data }`），每个已知类型的
 * `data` 都有独立类型；入站解析与出站归一化由 `segment-types/` 下各自的
 * 适配器提供，这里只做查找、渲染与整条消息的组装。
 *
 * 这里没有 CQ 字符串层：消息只按段数组进出。
 * @module dsh-onebot/segments
 */
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { mediaKindOf, type MediaKind } from '../media/kinds.js'
import type { OutboundSegment } from '../outbound/index.js'
import { scalar, text } from './segment-types/primitives.js'
import { segmentTypeOf, type SegmentSendContext } from './segment-types/registry.js'
import './segment-types/index.js'

export { MEDIA_KINDS, mediaKindOf, mediaLabel } from '../media/kinds.js'
export type { MediaKind, MediaKindSpec, MediaSegmentType } from '../media/kinds.js'

/** 一类媒体段共有的来源字段。 */
export interface MediaData {
  /** 本机路径（解析后回填）或原始缓存令牌。 */
  file?: string
  /** 远端地址。 */
  url?: string
  /** 表情包标记（QQ 用 sub_type=1）。 */
  sub_type?: string | number
  /** QQ 自带说明（贴纸名）。 */
  summary?: string
}

/** 已知段类型的 data 形状，键即 OneBot 的段类型名。 */
export interface SegmentData {
  text: { text: string }
  at: { qq: string; name?: string }
  /** 引用：展开后被引消息记录放进 message。 */
  reply: { id: string; message?: unknown }
  /** 合并转发：展开后节点记录放进 messages。 */
  forward: { id?: string; resId?: string; messages?: unknown[] }
  image: MediaData
  record: MediaData
  video: MediaData
  file: MediaData & { file_id?: string; name?: string }
  face: { id?: string; name?: string }
  mface: { summary?: string; emoji_id?: string; emoji_package_id?: string; key?: string; url?: string }
  dice: { result?: string }
  rps: { result?: string }
  json: { data?: string }
  xml: { data?: string }
  share: { url?: string; title?: string; content?: string; image?: string }
  contact: { type?: string; id?: string }
  location: { lat?: string; lon?: string; title?: string; content?: string }
  music: { type?: string; id?: string; url?: string; audio?: string; title?: string; content?: string; image?: string }
  node: { id?: string; user_id?: string; nickname?: string; content?: unknown; time?: string }
  markdown: { content?: string }
  tts: { text?: string }
  cardimage: { file?: string }
}

/** 已知类型名的联合。 */
export type SegmentType = keyof SegmentData

/** 一个已知段：`type` 与 `data` 绑定，改一处编译器就能发现另一处。 */
export type KnownSegment = {
  [K in SegmentType]: { type: K; data: SegmentData[K] }
}[SegmentType]

/**
 * 未知段：保留原始属性，不做猜测。`$type` 记住原始类型名，
 * 渲染时还原成 OneBot 原形状（模型仍看到 `{type:'foo',data:{…}}`）。
 */
export interface UnknownSegment {
  type: 'unknown'
  data: Record<string, unknown> & { $type: string }
}

/** 管线内部的段联合：判别属性 `type` 全是字面量，switch 后可穷尽收窄。 */
export type Segment = KnownSegment | UnknownSegment

/** 入站事件里段数组的宽松形态（实现之间字段有出入）。 */
export type IncomingSegment = {
  type: string
  data?: { [key: string]: JsonValue }
}

/** 待取字节的媒体引用：解析产物，交给媒体存储换成本地文件。 */
export interface MediaRef {
  kind: MediaKind
  url?: string
  file?: string
  fileId?: string
  name?: string
  subType?: string | number
  summary?: string
  /** 商城表情五字段：入站原样保留，回填时与本地文件一起写回段数据。 */
  mface?: SegmentData['mface']
  /** 该引用在段数组中的下标，回填路径时按位置写回。 */
  segmentIndex: number
}

/** 一条消息的入站解析产物。 */
export interface ParsedMessage {
  /** 只有文本段贡献的纯文本（命令匹配用）。 */
  text: string
  /** 还在等本地文件的媒体引用。 */
  media: MediaRef[]
  /** 模型可见的段数组。 */
  segments: Segment[]
}

/**
 * 事件或接口响应里的段数组；不是数组时视为空。
 * 这里没有 CQ 字符串回退：字符串载荷不是段数组，按无段处理。
 *
 * Args:
 *   value (unknown): 事件/响应里的 `message` 字段。
 *
 * Returns:
 *   IncomingSegment[]: 段数组（原样返回，不做拷贝）。
 *
 * Callers:
 *   - `src/inbound/index.ts:InboundPipeline`：expandQuote、expandForward。
 *   - `src/inbound/normalize.ts:normalizeOneBot11`：入站段数组。
 *   - `src/tools/index.ts`：qq_group_history 的文本提取。
 */
export function incomingSegments(value: unknown): IncomingSegment[] {
  return Array.isArray(value) ? value as IncomingSegment[] : []
}

/**
 * 把一个入站段解析成模型可见段：具体转换由该类型的适配器提供，
 * 未注册的类型整段保留并记住原始类型名。
 *
 * Args:
 *   raw (IncomingSegment): OneBot 原始段。
 *
 * Returns:
 *   Segment: 类型化的段。
 *
 * Callers:
 *   - `parseMessage`。
 */
export function parseSegment(raw: IncomingSegment): Segment {
  const segment = segmentTypeOf(raw.type)?.segment?.(raw)
  if (segment !== undefined) return segment
  return { type: 'unknown', data: { ...(raw.data ?? {}), $type: raw.type } }
}

/**
 * 把模型给出的段归一成可发送形态：与入站同源，转换由类型适配器提供。
 *
 * Args:
 *   raw (IncomingSegment): 模型传入的段。
 *   ctx (SegmentSendContext): 媒体围栏根与各媒体类型的大小上限。
 *
 * Returns:
 *   Promise<OutboundSegment | undefined>: 可发送段；不可发送时返回 undefined。
 *
 * Callers:
 *   - `src/tools/send.ts:outboundSegments`。
 */
export async function normalizeSegment(
  raw: IncomingSegment,
  ctx: SegmentSendContext,
): Promise<OutboundSegment | undefined> {
  const adapter = segmentTypeOf(raw.type)
  if (adapter?.normalize === undefined) return undefined
  return await adapter.normalize(raw.data ?? {}, { ...ctx, restore: value => restoreMessage(value, ctx) })
}

/**
 * 渲染值的逆还原：解包成段数组后逐段走同一张注册表。
 *
 * 与 `renderMessage` 对称——字符串是 text 段的渲染值，段对象按类型收下，
 * 数组逐项展开；每一段都交给它自己的适配器，管线不判断具体类型。
 *
 * Args:
 *   value (unknown): 渲染后的消息体。
 *   ctx (SegmentSendContext): 媒体围栏与大小上限。
 *
 * Returns:
 *   Promise<OutboundSegment[]>: 可发送段数组。
 *
 * Callers:
 *   - `normalizeSegment`（作为出站上下文的 `restore`）。
 */
async function restoreMessage(value: unknown, ctx: SegmentSendContext): Promise<OutboundSegment[]> {
  const out: OutboundSegment[] = []
  for (const raw of unpackRendered(value)) {
    const normalized = await normalizeSegment(raw, ctx)
    if (normalized !== undefined) out.push(normalized)
  }
  return out
}

/**
 * 把渲染值拆成原始段形状：字符串是 text，段对象原样，数组逐项展开。
 *
 * Args:
 *   value (unknown): 渲染后的消息体。
 *
 * Returns:
 *   IncomingSegment[]: 待归一化的段。
 *
 * Callers:
 *   - `restoreMessage`。
 */
function unpackRendered(value: unknown): IncomingSegment[] {
  if (typeof value === 'string') return [{ type: 'text', data: { text: value } }]
  if (Array.isArray(value)) return value.flatMap(item => unpackRendered(item))
  if (value === null || typeof value !== 'object') return []
  const segment = value as { type?: unknown; data?: unknown }
  if (typeof segment.type !== 'string' || segment.type === '') return []
  const data = (typeof segment.data === 'object' && segment.data !== null ? segment.data : {}) as IncomingSegment['data']
  return [{ type: segment.type, data }]
}

/**
 * 从媒体段造出待解析的媒体引用。
 *
 * Args:
 *   segment (Segment): 媒体段（空壳 data）。
 *   raw (IncomingSegment): 原始段（来源字段都在它的 data 里）。
 *   index (number): 段在数组中的下标。
 *
 * Returns:
 *   MediaRef: 媒体引用。
 *
 * Callers:
 *   - `parseMessage`。
 */
function mediaRefOf(segment: Segment, raw: IncomingSegment, index: number): MediaRef | undefined {
  const kind = mediaKindOf(segment)
  if (kind === undefined) return undefined
  const data = raw.data ?? {}
  const file = text(data.file)
  return {
    kind,
    segmentIndex: index,
    ...(text(data.url) !== undefined ? { url: text(data.url) } : {}),
    ...(file !== undefined ? { file } : {}),
    ...(text(data.file_id) !== undefined ? { fileId: text(data.file_id) } : {}),
    ...(text(data.name) !== undefined ? { name: text(data.name) } : file !== undefined ? { name: file } : {}),
    ...(scalar(data.sub_type) !== undefined ? { subType: scalar(data.sub_type) } : {}),
    ...(scalar(data['sub-type']) !== undefined ? { subType: scalar(data['sub-type']) } : {}),
    ...(text(data.summary) !== undefined ? { summary: text(data.summary) } : {}),
    // 商城表情可能是独立 mface 段，也可能是挂了五字段的 image 段。
    ...(kind === 'sticker' || text(data.emoji_id) !== undefined || scalar(data.emoji_package_id) !== undefined
      ? { mface: mfaceOf(data) }
      : {}),
  }
}

/**
 * 取商城表情五字段；缺失字段不写入，重放时由发送侧校验完整性。
 *
 * Args:
 *   data (Record<string, unknown>): 原始段数据。
 *
 * Returns:
 *   SegmentData['mface']: 只含存在的字段。
 *
 * Callers:
 *   - `mediaRefOf`。
 */
function mfaceOf(data: Record<string, unknown>): SegmentData['mface'] {
  const packageId = scalar(data.emoji_package_id)
  return {
    ...(text(data.summary) !== undefined ? { summary: text(data.summary) } : {}),
    ...(text(data.emoji_id) !== undefined ? { emoji_id: text(data.emoji_id) } : {}),
    // NapCat 把 emoji_package_id 当数字给，重放要求字符串。
    ...(packageId !== undefined ? { emoji_package_id: String(packageId) } : {}),
    ...(text(data.key) !== undefined ? { key: text(data.key) } : {}),
    ...(text(data.url) !== undefined ? { url: text(data.url) } : {}),
  }
}

/**
 * 解析一条入站消息：得到模型可见段数组、待取字节的媒体引用与纯文本。
 *
 * Args:
 *   segments (IncomingSegment[] | undefined): 消息段数组。
 *
 * Returns:
 *   ParsedMessage: 纯文本（仅文本段）、媒体引用（带段下标）与模型可见段数组。
 *
 * Callers:
 *   - `src/inbound/index.ts:InboundPipeline.parseOf`：每条消息只解析一次。
 */
export function parseMessage(segments: IncomingSegment[] | undefined): ParsedMessage {
  const textParts: string[] = []
  const media: MediaRef[] = []
  const parsed: Segment[] = []
  for (const raw of Array.isArray(segments) ? segments : []) {
    const segment = parseSegment(raw)
    if (segment.type === 'text') {
      if (segment.data.text === '') continue
      textParts.push(segment.data.text)
    }
    const ref = mediaRefOf(segment, raw, parsed.length)
    if (ref !== undefined) media.push(ref)
    parsed.push(segment)
  }
  return { text: textParts.join('').trim(), media, segments: parsed }
}

/**
 * 给 @ 提及段补显示名；未知 id 保持裸号码。
 *
 * Args:
 *   segments (Segment[]): 模型可见段数组（原地修改）。
 *   names (Map<string, string>): QQ → 显示名。
 *
 * Returns:
 *   无。
 *
 * Callers:
 *   - `src/inbound/index.ts:InboundPipeline.fillSegmentAtNames`。
 */
export function fillMentionNames(segments: Segment[], names: Map<string, string>): void {
  for (const segment of segments) {
    if (segment.type !== 'at') continue
    if (segment.data.name !== undefined && segment.data.name !== '') continue
    const name = names.get(segment.data.qq)
    if (name !== undefined && name !== '') segment.data.name = name
  }
}

/**
 * 判断消息是否提到了机器人（@ 或 @全体成员）。机器人 id 未知且未配置时一律 false。
 *
 * Args:
 *   segments (Segment[] | undefined): 段数组。
 *   selfId (string): 已学习的机器人 QQ（未知为 ''）。
 *   botQQ (string): 配置的机器人 QQ（未配置为 ''）。
 *
 * Returns:
 *   boolean: 是否有指向机器人的 at 段。
 *
 * Callers:
 *   - `src/inbound/index.ts:InboundPipeline.processInbound`：群聊提及闸门。
 */
export function detectMention(segments: Segment[] | undefined, selfId: string, botQQ: string): boolean {
  if (!Array.isArray(segments)) return false
  return segments.some(segment => segmentTypeOf(segment.type)?.wakes?.(segment, selfId, botQQ) === true)
}

/**
 * 把一个段渲染成模型可见形态：具体形态由该类型的适配器决定。
 *
 * Args:
 *   segment (Segment): 段。
 *
 * Returns:
 *   unknown: 模型看到的值；未注册的类型还原成 OneBot 原形状。
 *
 * Callers:
 *   - `renderMessage`。
 */
export function renderSegment(segment: Segment): unknown {
  if (segment.type === 'unknown') {
    // 还原 OneBot 原形状：模型拿到的是它认识的段类型名与全部原始属性。
    const { $type, ...rest } = segment.data
    return { type: $type, data: rest }
  }
  const render = segmentTypeOf(segment.type)?.render
  if (render === undefined) return segment
  return render(segment, { renderMessage, renderRecord: renderRecordValue })
}

/**
 * 渲染内嵌的一条记录：记录的 `message` 是段数组，递归渲染成模型可见值。
 * 不是记录（没有段数组 message）的值原样返回。
 *
 * Args:
 *   value (unknown): 引用的被引消息记录或转发节点记录。
 *
 * Returns:
 *   unknown: 渲染后的记录。
 *
 * Callers:
 *   - `renderSegment`（引用与合并转发）。
 */
function renderRecordValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  const record = value as { message?: unknown }
  if (!Array.isArray(record.message)) return value
  return { ...(value as Record<string, unknown>), message: renderMessage(record.message as Segment[]) }
}

/**
 * 渲染一条消息。文本段不留外壳——每个文本段是独立的裸字符串，不合并；
 * 只剩一个元素时解包成该元素。
 *
 * Args:
 *   segments (Segment[]): 段数组。
 *
 * Returns:
 *   unknown: 裸字符串、单个段，或段/字符串混合数组。
 *
 * Callers:
 *   - `renderSegment`（引用与转发内嵌消息）。
 *   - `src/onebot/records.ts:renderRecord`。
 */
export function renderMessage(segments: Segment[]): unknown {
  const items = segments.map(renderSegment).filter(item => item !== '')
  return items.length === 1 ? items[0] : items
}

