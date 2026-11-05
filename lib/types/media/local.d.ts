/**
 * 值是否本机绝对路径（Unix 或 Windows）。
 *
 * Args:
 *   value (string): 候选值。
 *
 * Returns:
 *   boolean: 是否本机绝对路径。
 *
 * Callers:
 *   - `src/onebot/segment-types/media.ts:normalizeMedia`。
 *   - `src/tools/index.ts:qq_napcat_api` 的路径参数判定。
 */
export declare function isLocalPath(value: string): boolean;
/**
 * 读取媒体围栏内的本机文件并编码成 base64。
 *
 * Args:
 *   path (string): 本机文件路径。
 *   maxBytes (number): 该类型的大小上限。
 *   allowedRoots (string[]): 允许读取的目录。
 *
 * Returns:
 *   Promise<string>: `base64://` 编码的内容。
 *
 * Callers:
 *   - `src/onebot/segment-types/media.ts:normalizeMedia`。
 *   - `src/tools/index.ts:qq_napcat_api` 的路径参数。
 */
export declare function encodeLocalFile(path: string, maxBytes: number, allowedRoots: string[]): Promise<string>;
