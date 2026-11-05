/**
 * Model-facing tools for the OneBot channel: the send family (tools/send),
 * the whitelisted NapCat API proxy, group history and per-chat model control.
 * Tools infer the target chat from the calling agent's session; an explicit
 * chat_id overrides.
 * @module dsh-onebot/tools
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ChatBridge } from '../bridge/index.js';
import type { OneBotConnection } from '../onebot/connection.js';
import { type MediaLimits } from './shared.js';
/**
 * Register all qq_* tools on the context. Registration is effect-based: the
 * returned disposer unregisters them.
 *
 * Args:
 *   ctx (Context): 插件上下文（工具注册面）。
 *   bridge (ChatBridge): 会话解析与出站发送的桥接对象。
 *   connection (OneBotConnection): NapCat API 代理与群历史的调用通道。
 *   limits (MediaLimits): 各媒体类型的大小上限。
 *   mediaDir (string): 插件媒体目录；本地表情库落在其 `stickers` 子目录。
 *
 * Returns:
 *   () => void: 注销全部工具的 disposer。
 *
 * Callers:
 *   - `bridge/index.ts:installChannelScope`（agent 作用域安装频道能力）。
 */
export declare function registerTools(ctx: Context, bridge: ChatBridge, connection: OneBotConnection, limits: MediaLimits, mediaDir: string): () => void;
