import type { ChatBridge } from '../bridge/index.js';
import { type RegisterTool } from './shared.js';
/**
 * 注册四个定时任务工具。
 *
 * Args:
 *   register (RegisterTool): 工具注册入口。
 *   bridge (ChatBridge): 定时器集合与当前会话解析。
 *
 * Returns:
 *   void
 *
 * Callers:
 *   - `src/tools/index.ts:registerTools`。
 */
export declare function registerScheduleTools(register: RegisterTool, bridge: ChatBridge): void;
