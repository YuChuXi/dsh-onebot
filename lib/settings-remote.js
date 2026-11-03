/**
 * dsh-onebot — `onebotSettings` Typert Remote service（T3 · T1 定案 B 路径）
 *
 * Host-plane root service declared in cordis.patch.yml（仓库模板同名文件）via an
 * independent insert row (`- id: onebot-settings-remote / name:
 * <DEPLOY_DIR>/lib/settings-remote.js`)，so the api-gateway discovers the
 * `onebotSettings` Remote namespace and the settings page client（T4,
 * lib/client.js）can read/write the dsh-onebot entry's config override row.
 * 契约唯一来源：docs/settings-page-design.md（T1 定案）§2 / §3 / §3.1 / §4。
 *
 * Contract — namespace `onebotSettings`，每方法一个 descriptor，全 positional
 * （宿主网关按 descriptor 位置序调用，methodParameterNames 拒绝解构/默认值/
 * rest，dsh-api-gateway/lib/index.js:1458-1495）：
 *
 *   getSettings()                            → OnebotSettingsSnapshot
 *   updateSettings(patch, expectedRevision)  → OnebotSettingsSnapshot
 *   listWorkspaces()                         → WorkspaceListResult（W7：只读查询宿主
 *     dsh-workspace 注册表，供设置页「快速填入 workspace」；registry 缺席/list()
 *     失败一律降级为 {available:false, workspaces:[]}，不抛错——辅助查询绝不
 *     阻塞 getSettings/updateSettings 主链路，也绝不打开 registry 内部态）
 *
 * 持久层 = profile patch 中 `dsh-onebot` 条目的 config 覆盖行（T1 §3——设置页
 * /手改 patch/宿主原生设置页三方同源，无第二优先级）。写入经宿主
 * configEditor.edit（dsh-config-editor/lib/index.js:63-123：文件锁 + 原子写 +
 * reconcile 热生效 + 激活失败自动回滚），本模块不发明第二条写路径。
 *
 * revision 语义（T1 §3.1，对齐宿主 SettingsForms）：
 * - 每宿主进程、每服务实例一个内存计数器，从 0 开始，不持久化；
 * - 读侧每次调用将 entry.options.config 序列化为指纹与上次比较，任何来源的
 *   已提交变更都 +1（本 Remote / 宿主原生设置页 / HMR 后的手改 patch）；
 * - updateSettings 的 expectedRevision ≠ 当前值 → 拒写，抛
 *   RemoteError('onebot-settings/conflict', {expected, actual})；undefined =
 *   无条件写（对齐宿主 settingsController 的 expectedRevision 语义，
 *   dsh-api-settings-controller/lib/index.js:404）；
 * - 不递增：写入被拒（校验失败 / 锁冲突 / 激活失败回滚）、no-op（合并结果与
 *   当前生效 config 全等，跳过 edit）。
 *
 * 敏感字段：accessToken 快照返回侧脱敏——snapshot.config.accessToken 恒为
 * ''，明文是否已配置由 snapshot.secrets 标记（T1 §3 敏感字段行；写入侧在
 * patch 文件明文落盘是宿主既有管道默认行为，加密存储范围外）。
 *
 * @deepseek-ai/dsh-typert-protocol 不可解析时（裸 dev checkout；装好的 profile
 * 内可解析）降级为普通 cordis 服务而非炸掉插件加载（照抄
 * dsh-expert-orchestrator/lib/remote.js 的降级骨架）。
 */
import { isDeepStrictEqual } from 'node:util';
import { parseModelRoute } from './bridge/model-route.js';
/** patch insert 中 dsh-onebot 主条目的 id（T1 §2/§3：唯一持久层条目）。 */
export const ENTRY_ID = 'dsh-onebot';
/** Typert Remote 命名空间 = cordis 服务键（T1 §4）。 */
export const NAMESPACE = 'onebotSettings';
/** 快照固定值：37 键均为插件级热重启生效（T1 §5）。 */
export const REMOTE_EFFECT = 'restart';
/** 设置页 UI 六组 37 键（与 src/index.ts Config schema 的 Config 面向面板的键一一对应）。
 *  connection/permissions/behavior 三组是连接、权限与行为面；diagnostics（诊断）
 *  组收纳观测/调试布尔键——它们默认关、属观测/调试面，与前三组的使用频率与
 *  风险等级都不同，独立分组让「默认全关的调试开关」一眼可辨。
 *  behavior 组的插话开关以布尔形式暴露（steerEnabled/steerAllMembers/
 *  steerAllowRestricted/steerNotice）；附加提示词按私聊/群聊分列。 */
