/**
 * 发送工具族：把一条或多条消息发到 QQ 会话。七个工具只描述参数与
 * 「参数 → 发送计划」，会话解析、媒体围栏、写闸与 end 收尾由统一工厂处理。
 * @module dsh-onebot/tools/send
 */
import type { ChatBridge } from '../bridge/index.js';
import { type MediaLimits, type RegisterTool } from './shared.js';
/**
 * 注册全部发送工具。每个工具只描述参数与发送计划；会话解析、媒体根目录、
 * 写闸、end 收尾与返回值统一在这里处理。
 *
 * Args:
 *   register (RegisterTool): 工具注册回调。
 *   bridge (ChatBridge): 出站发送与回合收尾的桥接对象。
 *   limits (MediaLimits): 各媒体类型的大小上限。
 *
 * Returns:
 *   void
 *
 * Callers:
 *   - `tools/index.ts:registerTools`。
 */
export declare function registerSendTools(register: RegisterTool, bridge: ChatBridge, limits: MediaLimits): void;
