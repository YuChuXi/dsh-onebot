/**
 * notice 事件的归一化：把 OneBot 11 / NapCat 的各类通知收缩成与会话消息
 * 完全相同的形状（会话、发送方、段数组、是否指向机器人），因此下游只有一条
 * 处理路径，不为每种 notice_type 增加分支。
 * @module dsh-onebot/inbound/notice
 */
/** 文本段。 */
function text(value) {
    return [{ type: 'text', data: { text: value } }];
}
/** 读取字符串字段；缺失或非标量时返回空串。 */
function field(event, key) {
    const value = event[key];
    return value === undefined || value === null ? '' : String(value);
}
/** 读取嵌套对象里的字符串字段。 */
function nested(event, key, inner) {
    const value = event[key];
    if (typeof value !== 'object' || value === null)
        return '';
    const item = value[inner];
    return item === undefined || item === null ? '' : String(item);
}
/** 群成员变动的措辞。 */
function memberAction(subType) {
    if (subType === 'invite')
        return '被邀请加入群聊';
    return '加入群聊';
}
/** 禁言措辞。 */
function banAction(subType, duration) {
    if (subType === 'lift_ban')
        return '的禁言被解除';
    return duration === '' ? '被禁言' : '被禁言 ' + duration + ' 秒';
}
/**
 * 把一条 notice 渲染成会话事件。
 *
 * 未知类型与「不构成会话内容」的类型（正在输入、头像点赞、机器人离线）
 * 返回 null，由调用方决定只记日志。
 *
 * Args:
 *   event (OneBotEvent): 原始 notice 事件。
 *   selfId (string): 机器人自身 QQ，用于判定事件是否指向机器人。
 *
 * Returns:
 *   NoticeRecord | null: 归一化结果；无会话语义时为 null。
 *
 * Callers:
 *   - `src/inbound/normalize.ts:normalizeEvent`。
 */
export function renderNotice(event, selfId) {
    const noticeType = field(event, 'notice_type');
    const subType = field(event, 'sub_type');
    const userId = field(event, 'user_id');
    const operator = field(event, 'operator_id');
    const target = field(event, 'target_id');
    const self = selfId !== '' ? selfId : field(event, 'self_id');
    if (noticeType === 'notify') {
        if (subType === 'poke') {
            const bySelf = self !== '' && userId === self;
            const atSelf = self !== '' && target === self;
            if (bySelf || (!atSelf && (userId === '' || target === '')))
                return null;
            return {
                from: userId,
                segments: [{ type: 'poke', data: { id: target, ...(atSelf ? { self: true } : {}) } }],
                wakes: atSelf,
            };
        }
        if (subType === 'lucky_king')
            return { from: target !== '' ? target : userId, segments: text('成为了运气王'), wakes: false };
        if (subType === 'honor') {
            const honor = field(event, 'honor_type');
            return { from: userId, segments: text('获得群荣誉' + (honor !== '' ? '（' + honor + '）' : '')), wakes: false };
        }
        if (subType === 'title') {
            const title = field(event, 'title');
            return { from: userId, segments: text('获得头衔' + (title !== '' ? '「' + title + '」' : '')), wakes: false };
        }
        if (subType === 'group_name') {
            const name = field(event, 'group_name');
            return { from: userId !== '' ? userId : operator, segments: text('群名改为「' + name + '」'), wakes: false };
        }
        if (subType === 'gray_tip') {
            const content = field(event, 'content');
            return { from: userId, segments: text('系统提示：' + content), wakes: false };
        }
        return null;
    }
    if (noticeType === 'group_upload') {
        const name = nested(event, 'file', 'name');
        return { from: userId, segments: text('上传了文件' + (name !== '' ? '「' + name + '」' : '')), wakes: false };
    }
    if (noticeType === 'group_admin') {
        return {
            from: userId,
            segments: text(subType === 'set' ? '成为群管理员' : '被取消群管理员'),
            wakes: self !== '' && userId === self,
        };
    }
    if (noticeType === 'group_decrease') {
        const left = subType === 'leave' ? '退出群聊' : subType === 'kick_me' ? '将机器人移出群聊' : '被移出群聊';
        // 机器人已不在群内，无法在该会话发言。
        return { from: userId, segments: text(left), wakes: false };
    }
    if (noticeType === 'group_increase') {
        return {
            from: userId,
            segments: text(memberAction(subType)),
            wakes: self !== '' && userId === self,
        };
    }
    if (noticeType === 'group_ban') {
        const by = operator !== '' && operator !== userId ? '（操作者 ' + operator + '）' : '';
        return { from: userId, segments: text(banAction(subType, field(event, 'duration')) + by), wakes: false };
    }
    if (noticeType === 'group_card') {
        const card = field(event, 'card');
        return { from: userId, segments: text('群名片改为「' + card + '」'), wakes: false };
    }
    if (noticeType === 'group_recall' || noticeType === 'friend_recall') {
        const by = operator !== '' && operator !== userId ? '（操作者 ' + operator + '）' : '';
        return { from: userId, segments: text('撤回了一条消息' + by), wakes: false };
    }
    if (noticeType === 'essence') {
        return { from: operator, segments: text(subType === 'delete' ? '取消了一条精华消息' : '将一条消息设为精华'), wakes: false };
    }
    if (noticeType === 'group_msg_emoji_like') {
        const likes = Array.isArray(event.likes) ? event.likes : [];
        const summary = likes
            .map(item => {
            if (typeof item !== 'object' || item === null)
                return '';
            const record = item;
            const id = record.emoji_id === undefined ? '' : String(record.emoji_id);
            const count = record.count === undefined ? '' : '×' + String(record.count);
            return id === '' ? '' : id + count;
        })
            .filter(part => part !== '')
            .join('、');
        return {
            from: userId,
            segments: text((field(event, 'is_add') === 'false' ? '取消了表情回应' : '表情回应') + (summary !== '' ? ' ' + summary : '')),
            wakes: false,
        };
    }
    return null;
}