export const SETTINGS_GROUPS = {
    connection: ['mode', 'host', 'port', 'url', 'accessToken', 'botQQ', 'workspacePath'],
    permissions: ['requireMention', 'adminUsers', 'dmPolicy', 'groupPolicy', 'allowAllUsers', 'allowFrom', 'groupAllowFrom'],
    private: ['modelPrivate', 'thinkingPrivate', 'extraPromptPrivate'],
    group: ['modelGroup', 'thinkingGroup', 'extraPromptGroup'],
    behavior: ['sendErrorNotice', 'outboundIntervalBaseMs', 'outboundIntervalPerCharMs', 'outboundIntervalJitterPct', 'recentMessages', 'steerEnabled', 'steerAllMembers', 'steerAllowRestricted', 'steerNotice', 'sleepMode', 'sleepStart', 'sleepEnd'],
    diagnostics: ['traceEnabled', 'recordInbound', 'inboxRedact', 'injectEnabled', 'injectDryRun'],
};
/** schema 默认值（摘自 src/index.ts 的 Config schema），快照生效值的底层。 */
export const SCHEMA_DEFAULTS = {
    mode: 'reverse',
    host: '127.0.0.1',
    port: 8643,
    url: 'ws://127.0.0.1:3001',
    accessToken: '',
    botQQ: '',
    // W7：会话默认工作区路径（schema 默认 ''，src/index.ts:287——留空 = 宿主进程 cwd）。
    workspacePath: '',
    requireMention: true,
    adminUsers: [],
    dmPolicy: 'open',
    groupPolicy: 'open',
    allowAllUsers: false,
    allowFrom: [],
    groupAllowFrom: [],
    sendErrorNotice: true,
    // 出站节流：基础间隔 + 每字追加 + 抖动百分比（与 src/index.ts schema 默认一致）。
    outboundIntervalBaseMs: 300,
    outboundIntervalPerCharMs: 60,
    outboundIntervalJitterPct: 30,
    // 注入上文窗口的记录总条数（含触发消息；0 = 只注入触发消息）。
    recentMessages: 50,
    // 休眠：每日时段（window）或高峰时段（peak），时段留空 = 不启用。
    sleepMode: 'window',
    sleepStart: '',
    sleepEnd: '',
    // 附加提示词：按私聊/群聊分列，留空不注入。
    extraPromptPrivate: '',
    extraPromptGroup: '',
    // 新建会话的思考强度：默认跟随部署默认。
    thinkingPrivate: 'default',
    thinkingGroup: 'default',
    // 按会话类型的模型路由：空串 = 部署默认。
    modelPrivate: '',
    modelGroup: '',
    // 插话四开关（面板复选框；默认排队，仅管理员可插话，受限成员放行，插话回执开）。
    steerEnabled: false,
    steerAllMembers: false,
    steerAllowRestricted: true,
    steerNotice: true,
    // 可观测/调试布尔键（默认关）。
    traceEnabled: false,
    recordInbound: false,
    inboxRedact: false,
    injectEnabled: false,
    injectDryRun: true,
};
/** 快照返回侧脱敏的键（T1 §3 敏感字段行；写入侧明文落盘属宿主既有行为）。 */
export const SECRET_KEYS = ['accessToken'];
/** 思考强度档位（与 src/index.ts Config schema 的枚举一致）。 */
const THINKING_LEVELS = ['off', 'low', 'high', 'max', 'default'];
const ENUM_KEYS = {
    mode: ['reverse', 'forward'],
    dmPolicy: ['open', 'allowlist', 'disabled'],
    groupPolicy: ['open', 'allowlist', 'disabled'],
    sleepMode: ['window', 'peak'],
    thinkingPrivate: THINKING_LEVELS,
    thinkingGroup: THINKING_LEVELS,
};
const NUMBER_KEYS = ['port', 'outboundIntervalBaseMs', 'outboundIntervalPerCharMs', 'outboundIntervalJitterPct', 'recentMessages'];
/** 数字键取值范围（port 1–65535、间隔 ≥0；越界在 Remote 层拒绝）。 */
const NUMBER_RANGE = {
    port: [1, 65535],
    outboundIntervalBaseMs: [0, undefined],
    outboundIntervalPerCharMs: [0, undefined],
    outboundIntervalJitterPct: [0, 100],
    recentMessages: [0, 100],
};
/** 布尔键白名单（顺序对齐 SETTINGS_GROUPS 中 behavior 与 diagnostics 的键序）。
 *  调优数值键（dedupWindowSeconds、injectIntervalMs）与枚举键 traceLevel 不入
 *  UI 白名单，仍走 patch config 手改。 */
