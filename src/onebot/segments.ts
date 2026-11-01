/**
 * OneBot 11 消息段：类型化的段模型、入站解析、模型可见渲染与 @ 提及判定。
 *
 * 内部一律使用 OneBot 的段数组形态（`{ type, data }`），但每个已知类型的
 * `data` 都有独立类型，按 `type` 判别后可穷尽处理——新增段类型时编译器会
 * 指出每一处需要照顾的分支，而不是在运行时查表。
 *
 * 这里没有 CQ 字符串层：消息只按段数组进出。
 * @module dsh-onebot/segments
 */
import { faceId, faceName } from './faces.js'
import { mediaKindOf, mediaLabel, type MediaKind } from '../media/kinds.js'

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
export interface IncomingSegment {
  type: string
  data?: Record<string, unknown>
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

/** 段 data 里取字符串，空值归为 undefined。 */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** 段 data 里取标量（字符串或数字）。 */
function scalar(value: unknown): string | number | undefined {
  return typeof value === 'string' || typeof value === 'number' ? value : undefined
}

/** 只保留指定属性，空值（undefined / null / ''）丢弃。 */
function pickFields(data: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of fields) {
    const value = data[key]
    if (value !== undefined && value !== null && value !== '') out[key] = value
  }
  return out
}

/** mface 段保留的属性（重放商城表情需要的五件套）。 */
const MFACE_FIELDS: readonly string[] = ['summary', 'emoji_id', 'emoji_package_id', 'key', 'url']

/** 已知段类型 → 模型可见段保留的字段。text / face / mface / 媒体段由各自分支处理。 */
const SEGMENT_FIELDS: Partial<Record<SegmentType, readonly string[]>> = {
  forward: ['id', 'resId'],
  dice: ['result'],
  rps: ['result'],
  json: ['data'],
  xml: ['data'],
  share: ['url', 'title', 'content', 'image'],
  contact: ['type', 'id'],
  location: ['lat', 'lon', 'title', 'content'],
  music: ['type', 'id', 'url', 'audio', 'title', 'content', 'image'],
  node: ['id', 'user_id', 'nickname', 'content', 'time'],
  markdown: ['content'],
  tts: ['text'],
  cardimage: ['file'],
}

/**
 * 把一个入站段解析成管线段：媒体段换成空壳 data（等字节回填），
 * 表情补中文名，其余已知类型按字段表挑属性，未知类型整段保留。
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
  const data = raw.data ?? {}
  // 媒体段先占位：段顺序与发送方一致，字节到手后按同一位置回填。
  if (mediaKindOf({ type: raw.type }) !== undefined) return { type: raw.type, data: {} } as Segment
  switch (raw.type) {
    case 'text':
      return { type: 'text', data: { text: String(data.text ?? '') } }
    case 'at':
      return { type: 'at', data: { qq: String(data.qq ?? ''), ...pickFields(data, ['name']) } as SegmentData['at'] }
    case 'reply':
      return { type: 'reply', data: { id: String(data.id ?? '') } }
    case 'face': {
      const id = text(data.id) ?? (data.id !== undefined && data.id !== '' ? String(data.id) : undefined)
      const name = text(data.name) ?? (id !== undefined ? faceName(id) : undefined)
      return { type: 'face', data: { ...(id !== undefined ? { id } : {}), ...(name !== undefined ? { name } : {}) } }
    }
    case 'mface':
      return { type: 'mface', data: pickFields(data, MFACE_FIELDS) as SegmentData['mface'] }
    default: {
      const fields = SEGMENT_FIELDS[raw.type as SegmentType]
      if (fields === undefined) return { type: 'unknown', data: { ...data, $type: raw.type } }
      return { type: raw.type as SegmentType, data: pickFields(data, fields) } as Segment
    }
  }
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
    // 表情包（mface）带图片地址时按图片处理：模型拿到本地文件与 QQ 的说明。
    if (segment.type === 'mface') {
      const url = segment.data.url
      if (url !== undefined && /^https?:\/\//.test(url)) {
        const index = parsed.length
        parsed.push({ type: 'image', data: {} })
        media.push({
          kind: 'image',
          segmentIndex: index,
          url,
          ...(segment.data.summary !== undefined ? { summary: segment.data.summary } : {}),
        })
        continue
      }
    }
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
 * 把一段文本按表情名/表情 id 规范化成 face 段（模型写出时用）。
 *
 * Args:
 *   id (string | undefined): 表情 id。
 *   name (string | undefined): 表情中文名。
 *
 * Returns:
 *   SegmentData['face'] | undefined: 两端至少有一个可用的表情数据。
 *
 * Callers:
 *   - `src/onebot/segments.ts:faceData`：工具参数里的 face 段。
 */
export function faceData(id: string | undefined, name: string | undefined): SegmentData['face'] | undefined {
  const resolvedId = id !== undefined && id !== '' ? id : (name !== undefined ? faceId(name) : undefined)
  if (resolvedId === undefined) return name !== undefined ? { name } : undefined
  const resolvedName = name !== undefined && name !== '' ? name : faceName(resolvedId)
  return { id: resolvedId, ...(resolvedName !== undefined ? { name: resolvedName } : {}) }
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
  const bot = selfId !== '' ? selfId : botQQ
  if (bot === '' || !Array.isArray(segments)) return false
  return segments.some(segment => segment.type === 'at'
    && (String(segment.data.qq) === bot || String(segment.data.qq) === 'all'))
}

/** 段是否带本地文件（媒体是否已取到）。 */
function hasFile(segment: Segment): boolean {
  if (mediaKindOf(segment) === undefined) return true
  const data = segment.data as MediaData
  return data.file !== undefined && data.file !== ''
}

/**
 * 把一个段渲染成模型可见形态：媒体段没有本地文件时变成明确的「未取到」说明，
 * 引用的被引消息与转发的节点列表递归渲染。
 *
 * Args:
 *   segment (Segment): 段。
 *
 * Returns:
 *   unknown: 文本 → 裸字符串；其余 → 段对象（内嵌消息已渲染）。
 *
 * Callers:
 *   - `renderMessage`。
 */
export function renderSegment(segment: Segment): unknown {
  if (segment.type === 'text') return segment.data.text
  if (segment.type === 'unknown') {
    // 还原 OneBot 原形状：模型拿到的是它认识的段类型名与全部原始属性。
    const { $type, ...rest } = segment.data
    return { type: $type, data: rest }
  }
  if (!hasFile(segment)) {
    const kind = mediaKindOf(segment)
    return '(' + (kind !== undefined ? mediaLabel(kind) : '媒体') + '未取到)'
  }
  if (segment.type === 'reply' && segment.data.message !== undefined) {
    return { type: 'reply', data: { ...segment.data, message: renderRecordValue(segment.data.message) } }
  }
  if (segment.type === 'forward' && Array.isArray(segment.data.messages)) {
    return {
      type: 'forward',
      data: { ...segment.data, messages: segment.data.messages.map(renderRecordValue) },
    }
  }
  return segment
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
