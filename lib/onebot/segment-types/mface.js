import { pickFields } from './primitives.js';
import { registerSegmentType } from './registry.js';
/** 重放商城表情需要的属性。 */
const MFACE_FIELDS = ['summary', 'emoji_id', 'emoji_package_id', 'key', 'url'];
registerSegmentType('mface', {
    segment: (raw) => ({
        type: 'mface',
        data: pickFields(raw.data ?? {}, MFACE_FIELDS),
    }),
    normalize: data => {
        const picked = pickFields(data, MFACE_FIELDS);
        return Object.keys(picked).length === 0 ? undefined : { type: 'mface', data: picked };
    },
});
