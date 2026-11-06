'use strict';

/**
 * Background catalogue + config validation.
 *
 * The control panel may only ever send a *file name*; every path is rebuilt
 * here from a fixed set of roots, so a client cannot reference anything
 * outside LiveAssets/Backgrounds/{images,videos} or DJ_VIDEO.
 */

const fs = require('node:fs/promises');
const { statSync } = require('node:fs');
const path = require('node:path');
const { readVideoMeta } = require('./video-meta');

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg']);
/**
 * Containers Unity's VideoPlayer can open on Windows. H.264 in MP4 is the
 * reliable one; WebM depends on the VP8/VP9 decoder installed on the machine,
 * so WebM entries carry a warning the panel shows to the operator.
 */
const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.webm']);
const FIT_MODES = new Set(['native', 'fit', 'fill']);
const ROTATIONS = new Set([0, 90, 180, 270]);
const FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_VIDEO_BYTES = 512 * 1024 * 1024;

const WEBM_WARNING = 'WebM phụ thuộc bộ giải mã của Windows; nên dùng MP4 (H.264) nếu Unity không phát được.';

const LEGACY_FILE = 'nenamphu.png';
const DEFAULT_TRANSFORM = Object.freeze({ rotation: 0, flipHorizontal: false, flipVertical: false });
const TRANSFORM_KEYS = new Set(['rotation', 'flipHorizontal', 'flipVertical']);
const DEFAULT_BACKGROUND = Object.freeze({
    id: 'legacy-default',
    type: 'image',
    file: LEGACY_FILE,
    fitMode: 'native',
    loop: true,
    rotation: 0,
    transform: DEFAULT_TRANSFORM,
    generation: 0
});

function folderFor(type) {
    return type === 'video' ? 'videos' : 'images';
}

function extensionOf(file) {
    return path.extname(String(file || '')).toLowerCase();
}

function kindForFile(file) {
    const extension = extensionOf(file);
    if (IMAGE_EXTENSIONS.has(extension)) return 'image';
    if (VIDEO_EXTENSIONS.has(extension)) return 'video';
    return null;
}

function isSafeFileName(file) {
    const name = String(file || '');
    if (!FILE_PATTERN.test(name)) return false;
    if (name === '.' || name === '..') return false;
    if (name.includes('..')) return false;
    if (name.includes('/') || name.includes('\\')) return false;
    return true;
}

function sanitizeId(value) {
    const id = String(value || '').trim();
    return ID_PATTERN.test(id) ? id : '';
}

function defaultBackground(overrides = {}) {
    return { ...DEFAULT_BACKGROUND, ...overrides };
}

/**
 * Validates an operator transform. `undefined` means "not supplied"; anything
 * supplied must be exact — a bad rotation or a non-boolean flip is an error, not
 * something to quietly coerce.
 *
 * @returns {{ value?: object, error?: string }}
 */
function validateTransform(input) {
    if (input === undefined || input === null) return { value: null };
    if (typeof input !== 'object' || Array.isArray(input)) return { error: 'Transform không hợp lệ.' };

    for (const key of Object.keys(input)) {
        if (!TRANSFORM_KEYS.has(key)) return { error: `Transform có trường không hợp lệ: ${key}.` };
    }

    const rotation = input.rotation === undefined ? 0 : input.rotation;
    if (!ROTATIONS.has(rotation)) return { error: 'Góc xoay chỉ được 0, 90, 180 hoặc 270.' };

    for (const key of ['flipHorizontal', 'flipVertical']) {
        if (input[key] !== undefined && typeof input[key] !== 'boolean') {
            return { error: `${key} phải là true hoặc false.` };
        }
    }

    return {
        value: {
            rotation,
            flipHorizontal: input.flipHorizontal === true,
            flipVertical: input.flipVertical === true
        }
    };
}

/**
 * @returns {{ value?: object, error?: string }}
 */
