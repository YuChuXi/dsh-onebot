/** 普通图片默认所属的表情包。 */
export declare const DEFAULT_STICKER_PACK = "\u6211\u7684\u6536\u85CF";
/** 商城表情五字段；摘要同时是表情的定位摘要。 */
export type StickerMark = {
    summary: string;
    emoji_id: string;
    emoji_package_id: string;
    key: string;
    url: string;
};
/** 一条本地表情记录。 */
export type StickerRecord = {
    /** 所属表情包名称。 */
    pack: string;
    /** 用于定位的简短表情摘要；同一表情包内唯一。 */
    summary: string;
    /** 画面、情绪与适用语境的详细描述；可以尚未填写。 */
    caption: string;
    /** 表情图片的本机绝对路径。 */
    file: string;
    /** 图片内容 MD5（小写十六进制）。 */
    md5: string;
    /** 商城表情元数据；普通图片没有。 */
    mark?: StickerMark;
    /** 收录时间（毫秒时间戳）。 */
    addedAt: number;
};
/** 待收藏的一张表情。 */
export type StickerSource = {
    /** 已通过媒体围栏校验或下载完成的本机图片路径。 */
    file: string;
    /** 所属表情包名称。 */
    pack: string;
    /** 用于定位的简短表情摘要。 */
    summary: string;
    /** 画面、情绪与适用语境的详细描述。 */
    caption: string;
    /** 商城表情元数据。 */
    mark?: StickerMark;
};
/** 一条修改项：按 `pack + summary` 定位，未给的字段保持不变。 */
export type StickerChange = {
    /** 所属表情包名称。 */
    pack: string;
    /** 定位用的现有表情摘要。 */
    summary: string;
    /** 新的表情摘要；省略时保留原摘要。 */
    newSummary?: string;
    /** 新的详细描述；空串表示清除。 */
    caption?: string;
};
/** 本地表情库。 */
export declare class StickerLibrary {
    readonly dir: string;
    private readonly indexPath;
    /**
     * 创建本地表情库访问器。
     *
     * Args:
     *   mediaDir (string): 插件媒体目录；库文件位于其 `stickers` 子目录。
     *
     * Callers:
     *   - `src/tools/index.ts:registerTools`。
     */
    constructor(mediaDir: string);
    /**
     * 按收藏顺序列出全部表情。
     *
     * Returns:
     *   Promise<StickerRecord[]>: 记录数组；索引尚未建立时为空数组。
     *
     * Callers:
     *   - `src/tools/stickers.ts`：列出、定位与备注工具。
     */
    list(): Promise<StickerRecord[]>;
    /**
     * 批量收录表情；同一表情包内的相同内容复用记录，索引只写一次。
     *
     * Args:
     *   sources (readonly StickerSource[]): 待收录来源；空数组直接拒绝。
     *
     * Returns:
     *   Promise<StickerRecord[]>: 与 `sources` 等长的记录数组。
     *
     * Callers:
     *   - `src/tools/stickers.ts`（qq_collect_sticker）。
     */
    addMany(sources: readonly StickerSource[]): Promise<StickerRecord[]>;
    /**
     * 批量修改摘要与详细描述，全部校验通过后一次写回索引。
     *
     * Args:
     *   changes (readonly StickerChange[]): 修改项；按 `pack + summary` 定位，
     *     `newSummary` 省略时保留原摘要。
     *
     * Returns:
     *   Promise<StickerRecord[]>: 与修改项等长的更新后记录。
     *
     * Callers:
     *   - `src/tools/stickers.ts`（qq_remark_sticker）。
     */
    remarkMany(changes: readonly StickerChange[]): Promise<StickerRecord[]>;
    /**
     * 读取并校验索引；索引文件不存在表示库尚未建立。
     *
     * Returns:
     *   Promise<StickerRecord[]>: 持久化记录数组。
     *
     * Callers:
     *   - `list`、`addMany`、`remarkMany`。
     */
    private readIndex;
    /**
     * 原子写出索引：先写临时文件再重命名，避免中断留下不完整 JSON。
     *
     * Args:
     *   records (StickerRecord[]): 完整记录数组。
     *
     * Returns:
     *   Promise<void>: 写入完成。
     *
     * Callers:
     *   - `addMany`、`remarkMany`。
     */
    private writeIndex;
}
