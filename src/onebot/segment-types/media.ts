/**
 * 媒体段：入站只留空壳等字节回填；出站把本机路径读成 base64，
 * 其余来源（base64 / file / URL）原样交给 NapCat。
 * @module dsh-onebot/segment-types/media
 */
import type { MediaLimitKey } from '../../media/kinds.js'
import { mediaKindOf, mediaLabel } from '../../media/kinds.js'
import { encodeLocalFile, isLocalPath } from '../../media/local.js'
import { isUrl } from '../../media/store.js'
import type { OutboundSegment } from '../../outbound/index.js'
import type { IncomingSegment, Segment, SegmentData } from '../segments.js'
import { MFACE_FIELDS } from './mface.js'
import { pickFields, scalar, text } from './primitives.js'
import { registerSegmentType, type SegmentSendContext } from './registry.js'

/** 媒体段携带的来源属性。 */
const SOURCE_FIELDS: readonly string[] = ['file', 'url', 'sub_type', 'summary', 'file_id', 'name']

/** 由本模块归一化的段类型；商城表情有自己的适配器，不在此表内。 */
type LocalMediaSegment = 'image' | 'record' | 'video' | 'file'

/** 段类型 → 出站大小上限的配置键。 */
const LIMIT: Record<LocalMediaSegment, MediaLimitKey> = {
  image: 'maxImageBytes',
  record: 'maxVoiceBytes',
  video: 'maxFileBytes',
  file: 'maxFileBytes',
}

/**
 * 媒体段出站归一化：本机路径读成 base64，其余来源原样放行。
 *
 * Args:
 *   type (MediaSegmentType): 段类型。
 *   data (Record<string, unknown>): 模型给出的 data。
 *   ctx (SegmentSendContext): 媒体围栏根与大小上限。
 *
 * Returns:
 *   Promise<OutboundSegment | undefined>: 可发送段；无法解析的路径返回 undefined。
 *
 * Callers:
 *   - `segment-types/media.ts` 的四个注册项。
 */
async function normalizeMedia(
  type: LocalMediaSegment,
  data: Record<string, unknown>,
  ctx: SegmentSendContext,
): Promise<OutboundSegment | undefined> {
  const attrs = pickFields(data, SOURCE_FIELDS)
  const file = typeof attrs.file === 'string' ? attrs.file : ''
  const url = typeof attrs.url === 'string' ? attrs.url : ''
  if (file.startsWith('base64://') || file.startsWith('data:') || file.startsWith('file://') || isUrl(file)) {
    return { type, data: attrs }
  }
  if (isUrl(url)) return { type, data: attrs }
  const candidate = file !== '' ? file : url
  if (candidate === '' || !isLocalPath(candidate)) return undefined
  const encoded = await encodeLocalFile(candidate, ctx[LIMIT[type]], ctx.allowedRoots)
  return { type, data: { ...attrs, file: encoded } }
}

for (const type of Object.keys(LIMIT) as LocalMediaSegment[]) {
  registerSegmentType(type, {
    // QQ 把商城表情包装成 image 段，五字段挂在 data 上；这里归一成 mface，
    // 模型才能直接看出这是表情而不是普通图片。
    segment: (raw: IncomingSegment): Segment => {
      if (type === 'image' &&
          (text(raw.data?.emoji_id) !== undefined || scalar(raw.data?.emoji_package_id) !== undefined)) {
        const picked = pickFields(raw.data ?? {}, MFACE_FIELDS)
        // NapCat 把 emoji_package_id 当数字给，mface 段统一用字符串。
        if (picked.emoji_package_id !== undefined) picked.emoji_package_id = String(picked.emoji_package_id)
        return { type: 'mface', data: picked as SegmentData['mface'] }
      }
      return { type, data: {} } as Segment
    },
    render: segment => {
      const kind = mediaKindOf(segment)
      const file = (segment.data as { file?: unknown }).file
      if (kind !== undefined && (typeof file !== 'string' || file === '')) return '(' + mediaLabel(kind) + '未取到)'
      return segment
    },
    normalize: (data, ctx) => normalizeMedia(type, data, ctx),
  })
}