const BOOLEAN_KEYS = [
    'requireMention', 'allowAllUsers', 'sendErrorNotice',
    'steerEnabled', 'steerAllMembers', 'steerAllowRestricted', 'steerNotice',
    'traceEnabled', 'recordInbound', 'inboxRedact', 'injectEnabled', 'injectDryRun',
];
const STRING_KEYS = ['host', 'url', 'accessToken', 'botQQ', 'workspacePath', 'sleepStart', 'sleepEnd', 'extraPromptPrivate', 'extraPromptGroup', 'modelPrivate', 'modelGroup'];
const STRING_ARRAY_KEYS = ['adminUsers', 'allowFrom', 'groupAllowFrom'];
/** 全部 37 键（校验与快照的唯一键集；6 枚举 + 5 数字 + 12 布尔 + 11 字符串 + 3 字符串数组）。 */
export const ALL_KEYS = [
    ...Object.keys(ENUM_KEYS), ...NUMBER_KEYS, ...BOOLEAN_KEYS, ...STRING_KEYS, ...STRING_ARRAY_KEYS,
];
/**
 * 从宿主上下文惰性解析能力端口。
 *
 * Args:
 *   ctx ({ get(key: string): unknown } | undefined): 宿主上下文（服务宿主）。
 *
 * Returns:
 *   SettingsServices: 只含形状校验通过的服务；缺席项省略。
 *
 * Callers:
 *   - 服务类的 getSettings / updateSettings 方法。
 */
export function resolveSettingsServices(ctx) {
    const llm = ctx?.get?.('llm');
    const defaultModel = ctx?.get?.('agentDefaultModel');
    const usable = llm !== undefined
        && typeof llm.resolveModelInfo === 'function'
        && typeof llm.listProviders === 'function'
        && typeof llm.listModels === 'function';
    return {
        llm: usable ? llm : undefined,
        agentDefaultModel: defaultModel !== undefined && typeof defaultModel.currentSelection === 'function' ? defaultModel : undefined,
    };
}
/** typert-protocol 不可解析时的降级错误：结构对齐 RemoteError（code/details/
 *  isDSHRemoteError 标记），保证失败路径语义一致。 */
class FallbackRemoteError extends Error {
    code;
    details;
    isDSHRemoteError = true;
    constructor(code, message, details, options) {
        super(message, options);
        this.code = code;
        this.details = details;
        this.name = 'RemoteError';
    }
}
let protocol = null;
try {
    protocol = await import('@deepseek-ai/dsh-typert-protocol');
}
catch {
    protocol = null;
}
/** RemoteError 统一出口：协议在位用宿主类（跨域识别按 isDSHRemoteError），否则降级类。
 *  宿主类对 code 有 RemoteErrorDetailsMap 泛型约束（类型层），本服务使用自有
 *  onebot-settings/* 错误码（运行期任意字符串均可，网关原样透传），故统一收窄为
 *  本模块的宽松构造签名。 */
