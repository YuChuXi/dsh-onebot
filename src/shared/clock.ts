/**
 * 时间显示格式：记录里的时间统一是本地时区的 `HH:MM`。
 * @module dsh-onebot/shared/clock
 */

/**
 * 毫秒时间戳 → `HH:MM`。
 *
 * Args:
 *   ms (number): 毫秒时间戳。
 *
 * Returns:
 *   string: 本地时区的 `HH:MM`。
 *
 * Callers:
 *   - `src/inbound/index.ts:InboundPipeline`：消息、引用、转发节点与休眠说明的时间。
 *   - `src/inbound/notice.ts:renderNotice`：notice 记录的时间。
 */
export function formatClock(ms: number): string {
  const date = new Date(ms)
  return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0')
}
