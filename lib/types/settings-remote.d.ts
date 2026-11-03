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
/** 宿主 dsh-workspace 注册表（src/bridge.ts:152 已有结构面；本模块只读消费
 *  list()，不打开 registry 内部态——import type 零运行时依赖，不改 bridge.ts）。 */
import type { WorkspaceRegistryLike } from './bridge/config.js';
/** patch insert 中 dsh-onebot 主条目的 id（T1 §2/§3：唯一持久层条目）。 */
export declare const ENTRY_ID = "dsh-onebot";
/** Typert Remote 命名空间 = cordis 服务键（T1 §4）。 */
export declare const NAMESPACE = "onebotSettings";
/** 快照固定值：37 键均为插件级热重启生效（T1 §5）。 */
export declare const REMOTE_EFFECT = "restart";
/** 设置页 UI 六组 37 键（与 src/index.ts Config schema 的 Config 面向面板的键一一对应）。
 *  connection/permissions/behavior 三组是连接、权限与行为面；diagnostics（诊断）
 *  组收纳观测/调试布尔键——它们默认关、属观测/调试面，与前三组的使用频率与
 *  风险等级都不同，独立分组让「默认全关的调试开关」一眼可辨。
 *  behavior 组的插话开关以布尔形式暴露（steerEnabled/steerAllMembers/
 *  steerAllowRestricted/steerNotice）；附加提示词按私聊/群聊分列。 */
export declare const SETTINGS_GROUPS: Readonly<Record<string, readonly string[]>>;
/** schema 默认值（摘自 src/index.ts 的 Config schema），快照生效值的底层。 */
export declare const SCHEMA_DEFAULTS: Readonly<Record<string, unknown>>;
/** 快照返回侧脱敏的键（T1 §3 敏感字段行；写入侧明文落盘属宿主既有行为）。 */
export declare const SECRET_KEYS: readonly string[];
/** 全部 37 键（校验与快照的唯一键集；6 枚举 + 5 数字 + 12 布尔 + 11 字符串 + 3 字符串数组）。 */
export declare const ALL_KEYS: readonly string[];
/** OnebotSettingsSnapshot（T1 §3 快照结构）。 */
export interface OnebotSettingsSnapshot {
    /** §3.1 乐观锁计数器。 */
    revision: number;
    /** dsh-onebot 条目 fiber 是否 active（fiber.state === 2，同 configEditor.edit 的活性判据）。 */
    entryActive: boolean;
    /** 37 键生效值；accessToken 脱敏为 ''。 */
    config: Record<string, unknown>;
    /** 动态下拉选项（按宿主模型能力）；缺席的键由客户端用静态选项。 */
    choices?: Record<string, string[]>;
    /** provider/model 下拉的数据；llm 缺席时省略。 */
    catalog?: SettingsCatalog;
    /** 脱敏键标记：明文是否已配置。 */
    secrets: Array<{
        path: string[];
        set: boolean;
    }>;
    groups: Record<string, string[]>;
    effect: typeof REMOTE_EFFECT;
}
/** §3.1 revision 计数器状态（内存态，随宿主进程/服务实例存续）。 */
export interface RevisionState {
    revision: number;
    /** 上次观察到的 entry.options.config 序列化指纹；null = 尚未建立基线。 */
    fingerprint: string | null;
}
/** configEditor（dsh-config-editor）本模块实际消费的最小面。 */
export interface ConfigEditorEntry {
    options: {
        id?: string;
        name?: string;
        config?: Record<string, unknown>;
    };
    fiber?: {
        state?: number;
    } | undefined;
}
export interface ConfigEditorLike {
    entries(): readonly ConfigEditorEntry[];
    edit(entry: ConfigEditorEntry, change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>): Promise<void>;
}
/** 宿主 llm 能力查询的最小面：设置页据此生成思考强度下拉选项。 */
export interface ModelCapabilityPort {
    resolveModelInfo(provider: string, model: string): Promise<{
        reasoning?: {
            efforts: readonly {
                id: string;
            }[];
        };
    }>;
}
/** 模型目录（设置页 provider/model 下拉的数据源）。 */
export interface ModelCatalogPort extends ModelCapabilityPort {
    listProviders(): Array<{
        id: string;
        name?: string;
    }>;
    listModels(provider: string): Promise<Array<{
        id: string;
        name?: string;
    }>>;
}
/** 设置页模型下拉的数据：provider 列表 + 每个 provider 的模型。 */
export interface SettingsCatalog {
    providers: Array<{
        id: string;
        name: string;
    }>;
    models: Record<string, Array<{
        id: string;
        name: string;
    }>>;
}
/** 单个模型的思考强度能力（设置页切换模型时重算档位下拉）。 */
export interface ModelEfforts {
    efforts: string[];
}
/** 宿主默认模型读取的最小面（无通配绑定时的类型路由）。 */
export interface DefaultModelPort {
    currentSelection(): {
        provider: string;
        model: string;
    } | undefined;
}
/** 设置页可用的宿主能力；缺席 = 能力未知，动态选项与模型下拉一并省略。 */
export interface SettingsServices {
    llm?: ModelCatalogPort | undefined;
    agentDefaultModel?: DefaultModelPort | undefined;
}
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
export declare function resolveSettingsServices(ctx: {
    get(key: string): unknown;
} | undefined): SettingsServices;
export declare function createRevisionState(): RevisionState;
/** §3.1 #2：读侧观察——config 指纹相对上次有差异即 +1（任何来源的已提交变更
 *  一视同仁）；首次调用仅建立基线不递增。 */
