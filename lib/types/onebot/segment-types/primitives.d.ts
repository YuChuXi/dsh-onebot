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
export declare function text(value: unknown): string | undefined;
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
export declare function scalar(value: unknown): string | number | undefined;
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
export declare function pickFields(data: Record<string, unknown>, fields: readonly string[]): Record<string, unknown>;
