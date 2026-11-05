/**
 * 本地表情库：按“表情包 / 表情摘要”组织普通图片与商城表情。
 *
 * 索引文件 `<mediaDir>/stickers/index.json` 保存记录数组；`pack + summary`
 * 是唯一键。图片按内容 MD5 命名；同一表情包内的相同内容复用记录。
 * @module dsh-onebot/media/stickers
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { extForInboundName } from './store.js';
/** 普通图片默认所属的表情包。 */
export const DEFAULT_STICKER_PACK = '我的收藏';
/** 本地表情库。 */
export class StickerLibrary {
    dir;
    indexPath;
    /**
     * 创建本地表情库访问器。
     *
     * Args:
     *   mediaDir (string): 插件媒体目录；库文件位于其 `stickers` 子目录。
     *
     * Callers:
     *   - `src/tools/index.ts:registerTools`。
     */
    constructor(mediaDir) {
        this.dir = join(mediaDir, 'stickers');
        this.indexPath = join(this.dir, 'index.json');
    }
    /**
     * 按收藏顺序列出全部表情。
     *
     * Returns:
     *   Promise<StickerRecord[]>: 记录数组；索引尚未建立时为空数组。
     *
     * Callers:
     *   - `src/tools/stickers.ts`：列出、定位与备注工具。
     */
    async list() {
        return await this.readIndex();
    }
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
    async addMany(sources) {
        if (sources.length === 0)
            throw new Error('表情库：没有要收录的表情');
        const records = await this.readIndex();
        const results = [];
        let changed = false;
        for (const source of sources) {
            const data = await readFile(source.file);
            const md5 = createHash('md5').update(data).digest('hex');
            const existing = records.find(record => record.pack === source.pack && record.md5 === md5);
            if (existing !== undefined) {
                results.push({ ...existing });
                continue;
            }
            const conflict = records.find(record => record.pack === source.pack && record.summary === source.summary);
            if (conflict !== undefined) {
                throw new Error('表情库：表情包「' + source.pack + '」已有摘要「' + source.summary + '」');
            }
            await mkdir(this.dir, { recursive: true });
            const file = join(this.dir, md5 + extForInboundName(basename(source.file)));
            if (source.file !== file)
                await copyFile(source.file, file);
            const record = {
                pack: source.pack,
                summary: source.summary,
                caption: source.caption,
                file,
                md5,
                ...(source.mark === undefined ? {} : { mark: source.mark }),
                addedAt: Date.now(),
            };
            records.push(record);
            results.push({ ...record });
            changed = true;
        }
        if (changed)
            await this.writeIndex(records);
        return results;
    }
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
    async remarkMany(changes) {
        if (changes.length === 0)
            throw new Error('表情库：没有要修改的表情');
        const next = (await this.readIndex()).map(record => ({ ...record }));
        for (const change of changes) {
            const position = next.findIndex(record => record.pack === change.pack && record.summary === change.summary);
            const record = next[position];
            if (record === undefined) {
                throw new Error('表情库：表情包「' + change.pack + '」没有摘要「' + change.summary + '」');
            }
            next[position] = {
                ...record,
                ...(change.newSummary === undefined ? {} : { summary: change.newSummary }),
                ...(change.caption === undefined ? {} : { caption: change.caption }),
            };
        }
        const seen = new Set();
        for (const record of next) {
            const key = record.pack + '\0' + record.summary;
            if (seen.has(key))
                throw new Error('表情库：表情包「' + record.pack + '」已有摘要「' + record.summary + '」');
            seen.add(key);
        }
        await this.writeIndex(next);
        return changes.map(change => {
            const record = next.find(item => item.pack === change.pack &&
                item.summary === (change.newSummary ?? change.summary));
            if (record === undefined)
                throw new Error('表情库：修改结果丢失');
            return { ...record };
        });
    }
    /**
     * 读取并校验索引；索引文件不存在表示库尚未建立。
     *
     * Returns:
     *   Promise<StickerRecord[]>: 持久化记录数组。
     *
     * Callers:
     *   - `list`、`addMany`、`remarkMany`。
     */
    async readIndex() {
        let info;
        try {
            info = await stat(this.indexPath);
        }
        catch (error) {
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
                return [];
            throw error;
        }
        if (!info.isFile())
            throw new Error('表情库索引不是普通文件：' + this.indexPath);
        const raw = JSON.parse(await readFile(this.indexPath, 'utf8'));
        if (!Array.isArray(raw))
            throw new Error('表情库索引格式错误：' + this.indexPath);
        for (const item of raw) {
            if (item === null || typeof item !== 'object')
                throw new Error('表情库索引记录格式错误：' + this.indexPath);
            const record = item;
            if (typeof record.pack !== 'string' || typeof record.summary !== 'string' ||
                typeof record.caption !== 'string' || typeof record.file !== 'string' ||
                typeof record.md5 !== 'string' || typeof record.addedAt !== 'number') {
                throw new Error('表情库索引记录缺少 pack/summary/caption/file/md5/addedAt：' + this.indexPath);
            }
        }
        return raw;
    }
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
    async writeIndex(records) {
        await mkdir(this.dir, { recursive: true });
        const temp = this.indexPath + '.tmp';
        await writeFile(temp, JSON.stringify(records, null, 2) + '\n', 'utf8');
        await rename(temp, this.indexPath);
    }
}