function validateBackground(input = {}, options = {}) {
    const source = input && typeof input === 'object' ? input : {};
    const file = typeof source.file === 'string' ? source.file.trim() : '';

    if (!isSafeFileName(file)) return { error: 'Tên file background không hợp lệ.' };

    const kind = kindForFile(file);
    if (!kind) return { error: 'Chỉ hỗ trợ PNG, JPG, JPEG, MP4, M4V, MOV hoặc WebM.' };

    const requestedType = String(source.type || kind).trim().toLowerCase();
    if (requestedType !== kind) return { error: 'Loại background không khớp với định dạng file.' };

    if (Array.isArray(options.available)) {
        const present = options.available.some(item =>
            typeof item === 'string'
                ? item.toLowerCase() === file.toLowerCase()
                : String(item.file || '').toLowerCase() === file.toLowerCase()
        );
        if (!present) return { error: 'Background không có trong thư mục cho phép.' };
    }

    const generation = Number.isInteger(source.generation) && source.generation >= 0
        ? source.generation
        : (Number.isInteger(options.generation) && options.generation >= 0 ? options.generation : 0);

    // `transform` is the authoritative orientation; the Phase 1.2 top-level
    // `rotation` is still accepted so older configs keep loading.
    const transformInput = source.transform !== undefined
        ? source.transform
        : (source.rotation !== undefined ? { rotation: source.rotation } : undefined);

    const transformCheck = validateTransform(transformInput);
    if (transformCheck.error) return { error: transformCheck.error };

    const suppliedTransform = transformCheck.value || { ...DEFAULT_TRANSFORM };
    // Images have no orientation. A neutral transform is harmless (old clients
    // send it), but a real rotation/flip on a PNG is a client bug, not data to
    // silently drop.
    const neutral = suppliedTransform.rotation === 0 &&
        !suppliedTransform.flipHorizontal && !suppliedTransform.flipVertical;
    if (kind === 'image' && !neutral) {
        return { error: 'Ảnh PNG/JPG không hỗ trợ xoay hoặc lật.' };
    }
    const transform = kind === 'video' ? suppliedTransform : { ...DEFAULT_TRANSFORM };

    return {
        value: {
            id: sanitizeId(source.id) || `bg-${Date.now().toString(36)}`,
            type: kind,
            file,
            fitMode: FIT_MODES.has(source.fitMode) ? source.fitMode : 'native',
            loop: source.loop !== false,
            rotation: transform.rotation,
            transform,
            generation
        }
    };
}

/**
 * Normalises `options.extraVideoDirs` into `{ dir, folder }` records that are
 * safe to scan: absolute, de-duplicated and never the default videos folder.
 */
function normaliseExtraDirs(root, extraVideoDirs) {
    const base = path.resolve(root);
    const seen = new Set([path.resolve(base, 'videos').toLowerCase()]);
    const result = [];
    for (const entry of Array.isArray(extraVideoDirs) ? extraVideoDirs : []) {
        if (typeof entry !== 'string' || !entry.trim()) continue;
        const dir = path.resolve(entry);
        const key = dir.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({ dir, folder: path.basename(dir) || 'videos' });
    }
    return result;
}

async function readFolder(directory, type, folder) {
    let entries;
    try {
        entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }

    const allowed = type === 'video' ? VIDEO_EXTENSIONS : IMAGE_EXTENSIONS;
    const maxBytes = type === 'video' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
    const files = [];

    for (const entry of entries) {
        if (!entry.isFile()) continue;
        const file = entry.name;
        if (!isSafeFileName(file)) continue;
        const extension = extensionOf(file);
        if (!allowed.has(extension)) continue;

        let bytes = 0;
        try {
            bytes = (await fs.stat(path.join(directory, file))).size;
        } catch {
            continue;
        }
        if (bytes <= 0 || bytes > maxBytes) continue;

        const item = { file, type, bytes, folder, extension };
        if (extension === '.webm') item.warning = WEBM_WARNING;

        if (type === 'video') {
            const meta = await readVideoMeta(path.join(directory, file));
            if (meta) {
                item.rotation = meta.rotation;
                item.width = meta.width;
                item.height = meta.height;
                item.duration = meta.duration;
            }
        }

        files.push(item);
    }

    return files.sort((left, right) => left.file.localeCompare(right.file));
}

/**
 * Lists every selectable background. Videos are collected from
 * `<root>/videos` first and then from each extra folder (DJ_VIDEO), because
 * the project has always kept its clips in DJ_VIDEO. A file that exists in
 * both places is offered once, using the LiveAssets copy.
 */
