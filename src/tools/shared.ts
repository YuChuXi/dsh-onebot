/**
 * qq_* 工具共用的执行环境：目标会话解析与出站媒体围栏根目录。
 * @module dsh-onebot/tools/shared
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

import type { ChatBridge } from '../bridge/index.js'

/** 工具注册回调（ctx.tools.register 的参数类型）。 */
export type RegisterTool = (tool: Parameters<Context['tools']['register']>[0]) => void

/** 出站媒体大小上限（发送工具族共用）。 */
export interface MediaLimits {
  maxImageBytes: number
  maxVoiceBytes: number
  maxFileBytes: number
}

/** 所有发送工具共用的会话参数。 */
export const CHAT_ID_PARAM = {
  type: 'string' as const,
  description: '目标会话（private:<QQ号> 或 group:<群号>）；省略时默认当前会话',
}

/** 发送工具共享的 end 参数：最后一步执行完立即结束回合。 */
export const END_PARAM = {
  type: 'boolean' as const,
  description: '本次是最后一步：执行后立即结束回合，省掉一次收尾的模型调用',
}

/**
 * Resolve the target chat for a tool call.
 *
 * Args:
 *   bridge (ChatBridge): 负责 session → chat 反查的桥接对象。
 *   exec (ToolRunContext): 宿主给出的工具执行上下文。
 *   chatIdArg (unknown): 工具参数里的 chat_id。
 *
 * Returns:
 *   string: 目标会话 id。
 *
 * Callers:
 *   - `tools/send.ts:registerSendTools`、`tools/index.ts:registerTools`。
 */
export function resolveChat(bridge: ChatBridge, exec: ToolRunContext, chatIdArg: unknown): string {
  if (typeof chatIdArg === 'string' && chatIdArg !== '') return chatIdArg
  const sessionId = exec.agent?.session.id
  if (sessionId !== undefined) {
    const chatId = bridge.chatForSession(String(sessionId))
    if (chatId !== undefined) return chatId
  }
  throw new Error('无法确定目标会话：请传 chat_id（格式 private:<qq> 或 group:<群号>）')
}

/**
 * Outbound media fence roots for the calling session's current turn
 * (M1-A3b): the plugin media dir always, plus the chat workspace on admin
 * turns. An unknown caller session degrades to mediaDir-only inside the
 * bridge — fail-closed.
 *
 * Args:
 *   bridge (ChatBridge): 提供回合级媒体围栏根的桥接对象。
 *   exec (ToolRunContext): 宿主给出的工具执行上下文。
 *
 * Returns:
 *   Promise<string[]>: 允许读取的媒体根目录。
 *
 * Callers:
 *   - `tools/send.ts:registerSendTools`。
 */
export async function mediaRoots(bridge: ChatBridge, exec: ToolRunContext): Promise<string[]> {
  const gate = await bridge.mediaSendRoots(exec.agent?.session.id)
  return gate.roots
}
