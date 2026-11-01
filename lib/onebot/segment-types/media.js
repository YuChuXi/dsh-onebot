import { mediaKindOf, mediaLabel } from '../../media/kinds.js';
import { encodeLocalFile, isLocalPath } from '../../media/local.js';
import { isUrl } from '../../media/store.js';
import { pickFields } from './primitives.js';
import { registerSegmentType } from './registry.js';
/** 媒体段携带的来源属性。 */
const SOURCE_FIELDS = ['file', 'url', 'sub_type', 'summary', 'file_id', 'name'];
/** 段类型 → 出站大小上限的配置键。 */
const LIMIT = {
    image: 'maxImageBytes',
    record: 'maxVoiceBytes',
    video: 'maxFileBytes',
    file: 'maxFileBytes',
};
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
async function normalizeMedia(type, data, ctx) {
    const attrs = pickFields(data, SOURCE_FIELDS);
    const file = typeof attrs.file === 'string' ? attrs.file : '';
    const url = typeof attrs.url === 'string' ? attrs.url : '';
    if (file.startsWith('base64://') || file.startsWith('data:') || file.startsWith('file://') || isUrl(file)) {
        return { type, data: attrs };
    }
    if (isUrl(url))
        return { type, data: attrs };
    const candidate = file !== '' ? file : url;
    if (candidate === '' || !isLocalPath(candidate))
        return undefined;
    const encoded = await encodeLocalFile(candidate, ctx[LIMIT[type]], ctx.allowedRoots);
    return { type, data: { ...attrs, file: encoded } };
}
for (const type of Object.keys(LIMIT)) {
    registerSegmentType(type, {
        segment: () => ({ type, data: {} }),
        render: segment => {
            const kind = mediaKindOf(segment);
            const file = segment.data.file;
            if (kind !== undefined && (typeof file !== 'string' || file === ''))
                return '(' + mediaLabel(kind) + '未取到)';
            return segment;
        },
        normalize: (data, ctx) => normalizeMedia(type, data, ctx),
    });
}