const RemoteError = (protocol?.RemoteError ?? FallbackRemoteError);
/** 乐观锁/降级以外唯一会抛的宿主依赖缺失情形：configEditor 不在位。 */
function requireConfigEditor(ctx) {
    const editor = ctx?.get?.('configEditor');
    if (!editor || typeof editor.entries !== 'function' || typeof editor.edit !== 'function') {
        throw new RemoteError('onebot-settings/no-config-editor', 'configEditor service is unavailable: the onebot-settings-remote row must mount beside the host bundle\'s dsh-config-editor', { entryId: ENTRY_ID });
    }
    return editor;
}
/** 在 profile patch 的可寻址条目中定位 dsh-onebot 主条目；不存在必须显式报错
 *  （T1 §2：条目不存在时返回明确错误，不得静默）。 */
function findEntry(editor) {
    const entry = editor.entries().find((candidate) => candidate?.options?.id === ENTRY_ID);
    if (!entry) {
        throw new RemoteError('onebot-settings/no-entry', `no active "${ENTRY_ID}" entry in the profile patch — mount dsh-onebot first`, { entryId: ENTRY_ID });
    }
    return entry;
}
/** T1 §2/§5：条目 fiber.state === 2 = active（与 configEditor.edit 的活性判据一致）。 */
function entryActiveOf(entry) {
    return entry.fiber !== undefined && entry.fiber.state === 2;
}
export function createRevisionState() {
    return { revision: 0, fingerprint: null };
}
function fingerprintOf(config) {
    return JSON.stringify(config ?? null);
}
/** §3.1 #2：读侧观察——config 指纹相对上次有差异即 +1（任何来源的已提交变更
 *  一视同仁）；首次调用仅建立基线不递增。 */
export function observeRevision(state, config) {
    const fingerprint = fingerprintOf(config);
    if (state.fingerprint !== null && fingerprint !== state.fingerprint)
        state.revision += 1;
    state.fingerprint = fingerprint;
    return state.revision;
}
/** W7：listWorkspaces 纯实现（descriptor 方法体共用；对 registry 形状做防御性
 *  校验——与 requireConfigEditor 同款「运行期再校验形状」风格，但绝不抛错：
 *  缺席/形状不符/list() 失败都归一为 unavailable 空列表）。 */
export function listWorkspaces(registry) {
    if (registry === undefined || typeof registry.list !== 'function') {
        return { available: false, workspaces: [] };
    }
    try {
        const workspaces = registry.list().map((workspace) => ({
            id: String(workspace?.id ?? ''),
            path: String(workspace?.path ?? ''),
            sessionCount: Array.isArray(workspace?.sessionIds) ? workspace.sessionIds.length : 0,
        }));
        return { available: true, workspaces };
    }
    catch {
        // 只读辅助查询：注册表异常（存储失败等）不该炸掉设置页，降级为不可用。
        return { available: false, workspaces: [] };
    }
}
/** W7：惰性解析宿主 workspaceRegistry（不经 static inject——保持可选依赖，
 *  registry 缺席时服务照常挂载，仅 listWorkspaces 降级 unavailable）。 */
function resolveWorkspaceRegistry(ctx) {
    const registry = ctx?.get?.('workspaceRegistry');
    return registry !== undefined && registry !== null && typeof registry.list === 'function' ? registry : undefined;
}
/** 33 键生效值 = schema 默认值 ← 条目 config 覆盖（T1 §3 合并优先级一句话）。 */
export function effectiveConfig(raw) {
    const effective = {};
    for (const key of ALL_KEYS) {
        const value = raw[key];
        effective[key] = value === undefined ? SCHEMA_DEFAULTS[key] : value;
    }
    return effective;
}
function buildSnapshot(entry, state) {
    const raw = entry.options.config ?? {};
    const revision = observeRevision(state, raw);
    const config = effectiveConfig(raw);
    const secrets = SECRET_KEYS.map((key) => {
        const set = typeof raw[key] === 'string' && raw[key].length > 0;
        config[key] = ''; // 脱敏：快照不回显明文（T1 §3）
        return { path: [key], set };
    });
    return {
        revision,
        entryActive: entryActiveOf(entry),
        config,
        secrets,
        groups: Object.fromEntries(Object.entries(SETTINGS_GROUPS).map(([group, keys]) => [group, [...keys]])),
        effect: REMOTE_EFFECT,
    };
}
/** updateSettings 入参校验（T1 §4：33 键的任意子集，扁平 JSON）。未知键整单
 *  拒绝（不静默丢弃）；类型/枚举不符拒绝；具体取值合法性交由宿主 schemastery
 *  校验 + reconcile 失败自动回滚兜底（T1 §5）。 */
