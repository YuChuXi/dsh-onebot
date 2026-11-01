import type { MediaStore } from '../media/store.js';
import type { Transcriber } from '../media/stt.js';
import type { IncomingSegment } from '../onebot/segments.js';
import type { AccessPolicyConfig, ChatId, UserRole } from '../chat/index.js';
import type { MessageRecord } from '../onebot/records.js';
import type { BridgeConfig } from '../bridge/config.js';
import type { ChatSettings } from '../registry/index.js';
import type { NormalizedInbound, RawMessage } from './normalize.js';
/** W2-② 去重窗口的默认秒数，与 MIT 竞品的 dedupWindowSeconds 对齐。 */
export declare const DEFAULT_DEDUP_WINDOW_SECONDS = 300;
/** W2-② 去重窗口映射的条目上限（LRU 淘汰），防止 message_id 洪水撑爆内存。 */
export declare const DEDUP_MAX_ENTRIES = 4096;
/** 管线需要的桥接能力（比 BridgeDeps 窄：只列它真正读写的）。 */
export interface InboundContext {
    /** OneBot 动作调用（get_msg / get_image / get_record / get_file / get_forward_msg …）。 */
    call(action: string, params: Record<string, unknown>): Promise<unknown>;
    /** 连接当前学到的机器人 QQ。 */
    selfId(): string;
    /** 访问策略：私聊/群白名单与管理员集合。 */
    policy: AccessPolicyConfig;
    /** 会话级设置（水位）。 */
    getSettings(chatId: ChatId): ChatSettings;
    /** 水位变化后落盘。 */
    saveMapping(): void;
    /** 懒驱逐空闲会话。 */
    sweepIdleChats(): Promise<void>;
    /** 媒体存储：引用解析、下载、落盘、临时清理。 */
    media: MediaStore;
    /** 语音转写器。 */
    transcriber: Transcriber;
    /** 转写完成后把文本送进会话（运行中插话，空闲时开新回合）。 */
    steerTranscript(chatId: ChatId, text: string): void;
    /** 斜杠命令路由。 */
    tryHandleCommand(chatId: ChatId, text: string, userId: string): Promise<boolean>;
    /** 回合投递：桥接负责 ensureChat 与每回合前缀。 */
    dispatchFollowup(chatId: ChatId, text: string, role: UserRole, nickname?: string): Promise<void>;
    /** T2：忙时策略。返回 true 表示消息已被消费（插话或排队）。 */
    interceptBusyTurn?(chatId: ChatId, text: string, role: UserRole, nickname: string | undefined): Promise<boolean>;
    /** 桥接日志。 */
    log(level: 'info' | 'warn' | 'error' | 'debug', message: string): void;
    /** 管线读取的配置字段。 */
    config: Pick<BridgeConfig, 'botQQ' | 'ignoreSelf' | 'requireMention' | 'maxInboundFileBytes'> & Partial<{
        /** W2-② 去重窗口秒数；0 关闭。 */
        dedupWindowSeconds: number;
        /** 上文窗口条数上限（含触发消息）；0 = 只注入触发消息。 */
        recentMessages: number;
        /** 休眠模式：window（每日窗口）/ peak（高峰时段）。 */
        sleepMode: string;
        /** 休眠窗口起点 HH:MM。 */
        sleepStart: string;
        /** 休眠窗口终点 HH:MM。 */
        sleepEnd: string;
    }>;
}
/** 构造参数（测试可注入假时钟与小容量）。 */
export interface InboundPipelineOptions {
    /** 去重窗口容量覆盖（测试）。 */
    dedupMaxEntries?: number;
    /** 时钟覆盖（测试）。 */
    now?: () => number;
}
/**
 * 入站管线：一条中性事件 → 一次回合。
 * 负责媒体解析、引用/转发展开与上文窗口；投递本身留在上下文回调里。
 */
