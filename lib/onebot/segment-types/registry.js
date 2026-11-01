const registry = new Map();
/**
 * 注册一个段类型的双向转换。
 *
 * Args:
 *   type (string): OneBot 段类型名。
 *   adapter (SegmentTypeAdapter): 入站与出站转换。
 *
 * Returns:
 *   无。
 *
 * Callers:
 *   - `segment-types/basic.ts`、`face.ts`、`mface.ts`、`media.ts` 的模块顶层。
 */
export function registerSegmentType(type, adapter) {
    registry.set(type, adapter);
}
/**
 * 按类型名取适配器。
 *
 * Args:
 *   type (string): OneBot 段类型名。
 *
 * Returns:
 *   SegmentTypeAdapter | undefined: 未注册的类型返回 undefined。
 *
 * Callers:
 *   - `src/onebot/segments.ts:parseSegment`、`normalizeSegment`。
 */
export function segmentTypeOf(type) {
    return registry.get(type);
}