export function validatePatch(patch) {
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
        throw new RemoteError('onebot-settings/bad-request', 'patch must be a flat JSON object keyed by setting names', {
            issues: ['patch 必须是扁平 JSON 对象'],
        });
    }
    const issues = [];
    const clean = {};
    for (const [key, value] of Object.entries(patch)) {
        const enums = ENUM_KEYS[key];
        if (enums !== undefined) {
            if (typeof value === 'string' && enums.includes(value))
                clean[key] = value;
            else
                issues.push(`${key} 必须是 ${enums.join(' | ')} 之一`);
        }
        else if (NUMBER_KEYS.includes(key)) {
            const [min, max] = NUMBER_RANGE[key];
            if (typeof value === 'number' && Number.isFinite(value) && value >= min && (max === undefined || value <= max))
                clean[key] = value;
            else
                issues.push(`${key} 必须是 ${max === undefined ? `≥${min}` : `${min}–${max}`} 的有限数字`);
        }
        else if (BOOLEAN_KEYS.includes(key)) {
            if (typeof value === 'boolean')
                clean[key] = value;
            else
                issues.push(`${key} 必须是布尔值`);
        }
        else if (STRING_KEYS.includes(key)) {
            if (typeof value === 'string')
                clean[key] = value;
            else
                issues.push(`${key} 必须是字符串`);
        }
        else if (STRING_ARRAY_KEYS.includes(key)) {
            if (Array.isArray(value) && value.every((item) => typeof item === 'string'))
                clean[key] = value;
            else
                issues.push(`${key} 必须是字符串数组`);
        }
        else {
            issues.push(`未知设置键 "${key}"（仅支持 ${ALL_KEYS.length} 键：${ALL_KEYS.join(', ')}）`);
        }
    }
    if (issues.length > 0) {
        throw new RemoteError('onebot-settings/bad-request', `invalid settings patch: ${issues.join('; ')}`, { issues });
    }
    return clean;
}
/** 某 route 支持的档位；provider/model 无法解析时按 bad-request 拒绝。 */
async function effortsOf(llm, provider, model) {
    let info;
    try {
        info = await llm.resolveModelInfo(provider, model);
    }
    catch (error) {
        throw new RemoteError('onebot-settings/bad-request', '无法解析模型 ' + provider + '/' + model + '：'
            + (error instanceof Error ? error.message : String(error)));
    }
    return info.reasoning === undefined ? [] : info.reasoning.efforts.map(effort => String(effort.id));
}
/** 解析某类型的模型路由配置；语法错误转 bad-request。 */
function routeOf(config, key) {
    const value = config[key];
    if (typeof value !== 'string')
        return undefined;
    try {
        return parseModelRoute(value, key);
    }
    catch (error) {
        throw new RemoteError('onebot-settings/bad-request', error instanceof Error ? error.message : String(error));
    }
}
/** 设置页两类会话的配置键：模型路由与思考强度。 */
const TYPE_KEYS = [
    { group: 'private', routeKey: 'modelPrivate', thinkingKey: 'thinkingPrivate' },
    { group: 'group', routeKey: 'modelGroup', thinkingKey: 'thinkingGroup' },
];
/**
 * 查询单个模型接受的思考强度档位（设置页切换模型时重算档位下拉的数据源）。
 *
 * Args:
 *   services (SettingsServices): 宿主 llm 能力端口。
 *   provider (string): 模型提供商 id。
 *   model (string): 模型 id。
 *
 * Returns:
 *   Promise<ModelEfforts>: 档位 id 列表；空数组表示该模型不接受思考强度。
 *
 * Callers:
 *   - `createOnebotSettingsMethods` 与两个服务分支的 getModelEfforts。
 */
