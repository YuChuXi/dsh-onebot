/**
 * 段处理的共用取值工具：空值归一与字段裁剪。
 * @module dsh-onebot/segment-types/primitives
 */
/**
 * data 里取字符串，空串归为 undefined。
 *
 * Args:
 *   value (unknown): 原始属性。
 *
 * Returns:
 *   string | undefined: 非空字符串。
 *
 * Callers:
 *   - `segment-types/basic.ts`、`segment-types/face.ts`、`segment-types/mface.ts`。
 */
export function text(value) {
    return typeof value === 'string' && value !== '' ? value : undefined;
}
/**
 * data 里取标量（字符串或数字）。
 *
 * Args:
 *   value (unknown): 原始属性。
 *
 * Returns:
 *   string | number | undefined: 标量值。
 *
 * Callers:
 *   - `segment-types/basic.ts`、`segment-types/face.ts`。
 */
export function scalar(value) {
    return typeof value === 'string' || typeof value === 'number' ? value : undefined;
}
/**
 * 只保留指定属性，空值（undefined / null / ''）丢弃。
 *
 * Args:
 *   data (Record<string, unknown>): 段的 data。
 *   fields (readonly string[]): 要保留的属性名。
 *
 * Returns:
 *   Record<string, unknown>: 裁剪后的 data。
 *
 * Callers:
 *   - `segment-types/basic.ts`、`segment-types/mface.ts`、`segment-types/media.ts`。
 */
export function pickFields(data, fields) {
    const out = {};
    for (const key of fields) {
        const value = data[key];
        if (value !== undefined && value !== null && value !== '')
            out[key] = value;
    }
    return out;
}
