/**
 * 表情工具族：以“表情包 / 表情摘要”定位，以详细描述辅助理解与检索。
 *
 * 表情只保存在插件媒体目录内。普通图片默认进入“我的收藏”；商城表情使用
 * 固有 summary 作为摘要，并按 emoji_package_id 归属同一个表情包。发送时本地
 * 图片读成 base64，商城表情按五字段原样重放。
 * @module dsh-onebot/tools/stickers
 */
import type { ChatBridge } from '../bridge/index.js';
import { type StickerLibrary } from '../media/stickers.js';
import { type MediaLimits, type RegisterTool } from './shared.js';
/** 宿主附件服务的图片引用（@deepseek-ai/dsh-attachment 的 ImageAttachmentRef）。 */
export type StickerImageRef = {
    attachmentId: string;
    mediaType: string;
    bytes: number;
    width: number;
    height: number;
    name?: string;
};
/** 宿主附件服务的最小接口。 */
export type StickerImageStore = {
    saveImage(input: {
        data: Uint8Array;
        mediaType: 'image/png';
        name?: string;
    }): Promise<StickerImageRef>;
};
/**
 * 注册表情工具族。
 *
 * Args:
 *   register (RegisterTool): 工具注册回调。
 *   bridge (ChatBridge): 出站发送、媒体下载与围栏根来源。
 *   library (StickerLibrary): 本地表情库。
 *   limits (MediaLimits): 媒体大小上限。
 *   images (() => StickerImageStore | undefined): 宿主附件服务访问器。
 *
 * Returns:
 *   void
 *
 * Callers:
 *   - `tools/index.ts:registerTools`。
 */
export declare function registerStickerTools(register: RegisterTool, bridge: ChatBridge, library: StickerLibrary, limits: MediaLimits, images: () => StickerImageStore | undefined): void;