export async function getModelEfforts(services, provider, model) {
    const llm = services.llm;
    if (llm === undefined) {
        throw new RemoteError('onebot-settings/bad-request', '宿主未提供模型能力查询（llm 服务缺席）');
    }
    return { efforts: await effortsOf(llm, provider, model) };
}
/**
 * 生成设置页的动态下拉选项：思考强度按各类型模型的能力给出。能力端口缺席、
 * 路由暂时无法解析时省略该键——读侧不阻断快照，客户端退回静态选项。
 *
 * Args:
 *   config (Record<string, unknown>): 当前生效配置。
 *   services (SettingsServices): 宿主 llm 能力与默认模型。
 *
 * Returns:
 *   Promise<Record<string, string[]>>: 设置键 → 选项（含 default）。
 *
 * Callers:
 *   - `getSettingsWithChoices`。
 */
export async function modelChoices(config, services) {
    const llm = services.llm;
    if (llm === undefined)
        return {};
    let routes;
    try {
        routes = TYPE_KEYS.map(({ routeKey, thinkingKey }) => ({ thinkingKey, route: routeOf(config, routeKey) }));
    }
    catch {
        return {};
    }
    const deployment = services.agentDefaultModel?.currentSelection();
    const choices = {};
    for (const { thinkingKey, route } of routes) {
        const provider = route?.provider ?? deployment?.provider;
        const model = route?.model ?? deployment?.model;
        if (provider === undefined || model === undefined)
            continue;
        try {
            choices[thinkingKey] = ['default', ...await effortsOf(llm, provider, model)];
        }
        catch {
            // 读侧：路由暂时解析不了就不提供动态选项，客户端用静态列表。
        }
    }
    return choices;
}
/**
 * 读取设置页 provider/model 下拉的数据；llm 缺席时省略（客户端隐藏模型控件）。
 *
 * Args:
 *   services (SettingsServices): 宿主 llm 目录端口。
 *
 * Returns:
 *   Promise<SettingsCatalog | undefined>: provider 列表与各自的模型。
 *
 * Callers:
 *   - `getSettingsWithChoices`。
 */
export async function modelCatalog(services) {
    const llm = services.llm;
    if (llm === undefined)
        return undefined;
    const providers = llm.listProviders().map(provider => ({ id: provider.id, name: provider.name ?? provider.id }));
    const models = {};
    for (const provider of providers) {
        try {
            models[provider.id] = (await llm.listModels(provider.id)).map(model => ({ id: model.id, name: model.name ?? model.id }));
        }
        catch {
            // 读侧：某个 provider 的模型列表暂时拉不到就留空，不影响其它 provider。
            models[provider.id] = [];
        }
    }
    return { providers, models };
}
/** getSettings 实现（descriptor 方法体共用；descriptor 参数 0 个）。 */
export function getSettings(editor, state) {
    return buildSnapshot(findEntry(editor), state);
}
/**
 * 给快照补上动态下拉选项与模型目录；读写两条路径共用同一份装配。
 *
 * Args:
 *   snapshot (OnebotSettingsSnapshot): 基础快照（生效值 + revision）。
 *   services (SettingsServices | undefined): 宿主能力端口。
 *
 * Returns:
 *   Promise<OnebotSettingsSnapshot>: 附带 choices / catalog 的快照。
 *
 * Callers:
 *   - `getSettingsWithChoices`。
 *   - `updateSettings`（写入成功与 no-op 两条返回路径）。
 */
async function withChoices(snapshot, services) {
    const resolved = services ?? {};
    return {
        ...snapshot,
        choices: await modelChoices(snapshot.config, resolved),
        catalog: await modelCatalog(resolved),
    };
}
/** 带动态下拉选项的快照（服务方法用；同步快照 + choices）。 */
export async function getSettingsWithChoices(editor, state, services) {
    return withChoices(getSettings(editor, state), services);
}
/** W6 错误归一：宿主 configEditor.edit 的原生失败（文件锁超时 / 活性检查 /
 *  schema 校验 / home-patch 守卫 / 激活失败回滚后 rethrow）按
 *  docs/m1-characterization/config-editor.md §3 矩阵归类，转成面板可直接渲染的
 *  中文 RemoteError('onebot-settings/edit-failed')，原始错误挂 cause（网关透传
 *  detail 不吞诊断信息）。归类按宿主错误消息特征词匹配，未命中走通用文案；
 *  所有分支的共同事实（该文档 §3 已钉死）：失败时 patch 文件要么从未被写、要么
 *  已被宿主逐字节还原，本模块不做任何补偿写（不重试、不回写），仅归一转发。 */
