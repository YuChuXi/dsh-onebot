/**
 * 本机文件的读取出口：把媒体围栏的拒绝翻译成可读提示，
 * 其余错误（大小超限、IO）原样抛出。
 * @module dsh-onebot/media/local
 */
import { fileToBase64 } from './store.js'

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
export function isLocalPath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)
}

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
export async function encodeLocalFile(path: string, maxBytes: number, allowedRoots: string[]): Promise<string> {
  try {
    return await fileToBase64(path, maxBytes, allowedRoots)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('path not allowed or does not exist')) {
      throw new Error('本地路径不在允许的媒体目录内（管理员回合可另读会话工作区），或文件不存在：' + path)
    }
    throw error
  }
}
