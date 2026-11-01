/**
 * qq_* 工具共用的执行环境：目标会话解析与出站媒体围栏根目录。
 * @module dsh-onebot/tools/shared
 */
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
export function resolveChat(bridge, exec, chatIdArg) {
    if (typeof chatIdArg === 'string' && chatIdArg !== '')
        return chatIdArg;
    const sessionId = exec.agent?.session.id;
    if (sessionId !== undefined) {
        const chatId = bridge.chatForSession(String(sessionId));
        if (chatId !== undefined)
            return chatId;
    }
    throw new Error('无法确定目标会话：请传 chat_id（格式 private:<qq> 或 group:<群号>）');
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
export async function mediaRoots(bridge, exec) {
    const gate = await bridge.mediaSendRoots(exec.agent?.session.id);
    return gate.roots;
}