export declare class InboundPipeline {
    private readonly ctx;
    private readonly dedupMaxEntries;
    private readonly now;
    /** "chatId#messageId" → 首次出现时刻，Map 插入序即 LRU 顺序。 */
    private readonly seenMessages;
    /** 群号 → { at, names }：@ 名字富集缓存。 */
    private readonly memberCache;
    /** 进行中的成员表拉取，避免一阵 @ 触发多次接口调用。 */
    private readonly memberFetches;
    /** 会话 → 会话事件（戳一戳、撤回、禁言、成员变动等 notice），在下一次载荷里并回同一条时间线。 */
    private readonly contextBuffers;
    /** 会话 → 已经提示过的休眠窗口标识。 */
    private readonly sleepNotices;
    /** 缓存令牌 → 已取到的本地文件。 */
    private readonly mediaMemo;
    /** 消息对象 → 解析结果（每条只解析一次）。 */
    private readonly parseCache;
    /** "chatId#messageId" → 已取过的被引消息：提及校验与引用展开共用一次
     * get_msg；null 表示这次查询失败，展开时不再重查。 */
    private readonly quotedCache;
    constructor(ctx: InboundContext, options?: InboundPipelineOptions);
    /** 健康快照：去重窗口当前持有的 message_id 数量。 */
    get dedupWindowEntries(): number;
    /**
     * 处理一条入站事件。
     *
     * Args:
     *   inbound (NormalizedInbound): 中性入站事件。
     *
     * Returns:
     *   Promise<void>: 处理完成（包含未被消费的丢弃分支）。
     *
     * Callers:
     *   - `src/bridge/index.ts:processInbound`。
     */
    processInbound(inbound: NormalizedInbound): Promise<void>;
    /**
     * W2-②：(chatId, message_id) 滑动窗口去重，抵挡 OneBot 重投。
     * 命中时刷新 LRU 顺序但保留首次时间；超过容量淘汰最旧的一条。
     *
     * Args:
     *   inbound (NormalizedInbound): 中性事件。
     *
     * Returns:
     *   boolean: true 表示本次投递必须静默跳过。
     *
     * Callers:
     *   - `processInbound`（第一个闸门）。
     */
    private duplicated;
    /**
     * 每条消息只解析一次：闸门看文本、记录构造看段，都复用同一份结果。
     *
     * Args:
     *   message (RawMessage): OneBot 消息对象。
     *
     * Returns:
     *   ParsedMessage: 解析结果。
     *
     * Callers:
     *   - `processInbound`、`recordOf`。
     */
    private parseOf;
    /**
     * 一条消息 → 一条记录，没有例外：触发消息、窗口行、被引消息、转发节点
     * 都走这里，只有它构造记录。媒体换成本机路径，@ 补名字，引用/转发展开。
     *
     * Args:
     *   message (RawMessage): OneBot 消息对象。
     *   chatId (ChatId): 会话 id（媒体落地与成员表按会话取）。
     *
     * Returns:
     *   MessageRecord: 记录。
     *
     * Callers:
     *   - `processInbound`、`sleepTurn`、`expandQuote`、`expandForward`。
     */
    recordOf(message: RawMessage, chatId: ChatId): Promise<MessageRecord>;
    /**
     * 一条消息的段数组，已把媒体占位换成可发送/可读的形态、并补齐 @ 名字。
     *
     * Args:
     *   parsed (ParsedMessage): 解析结果。
     *   chatId (ChatId): 会话 id。
     *
     * Returns:
     *   Promise<Segment[]>: 归一化后的段数组。
     *
     * Callers:
     *   - `recordOf`、`expandQuote`、`expandForward`。
     */
    private normalizedSegments;
    /**
     * 把每个媒体占位换成它的本机路径；取不到字节时写成明确的「未取到」。
     *
     * Args:
     *   segments (Segment[]): 段数组（原地修改）。
     *   media (MediaRef[]): 待解析引用。
     *   chatId (ChatId): 会话 id。
     *
     * Returns:
     *   Promise<void>: 修改完成。
     *
     * Callers:
     *   - `normalizedSegments`。
     */
    private fillMediaSegments;
    /**
     * @ 提及只有 id，裸号码没有上下文：按群成员表补显示名。
     *
     * Args:
     *   segments (Segment[]): 段数组（原地修改）。
     *   chatId (ChatId): 会话 id。
     *
     * Returns:
     *   Promise<void>: 修改完成。
     *
     * Callers:
     *   - `normalizedSegments`。
     */
    private fillSegmentAtNames;
    /**
     * 带外内容就地展开：引用取被引消息、合并转发取节点列表，
     * 展开结果仍是段，位置不变。
     *
     * Args:
     *   segments (Segment[]): 段数组。
     *   chatId (ChatId): 会话 id。
     *
     * Returns:
     *   Promise<Segment[]>: 展开后的段数组。
     *
     * Callers:
     *   - `recordOf`。
     */
    private expandSegments;
    /**
     * 记住已取过的被引消息：提及校验与引用展开共用同一次 get_msg。
     *
     * Args:
     *   chatId (ChatId): 会话 id。
     *   messageId (string): 被引消息 id 的原始文本。
     *   data (RawMessage | null): 查询结果；null 表示这次查询失败。
     *
     * Returns:
     *   无。
     *
     * Callers:
     *   - `processInbound`（作者校验之后）。
     *   - `expandQuote`（展开之后）。
     */
    private rememberQuoted;
    /**
     * 把一条引用展开成 reply 段：被引消息成为该段的 `message`（自己的记录形状，
     * 媒体已本地化）。取不到时只保留 id，模型仍可用 get_msg 自查。
     *
     * Args:
     *   messageId (string): 被引消息 id。
     *   chatId (ChatId): 会话 id。
     *
     * Returns:
     *   Promise<Segment>: reply 段。
     *
     * Callers:
     *   - `expandSegments`。
     */
    private expandQuote;
    /**
     * 把一条合并转发展开成 forward 段：节点列表就是记录数组，节点媒体本地化。
     * 取不到时只保留 id，模型仍可用 get_forward_msg 自查。
     *
     * Args:
     *   forwardId (string): 合并转发 id。
     *   chatId (ChatId): 会话 id。
     *
     * Returns:
     *   Promise<Segment>: forward 段。
     *
     * Callers:
     *   - `expandSegments`。
     */
    private expandForward;
    /**
     * 房间的「后台补充」：两次 @ 之间的窗口。
     *
     * 每次 @ 触发都向 NapCat 要最近 N 条，只保留上一次注入之后、这一次之前
     * 的部分——机器人没看见过的闲聊，不重放已投递的内容。水位存在会话映射里，
     * 重启、驱逐、换会话都不丢；有 id 时按 id 切分（同一秒多条也不串），
     * 滑出历史时退回时间比较并标记截断。
     *
     * @param chatId 目标会话（水位键）。
     * @param groupId 要查询的群；私聊为 ''。
     * @param trigger 触发本回合的消息；末尾永远是它。
     * @param peek 只读（休眠唤醒），不消费戳一戳缓冲、不推进水位。
     * @returns 窗口内的消息对象（含触发消息）与是否截断。
     */
    private recentMessages;
    /**
     * 推进上文水位：谁把载荷注入给模型，谁就报告这次注入的最后一条。
     * 窗口函数本身只读——于是「注入过的不会再注入」只有这一条语义。
     *
     * Args:
     *   chatId (ChatId): 目标会话。
     *   pointer (object): `{ id, time }`，time 是秒级时间戳。
     *
     * Returns:
     *   无。
     *
     * Callers:
     *   - `processInbound`。
     */
    private noteInjected;
    /**
     * 记录一条会话事件（戳一戳、撤回、禁言、成员变动等），等下一次载荷注入时
     * 并回时间线。事件不唤醒回合：进入上下文，而不是发起对话。
     *
     * Args:
     *   chatId (ChatId): 事件所属会话。
     *   from (string): 事件涉及的成员 QQ 号。
     *   segments (IncomingSegment[]): 与普通消息同构的段数组。
     *
     * Returns:
     *   void: 无返回值。
     *
     * Callers:
     *   - `processInbound`（wakes 为 false 的会话事件）。
     */
    rememberContext(chatId: ChatId, from: string, segments: IncomingSegment[]): void;
    /**
     * 群成员 QQ → 显示名，按群缓存（30 分钟）。
     *
     * Args:
     *   groupId (string): 群号。
     *
     * Returns:
     *   Promise<Map<string, string>>: QQ → 显示名。
     *
     * Callers:
     *   - `fillSegmentAtNames`、`recentMessages`。
     */
    memberNames(groupId: string): Promise<Map<string, string>>;
    /**
     * 记下刚看到的发送方，让成员表拉取之前 @ 名字也能用。
     *
     * Args:
     *   groupId (string): 群号。
     *   qq (string): 发送方 QQ。
     *   name (string): 显示名。
     *
     * Returns:
     *   无。
     *
     * Callers:
     *   - `processInbound`。
     */
    private rememberMember;
    /**
     * 解析一个媒体引用并返回本机路径；同一令牌只取一次字节
     * （临时清理会删文件，命中时先复查存在性）。
     *
     * Args:
     *   ref (MediaRef): 媒体引用。
     *   chatId (ChatId): 会话 id。
     *
     * Returns:
     *   Promise<string>: 本机路径；取不到时 ''。
     *
     * Callers:
     *   - `fillMediaSegments`。
     */
    private resolveMediaPath;
    /**
     * 把入站 QQ 文件取到本机。NapCat 的 get_file 可能给出容器内部路径，所以：
     *   1. 优先私聊直链（get_private_file_url → CDN 下载）；
     *   2. 回退 get_file 的 base64 / http url。
     *
     * Args:
     *   ref (MediaRef): 文件引用。
     *
     * Returns:
     *   Promise<string>: 本机路径；失败时 ''。
     *
     * Callers:
     *   - `resolveMediaPath`。
     */
    private resolveNasFile;
    /**
     * 把字节写到媒体目录下一个全新的不可预测名字。
     *
     * Args:
     *   buffer (Buffer): 文件内容。
     *   ext (string): 已白名单化的扩展名。
     *
     * Returns:
     *   Promise<string>: 本机路径。
     *
     * Callers:
     *   - `resolveNasFile`。
     */
    private writeMediaFile;
    /**
     * 载荷的回合级后果：最后一条记录（要回答的这条）的语音后台转写。
     *
     * Args:
     *   records (MessageRecord[]): 本回合记录。
     *   chatId (ChatId): 会话 id。
     *
     * Returns:
     *   无。
     *
     * Callers:
     *   - `processInbound`、`sleepTurn`。
     */
    private applyTurnSideEffects;
    /**
     * M3-D4c：后台转写，完成后把带标注的文本送进会话
     * （运行中的回合在最近的步骤边界插话，空闲时开新回合）。失败保留 [语音] 占位。
     *
     * Args:
     *   path (string): 语音文件路径。
     *   chatId (ChatId): 会话 id。
     *
     * Returns:
     *   Promise<void>: 无返回值。
     *
     * Callers:
     *   - `applyTurnSideEffects`（不等待）。
     */
    private transcribeLater;
    /** 当前是否处于休眠窗口（每日窗口或高峰时段）。 */
    private sleeping;
    /** 占位说明：为什么现在是睡觉时间。 */
    private dormancyNotice;
    /**
     * 每个窗口只有一次告别回合：房间最近的闲聊、一条占位说明、以及把我们
     * 叫醒的这条消息。让模型自己写告别，而不是插件贴一句罐头文本。
     *
     * Args:
     *   chatId (ChatId): 会话 id。
     *   inbound (NormalizedInbound): 唤醒消息。
     *
     * Returns:
     *   Promise<boolean>: true = 本窗口已提示过、本条丢弃；false = 已载入回合。
     *
     * Callers:
     *   - `processInbound`。
     */
    private sleepTurn;
}
