/**
 * Chat identity and access policy: chat-id encoding, session-id derivation,
 * and the DM/group/mention/role authorization model ported from the Hermes
 * OneBot adapter. Pure functions.
 * @module dsh-onebot/chat
 */
/**
 * Encode a chat reference as "private:<qq>" / "group:<qq>".
 * @param kind - chat kind.
 * @param target - QQ number as string.
 * @returns the canonical chat id.
 */
export function buildChatId(kind, target) {
    return kind === 'private' ? 'private:' + target : 'group:' + target;
}
/**
 * Decode a chat id; a bare QQ number defaults to a private chat.
 * @param chatId - canonical chat id or bare number.
 * @returns the chat reference.
 */
export function splitChatId(chatId) {
    const idx = chatId.indexOf(':');
    if (idx > 0) {
        const kind = chatId.slice(0, idx);
        const target = chatId.slice(idx + 1);
        if (kind === 'private' || kind === 'group')
            return { kind, target };
    }
    return { kind: 'private', target: chatId };
}
/**
 * Derive the durable session id for a chat: "onebot-<chatId>" with
 * non-alphanumerics flattened, so the session store key stays filesystem-safe
 * while remaining recognizable in logs.
 * @param chatId - canonical chat id.
 * @returns the session id string.
 */
export function sessionIdForChat(chatId) {
    return 'onebot-' + chatId.replace(/[^A-Za-z0-9-]/g, '-');
}
/**
 * Classify a user as admin or member. Admins are the explicit admin set plus
 * the ONEBOT_ALLOWED_USERS env fallback; everyone else (group members) is a
 * member. Unknown users are members.
 * @param userId - QQ number.
 * @param adminUsers - admin allowlist (already env-merged).
 * @returns the role.
 */
export function classifyUserRole(userId, adminUsers) {
    return adminUsers.includes(userId) ? 'admin' : 'member';
}
/**
 * Whether a private-chat message from the user is allowed. "open" admits
 * admins only (matching the Hermes adapter's trust posture); "allowlist"
 * admits the allowFrom set; "disabled" admits nobody.
 * @param userId - sender QQ number.
 * @param policy - resolved policy.
 * @returns allowed or not.
 */
export function dmAllowed(userId, policy) {
    if (policy.dmPolicy === 'disabled')
        return false;
    if (policy.dmPolicy === 'allowlist')
        return policy.allowFrom.includes(userId);
    return policy.allowAllUsers || policy.adminUsers.includes(userId);
}
/**
 * Whether a group-chat message is allowed by group policy.
 * @param groupId - group QQ number.
 * @param policy - resolved policy.
 * @returns allowed or not.
 */
export function groupAllowed(groupId, policy) {
    if (policy.groupPolicy === 'disabled')
        return false;
    if (policy.groupPolicy === 'allowlist')
        return policy.groupAllowFrom.includes(groupId);
    return true;
}
/**
 * 发送方显示名：群名片优先，其次昵称，最后回落到调用方给的值（通常是 QQ 号）。
 * OneBot 的 sender 在各实现之间字段一致，所有展示位都走这里。
 *
 * Args:
 *   sender (object | undefined): `{ card?, nickname? }`，缺失即回落。
 *   fallback (string): 兜底值（QQ 号或空串）。
 *
 * Returns:
 *   string: 显示名。
 *
 * Callers:
 *   - `src/inbound/normalize.ts:normalizeOneBot11`：入站事件边界。
 *   - `src/inbound/index.ts:InboundPipeline`：recordOf、引用与转发节点。
 *   - `src/inbound/normalize.ts:normalizeEvent`：入站事件归一化。
 */
export function displayName(sender, fallback) {
    const card = sender?.card;
    if (typeof card === 'string' && card !== '')
        return card;
    const nickname = sender?.nickname;
    if (typeof nickname === 'string' && nickname !== '')
        return nickname;
    return fallback;
}
