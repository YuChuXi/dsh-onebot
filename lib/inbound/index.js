/**
 * 入站管线：OneBot 事件 → 一次 agent 回合。
 *
 * 两件事：`normalizeOneBot11` / `normalizeEvent` 把原始事件收缩成中性入站事件
 * （null = 不处理），`InboundPipeline` 让它依次通过闸门（去重 → 自身 → 策略 →
 * 提及 → 命令 → 休眠），然后把**同一房间最近的一批消息与系统事件 + 这条触发
 * 事件**组装成记录数组交给回合。
 *
 * 载荷是记录数组而不是一段拼接文本：真人消息是 `{qq, nickname, id, time,
 * role?, message}`，系统事件是 `{notice, time?, …OneBot 原始字段}`；媒体段带
 * 本机路径，引用与合并转发在原位置展开成记录。窗口水位 `{time, id}` 随会话
 * 映射持久化：注入过的消息不会再注入一次。
 * @module dsh-onebot/inbound
 */
import { stat, writeFile } from 'node:fs/promises';
import { extForInboundName } from '../media/store.js';
import { transcriptLabel } from '../media/stt.js';
import { detectMention, fillMentionNames, incomingSegments, MEDIA_KINDS, mediaKindOf, mediaLabel, parseMessage, } from '../onebot/segments.js';
import { classifyUserRole, displayName, dmAllowed, groupAllowed, splitChatId } from '../chat/index.js';
import { formatRecords, messageRecord, SYSTEM_NICKNAME, systemRecord } from '../onebot/records.js';
import { describeError } from '../shared/errors.js';
import { formatClock } from '../shared/clock.js';
import { normalizeEvent } from './normalize.js';
import { dormancyKey, sleepingNow } from './sleep.js';
import { currentTrace, TRACE_REASONS } from '../ops/trace.js';
/** W2-② 去重窗口的默认秒数，与 MIT 竞品的 dedupWindowSeconds 对齐。 */
export const DEFAULT_DEDUP_WINDOW_SECONDS = 300;
/** W2-② 去重窗口映射的条目上限（LRU 淘汰），防止 message_id 洪水撑爆内存。 */
export const DEDUP_MAX_ENTRIES = 4096;
/** 群成员表缓存有效期：@ 名字富集不必每条消息都拉一次。 */
const MEMBER_CACHE_TTL_MS = 30 * 60_000;
/** 已解析媒体文件的记忆上限（每个缓存令牌一条）。 */
const MEDIA_MEMO_MAX = 300;
/** 被引消息缓存上限：一次 @ 最多带少量引用，超出按插入序淘汰。 */
const QUOTED_CACHE_MAX = 200;
/**
 * 入站管线：一条中性事件 → 一次回合。
 * 负责媒体解析、引用/转发展开与上文窗口；投递本身留在上下文回调里。
 */