async function listBackgroundFiles(root, options = {}) {
    const base = path.resolve(root);
    const images = await readFolder(path.join(base, 'images'), 'image', 'images');

    const videos = [];
    const seen = new Set();
    const videoFolders = [
        { dir: path.join(base, 'videos'), folder: 'videos' },
        ...normaliseExtraDirs(base, options.extraVideoDirs)
    ];
    for (const source of videoFolders) {
        const found = await readFolder(source.dir, 'video', source.folder);
        for (const item of found) {
            const key = item.file.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            videos.push(item);
        }
    }
    videos.sort((left, right) => left.file.localeCompare(right.file));

    return { images, videos, all: [...images, ...videos] };
}

/**
 * Rebuilds the absolute path from the validated file name and verifies that
 * the result is still inside one of the allowed folders.
 *
 * Synchronous by design: it is called per media request, the folder list is
 * tiny, and `exists` tells the route whether to 404 without a second lookup.
 */
function resolveBackgroundPath(root, background, options = {}) {
    const type = background && background.type === 'video' ? 'video' : 'image';
    const file = background && background.file;
    if (!isSafeFileName(file) || kindForFile(file) !== type) {
        return { error: 'Tên file background không hợp lệ.' };
    }

    const base = path.resolve(root);
    const folders = type === 'video'
        ? [{ dir: path.join(base, 'videos'), folder: 'videos' }, ...normaliseExtraDirs(base, options.extraVideoDirs)]
        : [{ dir: path.join(base, 'images'), folder: 'images' }];

    let fallback = null;
    for (const entry of folders) {
        const directory = path.resolve(entry.dir);
        const absolute = path.resolve(directory, String(file));
        if (absolute !== path.join(directory, String(file))) {
            return { error: 'Đường dẫn ngoài thư mục cho phép.' };
        }
        if (!absolute.startsWith(directory + path.sep)) {
            return { error: 'Đường dẫn ngoài thư mục cho phép.' };
        }

        if (!fallback) fallback = { directory, folder: entry.folder, absolute, exists: false };

        let exists = false;
        try {
            exists = statSync(absolute).isFile();
        } catch {
            exists = false;
        }
        if (exists) return { directory, folder: entry.folder, absolute, exists: true };
    }

    return fallback || { error: 'Không tìm thấy file background.' };
}

function backgroundUrl(background) {
    if (!background || !isSafeFileName(background.file)) return '';
    if (background.file.toLowerCase() === LEGACY_FILE) {
        return `/backgrounds/legacy/${LEGACY_FILE}`;
    }
    return `/backgrounds/${folderFor(background.type)}/${encodeURIComponent(background.file)}`;
}

async function loadBackgroundConfig(configPath, options = {}) {
    let parsed;
    try {
        parsed = JSON.parse(await fs.readFile(configPath, 'utf8'));
    } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
        return defaultBackground();
    }

    const validation = validateBackground(parsed, { available: options.available });
    if (validation.error) return defaultBackground();

    if (Array.isArray(options.available)) {
        const present = options.available.some(item =>
            String(item.file || item).toLowerCase() === validation.value.file.toLowerCase()
        );
        if (!present) return defaultBackground();
    }

    return validation.value;
}

async function saveBackgroundConfig(configPath, background) {
    const validation = validateBackground(background);
    if (validation.error) throw new Error(validation.error);

    await fs.mkdir(path.dirname(configPath), { recursive: true });
    const temporary = `${configPath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(validation.value, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, configPath);
    return validation.value;
}

module.exports = {
    LEGACY_FILE,
    DEFAULT_BACKGROUND,
    FIT_MODES,
    IMAGE_EXTENSIONS,
    VIDEO_EXTENSIONS,
    ROTATIONS,
    DEFAULT_TRANSFORM,
    WEBM_WARNING,
    validateTransform,
    defaultBackground,
    folderFor,
    isSafeFileName,
    kindForFile,
    validateBackground,
    listBackgroundFiles,
    resolveBackgroundPath,
    backgroundUrl,
    loadBackgroundConfig,
    saveBackgroundConfig
};
