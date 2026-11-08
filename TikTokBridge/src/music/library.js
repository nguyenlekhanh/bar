'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const SUPPORTED_EXTENSIONS = new Map([
    ['.mp3', 'audio/mpeg'],
    ['.wav', 'audio/wav'],
    ['.ogg', 'audio/ogg']
]);

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function extensionOf(file) {
    return path.extname(String(file || '')).toLowerCase();
}

function mimeFor(file) {
    return SUPPORTED_EXTENSIONS.get(extensionOf(file)) || '';
}

function isSupportedAudio(file) {
    return SUPPORTED_EXTENSIONS.has(extensionOf(file));
}

/**
 * A library entry is always a single filename inside DJ_MUSIC. Reject path
 * separators, drive letters, dotfiles and Windows device names before any
 * filesystem call.
 */
function validateFileName(file) {
    const name = String(file || '').normalize('NFC').trim();
    if (!name) return { error: 'A music filename is required.' };
    if (name.length > 160) return { error: 'The music filename is too long.' };
    if (/[\u0000-\u001f\u007f]/.test(name)) return { error: 'The music filename contains control characters.' };
    if (name === '.' || name === '..' || name.startsWith('.')) return { error: 'Hidden or temporary files are not allowed.' };
    if (name.includes('/') || name.includes('\\') || path.basename(name) !== name) {
        return { error: 'The music filename must not contain a path.' };
    }
    if (/^[A-Za-z]:/.test(name)) return { error: 'The music filename must not contain a drive letter.' };
    if (WINDOWS_RESERVED.test(name)) return { error: 'That Windows device name is not allowed.' };
    if (!isSupportedAudio(name)) return { error: 'Only MP3, WAV and OGG files are supported.' };
    return { value: name };
}

function safeMusicPath(folder, file) {
    const checked = validateFileName(file);
    if (checked.error) return { error: checked.error };
    const root = path.resolve(folder);
    const resolved = path.resolve(root, checked.value);
    if (path.dirname(resolved) !== root) return { error: 'The music file is outside DJ_MUSIC.' };
    return { absolute: resolved, file: checked.value, mime: mimeFor(checked.value) };
}

/** Reads only the bytes needed to prove the container signature. */
function audioHeaderIsValid(buffer, extension) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 12) return false;
    switch (extension) {
        case '.wav':
            return buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
                buffer.subarray(8, 12).toString('ascii') === 'WAVE';
        case '.ogg':
            return buffer.subarray(0, 4).toString('ascii') === 'OggS';
        case '.mp3': {
            if (buffer.subarray(0, 3).toString('ascii') === 'ID3') return true;
            // MPEG audio frame sync: eleven set bits.
            return buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0;
        }
        default:
            return false;
    }
}

function validateAudioBuffer(buffer, file) {
    const checked = validateFileName(file);
    if (checked.error) return checked;
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return { error: 'The audio file is empty.' };
    if (buffer.length > MAX_UPLOAD_BYTES) return { error: 'The audio file is larger than 100 MB.' };
    if (!audioHeaderIsValid(buffer, extensionOf(checked.value))) {
        return { error: `The ${extensionOf(checked.value).slice(1).toUpperCase()} header is missing or corrupt.` };
    }
    return { value: checked.value };
}

async function inspectAudioFile(absolute, file) {
    try {
        const stat = await fs.stat(absolute);
        if (!stat.isFile()) return { error: 'Not a regular file.' };
        if (stat.size <= 0) return { error: 'The audio file is empty.' };
        if (stat.size > MAX_UPLOAD_BYTES) return { error: 'The audio file is larger than 100 MB.' };
        const handle = await fs.open(absolute, 'r');
        let header;
        try {
            header = Buffer.alloc(Math.min(12, stat.size));
            await handle.read(header, 0, header.length, 0);
        } finally {
            await handle.close();
        }
        if (!audioHeaderIsValid(header, extensionOf(file))) {
            return { error: `The ${extensionOf(file).slice(1).toUpperCase()} header is missing or corrupt.` };
        }
        return { bytes: stat.size, modifiedAt: stat.mtimeMs };
    } catch (error) {
        if (error.code === 'ENOENT') return { error: 'The file no longer exists.' };
        return { error: `Could not read the audio file: ${error.message}` };
    }
}

/**
 * Scans only the top level of DJ_MUSIC. A file first observed in this scan is
 * held back until it has remained unchanged for `stableMs`, which avoids
 * exposing a copy that is still being written. Uploads are atomic renames and
 * therefore appear immediately on the next scan.
 */
