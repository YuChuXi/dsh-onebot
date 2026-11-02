/**
 * 表情包工具族：收藏表情列表、发送（收藏表情 / 图片 / 商城表情）、收藏。
 *
 * 收藏表情来自 NapCat 的 fetch_custom_face；发送收藏表情走 image 段
 * （URL + sub_type=1），商城表情走 mface 段；收藏走 add_custom_face，
 * 文件必须落在媒体目录内（NapCat 需要能读到该路径）。
 * @module dsh-onebot/tools/stickers
 */
import type { ChatBridge } from '../bridge/index.js';
import type { OneBotConnection } from '../onebot/connection.js';
import { type MediaLimits, type RegisterTool } from './shared.js';
/**
 * 注册表情包工具族。
 *
 * Args:
 *   register (RegisterTool): 工具注册回调。
 *   bridge (ChatBridge): 出站发送与媒体下载的桥接对象。
 *   connection (OneBotConnection): NapCat 调用通道。
 *   limits (MediaLimits): 媒体大小上限。
 *
 * Returns:
 *   void
 *
 * Callers:
 *   - `tools/index.ts:registerTools`。
 */
export declare function registerStickerTools(register: RegisterTool, bridge: ChatBridge, connection: OneBotConnection, limits: MediaLimits): void;
