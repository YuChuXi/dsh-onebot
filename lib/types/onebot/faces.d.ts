/**
 * QQ 经典表情 id → 中文名。
 *
 * CQ face 的 id 空间（NapCat 的 `[CQ:face,id=…]`）：0 是惊讶、14 是微笑、
 * 76 是赞、111 是可怜 —— 与 https://docs-v1.zhamao.xin/face_list.html 的表情图
 * 逐一核对过。没有名字的 id 保持裸 id 输出，不做猜测。
 * @module dsh-onebot/faces
 */
/** id → 中文名。 */
export declare const FACE_NAME: Record<string, string>;
/**
 * 按 id 查表情名。
 *
 * Args:
 *   id (string | number): 表情 id。
 *
 * Returns:
 *   string | undefined: 中文名；未知 id 返回 undefined。
 *
 * Callers:
 *   - `src/cq/types/face.ts`：补全段里的 name。
 */
export declare function faceName(id: string | number): string | undefined;
/**
 * 按名字查表情 id。
 *
 * Args:
 *   name (string): 表情中文名。
 *
 * Returns:
 *   string | undefined: id；未知名字返回 undefined。
 *
 * Callers:
 *   - `src/cq/types/face.ts`：模型只写名字时补 id。
 */
export declare function faceId(name: string): string | undefined;