export declare function observeRevision(state: RevisionState, config: unknown): number;
/** W7：listWorkspaces 返回的单条 workspace 摘要（sessionCount = 注册表里挂在
 *  该 workspace 下的会话数，纯展示用途）。 */
export interface WorkspaceSummary {
    id: string;
    path: string;
    sessionCount: number;
}
/** W7：listWorkspaces 返回值。available=false = 宿主 workspaceRegistry 缺席或
 *  list() 抛错（降级语义：空列表 + 标注，不抛错——设置页隐藏快速填入行并提示
 *  可直接输入路径）。 */
export interface WorkspaceListResult {
    available: boolean;
    workspaces: WorkspaceSummary[];
}
/** W7：listWorkspaces 纯实现（descriptor 方法体共用；对 registry 形状做防御性
 *  校验——与 requireConfigEditor 同款「运行期再校验形状」风格，但绝不抛错：
 *  缺席/形状不符/list() 失败都归一为 unavailable 空列表）。 */
export declare function listWorkspaces(registry: WorkspaceRegistryLike | undefined): WorkspaceListResult;
/** 33 键生效值 = schema 默认值 ← 条目 config 覆盖（T1 §3 合并优先级一句话）。 */
export declare function effectiveConfig(raw: Record<string, unknown>): Record<string, unknown>;
/** updateSettings 入参校验（T1 §4：33 键的任意子集，扁平 JSON）。未知键整单
 *  拒绝（不静默丢弃）；类型/枚举不符拒绝；具体取值合法性交由宿主 schemastery
 *  校验 + reconcile 失败自动回滚兜底（T1 §5）。 */
export declare function validatePatch(patch: unknown): Record<string, unknown>;
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
export declare function getModelEfforts(services: SettingsServices, provider: string, model: string): Promise<ModelEfforts>;
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
export declare function modelChoices(config: Record<string, unknown>, services: SettingsServices): Promise<Record<string, string[]>>;
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
export declare function modelCatalog(services: SettingsServices): Promise<SettingsCatalog | undefined>;
/** getSettings 实现（descriptor 方法体共用；descriptor 参数 0 个）。 */
export declare function getSettings(editor: ConfigEditorLike, state: RevisionState): OnebotSettingsSnapshot;
/** 带动态下拉选项的快照（服务方法用；同步快照 + choices）。 */
export declare function getSettingsWithChoices(editor: ConfigEditorLike, state: RevisionState, services: SettingsServices): Promise<OnebotSettingsSnapshot>;
/** W6 错误归一：宿主 configEditor.edit 的原生失败（文件锁超时 / 活性检查 /
 *  schema 校验 / home-patch 守卫 / 激活失败回滚后 rethrow）按
 *  docs/m1-characterization/config-editor.md §3 矩阵归类，转成面板可直接渲染的
 *  中文 RemoteError('onebot-settings/edit-failed')，原始错误挂 cause（网关透传
 *  detail 不吞诊断信息）。归类按宿主错误消息特征词匹配，未命中走通用文案；
 *  所有分支的共同事实（该文档 §3 已钉死）：失败时 patch 文件要么从未被写、要么
 *  已被宿主逐字节还原，本模块不做任何补偿写（不重试、不回写），仅归一转发。 */
export declare const EDIT_FAILED_CODE = "onebot-settings/edit-failed";
export declare function describeEditFailure(cause: unknown): string;
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
export declare function updateSettings(editor: ConfigEditorLike, state: RevisionState, patch: unknown, expectedRevision?: number, services?: SettingsServices): Promise<OnebotSettingsSnapshot>;
/** 组装 descriptor 方法对象（测试与降级类共用；与类方法同一实现）。
 *  W7：workspaceRegistry 可选注入——省略时 listWorkspaces 降级 unavailable
 *  （与类分支的惰性 ctx 解析同一 listWorkspaces 纯函数出口）。 */
export declare function createOnebotSettingsMethods(editor: ConfigEditorLike, state?: RevisionState, workspaceRegistry?: WorkspaceRegistryLike, services?: SettingsServices): {
    getSettings(): Promise<OnebotSettingsSnapshot> | OnebotSettingsSnapshot;
    updateSettings(patch: unknown, expectedRevision?: number): Promise<OnebotSettingsSnapshot>;
    getModelEfforts(provider: string, model: string): Promise<ModelEfforts>;
    listWorkspaces(): Promise<WorkspaceListResult>;
};
/** 服务装配：协议在位 → TypertRemoteService 子类（网关按 typertRemote 绑定 +
 *  原型 descriptor 发现）；否则降级为普通 cordis 服务（同名方法面，仅无网关
 *  发现）。两个分支共用上方导出的实现函数与同一 descriptor 形状。 */
declare let OnebotSettingsService: any;
export default OnebotSettingsService;
export { OnebotSettingsService };
