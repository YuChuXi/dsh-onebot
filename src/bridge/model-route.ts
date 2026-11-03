/**
 * 单个 provider/model 路由配置值的解析：设置页下拉写入 `provider/model`，
 * 留空表示跟随部署默认。非法值直接抛错，让配置激活失败并指出是哪个键。
 * @module dsh-onebot/bridge/model-route
 */

/** 一条 provider/model 路由。 */
export interface ModelRoute {
  provider: string
  model: string
}

/**
 * 解析 `provider/model` 形式的配置值。
 *
 * Args:
 *   value (string): 原始配置值；空串 = 未指定。
 *   key (string): 配置键名（用于错误定位）。
 *
 * Returns:
 *   ModelRoute | undefined: 解析结果；空串返回 undefined。
 *
 * Callers:
 *   - `src/index.ts:apply`（modelPrivate / modelGroup）。
 *   - `src/settings-remote.ts:routeOf`（快照动态档位）。
 */
export function parseModelRoute(value: string, key: string): ModelRoute | undefined {
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  const slash = trimmed.indexOf('/')
  if (slash <= 0 || slash === trimmed.length - 1 || trimmed.indexOf('/', slash + 1) !== -1) {
    throw new Error(key + ' 格式错误：「' + value + '」应为 <provider>/<model>')
  }
  return { provider: trimmed.slice(0, slash), model: trimmed.slice(slash + 1) }
}
