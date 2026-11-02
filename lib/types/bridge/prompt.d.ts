/**
 * dsh-onebot 通道的系统提示词。
 *
 * 入站载荷是记录数组；出站契约是「回合最终文本不会自动发送」——
 * 要发言只能调用 qq_send_message（或 qq_send_text / qq_send_image 等），
 * 最后一条带 `end: true` 立即结束回合。
 * @module dsh-onebot/prompt
 */
import type { ChatId } from '../chat/index.js';
/**
 * 构建 dsh-onebot 通道的提示词。
 * 思考档位不进提示词：它是请求参数（请求里由 installModelSelection 写入），
 * 模型要读当前值就调 qq_thinking(action=get)，不必为一行仪表盘牺牲前缀缓存。
 *
 * Args:
 *   chatId (ChatId): 会话 id；决定提示词里的群号 / 对方 QQ。
 *   restrictedMembers (boolean): 是否包含受限成员约束。
 *   extraPrompt (string): 附加提示词（人设、背景、语言风格等）；去除首尾空白后追加在段落末尾，空串不追加。
 *
 * Returns:
 *   string: 通道提示词段落。
 *
 * Callers:
 *   - `src/bridge/index.ts:installChannelScope` 为每个 QQ 会话注册系统提示词。
 */
export declare function buildPlatformPrompt(chatId: ChatId, restrictedMembers: boolean, extraPrompt?: string): string;