export const EDIT_FAILED_CODE = 'onebot-settings/edit-failed';
export function describeEditFailure(cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (/timed out waiting for the writer lock/i.test(message)) {
        return '写入失败：配置文件被其他写入方占用（等待文件锁超时），本次修改未落盘，请稍后重试';
    }
    if (/no longer available|changed during reload/i.test(message)) {
        return '写入失败：dsh-onebot 条目在编辑期间被替换或失活，本次修改未落盘，请刷新后重试';
    }
    if (/no longer active/i.test(message)) {
        return '写入失败：dsh-onebot 插件当前未激活，本次修改未落盘，请检查插件加载状态';
    }
    if (/overridden by a home patch|command-line overlay/i.test(message)) {
        return '写入失败：该配置被 home patch 或命令行覆盖层接管，修改被宿主拒绝；请改在对应层修改';
    }
    return `写入失败：宿主 configEditor 拒绝了本次修改（${message}），配置保持不变`;
}
/** updateSettings 实现（descriptor 参数 (patch, expectedRevision)，全 positional）。
 *
 * 流程：定位条目 → 观察当前 revision → 乐观锁校验 → patch 校验 → no-op 短路
 * （合并结果与当前生效 config 全等则不写、不递增）→ configEditor.edit 合并写
 * （next = fresh config ∪ patch，未知原键原样保留；等于继承层时由宿主整行删
 * 除覆盖行，dsh-config-editor/lib/index.js:93-104）→ 成功后返回新快照（指纹
 * 变化 → revision +1）。
 *
 * edit 失败按 describeEditFailure 归一为 onebot-settings/edit-failed 中文错误
 * 并保留 cause，宿主原生错误文案不下发网关；失败路径 revision 不递增（指纹
 * 观察只在成功后的 buildSnapshot 发生）、不重试、不补偿写，patch 文件由宿主
 * 保证未被破坏（config-editor.md §3 矩阵）。 */
export async function updateSettings(editor, state, patch, expectedRevision, services) {
    const entry = findEntry(editor);
    const actual = observeRevision(state, entry.options.config ?? {});
    if (expectedRevision !== undefined && (!Number.isInteger(expectedRevision) || expectedRevision !== actual)) {
        throw new RemoteError('onebot-settings/conflict', `expectedRevision ${String(expectedRevision)} does not match current revision ${actual}; re-read getSettings() and replay`, { expected: expectedRevision, actual });
    }
    const clean = validatePatch(patch);
    const current = entry.options.config ?? {};
    const merged = { ...current, ...clean };
    if (isDeepStrictEqual(merged, current))
        return withChoices(buildSnapshot(entry, state), services); // no-op：不递增（§3.1 #4）
    try {
        await editor.edit(entry, (fresh) => ({ ...fresh, ...clean }));
    }
    catch (cause) {
        // W6 错误归一：只翻译、不重试、不补偿写；宿主已保证 patch 文件未被破坏或已逐字节还原。
        // details 带宿主原文（可跨网关序列化），cause 仅进程内诊断。
        throw new RemoteError(EDIT_FAILED_CODE, describeEditFailure(cause), { hostMessage: cause instanceof Error ? cause.message : String(cause) }, { cause });
    }
    return withChoices(buildSnapshot(findEntry(editor), state), services);
}
/** 组装 descriptor 方法对象（测试与降级类共用；与类方法同一实现）。
 *  W7：workspaceRegistry 可选注入——省略时 listWorkspaces 降级 unavailable
 *  （与类分支的惰性 ctx 解析同一 listWorkspaces 纯函数出口）。 */
export function createOnebotSettingsMethods(editor, state = createRevisionState(), workspaceRegistry, services) {
    return {
        getSettings: () => getSettingsWithChoices(editor, state, services ?? {}),
        updateSettings: (patch, expectedRevision) => updateSettings(editor, state, patch, expectedRevision, services),
        getModelEfforts: (provider, model) => getModelEfforts(services ?? {}, provider, model),
        listWorkspaces: async () => listWorkspaces(workspaceRegistry),
    };
}
/** 把 typert-protocol 的 Remote 标记应用到类原型（无原生装饰器语法的 shim，
 *  照抄 dsh-expert-orchestrator/lib/remote.js:99-115；mark() 对同一原型幂等）。 */
