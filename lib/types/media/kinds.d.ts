/**
 * 媒体类型的唯一声明点。
 *
 * 一个媒体类型携带它自己的全部事实：OneBot 段类型、中文名、出站大小上限键、
 * 入站取字节方式、回填方式，以及它在回合级处理里的角色（/ocr 目标、语音转写、
 * 是否走 get_file 系接口）。入站（解析、落盘、OCR、转写）与出站（段构造、上限）
 * 都只读这张表，不在上下游各自枚举类型。
 * @module dsh-onebot/media-kinds
 */
import type { MediaRef } from '../onebot/segments.js';
/** 媒体种类：入站五类载荷段共用同一套解析与回填流程。 */
export type MediaKind = 'image' | 'voice' | 'video' | 'file' | 'sticker';
/** 承载媒体载荷的 OneBot 段类型。 */
export type MediaSegmentType = 'image' | 'record' | 'video' | 'file' | 'mface';
/** 出站大小上限的配置键。 */
export type MediaLimitKey = 'maxImageBytes' | 'maxVoiceBytes' | 'maxFileBytes';
/** 媒体存储把缓存令牌换成字节的出口。 */
export type MediaBytesFetcher = (call: (action: string, params: Record<string, unknown>) => Promise<unknown>, file: string) => Promise<{
    file?: string;
    url?: string;
} | undefined>;
/** 一种媒体类型在入站与出站两个方向上的全部行为。 */
export interface MediaKindSpec {
    /** 中文名（取不到字节时的说明、提示词用）。 */
    label: string;
    /** 承载它的 OneBot 段类型。 */
    segment: MediaSegmentType;
    /** 出站大小上限的配置键。 */
    limit: MediaLimitKey;
    /** 入站：缓存令牌 → 可下载来源（undefined = 该类型不走缓存令牌）。 */
    fetch?: MediaBytesFetcher;
    /** 入站：需要后台转写。 */
    transcribe?: boolean;
    /** 入站：字节要走 get_file 系接口（NapCat 文件段）。 */
    nas?: boolean;
    /** 回填：模型可见的文件路径与元数据写成段的 data。 */
    resolved(ref: MediaRef, path: string): Record<string, unknown>;
}
/** 媒体类型的唯一枚举：行为随类型走，不在上下游重复。 */
export declare const MEDIA_KINDS: Record<MediaKind, MediaKindSpec>;
/**
 * 段是否承载媒体，以及属于哪一类。
 *
 * Args:
 *   segment ({ type: string }): 任意段或段类型壳。
 *
 * Returns:
 *   MediaKind | undefined: 媒体种类；非媒体段返回 undefined。
 *
 * Callers:
 *   - `src/onebot/segments.ts`：解析占位、渲染判空。
 *   - `src/inbound/index.ts`：媒体落盘、/ocr 目标与转写筛选。
 *   - `src/tools/send.ts`：出站段构造与大小上限。
 */
export declare function mediaKindOf(segment: {
    type: string;
}): MediaKind | undefined;
/**
 * 媒体种类的中文名。
 *
 * Args:
 *   kind (MediaKind): 媒体种类。
 *
 * Returns:
 *   string: 「图片」「语音」「视频」「文件」。
 *
 * Callers:
 *   - `src/onebot/segments.ts`：取不到字节时的占位说明。
 */
export declare function mediaLabel(kind: MediaKind): string;
