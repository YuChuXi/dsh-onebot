/**
 * 商城表情：重放需要完整五件套，入站原样保留，出站缺一即拒绝。
 * @module dsh-onebot/segment-types/mface
 */
import type { IncomingSegment, Segment, SegmentData } from '../segments.js'
import { pickFields } from './primitives.js'
import { registerSegmentType } from './registry.js'

/** 重放商城表情需要的属性。 */
export const MFACE_FIELDS: readonly string[] = ['summary', 'emoji_id', 'emoji_package_id', 'key', 'url']

registerSegmentType('mface', {
  segment: (raw: IncomingSegment): Segment => ({
    type: 'mface',
    data: pickFields(raw.data ?? {}, MFACE_FIELDS) as SegmentData['mface'],
  }),
  normalize: data => {
    const picked = pickFields(data, MFACE_FIELDS)
    return Object.keys(picked).length === 0 ? undefined : { type: 'mface', data: picked }
  },
})