function markRemote(klass, methodName) {
    if (!protocol?.Remote)
        return;
    const initializers = [];
    const decorator = protocol.Remote(methodName);
    decorator(undefined, {
        name: methodName,
        private: false,
        static: false,
        addInitializer(fn) { initializers.push(fn); },
    });
    const receiver = Object.create(klass.prototype);
    for (const fn of initializers)
        fn.call(receiver);
}
/** 服务装配：协议在位 → TypertRemoteService 子类（网关按 typertRemote 绑定 +
 *  原型 descriptor 发现）；否则降级为普通 cordis 服务（同名方法面，仅无网关
 *  发现）。两个分支共用上方导出的实现函数与同一 descriptor 形状。 */
// 显式 any：两个分支的类形状在运行期二选一，降级分支没有 Service 基类可声明。
let OnebotSettingsService;
if (protocol?.TypertRemoteService) {
    class OnebotSettingsRemote extends protocol.TypertRemoteService {
        static inject = ['configEditor', 'profileContext'];
        state = createRevisionState();
        /** Service 基类的 ctx 为 protected 且跨包声明，此处自存一份只读引用供惰性解析。 */
        ownerCtx;
        constructor(ctx) {
            super(ctx, NAMESPACE);
            this.ownerCtx = ctx;
        }
        /** 惰性解析宿主 configEditor（static inject 保证在位；运行期再校验形状）。 */
        configEditor() {
            return requireConfigEditor(this.ownerCtx);
        }
        async getSettings() {
            return getSettingsWithChoices(this.configEditor(), this.state, resolveSettingsServices(this.ownerCtx));
        }
        async updateSettings(patch, expectedRevision) {
            return updateSettings(this.configEditor(), this.state, patch, expectedRevision, resolveSettingsServices(this.ownerCtx));
        }
        /** 刷新档位下拉：按所选模型的能力返回思考强度档位。 */
        async getModelEfforts(provider, model) {
            return getModelEfforts(resolveSettingsServices(this.ownerCtx), provider, model);
        }
        /** W7：只读查询宿主 workspace 注册表（惰性解析，缺席降级 unavailable，不抛错）。 */
        async listWorkspaces() {
            return listWorkspaces(resolveWorkspaceRegistry(this.ownerCtx));
        }
    }
    markRemote(OnebotSettingsRemote, 'getSettings');
    markRemote(OnebotSettingsRemote, 'updateSettings');
    markRemote(OnebotSettingsRemote, 'getModelEfforts');
    markRemote(OnebotSettingsRemote, 'listWorkspaces');
    OnebotSettingsService = OnebotSettingsRemote;
}
else {
    console.warn('[dsh-onebot] @deepseek-ai/dsh-typert-protocol unavailable — onebotSettings remote degrades to a plain cordis service');
    class OnebotSettingsPlain {
        static inject = ['configEditor', 'profileContext'];
        name = NAMESPACE;
        state = createRevisionState();
        ctx;
        constructor(ctx) {
            this.ctx = ctx;
        }
        configEditor() {
            return requireConfigEditor(this.ctx);
        }
        getSettings() {
            return getSettingsWithChoices(this.configEditor(), this.state, resolveSettingsServices(this.ctx));
        }
        async updateSettings(patch, expectedRevision) {
            return updateSettings(this.configEditor(), this.state, patch, expectedRevision, resolveSettingsServices(this.ctx));
        }
        /** 与 typert 分支同一实现：按所选模型的能力返回思考强度档位。 */
        async getModelEfforts(provider, model) {
            return getModelEfforts(resolveSettingsServices(this.ctx), provider, model);
        }
        /** W7：与 typert 分支同一惰性解析 + 降级语义。 */
        async listWorkspaces() {
            return listWorkspaces(resolveWorkspaceRegistry(this.ctx));
        }
    }
    OnebotSettingsService = OnebotSettingsPlain;
}
export default OnebotSettingsService;
export { OnebotSettingsService };