async function scanMusicFolder(folder, options = {}) {
    const now = Number(options.now) || Date.now();
    const stableMs = Math.max(0, Number(options.stableMs) || 0);
    const seen = options.seen || new Map();
    const initial = options.initial === true;
    const force = options.force === true;
    let entries;
    try {
        entries = await fs.readdir(folder, { withFileTypes: true });
    } catch (error) {
        if (error.code === 'ENOENT') return { exists: false, library: [], pending: [], seen };
        throw error;
    }

    const library = [];
    const pending = [];
    const present = new Set();
    for (const entry of entries) {
        if (!entry.isFile()) continue;
        const file = entry.name;
        if (!isSupportedAudio(file)) continue;
        present.add(file);
        const absolute = path.join(folder, file);
        let stat;
        try {
            stat = await fs.stat(absolute);
        } catch {
            continue;
        }
        const previous = seen.get(file);
        const firstSeen = previous ? previous.firstSeen : now;
        const previousSize = previous ? previous.size : null;
        const sameSize = previousSize === stat.size;
        const stable = initial || force || (sameSize && now - firstSeen >= stableMs);
        seen.set(file, { firstSeen, size: stat.size, modifiedAt: stat.mtimeMs, lastSeen: now });

        if (!stable) {
            pending.push(file);
            continue;
        }

        const inspected = await inspectAudioFile(absolute, file);
        library.push({
            file,
            bytes: stat.size,
            modifiedAt: stat.mtimeMs,
            valid: !inspected.error,
            error: inspected.error || '',
            mime: mimeFor(file)
        });
    }

    // Forget files that disappeared so a later re-copy is treated as new.
    for (const file of seen.keys()) {
        if (!present.has(file)) seen.delete(file);
    }

    library.sort((a, b) => a.file.localeCompare(b.file, 'en', { sensitivity: 'base' }));
    pending.sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
    return { exists: true, library, pending, seen };
}

function defaultMusicState() {
    return {
        version: 1,
        playlist: [],
        current: '',
        shuffle: false,
        repeat: true,
        volume: 0.35,
        trackVolumes: {},
        playbackPreference: 'paused'
    };
}

function clampVolume(value, fallback = 0.35) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
}

function sanitizePlaylist(value, validFiles) {
    const valid = new Set(validFiles);
    const result = [];
    const seen = new Set();
    for (const entry of Array.isArray(value) ? value : []) {
        const checked = validateFileName(entry);
        if (checked.error || seen.has(checked.value) || (valid && !valid.has(checked.value))) continue;
        seen.add(checked.value);
        result.push(checked.value);
    }
    return result;
}

function sanitizeTrackVolumes(value, validFiles) {
    const valid = new Set(validFiles || []);
    const result = {};
    for (const [key, raw] of Object.entries(value && typeof value === 'object' ? value : {})) {
        const checked = validateFileName(key);
        if (checked.error) continue;
        if (validFiles && !valid.has(checked.value)) continue;
        const number = Number(raw);
        if (!Number.isFinite(number)) continue;
        result[checked.value] = Math.max(0, Math.min(1, number));
    }
    return result;
}

function sanitizeMusicState(input, validFiles) {
    const base = defaultMusicState();
    const source = input && typeof input === 'object' ? input : {};
    const playlist = sanitizePlaylist(source.playlist, validFiles);
    const current = validateFileName(source.current);
    return {
        ...base,
        playlist,
        current: current.error ? '' : (playlist.includes(current.value) ? current.value : ''),
        shuffle: source.shuffle === true,
        repeat: source.repeat !== false,
        volume: clampVolume(source.volume, base.volume),
        trackVolumes: sanitizeTrackVolumes(source.trackVolumes, validFiles),
        playbackPreference: source.playbackPreference === 'playing' ? 'playing' : 'paused'
    };
}

module.exports = {
    SUPPORTED_EXTENSIONS,
    MAX_UPLOAD_BYTES,
    extensionOf,
    mimeFor,
    isSupportedAudio,
    validateFileName,
    safeMusicPath,
    validateAudioBuffer,
    audioHeaderIsValid,
    inspectAudioFile,
    scanMusicFolder,
    defaultMusicState,
    clampVolume,
    sanitizePlaylist,
    sanitizeTrackVolumes,
    sanitizeMusicState
};
