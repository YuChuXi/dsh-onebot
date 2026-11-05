/** `get_image`：NapCat 从自己的缓存出图，url 的 rkey 过期后字节仍在。 */
const imageBytes = async (call, file) => {
    const data = await call('get_image', { file });
    const b64 = typeof data?.base64 === 'string' ? data.base64 : '';
    if (b64 !== '')
        return { file: 'base64://' + b64 };
    return { url: data?.url, file: data?.file };
};
/** `get_record`：同一套路，语音转成 mp3。 */
const voiceBytes = async (call, file) => {
    const data = await call('get_record', { file, out_format: 'mp3' });
    const b64 = typeof data?.base64 === 'string' ? data.base64 : '';
    if (b64 !== '')
        return { file: 'base64://' + b64 };
    return { file: data?.file };
};
/**
 * 普通媒体段的回填：模型可见的文件路径，加上贴纸标记与 QQ 自带说明。
 *
 * Args:
 *   ref (MediaRef): 媒体引用（携带 sub_type / summary）。
 *   path (string): 媒体目录内的文件名（目录外的路径保持原样）。
 *
 * Returns:
 *   Record<string, unknown>: 段的 data。
 *
 * Callers:
 *   - `MEDIA_KINDS` 的 image / voice / video 项。
 */
function mediaData(ref, path) {
    const summary = typeof ref.summary === 'string' ? ref.summary : '';
    const sticker = String(ref.subType ?? '') === '1';
    return {
        file: path,
        ...(sticker ? { sub_type: 1 } : {}),
        ...(summary !== '' ? { summary } : {}),
    };
}
/** 媒体类型的唯一枚举：行为随类型走，不在上下游重复。 */
export const MEDIA_KINDS = {
    image: {
        label: '图片',
        segment: 'image',
        limit: 'maxImageBytes',
        fetch: imageBytes,
        resolved: mediaData,
    },
    voice: {
        label: '语音',
        segment: 'record',
        limit: 'maxVoiceBytes',
        fetch: voiceBytes,
        transcribe: true,
        resolved: mediaData,
    },
    video: {
        label: '视频',
        segment: 'video',
        limit: 'maxFileBytes',
        resolved: mediaData,
    },
    file: {
        label: '文件',
        segment: 'file',
        limit: 'maxFileBytes',
        nas: true,
        // 文件段保留原始文件名与 file_id：模型需要知道发来的是什么文件。
        resolved: (ref, path) => ({
            file: path,
            ...(ref.name !== undefined ? { name: ref.name } : {}),
            ...(ref.fileId !== undefined ? { file_id: ref.fileId } : {}),
        }),
    },
    sticker: {
        label: '表情',
        segment: 'mface',
        limit: 'maxImageBytes',
        // 商城表情重放依赖五字段，入站解析时随引用带到回填结果里。
        resolved: (ref, path) => ({
            file: path,
            ...(ref.summary !== undefined && ref.summary !== '' ? { summary: ref.summary } : {}),
            ...(ref.mface ?? {}),
        }),
    },
};
/** 段类型 → 媒体种类（由同一张表反推，不另立一份）。 */
const KIND_OF_SEGMENT = Object.fromEntries(Object.entries(MEDIA_KINDS).map(([kind, spec]) => [spec.segment, kind]));
/**
 * 段是否承载媒体，以及属于哪一类。
 *
 * Args:
 *   segment ({ type: string }): 任意段或段类型壳。
 *
 * Returns:
 *   MediaKind | undefined: 媒体种类；非媒体段返回 undefined。
 *
 * Callers:
 *   - `src/onebot/segments.ts`：解析占位、渲染判空。
 *   - `src/inbound/index.ts`：媒体落盘、/ocr 目标与转写筛选。
 *   - `src/tools/send.ts`：出站段构造与大小上限。
 */
export function mediaKindOf(segment) {
    return segment.type in KIND_OF_SEGMENT ? KIND_OF_SEGMENT[segment.type] : undefined;
}
/**
 * 媒体种类的中文名。
 *
 * Args:
 *   kind (MediaKind): 媒体种类。
 *
 * Returns:
 *   string: 「图片」「语音」「视频」「文件」。
 *
 * Callers:
 *   - `src/onebot/segments.ts`：取不到字节时的占位说明。
 */
export function mediaLabel(kind) {
    return MEDIA_KINDS[kind].label;
}
