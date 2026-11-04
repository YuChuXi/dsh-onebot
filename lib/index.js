/**
 * dsh-onebot: a QQ (OneBot 11 / NapCat) chat channel for DeepSeek Harness.
 *
 * Mounts inside the dsh host process: a reverse- or forward-WebSocket link to
 * NapCat, one Agent per QQ chat, inbound images/voice handled for the model
 * (whisper STT when enabled), outbound sends driven exclusively by qq_* tool
 * calls, merged-forward sending, allowlist/mention access control, and a set
 * of qq_* tools for media and NapCat APIs.
 * @module dsh-onebot
 */
import { parseModelRoute } from './bridge/model-route.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
// R1 部署加固：peer 依赖解析失败/关键模块缺失时必须显眼报错并 fail-loud，
// 不能静默不挂载。静态 import 会在本模块任何代码运行之前就以晦涩的
// ERR_MODULE_NOT_FOUND 失败（宿主侧表现为插件被静默跳过），因此运行时
// 值依赖改为入口顶部受控动态加载：失败时先输出含「peer/依赖」的显式
// 错误，再把原错误抛出。
let z;
let OneBotConnection;
let ChatBridge;
let MediaStore;
let IMAGE_MAX_BYTES;
let VOICE_MAX_BYTES;
let MEDIA_MAX_BYTES;
let Transcriber;
let TraceSink;
let InboundRecorder;
let InjectChannel;
let describeError;
try {
    ;
    ({ default: z } = await import('@deepseek-ai/schemastery'));
    ({ OneBotConnection } = await import('./onebot/connection.js'));
    ({ ChatBridge } = await import('./bridge/index.js'));
    ({ MediaStore, IMAGE_MAX_BYTES, VOICE_MAX_BYTES, MEDIA_MAX_BYTES } = await import('./media/store.js'));
    ({ Transcriber } = await import('./media/stt.js'));
    ({ TraceSink } = await import('./ops/trace.js'));
    ({ InboundRecorder } = await import('./ops/record.js'));
    ({ InjectChannel } = await import('./inbound/inject.js'));
    ({ describeError } = await import('./shared/errors.js'));
}
catch (error) {
    console.error('[dsh-onebot] 挂载失败：peer 依赖解析失败或关键模块缺失 —— 部署副本必须带完整 node_modules 链接集（scripts/link-host.sh 产物），只复制 lib/ 不够。原始错误：' + (error instanceof Error ? error.message : String(error)));
    throw error;
}
export const name = 'dsh-onebot';
export const inject = ['tools', 'systemPrompt', 'agents', 'sessions', 'agentDefaultModel', 'agentPresets', 'sessionPersistence', 'workspaceRegistry', 'commands', 'llm', 'skills'];
const ENV = (name) => process.env[name] ?? '';
/** Default media dir: <dsh-home>/media/onebot (dsh-home = $DSH_HOME or ~/.dsh). */
export function defaultMediaDir() {
    // os.homedir() reads $HOME first and falls back to the passwd entry; the
    // '/tmp' default covers the case where neither exists.
    const home = ENV('DSH_HOME') !== '' ? ENV('DSH_HOME') : join(homedir() || '/tmp', '.dsh');
    return join(home, 'media', 'onebot');
}
/** The dsh data home ($DSH_HOME or ~/.dsh); source of the .agent-presets dir. */
export function dshHome() {
    return ENV('DSH_HOME') !== '' ? ENV('DSH_HOME') : join(homedir() || '/tmp', '.dsh');
}
/** Schema defaults for the media size fields. */
const INBOUND_IMAGE_MAX_PX = 2048;
const OUTBOUND_IMAGE_MAX_BYTES = IMAGE_MAX_BYTES;
const INBOUND_FILE_MAX_BYTES = 20 * 1024 * 1024;
export const Config = z.object({
    mode: z.union([z.const('reverse'), z.const('forward')]).default('reverse')
        .description('连接模式：reverse = NapCat ws-reverse 拨入（本插件监听端口）；forward = 本插件主动连接 NapCat 的 ws 服务'),
    host: z.string().default('127.0.0.1')
        .description('reverse 模式监听地址；跨机部署（NapCat 从其他机器拨入）需显式改为 0.0.0.0'),
    port: z.number().default(8643)
        .description('reverse 模式监听端口'),
    url: z.string().default('ws://127.0.0.1:3001')
        .description('forward 模式的 NapCat ws 地址'),
    accessToken: z.string().role('secret').default('')
        .description('OneBot access_token（reverse 校验 / forward 发送 Authorization: Bearer）'),
    reconnectMaxAttempts: z.number().default(100)
        .description('forward 模式重连上限：连续失败达到该次数后放弃重连并打印恢复指引；0 = 无限重试（退避间隔封顶 60s）'),
    botQQ: z.string().default('')
        .description('机器人自身 QQ 号；留空则从 meta 事件自动学习'),
    requireMention: z.boolean().default(true)
        .description('群聊是否仅在 @机器人（或回复其消息）时响应'),
    steerEnabled: z.boolean().default(false)
        .description('插话开关（设置面板复选框）：开=任务运行中收到的新消息作为补充指令插进当前回合（模型下一步读取）；关=排队到下一回合。文字/图片/文件/语音/引用/合并转发消息一视同仁，资格与受限成员判定另由 steerAllMembers/steerAllowRestricted 控制'),
    steerAllMembers: z.boolean().default(false)
        .description('插话资格（设置面板复选框）：开=所有成员都能插话；关（默认）=仅管理员'),
    steerAllowRestricted: z.boolean().default(true)
        .description('受限成员插话（设置面板复选框）：开（默认）=群内受限成员也能插话；关=受限成员始终排队。只在插话开关打开时生效'),
    dmPolicy: z.union([z.const('open'), z.const('allowlist'), z.const('disabled')]).default('open')
        .description('私聊策略：open=仅管理员；allowlist=仅 allowFrom；disabled=拒绝所有私聊'),
    groupPolicy: z.union([z.const('open'), z.const('allowlist'), z.const('disabled')]).default('open')
        .description('群聊策略：open=所有群；allowlist=仅 groupAllowFrom；disabled=拒绝所有群'),
    allowFrom: z.array(z.string()).default([])
        .description('dmPolicy=allowlist 时允许私聊的 QQ 号'),
    groupAllowFrom: z.array(z.string()).default([])
        .description('groupPolicy=allowlist 时允许的群号'),
    adminUsers: z.array(z.string()).default([])
        .description('管理员 QQ 号（也可用环境变量 ONEBOT_ALLOWED_USERS 逗号分隔指定）'),
    allowAllUsers: z.boolean().default(false)
        .description('放行所有用户（仅开发用；也可用 ONEBOT_ALLOW_ALL_USERS=true）'),
    ignoreSelf: z.boolean().default(true)
        .description('忽略机器人自己发出的消息（防自循环）'),
    sendErrorNotice: z.boolean().default(true)
        .description('一轮运行出错时向用户发送错误提示'),
    outboundIntervalBaseMs: z.number().min(0).default(300)
        .description('出站节流：同一会话相邻两条消息的基础间隔（毫秒）'),
    outboundIntervalPerCharMs: z.number().min(0).default(60)
        .description('出站节流：每条消息按字数追加的间隔（毫秒/字）'),
    outboundIntervalJitterPct: z.number().min(0).max(100).default(30)
        .description('出站节流：间隔的随机抖动百分比（0–100），避免发送节奏完全固定'),
    recentMessages: z.number().min(0).max(100).default(50)
        .description('每次被 @ 时注入的记录总条数（含当前消息；顶部「更早的消息已省略」那条不计数；0=只注入当前消息）。群聊从持久化水位向当前消息截取，私聊只有当前消息'),
    sleepMode: z.union([z.const('window'), z.const('peak')]).default('window')
        .description('休眠模式：window=用下面的开始/结束时间（每日时段）；peak=按高峰价格时段休眠（北京时间工作日 9:00–12:00、14:00–18:00）'),
    sleepStart: z.string().default('')
        .description('休眠时段开始（HH:MM，Asia/Shanghai 墙钟）；留空=不启用，须与 sleepEnd 同时设置；可跨午夜，如 23:30'),
    sleepEnd: z.string().default('')
        .description('休眠时段结束（HH:MM）；休眠期间不响应唤醒，每个会话每个时段把首个唤醒交给模型回一句「该睡了」，之后静默'),
    restrictedMemberPrefix: z.boolean().default(true)
        .description('群聊里 role 非 owner/admin 的成员按受限用户处理（仅问答，禁止文件/终端/配置等操作）'),
    extraPromptPrivate: z.string().default('')
        .description('私聊附加提示词：人设、背景、语言风格等，原样注入系统提示词；留空不注入'),
    extraPromptGroup: z.string().default('')
        .description('群聊附加提示词：人设、背景、语言风格等，原样注入系统提示词；留空不注入'),
    thinkingPrivate: z.union([z.const('off'), z.const('low'), z.const('high'), z.const('max'), z.const('default')]).default('default')
        .description('私聊新建会话的思考强度：off/low/high/max；default=跟随部署默认。已有会话保留自己的选择'),
    thinkingGroup: z.union([z.const('off'), z.const('low'), z.const('high'), z.const('max'), z.const('default')]).default('default')
        .description('群聊新建会话的思考强度：off/low/high/max；default=跟随部署默认。已有会话保留自己的选择'),
    modelPrivate: z.string().default('')
        .description('私聊使用的模型：`provider/model`（如 opencode-go/deepseek-v4.1-flash）；留空 = 部署默认。设置页用下拉选择，保存时按宿主模型能力校验'),
    modelGroup: z.string().default('')
        .description('群聊使用的模型：`provider/model`；留空 = 部署默认。设置页用下拉选择，保存时按宿主模型能力校验'),
    mediaDir: z.string().default('')
        .description('入站媒体与映射文件目录；留空默认 <dsh-home>/media/onebot'),
    tempTtlHours: z.number().default(6)
        .description('入站临时媒体文件保留时长（小时），到期自动清理'),
    outboundImageMaxBytes: z.number().default(OUTBOUND_IMAGE_MAX_BYTES)
        .description('出站图片大小上限（字节）'),
    inboundImageMaxPx: z.number().default(INBOUND_IMAGE_MAX_PX)
        .description('入站图片长边上限（像素）；超过则等比压缩后交给视觉模型，<=0 禁用'),
    maxVoiceBytes: z.number().default(VOICE_MAX_BYTES)
        .description('出站语音大小上限（字节）'),
    maxFileBytes: z.number().default(MEDIA_MAX_BYTES)
        .description('出站视频/文件大小上限（字节）'),
    sttEnabled: z.boolean().default(true)
        .description('入站语音是否转写（需要 ffmpeg 和 whisper CLI；失败时降级为 [语音] 占位）'),
    sttEngine: z.union([z.const('auto'), z.const('openai'), z.const('whisper-cpp'), z.const('custom')]).default('auto')
        .description('STT 引擎：auto 自动探测 whisper-cli / whisper / mlx_whisper'),
    sttCommand: z.string().default('')
        .description('custom 引擎的程序名/路径'),
    sttArgs: z.array(z.string()).default([])
        .description('custom 引擎参数模板，{file} 与 {out} 会被替换'),
    sttModel: z.string().default('small')
        .description('whisper 模型（openai: small/base/medium...；whisper.cpp: 模型名或 .bin 绝对路径）'),
    sttTimeoutMs: z.number().default(60_000)
        .description('单次转写超时（毫秒，默认 60000）；超时后占位即终态，不追加转写'),
    agentPreset: z.string().default('')
        .description('QQ 会话加入的 agent 预设 id；留空用部署默认（settings 的 agent-presets.default，当前为 router-flash）。创建时总是解析有效预设并写入会话 header，Web 界面可见；resume 优先恢复会话自己记录的预设'),
    workspacePath: z.string().default('')
        .description('QQ 会话的工作区目录（写入会话 cwd，并自动归入该工作区，不存在则创建）；留空时使用宿主进程工作目录并在启动时告警提醒（宿主未提供可编程查询的默认工作区），单聊 /workspace 覆盖优先且已持久化到会话映射文件，重启/恢复失败均不丢失'),
    inboundFileMaxBytes: z.number().default(INBOUND_FILE_MAX_BYTES)
        .description('QQ 入站文件最大字节数（直链/base64 拉取，0 = 不限制）'),
    allowPrivateHosts: z.boolean().default(false)
        .description('下载 SSRF 防护逃生门：默认拒绝解析到私网/环回/链路本地地址的下载目标（协议仅 http/https、重定向逐跳复检仍生效）；NapCat 文件服务器或反代部署在本机/内网时置 true 跳过私网检查'),
    chatIdleEvictDays: z.number().default(7)
        .description('会话空闲淘汰天数：chat 超过该天数无任何活动时，在下一条入站消息处理前清理其 agent（会话先落盘 flush、映射保留，之后同一 chat 的消息可 resume 恢复原会话）；0 = 禁用'),
    dedupWindowSeconds: z.number().default(300)
        .description('入站消息去重窗口（秒，W2-②）：同一会话内相同 message_id 在该窗口内重投（断线重连重放等）只处理第一条，后续静默跳过并记 debug；仅对会触发回复处理的消息事件生效（notice/meta 类不经过此闸）；0 = 禁用去重'),
    traceEnabled: z.boolean().default(false)
        .description('链路追踪（W1）：为每条入站消息生成 traceId 并贯穿入站→模型回合→出站，决策事件（含限流/去重/白名单/@ 门控/闸门拒发与每个静默丢弃分支的中文 reason）逐行 JSON 落盘 mediaDir/qq-trace.jsonl（4MiB 改名轮转，保留 qq-trace.1/2.jsonl；同一原因 5 分钟限频）；默认关闭——关闭时不生成 traceId、不落盘'),
    traceLevel: z.union([z.const('debug'), z.const('warn')]).default('debug')
        .description('追踪事件级别（W1）：debug=记录全部决策事件；warn=仅记录 ok:false（被拒/失败/丢弃）事件'),
    recordInbound: z.boolean().default(false)
        .description('入站录制（W1）：把收到的每条入站事件（含被门控跳过的，附当时决策 reason）按可回放形状逐行 JSON 追加写 mediaDir/qq-inbox.jsonl（2MiB 改名轮转，保留 qq-inbox.1/2.jsonl；注入的帧不会被二次录制）；纯旁路：写失败仅 warn 限频，绝不影响回复管线；默认关闭——零文件零开销'),
    inboxRedact: z.boolean().default(false)
        .description('录制脱敏（W1）：落盘前把帧中 6 位以上的数字串（QQ 号/群号等）脱敏为前 3 位+****（数字型 id 字段一并处理），便于把录制文件发给别人离线回放；默认关闭'),
    injectEnabled: z.boolean().default(false)
        .description('事件注入通道（W1，仅调试用——信任边界：注入是调试通道，默认全关，勿在生产开启）：开启后按 injectIntervalMs 轮询 mediaDir/qq-inject.jsonl，把新行喂进真实入站管线（trace 事件标 stage=inject）；启动时已存在的历史行跳过并记一条说明；默认关闭'),
    injectDryRun: z.boolean().default(true)
        .description('注入干跑（W1）：true（默认，强烈建议保持）=注入回合触发的全部出站写操作（发消息/撤回等，含异步模型回合的最终回复——拦截点在出站动作层）被拦截计数、原文进 trace 事件、绝不真发 QQ；false=注入内容会真实发送，仅限隔离环境实验'),
    injectIntervalMs: z.number().default(2000)
        .description('注入队列轮询间隔（毫秒，W1；最小 500）'),
    logLevel: z.union([z.const('debug'), z.const('info'), z.const('warn'), z.const('error')]).default('info')
        .description('控制台日志级别门槛（debug < info < warn < error）：低于该级别的日志不输出。debug=全部输出（含「session 事件早退」等调试行）；info=常规信息（启动、连接建立、meta 事件等，默认）；warn=仅警告与错误；error=仅错误'),
});
/** Resolve env-var fallbacks into the effective access policy. */
function resolvePolicy(config) {
    const envAdmins = ENV('ONEBOT_ALLOWED_USERS')
        .split(',')
        .map(v => v.trim())
        .filter(v => v !== '');
    const adminUsers = [...new Set([...config.adminUsers, ...envAdmins])];
    return {
        dmPolicy: config.dmPolicy,
        groupPolicy: config.groupPolicy,
        allowFrom: config.allowFrom,
        groupAllowFrom: config.groupAllowFrom,
        adminUsers,
        allowAllUsers: config.allowAllUsers || ENV('ONEBOT_ALLOW_ALL_USERS').toLowerCase() === 'true',
        requireMention: config.requireMention,
    };
}
/** Severity rank for the logLevel gate (debug < info < warn < error). */
const LOG_LEVEL_RANK = { debug: 0, info: 1, warn: 2, error: 3 };
/** Mount the plugin. */
export function apply(ctx, config) {
    const mediaDir = config.mediaDir !== '' ? config.mediaDir : defaultMediaDir();
    const policy = resolvePolicy(config);
    const modelPrivate = parseModelRoute(config.modelPrivate, 'modelPrivate');
    const modelGroup = parseModelRoute(config.modelGroup, 'modelGroup');
    /** Console log line callback (level, message) — shared by the bridge deps,
     * the connection log port and the host-ready boot gate below (M2-C5b). */
    const log = (level, message) => {
        if (LOG_LEVEL_RANK[level] < LOG_LEVEL_RANK[config.logLevel])
            return;
        const prefix = '[dsh-onebot] ';
        if (level === 'error')
            console.error(prefix + message);
        else if (level === 'warn')
            console.warn(prefix + message);
        else
            console.log(prefix + message);
    };
    // T3 方案 B: the host exposes no queryable default workspace —
    // WorkspaceRegistry has no default getter and the session controller's
    // defaultCwd is assembly-internal — so the unconfigured fallback stays the
    // host process cwd. Say so once at mount so a /root surprise is explainable.
    if (config.workspacePath === '') {
        log('warn', '未配置 workspacePath：QQ 会话默认目录将使用宿主进程工作目录 ' + process.cwd() + '，建议在配置中设置 workspacePath，避免会话工作区落在宿主启动目录');
    }
    const connection = new OneBotConnection({
        mode: config.mode,
        host: config.host,
        port: config.port,
        url: config.url,
        accessToken: config.accessToken,
        reconnectMaxAttempts: config.reconnectMaxAttempts,
        callTimeoutMs: 30_000,
        log,
    });
    const media = new MediaStore(mediaDir, config.tempTtlHours, config.inboundImageMaxPx, { maxBytes: config.inboundFileMaxBytes, allowPrivateHosts: config.allowPrivateHosts });
    // W1: the trace sink exists only when explicitly enabled — default off
    // means no sink, no traceIds, no jsonl, zero behavior difference.
    const traceSink = config.traceEnabled
        ? new TraceSink({ dir: mediaDir, level: config.traceLevel, log: (level, message) => log(level, message) })
        : undefined;
    // W1/T5: the inbound recorder exists only when recordInbound is on (pure
    // bypass: its own writer, failures only warn); the inject channel only
    // when injectEnabled is on (DEBUG-ONLY) — both absent by default.
    const recorder = config.recordInbound
        ? new InboundRecorder({ dir: mediaDir, redact: config.inboxRedact, log: (level, message) => log(level, message) })
        : undefined;
    const injectChannel = config.injectEnabled
        ? new InjectChannel({
            dir: mediaDir,
            dryRun: config.injectDryRun,
            intervalMs: config.injectIntervalMs,
            handleEvent: async (event) => bridge.handleInbound(event, { injected: true }),
            trace: traceSink,
            log: (level, message) => log(level, message),
        })
        : undefined;
    const transcriber = new Transcriber({
        enabled: config.sttEnabled,
        engine: config.sttEngine,
        command: config.sttCommand,
        args: config.sttArgs,
        model: config.sttModel,
        timeoutMs: config.sttTimeoutMs,
    });
    connection.onEvent = (event) => {
        void bridge.handleInbound(event);
    };
    // W2-②③ 闸门键：BridgeConfig（bridge/config.ts）保持声明形状；管线通过
    // 可选交叉成员从运行期对象读取（见 InboundContext/OutboundContext.config），
    // 这里只负责把配置展开进桥接依赖。
    const gateConfig = {
        dedupWindowSeconds: config.dedupWindowSeconds,
    };
    const bridge = new ChatBridge({
        ctx,
        // M2-C5b: the bridge sees only explicit ports — the session-event feed
        // (this context's own `on`) and the two injectables below; the 'loader'
        // service lookup lives here, not in the bridge.
        hostReady: async () => {
            try {
                const loader = ctx.get('loader');
                await loader?.await();
            }
            catch (error) {
                log('debug', 'loader.await failed: ' + describeError(error));
            }
        },
        // Live llm lookup per call — same semantics as the pre-port live getter.
        llmCatalog: {
            listProviders: () => ctx.llm.listProviders(),
            listModels: provider => ctx.llm.listModels(provider),
            // 适配器未暴露 reasoning 时不设档位（空数组）；未知 route 让 llm 抛错。
            resolveReasoningEfforts: async (provider, model) => {
                const info = await ctx.llm.resolveModelInfo(provider, model);
                return info.reasoning === undefined ? [] : info.reasoning.efforts.map(effort => String(effort.id));
            },
        },
        connection,
        dshHome: dshHome(),
        media,
        transcriber,
        agents: ctx.agents,
        sessions: ctx.sessions,
        agentPresets: ctx.agentPresets,
        commands: ctx.commands,
        sessionPersistence: ctx.sessionPersistence,
        workspaceRegistry: ctx.workspaceRegistry,
        // 会话标题服务可能晚于插件注册：每次取名时现查。
        sessionTitle: () => ctx.get('sessionTitle'),
        agentDefaultModel: ctx.agentDefaultModel,
        defaultModel: () => {
            try {
                return ctx.agentDefaultModel.currentSelection();
            }
            catch {
                return undefined;
            }
        },
        config: {
            botQQ: config.botQQ,
            ignoreSelf: config.ignoreSelf,
            requireMention: config.requireMention,
            steerEnabled: config.steerEnabled,
            steerAllMembers: config.steerAllMembers,
            steerAllowRestricted: config.steerAllowRestricted,
            sendErrorNotice: config.sendErrorNotice,
            outboundIntervalBaseMs: config.outboundIntervalBaseMs,
            outboundIntervalPerCharMs: config.outboundIntervalPerCharMs,
            outboundIntervalJitterPct: config.outboundIntervalJitterPct,
            recentMessages: config.recentMessages,
            sleepMode: config.sleepMode,
            sleepStart: config.sleepStart,
            sleepEnd: config.sleepEnd,
            restrictedMemberPrefix: config.restrictedMemberPrefix,
            extraPromptPrivate: config.extraPromptPrivate,
            extraPromptGroup: config.extraPromptGroup,
            thinkingPrivate: config.thinkingPrivate,
            thinkingGroup: config.thinkingGroup,
            modelPrivate,
            modelGroup,
            mediaDir,
            maxImageBytes: config.outboundImageMaxBytes,
            maxVoiceBytes: config.maxVoiceBytes,
            maxFileBytes: config.maxFileBytes,
            agentPreset: config.agentPreset,
            workspacePath: config.workspacePath,
            maxInboundFileBytes: config.inboundFileMaxBytes,
            chatIdleEvictDays: config.chatIdleEvictDays,
            ...gateConfig,
            trace: traceSink,
            recorder,
            inject: injectChannel,
        },
        policy,
        log,
    });
    // Lifecycle: start the bridge and transport; unwind everything on unload.
    ctx.effect(() => {
        bridge.start();
        connection.start();
        injectChannel?.start();
        // QQ 平台说明与 qq_* 工具现按会话 agent 注入（见 ChatBridge.installChannelScope）
        return async () => {
            await injectChannel?.stop();
            await bridge.stop();
            await connection.stop();
        };
    }, 'dsh-onebot.lifecycle');
    console.log('[dsh-onebot] mounted (mode=' + config.mode + ', media=' + mediaDir + ', admins=' + policy.adminUsers.length + ')');
}
