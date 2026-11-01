import { faceId, faceName } from '../faces.js';
import { scalar, text } from './primitives.js';
import { registerSegmentType } from './registry.js';
registerSegmentType('face', {
    segment: (raw) => {
        const data = raw.data ?? {};
        const id = scalar(data.id);
        const idText = id === undefined ? undefined : String(id);
        const name = text(data.name) ?? (idText !== undefined ? faceName(idText) : undefined);
        if (idText === undefined && name === undefined)
            return undefined;
        return {
            type: 'face',
            data: { ...(idText !== undefined ? { id: idText } : {}), ...(name !== undefined ? { name } : {}) },
        };
    },
    normalize: data => {
        const id = scalar(data.id);
        const name = text(data.name);
        // NapCat 只认 id；模型只写名字时按名字反查。
        const resolved = id !== undefined && String(id) !== ''
            ? String(id)
            : (name !== undefined ? faceId(name) : undefined);
        if (resolved === undefined)
            return undefined;
        const resolvedName = name ?? faceName(resolved);
        return { type: 'face', data: { id: resolved, ...(resolvedName !== undefined ? { name: resolvedName } : {}) } };
    },
});