export class InboundPipeline {
    ctx;
    dedupMaxEntries;
    now;
    /** "chatId#messageId" → 首次出现时刻，Map 插入序即 LRU 顺序。 */
    seenMessages = new Map();
    /** 群号 → { at, names }：@ 名字富集缓存。 */
    memberCache = new Map();
    /** 进行中的成员表拉取，避免一阵 @ 触发多次接口调用。 */
    memberFetches = new Map();
    /** 会话 → 系统事件（戳一戳、撤回、禁言、成员变动等），在下一次载荷里并回同一条时间线。 */
    contextBuffers = new Map();
    /** 会话 → 已经提示过的休眠窗口标识。 */
    sleepNotices = new Map();
    /** 缓存令牌 → 已取到的本地文件。 */
    mediaMemo = new Map();
    /** 消息对象 → 解析结果（每条只解析一次）。 */
    parseCache = new WeakMap();
    /** "chatId#messageId" → 已取过的被引消息：提及校验与引用展开共用一次
     * get_msg；null 表示这次查询失败，展开时不再重查。 */
    quotedCache = new Map();
    constructor(ctx, options = {}) {
        this.ctx = ctx;
        this.dedupMaxEntries = options.dedupMaxEntries ?? DEDUP_MAX_ENTRIES;
        this.now = options.now ?? Date.now;
    }
    /** 健康快照：去重窗口当前持有的 message_id 数量。 */
    get dedupWindowEntries() {
        return this.seenMessages.size;
    }
    /**
     * 把一条原始 OneBot 事件归一化成中性入站事件。形状收缩是纯函数的事；
     * notice 文案要用的显示名在这里取（群成员表 / 陌生人信息），因为取名属于
     * 入站管线的 I/O。
     *
     * Args:
     *   event (OneBotEvent): 连接层送来的原始事件。
     *
     * Returns:
     *   Promise<NormalizedInbound | null>: 归一化结果；不构成会话内容时为 null。
     *
     * Callers:
     *   - `src/bridge/index.ts:handleInbound`。
     */
    async normalize(event) {
        const selfId = this.ctx.selfId() || this.ctx.config.botQQ;
        return await normalizeEvent(event, selfId, (qq, groupId) => this.qqName(qq, groupId));
    }
    /**
     * QQ 号 → 显示名：群事件读群成员表（按群缓存），私聊事件查陌生人信息。
     * 取不到时返回空串，由调用方决定展示什么。
     *
     * Args:
     *   qq (string): 要取名的 QQ 号。
     *   groupId (string): 事件所属群；私聊为 ''。
     *
     * Returns:
     *   Promise<string>: 显示名；查不到时 ''。
     *
     * Callers:
     *   - `normalize`（notice 专用处理器的取名回调）。
     */
    async qqName(qq, groupId) {
        if (qq === '')
            return '';
        if (groupId !== '')
            return (await this.memberNames(groupId)).get(qq) ?? '';
        const userId = Number(qq);
        if (!Number.isSafeInteger(userId) || userId <= 0)
            return '';
        try {
            const info = await this.ctx.call('get_stranger_info', { user_id: userId });
            return typeof info?.nickname === 'string' ? info.nickname : '';
        }
        catch (error) {
            this.ctx.log('debug', 'get_stranger_info failed for ' + qq + ': ' + describeError(error));
            return '';
        }
    }
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
    async processInbound(inbound) {
        // 不指向机器人的系统事件只进入上下文：模型下次看到它，但不因此发起回复。
        if (!inbound.wakes) {
            if (inbound.notice !== undefined)
                this.rememberNotice(inbound.chatId, inbound.notice);
            this.ctx.log('debug', '系统事件已记入上下文: ' + inbound.chatId);
            return;
        }
        if (this.duplicated(inbound))
            return;
        const { kind, userId, groupId, chatId } = inbound;
        // ignoreSelf 针对机器人自己发出的消息回声；notice 的 user_id 是事件主体（例如入群的是机器人）。
        if (inbound.notice === undefined
            && this.ctx.config.ignoreSelf && this.ctx.selfId() !== '' && userId === this.ctx.selfId()) {
            this.ctx.log('debug', '机器人自己的消息已忽略: ' + chatId);
            currentTrace()?.emit('self', { ok: false, reason: TRACE_REASONS.inboundSelf });
            return;
        }
        if (kind === 'group')
            this.rememberMember(groupId, userId, inbound.nickname);
        const policy = this.ctx.policy;
        if (kind === 'private') {
            if (!dmAllowed(userId, policy)) {
                this.ctx.log('debug', 'ignoring DM from non-allowed user ' + userId);
                currentTrace()?.emit('whitelist', { ok: false, reason: TRACE_REASONS.inboundDmBlocked });
                return;
            }
        }
        else if (!groupAllowed(groupId, policy)) {
            this.ctx.log('debug', 'ignoring group message from non-allowed group ' + groupId);
            currentTrace()?.emit('whitelist', { ok: false, reason: TRACE_REASONS.inboundGroupBlocked });
            return;
        }
        // notice 是否指向机器人已由归一化判定（wakes）；只有真人消息需要再过 @ 闸。
        const parsed = this.parseOf(inbound.message);
        const needsMention = inbound.notice === undefined && kind === 'group' && this.ctx.config.requireMention;
        let mentioned = detectMention(parsed.segments, this.ctx.selfId(), this.ctx.config.botQQ);
        let mentionDropReason = TRACE_REASONS.inboundUnmentioned;
        if (needsMention && !mentioned) {
            // 显式 @ 缺失时，只有「回复机器人自己的消息」可以触发；作者必须由
            // get_msg 证实，查询失败 / 作者未知 / 回复他人一律不唤醒（fail-closed）。
            const bot = this.ctx.selfId() || this.ctx.config.botQQ;
            const replyId = parsed.segments.find(segment => segment.type === 'reply');
            if (bot !== '' && replyId !== undefined && replyId.type === 'reply') {
                const messageId = numericReplyId(replyId.data.id);
                if (messageId === undefined) {
                    mentionDropReason = TRACE_REASONS.quoteInvalidId;
                }
                else {
                    try {
                        const quoted = await this.ctx.call('get_msg', { message_id: messageId });
                        this.rememberQuoted(chatId, replyId.data.id, quoted ?? null);
                        const author = String(quoted?.sender?.user_id ?? quoted?.user_id ?? '');
                        mentioned = author === bot;
                        if (quoted == null) {
                            mentionDropReason = TRACE_REASONS.inboundReplyLookupFailed;
                        }
                        else if (author === '') {
                            mentionDropReason = TRACE_REASONS.inboundReplyAuthorUnknown;
                        }
                        else if (!mentioned) {
                            mentionDropReason = TRACE_REASONS.inboundReplyOtherAuthor;
                        }
                    }
                    catch (error) {
                        mentionDropReason = TRACE_REASONS.inboundReplyLookupFailed;
                        this.ctx.log('debug', '引用作者校验失败，未唤醒机器人: ' + describeError(error));
                    }
                }
            }
        }
        if (needsMention && !mentioned) {
            this.ctx.log('debug', mentionDropReason + ': ' + groupId);
            currentTrace()?.emit('mention', { ok: false, reason: mentionDropReason });
            return;
        }
        if (this.sleeping()) {
            if (await this.sleepTurn(chatId, inbound)) {
                currentTrace()?.emit('sleep', { ok: true, reason: TRACE_REASONS.sleepNotice });
            }
            else {
                currentTrace()?.emit('sleep', { ok: false, reason: TRACE_REASONS.inboundSleep });
            }
            return;
        }
        this.sleepNotices.delete(chatId);
        await this.ctx.sweepIdleChats();
        void this.ctx.media.cleanupExpired();
        // 命令在最前面路由：带媒体的消息不该为了当命令而付下载代价。
        if (inbound.notice === undefined && await this.ctx.tryHandleCommand(chatId, parsed.text, userId)) {
            currentTrace()?.emit('command', { ok: true, reason: TRACE_REASONS.inboundCommand });
            return;
        }
        // 载荷 = 房间里的上文 + 这条触发事件，全部是同一种东西：
        // 可选的截断说明、窗口记录，触发事件永远在最后。
        const window = await this.recentMessages(chatId, groupId, inbound.notice === undefined ? inbound.message : undefined);
        const records = [];
        if (window.truncated) {
            records.push(systemRecord(window.cursor === null
                ? '更早的消息已省略'
                : '更早的消息已省略；需要时可调用 qq_group_history 并传 message_seq=' + window.cursor + ' 继续取更早的消息'));
        }
        for (const entry of window.entries) {
            if (entry.notice !== undefined)
                records.push(entry.notice);
            else if (entry.message !== undefined)
                records.push(await this.recordOf(entry.message, chatId));
        }
        if (inbound.notice !== undefined)
            records.push(inbound.notice);
        this.applyTurnSideEffects(records, chatId);
        // 载荷尾部就是触发消息：注入即推进水位，下次窗口从它之后开始。
        this.noteInjected(chatId, { id: inbound.messageId, time: Number(inbound.message.time ?? 0) });
        const content = records.length === 0 ? '' : formatRecords(records);
        if (content === '') {
            this.ctx.log('debug', '消息展开后无有效内容，已丢弃: ' + chatId);
            currentTrace()?.emit('dispatch', { ok: false, reason: TRACE_REASONS.inboundEmptyContent });
            return;
        }
        const role = classifyUserRole(userId, policy.adminUsers);
        // 忙时策略跑在所有闸之后、真正投递之前；此时 content 已是完整载荷，
        // 插话只是把它塞进运行中的回合，不再重复任何 I/O。
        if (this.ctx.interceptBusyTurn !== undefined
            && await this.ctx.interceptBusyTurn(chatId, content, role, inbound.nickname)) {
            return;
        }
        await this.ctx.dispatchFollowup(chatId, content, role, inbound.nickname);
    }
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
    duplicated(inbound) {
        const windowSeconds = this.ctx.config.dedupWindowSeconds ?? DEFAULT_DEDUP_WINDOW_SECONDS;
        if (windowSeconds <= 0)
            return false;
        if (inbound.messageId === undefined || inbound.messageId === '')
            return false;
        const now = this.now();
        const key = inbound.chatId + '#' + inbound.messageId;
        const seenAt = this.seenMessages.get(key);
        if (seenAt !== undefined && now - seenAt < windowSeconds * 1000) {
            this.seenMessages.delete(key);
            this.seenMessages.set(key, seenAt);
            this.ctx.log('debug', 'dedup hit in ' + inbound.chatId + ': message_id ' + inbound.messageId
                + ' redelivered within ' + windowSeconds + 's window, message skipped');
            currentTrace()?.emit('dedup', { ok: false, reason: TRACE_REASONS.inboundDedup });
            return true;
        }
        this.seenMessages.delete(key);
        while (this.seenMessages.size >= this.dedupMaxEntries) {
            const oldest = this.seenMessages.keys().next().value;
            if (oldest === undefined)
                break;
            this.seenMessages.delete(oldest);
        }
        this.seenMessages.set(key, now);
        return false;
    }
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
    parseOf(message) {
        const cached = this.parseCache.get(message);
        if (cached !== undefined)
            return cached;
        const parsed = parseMessage(Array.isArray(message.message) ? message.message : []);
        this.parseCache.set(message, parsed);
        return parsed;
    }
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
    async recordOf(message, chatId) {
        const parsed = this.parseOf(message);
        const normalized = await this.normalizedSegments(parsed, chatId);
        const segments = await this.expandSegments(normalized, chatId);
        const sender = message.sender ?? {};
        const qq = String(message.user_id ?? sender.user_id ?? '');
        return messageRecord({
            qq,
            nickname: displayName(sender, qq),
            id: message.message_id !== undefined && message.message_id !== null ? String(message.message_id) : undefined,
            time: formatClock(Number(message.time ?? Math.floor(this.now() / 1000)) * 1000),
            role: typeof sender.role === 'string' ? sender.role : message.role,
            message: segments,
        });
    }
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
    async normalizedSegments(parsed, chatId) {
        const segments = parsed.segments.map(segment => ({ ...segment, data: { ...segment.data } }));
        await this.fillMediaSegments(segments, parsed.media, chatId);
        await this.fillSegmentAtNames(segments, chatId);
        return segments;
    }
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
    async fillMediaSegments(segments, media, chatId) {
        for (const ref of media) {
            const index = ref.segmentIndex;
            const segment = segments[index];
            if (segment === undefined)
                continue;
            const path = await this.resolveMediaPath(ref, chatId);
            segments[index] = path !== ''
                ? withMediaPath(segment, ref, path)
                : { type: 'text', data: { text: '(' + mediaLabel(ref.kind) + '未取到)' } };
        }
    }
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
    async fillSegmentAtNames(segments, chatId) {
        if (!segments.some(segment => segment.type === 'at' && (segment.data.name === undefined || segment.data.name === '')))
            return;
        const ref = splitChatId(chatId);
        if (ref.kind !== 'group')
            return;
        fillMentionNames(segments, await this.memberNames(ref.target));
    }
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
    async expandSegments(segments, chatId) {
        const out = [];
        for (const segment of segments) {
            if (segment.type === 'reply' && segment.data.id !== '') {
                out.push(await this.expandQuote(segment.data.id, chatId));
            }
            else if (segment.type === 'forward') {
                const id = segment.data.id ?? segment.data.resId;
                out.push(id !== undefined && id !== '' ? await this.expandForward(id, chatId) : segment);
            }
            else {
                out.push(segment);
            }
        }
        return out;
    }
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
    rememberQuoted(chatId, messageId, data) {
        const key = chatId + '#' + messageId;
        if (this.quotedCache.size >= QUOTED_CACHE_MAX && !this.quotedCache.has(key)) {
            const oldest = this.quotedCache.keys().next().value;
            if (oldest !== undefined)
                this.quotedCache.delete(oldest);
        }
        this.quotedCache.set(key, data);
    }
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
    async expandQuote(messageId, chatId) {
        const cached = this.quotedCache.get(chatId + '#' + messageId);
        if (cached === null) {
            // 提及校验已经查过并失败：引用展开不再重查同一 id。
            currentTrace()?.emit('quote', { ok: false, reason: '引用消息此前查询失败，仅保留 id' });
            return { type: 'reply', data: { id: messageId } };
        }
        try {
            const data = cached ?? await this.ctx.call('get_msg', { message_id: Number(messageId) });
            if (cached === undefined)
                this.rememberQuoted(chatId, messageId, data ?? null);
            const segments = await this.normalizedSegments(parseMessage(incomingSegments(data?.message)), chatId);
            if (segments.length === 0)
                return { type: 'reply', data: { id: messageId } };
            const sender = data?.sender ?? {};
            const qq = String(sender.user_id ?? data?.user_id ?? '');
            const nickname = displayName(sender, qq);
            const seconds = Number(data?.time ?? 0);
            return {
                type: 'reply',
                data: {
                    id: messageId,
                    message: messageRecord({
                        qq,
                        nickname,
                        time: formatClock(seconds > 0 ? seconds * 1000 : this.now()),
                        role: sender.role,
                        message: segments,
                    }),
                },
            };
        }
        catch (error) {
            this.ctx.log('debug', 'quote expansion failed: ' + describeError(error));
            currentTrace()?.emit('quote', { ok: false, reason: '引用消息展开失败，仅保留 id: ' + describeError(error) });
            return { type: 'reply', data: { id: messageId } };
        }
    }
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
    async expandForward(forwardId, chatId) {
        try {
            // NapCat 的 get_forward_msg 接受 message_id 或 id；两个都发以覆盖其他实现。
            const data = await this.ctx.call('get_forward_msg', { id: forwardId, message_id: forwardId });
            const nodes = Array.isArray(data.messages) ? data.messages : [];
            const messages = [];
            for (const node of nodes) {
                const nodeData = (node.data ?? node);
                const content = nodeData.message ?? nodeData.content;
                // 字符串节点体是字面文本：不再做任何 CQ 字符串解析。
                const segments = typeof content === 'string'
                    ? [{ type: 'text', data: { text: content } }]
                    : incomingSegments(content);
                const sender = (nodeData.sender ?? {});
                const qq = String(nodeData.user_id ?? sender.user_id ?? '');
                const nickname = typeof nodeData.nickname === 'string' && nodeData.nickname !== ''
                    ? nodeData.nickname
                    : displayName(sender, qq);
                const seconds = Number(nodeData.time ?? 0);
                const normalized = await this.normalizedSegments(parseMessage(segments), chatId);
                messages.push(messageRecord({
                    qq,
                    nickname,
                    time: seconds > 0 ? formatClock(seconds * 1000) : undefined,
                    role: typeof nodeData.role === 'string' ? nodeData.role : typeof sender.role === 'string' ? sender.role : undefined,
                    message: normalized,
                }));
            }
            if (messages.length === 0)
                currentTrace()?.emit('forward', { ok: false, reason: '合并转发无节点' });
            return { type: 'forward', data: { id: forwardId, messages } };
        }
        catch (error) {
            this.ctx.log('info', 'forward expansion failed: resId=' + forwardId + ': ' + describeError(error));
            currentTrace()?.emit('forward', { ok: false, reason: '合并转发展开失败（仅保留 id）: ' + describeError(error) });
            return { type: 'forward', data: { id: forwardId } };
        }
    }
    /**
     * 房间的「后台补充」：两次 @ 之间的窗口。
     *
     * 每次 @ 触发都向 NapCat 要最近 N 条，只保留上一次注入之后、这一次之前
     * 的部分——机器人没看见过的闲聊，不重放已投递的内容。水位存在会话映射里，
     * 重启、驱逐、换会话都不丢；有 id 时按 id 切分（同一秒多条也不串），
     * 滑出历史时退回时间比较并标记截断。系统事件与消息并回同一条时间线。
     *
     * Args:
     *   chatId (ChatId): 目标会话（水位键）。
     *   groupId (string): 要查询的群；私聊为 ''。
     *   trigger (RawMessage | undefined): 触发本回合的消息；末尾永远是它。notice 触发时为 undefined。
     *   peek (boolean): 只读（休眠唤醒），不消费系统事件缓冲、不推进水位。
     *
     * Returns:
     *   Promise<{ entries: WindowEntry[]; truncated: boolean; cursor: number | null }>:
     *   窗口记录、是否截断，以及截断时可继续向前翻的游标（窗口最早一条的
     *   message_seq；未截断时为 null）。
     *
     * Callers:
     *   - `processInbound`、`sleepTurn`。
     */
    async recentMessages(chatId, groupId, trigger, peek = false) {
        const total = this.ctx.config.recentMessages ?? 50;
        // 私聊没有群历史可拉：窗口就是这一条触发消息。
        if (groupId === '' || total <= 0) {
            return {
                entries: trigger === undefined ? [] : [{ time: triggerTimeOf(trigger, this.now()), message: trigger }],
                truncated: false,
                cursor: null,
            };
        }
        const keep = Math.max(0, total - 1);
        let messages;
        try {
            const data = await this.ctx.call('get_group_msg_history', { group_id: Number(groupId), count: total });
            messages = Array.isArray(data.messages) ? data.messages : [];
        }
        catch (error) {
            // 群历史是外部接口：拿不到就只注入触发消息，本回合照常回答。
            this.ctx.log('warn', 'get_group_msg_history failed: ' + describeError(error));
            currentTrace()?.emit('history', { ok: false, reason: TRACE_REASONS.recentHistoryFailed });
            return {
                entries: trigger === undefined ? [] : [{ time: triggerTimeOf(trigger, this.now()), message: trigger }],
                truncated: false,
                cursor: null,
            };
        }
        const currentId = String(trigger?.message_id ?? '');
        const triggerTime = triggerTimeOf(trigger, this.now());
        const settings = this.ctx.getSettings(chatId);
        const watermark = settings.recentWatermark;
        const anchorTime = watermark?.time ?? 0;
        const anchorId = watermark?.id ?? '';
        let startIndex = 0;
        let watermarkMissed = false;
        if (anchorId !== '') {
            const index = messages.findIndex(message => String(message?.message_id ?? '') === anchorId);
            if (index >= 0)
                startIndex = index + 1;
            else
                watermarkMissed = true;
        }
        const entries = [];
        for (let index = startIndex; index < messages.length; index += 1) {
            const message = messages[index];
            const time = Number(message?.time ?? 0);
            if (time > triggerTime)
                continue;
            if ((anchorId === '' || watermarkMissed) && time <= anchorTime)
                continue;
            const userId = String(message?.sender?.user_id ?? message?.user_id ?? '');
            if (userId === '' || userId === this.ctx.selfId())
                continue;
            if (!Array.isArray(message?.message) || message.message.length === 0)
                continue;
            entries.push({ time, message });
        }
        // 系统事件不是历史行：它们在自己的缓冲里，这里按时间顺序并回同一条时间线。
        const events = peek ? [] : this.contextBuffers.get(chatId) ?? [];
        for (const event of events) {
            if (event.at <= anchorTime || event.at > triggerTime)
                continue;
            entries.push({ time: event.at, notice: event.notice });
        }
        if (!peek)
            this.contextBuffers.delete(chatId);
        // 载荷最后一条永远是触发消息：历史里已入库就用它，否则补到末尾。
        // 没有 message_id 的事件无法按 id 比对，直接补上——它不属于任何历史行。
        if (trigger !== undefined) {
            const last = entries[entries.length - 1];
            const lastId = String(last?.message?.message_id ?? '');
            if (currentId === '' || last === undefined || lastId !== currentId) {
                entries.push({ time: triggerTime, message: trigger });
            }
        }
        entries.sort((a, b) => a.time - b.time);
        const oldestFetched = messages.reduce((oldest, message) => {
            const time = Number(message?.time ?? 0);
            return time > 0 && time < oldest ? time : oldest;
        }, Infinity);
        const pageFull = messages.length >= total;
        const truncated = watermarkMissed
            || (anchorTime > 0 && (entries.length > keep || (pageFull && oldestFetched > anchorTime)));
        const window = keep === 0 ? [] : entries.slice(-keep);
        // 窗口按时间升序，第一条带 seq 的历史消息即窗口最早一条，作为向前翻页的起点。
        const earliest = truncated ? window.find(entry => entry.message?.message_seq != null) : undefined;
        const cursor = earliest === undefined ? null : Number(earliest.message.message_seq);
        return { entries: window, truncated, cursor };
    }
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
    noteInjected(chatId, pointer) {
        const settings = this.ctx.getSettings(chatId);
        const id = String(pointer.id ?? '');
        const time = Number(pointer.time ?? 0);
        if (id === '' && time <= 0)
            return;
        settings.recentWatermark = { time: time > 0 ? time : (settings.recentWatermark?.time ?? 0), id };
        this.ctx.saveMapping();
    }
    /**
     * 记录一条不指向机器人的系统事件（戳一戳、撤回、禁言、成员变动等），
     * 等下一次载荷注入时并回时间线。事件不唤醒回合：进入上下文，而不是发起对话。
     *
     * Args:
     *   chatId (ChatId): 事件所属会话。
     *   notice (NoticeRecord): 已归一化的事件记录。
     *
     * Returns:
     *   void: 无返回值。
     *
     * Callers:
     *   - `processInbound`（wakes 为 false 的 notice）。
     */
    rememberNotice(chatId, notice) {
        if (chatId === '')
            return;
        const at = Math.floor(this.now() / 1000);
        const buffer = this.contextBuffers.get(chatId) ?? [];
        buffer.push({ at, notice });
        while (buffer.length > 100)
            buffer.shift();
        this.contextBuffers.set(chatId, buffer);
    }
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
    async memberNames(groupId) {
        const cached = this.memberCache.get(groupId);
        if (cached !== undefined && this.now() - cached.at < MEMBER_CACHE_TTL_MS)
            return cached.names;
        const inflight = this.memberFetches.get(groupId);
        if (inflight !== undefined)
            return await inflight;
        const fetch = (async () => {
            try {
                const data = await this.ctx.call('get_group_member_list', { group_id: Number(groupId) });
                const names = cached?.names ?? new Map();
                for (const member of Array.isArray(data) ? data : []) {
                    const id = String(member.user_id ?? '');
                    if (id === '')
                        continue;
                    const name = typeof member.card === 'string' && member.card !== '' ? member.card
                        : typeof member.nickname === 'string' ? member.nickname : '';
                    if (name !== '')
                        names.set(id, name);
                }
                this.memberCache.set(groupId, { at: this.now(), names });
                return names;
            }
            catch (error) {
                this.ctx.log('debug', 'get_group_member_list failed: ' + describeError(error));
                return cached?.names ?? new Map();
            }
            finally {
                this.memberFetches.delete(groupId);
            }
        })();
        this.memberFetches.set(groupId, fetch);
        return await fetch;
    }
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
    rememberMember(groupId, qq, name) {
        if (groupId === '' || qq === '' || name === '' || name === qq)
            return;
        const entry = this.memberCache.get(groupId);
        if (entry !== undefined)
            entry.names.set(qq, name);
        else
            this.memberCache.set(groupId, { at: 0, names: new Map([[qq, name]]) });
    }
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
    async resolveMediaPath(ref, chatId) {
        const token = mediaToken(ref);
        const memoized = token === '' ? undefined : this.mediaMemo.get(token);
        if (memoized !== undefined) {
            if (await fileExists(memoized))
                return memoized;
            this.mediaMemo.delete(token);
        }
        const path = await resolveMedia(ref, {
            call: this.ctx.call.bind(this.ctx),
            store: this.ctx.media,
            nas: candidate => this.resolveNasFile(candidate),
        });
        if (path === '')
            return '';
        if (token !== '') {
            if (this.mediaMemo.size >= MEDIA_MEMO_MAX) {
                const oldest = this.mediaMemo.keys().next().value;
                if (oldest !== undefined)
                    this.mediaMemo.delete(oldest);
            }
            this.mediaMemo.set(token, path);
        }
        return path;
    }
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
    async resolveNasFile(ref) {
        const name = ref.name !== undefined && ref.name !== '' ? ref.name : 'file';
        // 发送方给的名字永远不成为磁盘路径：只有白名单扩展名能进新文件名的后缀。
        const ext = extForInboundName(name);
        const maxBytes = this.ctx.config.maxInboundFileBytes > 0 ? this.ctx.config.maxInboundFileBytes : undefined;
        const fid = ref.fileId ?? ref.file ?? '';
        if (fid === '')
            return '';
        // 1. 私聊直链：不依赖任何容器内路径。
        try {
            const direct = await this.ctx.call('get_private_file_url', { file_id: fid });
            if (direct.url !== undefined && direct.url !== '') {
                const localPath = await this.ctx.media.downloadUrl(direct.url, ext, maxBytes);
                this.ctx.log('info', 'qq file fetched via direct link: ' + localPath);
                return localPath;
            }
        }
        catch (error) {
            this.ctx.log('debug', 'get_private_file_url failed (falling back to get_file): ' + describeError(error));
        }
        // 2. get_file：开启文件服务器时返回 base64 或 http url，否则是不可达的容器路径。
        try {
            const data = await this.ctx.call('get_file', { file: fid });
            const size = Number(data.file_size ?? 0);
            if (this.ctx.config.maxInboundFileBytes > 0 && size > this.ctx.config.maxInboundFileBytes) {
                this.ctx.log('warn', 'qq file too large (' + size + 'B), skipping fetch');
                currentTrace()?.emit('media', { ok: false, reason: TRACE_REASONS.nasFileTooLarge });
                return '';
            }
            if (data.base64 !== undefined && data.base64 !== '') {
                const localPath = await this.writeMediaFile(Buffer.from(data.base64, 'base64'), ext);
                this.ctx.log('info', 'qq file fetched via get_file base64: ' + localPath);
                return localPath;
            }
            if (data.url !== undefined && /^https?:\/\//.test(data.url)) {
                const localPath = await this.ctx.media.downloadUrl(data.url, ext, maxBytes);
                this.ctx.log('info', 'qq file fetched via get_file url: ' + localPath);
                return localPath;
            }
        }
        catch (error) {
            this.ctx.log('debug', 'get_file base64/url path failed: ' + describeError(error));
        }
        this.ctx.log('warn', 'qq file fetch failed: no direct link / base64 / http url available for ' + fid);
        currentTrace()?.emit('media', { ok: false, reason: TRACE_REASONS.nasFileFailed });
        return '';
    }
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
    async writeMediaFile(buffer, ext) {
        try {
            await this.ctx.media.ensure();
            const localPath = this.ctx.media.freshPath(ext);
            await writeFile(localPath, buffer);
            return localPath;
        }
        catch (error) {
            this.ctx.log('warn', 'media write failed: ' + describeError(error));
            return '';
        }
    }
    /**
     * 载荷的回合级后果：最后一条记录（要回答的这条）的语音后台转写。
     *
     * Args:
     *   records (ConversationRecord[]): 本回合记录。
     *   chatId (ChatId): 会话 id。
     *
     * Returns:
     *   无。
     *
     * Callers:
     *   - `processInbound`、`sleepTurn`。
     */
    applyTurnSideEffects(records, chatId) {
        const last = records[records.length - 1];
        if (last === undefined || 'notice' in last || !this.ctx.transcriber.enabled)
            return;
        // 回填后的段只带本机路径：哪一种媒体要转写，由媒体类型自己声明。
        const fileOf = (segment) => {
            const data = segment.data;
            return data.file !== undefined && data.file !== '' ? data.file : '';
        };
        for (const segment of last.message) {
            const kind = mediaKindOf(segment);
            const file = fileOf(segment);
            if (kind !== undefined && MEDIA_KINDS[kind].transcribe === true && file !== '') {
                void this.transcribeLater(file, chatId);
            }
        }
    }
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
    async transcribeLater(path, chatId) {
        try {
            const text = await this.ctx.transcriber.transcribe(path);
            if (transcriptLabel(text) === '') {
                this.ctx.log('debug', '语音转写结果为空: ' + path);
                currentTrace()?.emit('transcribe', { ok: false, reason: TRACE_REASONS.sttEmpty });
                return;
            }
            this.ctx.steerTranscript(chatId, text);
        }
        catch (error) {
            this.ctx.log('warn', 'STT failed: ' + describeError(error));
            currentTrace()?.emit('transcribe', { ok: false, reason: '语音转写失败: ' + describeError(error) });
        }
    }
    /** 当前是否处于休眠窗口（每日窗口或高峰时段）。 */
    sleeping() {
        return sleepingNow(this.ctx.config, this.now());
    }
    /** 占位说明：为什么现在是睡觉时间。 */
    dormancyNotice() {
        if (this.ctx.config.sleepMode === 'peak') {
            return '现在是高峰时段（北京时间工作日 9:00–12:00、14:00–18:00，价格翻倍），该睡了。';
        }
        return '现在是休眠时段（' + String(this.ctx.config.sleepStart ?? '') + '–' + String(this.ctx.config.sleepEnd ?? '') + '），该睡觉了。';
    }
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
    async sleepTurn(chatId, inbound) {
        const key = dormancyKey(this.ctx.config, this.now());
        if (this.sleepNotices.get(chatId) === key) {
            this.ctx.log('debug', '休眠时段内已提示过，消息丢弃: ' + chatId);
            return false;
        }
        this.sleepNotices.set(chatId, key);
        const trigger = inbound.notice === undefined ? inbound.message : undefined;
        const window = await this.recentMessages(chatId, inbound.groupId, trigger, true);
        const records = [];
        for (const entry of window.entries) {
            if (entry.notice !== undefined) {
                records.push(entry.notice);
            }
            else if (entry.message !== undefined && String(entry.message.message_id ?? '') !== String(inbound.messageId ?? '')) {
                records.push(await this.recordOf(entry.message, chatId));
            }
        }
        if (trigger !== undefined)
            records.push(await this.recordOf(trigger, chatId));
        else if (inbound.notice !== undefined)
            records.push(inbound.notice);
        records.push(systemRecord(this.dormancyNotice(), formatClock(this.now())));
        this.applyTurnSideEffects(records, chatId);
        await this.ctx.dispatchFollowup(chatId, formatRecords(records), 'admin', SYSTEM_NICKNAME);
        return true;
    }
    /**
     * 定时唤醒：取该群/私聊的上文（只读，不推进水位），末尾追加一条
     * 系统提醒后投递回合。定时挂在群/私聊上，因此与当前绑定哪个会话无关。
     *
     * Args:
     *   chatId (ChatId): 定时绑定的群或私聊。
     *   note (string): 到点要提醒的内容。
     *
     * Returns:
     *   Promise<void>: 投递完成。
     *
     * Callers:
     *   - `src/bridge/index.ts`：TimerRunner 的 deliver 回调。
     */
    async wakeWithNote(chatId, note) {
        const { kind, target } = splitChatId(chatId);
        const window = await this.recentMessages(chatId, kind === 'group' ? target : '', undefined, true);
        const records = [];
        for (const entry of window.entries) {
            if (entry.notice !== undefined)
                records.push(entry.notice);
            else if (entry.message !== undefined)
                records.push(await this.recordOf(entry.message, chatId));
        }
        records.push(systemRecord('定时提醒：' + note, formatClock(this.now())));
        await this.ctx.dispatchFollowup(chatId, formatRecords(records), 'admin', SYSTEM_NICKNAME);
    }
}
/**
 * 触发消息的秒级时间；没有触发消息（notice 触发）时取当前时间。
 *
 * Args:
 *   trigger (RawMessage | undefined): 触发消息。
 *   now (number): 毫秒时间戳。
 *
 * Returns:
 *   number: 秒级时间戳。
 *
 * Callers:
 *   - `InboundPipeline.recentMessages`。
 */
function triggerTimeOf(trigger, now) {
    return Number(trigger?.time ?? Math.floor(now / 1000));
}
/**
 * 把引用消息 id 转成可安全请求的数字；空串、十六进制、小数、指数写法一律拒绝。
 *
 * Args:
 *   messageId (string): OneBot 引用段里的 id。
 *
 * Returns:
 *   number | undefined: 可用的整数 id；不可安全请求时 undefined。
 *
 * Callers:
 *   - `InboundPipeline.processInbound`：引用作者校验前的 id 检查。
 */
function numericReplyId(messageId) {
    const raw = String(messageId);
    if (raw.trim() !== raw || !/^-?\d+$/.test(raw))
        return undefined;
    const value = Number(raw);
    return Number.isSafeInteger(value) ? value : undefined;
}
/** 媒体引用的稳定标识（缓存文件名优先于会过期的 CDN 地址）。 */
function mediaToken(ref) {
    const value = ref.file !== undefined && ref.file !== '' ? ref.file : ref.url;
    return typeof value === 'string' && value !== '' ? ref.kind + '|' + value : '';
}
/** 已取到的媒体文件是否还在（临时清理会轮换）。 */
async function fileExists(path) {
    try {
        await stat(path);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * 把一个媒体段换成带本机路径的段：文件段带上原始文件名，图片带上贴纸说明。
 *
 * Args:
 *   segment (Segment): 原媒体段。
 *   ref (MediaRef): 媒体引用。
 *   path (string): 本机路径。
 *
 * Returns:
 *   Segment: 回填后的段。
 *
 * Callers:
 *   - `fillMediaSegments`。
 */
function withMediaPath(segment, ref, path) {
    if (mediaKindOf(segment) === undefined)
        return segment;
    return { ...segment, data: MEDIA_KINDS[ref.kind].resolved(ref, path) };
}
/**
 * 把一个媒体引用解析成本地路径：取字节方式与文件兜底都由媒体类型自己决定。
 *
 * Args:
 *   ref (MediaRef): 媒体引用。
 *   ports (MediaPorts): 动作调用、媒体存储与文件兜底。
 *
 * Returns:
 *   Promise<string>: 本机路径；取不到时 ''。
 *
 * Callers:
 *   - `resolveMediaPath`。
 */
async function resolveMedia(ref, ports) {
    const spec = MEDIA_KINDS[ref.kind];
    if (spec.nas === true)
        return await ports.nas(ref);
    const resolved = await ports.store.resolve(ref, async (_kind, file) => spec.fetch?.(ports.call, file));
    return resolved === undefined ? '' : resolved.path;
}
