'use strict';

/**
 * GIF Manager backend: import (upload or URL), inspect, convert, rename, edit
 * and delete animations. Everything here reuses the Phase 3 decoder, encoder
 * and pipeline — there is no second conversion path.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const dns = require('node:dns/promises');
const net = require('node:net');

const { isGif, decodeGif } = require('./gif-decoder');
const {
    resolveOptions,
    discoverAnimations,
    sanitizeAnimationId,
    writeManifest,
    writeAnimation,
    writeState,
    readState,
    readMetadata,
    sha256,
    METADATA_NAME
} = require('./pipeline');

const GIF_EXTENSION = '.gif';
const inspectionCache = new Map();

function positiveInteger(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function limitsFromEnv(env = process.env) {
    return {
        maxBytes: positiveInteger(env.GIF_MAX_BYTES, 8 * 1024 * 1024),
        maxFrames: positiveInteger(env.GIF_MAX_FRAMES, 600),
        maxDimension: positiveInteger(env.GIF_MAX_DIMENSION, 2048),
        maxDownloadBytes: positiveInteger(env.GIF_MAX_DOWNLOAD_BYTES, 12 * 1024 * 1024),
        downloadTimeoutMs: positiveInteger(env.GIF_DOWNLOAD_TIMEOUT_MS, 15000),
        maxRedirects: 3
    };
}

/** Client filenames are never trusted: basename only, safe charset, .gif. */
function sanitizeFileName(value) {
    const base = path.basename(String(value || '').replace(/\\/g, '/')).replace(/\.gif$/i, '');
    const cleaned = base
        .replace(/[^A-Za-z0-9._-]+/g, '_')
        .replace(/_{2,}/g, '_')
        .replace(/^[._-]+/, '')
        .slice(0, 80);
    return `${cleaned || 'animation'}${GIF_EXTENSION}`;
}

function formatSize(bytes) {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${bytes} B`;
}

/**
 * Validates and parses a GIF without writing anything. Throws a message the
 * panel can show verbatim.
 */
function inspectGifBuffer(buffer, { filename = 'upload.gif', limits = limitsFromEnv() } = {}) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        throw new Error('The file is empty.');
    }
    if (buffer.length > limits.maxBytes) {
        throw new Error(`GIF is ${formatSize(buffer.length)}; the limit is ${formatSize(limits.maxBytes)}.`);
    }
    if (!isGif(buffer)) {
        throw new Error('Not a GIF: expected a GIF87a or GIF89a signature.');
    }

    let decoded;
    try {
        decoded = decodeGif(buffer);
    } catch (error) {
        throw new Error(`The GIF could not be decoded: ${error.message}`);
    }

    if (decoded.frames.length === 0) throw new Error('The GIF contains no frames.');
    if (decoded.frames.length > limits.maxFrames) {
        throw new Error(`GIF has ${decoded.frames.length} frames; the limit is ${limits.maxFrames}.`);
    }
    if (decoded.width > limits.maxDimension || decoded.height > limits.maxDimension) {
        throw new Error(`Resolution ${decoded.width}×${decoded.height} exceeds the ${limits.maxDimension} px limit per side.`);
    }

    const safeName = sanitizeFileName(filename);
    const frameDelaysMs = decoded.frames.map(frame => frame.delayMs);
    const durationMs = frameDelaysMs.reduce((sum, delay) => sum + delay, 0);

    return {
        ok: true,
        filename: safeName,
        animationId: sanitizeAnimationId(safeName),
        bytes: buffer.length,
        sha256: sha256(buffer),
        width: decoded.width,
        height: decoded.height,
        frameCount: decoded.frames.length,
        fps: Math.round(decoded.fps * 10) / 10,
        frameDelaysMs,
        durationMs,
        transparent: decoded.hasTransparency,
        loop: decoded.loopCount !== 1,
        aspectRatio: decoded.height ? Math.round((decoded.width / decoded.height) * 1000) / 1000 : 1
    };
}

async function pathExists(target) {
    try {
        await fs.access(target);
        return true;
    } catch {
        return false;
    }
}

async function uniqueFileName(gifsDir, desiredName) {
    const extension = GIF_EXTENSION;
    const stem = desiredName.slice(0, -extension.length);
    for (let attempt = 1; attempt <= 99; attempt += 1) {
        const candidate = attempt === 1 ? desiredName : `${stem}-${attempt}${extension}`;
        if (!(await pathExists(path.join(gifsDir, candidate)))) return candidate;
    }
    return `${stem}-${Date.now()}${extension}`;
}

/** Parses every source GIF, reusing cached results while size/mtime match. */
async function listGifSources(rawOptions = {}) {
    const options = resolveOptions(rawOptions);
    const limits = rawOptions.limits || limitsFromEnv();

    let names;
    try {
        names = await fs.readdir(options.gifsDir);
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }

    const result = [];
    for (const name of names.filter(entry => entry.toLowerCase().endsWith(GIF_EXTENSION)).sort()) {
        const full = path.join(options.gifsDir, name);
        let stat;
        try {
            stat = await fs.stat(full);
        } catch {
            continue;
        }
        const cached = inspectionCache.get(full);
        let metadata;
        if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
            metadata = cached.metadata;
        } else {
            try {
                const buffer = await fs.readFile(full);
                metadata = inspectGifBuffer(buffer, { filename: name, limits });
            } catch (error) {
                metadata = { ok: false, filename: name, animationId: '', error: error.message };
            }
            inspectionCache.set(full, { size: stat.size, mtimeMs: stat.mtimeMs, metadata });
        }
        result.push({ file: name, bytes: stat.size, modifiedAt: new Date(stat.mtimeMs).toISOString(), ...metadata });
    }
    return result;
}

async function readReport(logDir) {
    try {
        const raw = await fs.readFile(path.join(logDir, 'gif-conversion-report.json'), 'utf8');
        const parsed = JSON.parse(raw);
        return {
            generatedAt: parsed.generatedAt || '',
            converted: Array.isArray(parsed.converted) ? parsed.converted : [],
            skipped: Array.isArray(parsed.skipped) ? parsed.skipped : [],
            failed: Array.isArray(parsed.failed) ? parsed.failed : []
        };
    } catch {
        return { generatedAt: '', converted: [], skipped: [], failed: [] };
    }
}

/** Everything the GIF Manager tab renders in one response. */
async function librarySnapshot(rawOptions = {}) {
    const options = resolveOptions(rawOptions);
    const limits = rawOptions.limits || limitsFromEnv();

    const [gifs, animations, report] = await Promise.all([
        listGifSources({ ...options, limits }),
        discoverAnimations(options.charactersDir),
        readReport(options.logDir)
    ]);

    const byId = new Map(animations.map(animation => [animation.animationId, animation]));
    const gifEntries = gifs.map(gif => {
        const animation = gif.animationId ? byId.get(gif.animationId) : null;
        return {
            ...gif,
            converted: Boolean(animation),
            animation: animation || null,
            status: !gif.ok ? 'invalid' : animation ? 'converted' : 'pending'
        };
    });

    const invalidGifs = gifEntries.filter(gif => gif.status === 'invalid');
    const stats = {
        totalGifs: gifEntries.length,
        convertedAnimations: animations.length,
        failedConversions: report.failed.length + invalidGifs.length,
        invalidGifs: invalidGifs.length,
        totalFrames: animations.reduce((sum, animation) => sum + animation.frameCount, 0)
    };
    const pipeline = {
        lastRunAt: report.generatedAt,
        converted: report.converted.length,
        skipped: report.skipped.length,
        failed: report.failed.length,
        autoConvert: process.env.GIF_AUTOCONVERT !== '0',
        limits
    };

    return { stats, pipeline, gifs: gifEntries, animations };
}

async function importGifBuffer(buffer, rawOptions = {}) {
    const options = resolveOptions(rawOptions);
    const limits = rawOptions.limits || limitsFromEnv();
    const inspected = inspectGifBuffer(buffer, { filename: rawOptions.filename, limits });

    await fs.mkdir(options.gifsDir, { recursive: true });

    const existing = await listGifSources({ ...options, limits });
    // Re-uploading the same file under the same name is a duplicate; the same
    // bytes under a new name is a deliberate second animation.
    const twin = existing.find(gif => gif.ok && gif.sha256 === inspected.sha256 && gif.file === inspected.filename);
    if (twin) {
        return { ...inspected, storedName: twin.file, duplicate: true };
    }

    const storedName = await uniqueFileName(options.gifsDir, inspected.filename);
    const temporary = path.join(options.gifsDir, `.upload-${process.pid}-${Date.now()}.tmp`);
    await fs.writeFile(temporary, buffer);
    try {
        await fs.rename(temporary, path.join(options.gifsDir, storedName));
    } catch (error) {
        await fs.rm(temporary, { force: true });
        throw error;
    }

    inspectionCache.delete(path.join(options.gifsDir, storedName));
    return { ...inspected, storedName, duplicate: false };
}

function isPrivateAddress(rawAddress) {
    const address = String(rawAddress || '').toLowerCase().replace(/^\[|\]$/g, '');
    const mapped = address.startsWith('::ffff:') ? address.slice(7) : address;
    if (net.isIPv4(mapped)) {
        const [a, b] = mapped.split('.').map(Number);
        if (a === 0 || a === 10 || a === 127) return true;
        if (a === 169 && b === 254) return true;
        if (a === 172 && b >= 16 && b <= 31) return true;
        if (a === 192 && b === 168) return true;
        if (a === 100 && b >= 64 && b <= 127) return true;
        if (a >= 224) return true;
        return false;
    }
    if (net.isIPv6(mapped)) {
        if (mapped === '::' || mapped === '::1') return true;
        if (/^f[cd][0-9a-f]{2}:/.test(mapped)) return true;
        if (/^fe[89ab][0-9a-f]:/.test(mapped)) return true;
    }
    return false;
}

/** Rejects scheme, credentials and hosts that resolve to private addresses. */
async function assertFetchableUrl(rawUrl) {
    if (typeof rawUrl !== 'string' || !rawUrl.trim()) throw new Error('Enter a GIF URL.');
    let url;
    try {
        url = new URL(rawUrl.trim());
    } catch {
        throw new Error('That URL is not valid.');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('Only http:// and https:// URLs are supported.');
    }
    if (url.username || url.password) throw new Error('URLs with embedded credentials are not allowed.');

    const host = url.hostname.replace(/^\[|\]$/g, '');
    let addresses;
    if (net.isIP(host)) {
        addresses = [{ address: host }];
    } else {
        try {
            addresses = await dns.lookup(host, { all: true, verbatim: true });
        } catch {
            throw new Error('That host could not be resolved.');
        }
    }
    if (!addresses.length) throw new Error('That host could not be resolved.');
    if (addresses.some(entry => isPrivateAddress(entry.address))) {
        throw new Error('Refusing to download from a private or loopback address.');
    }
    return url;
}

function filenameFromUrl(url) {
    try {
        const base = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
        return sanitizeFileName(base.toLowerCase().endsWith(GIF_EXTENSION) ? base : `${base || 'download'}.gif`);
    } catch {
        return 'download.gif';
    }
}

async function downloadGifFromUrl(rawUrl, rawOptions = {}) {
    const limits = rawOptions.limits || limitsFromEnv();
    let current = await assertFetchableUrl(rawUrl);
    let response;

    for (let hop = 0; hop <= limits.maxRedirects; hop += 1) {
        response = await fetch(current, {
            redirect: 'manual',
            signal: AbortSignal.timeout(limits.downloadTimeoutMs),
            headers: { accept: 'image/gif, image/*;q=0.9' }
        });
        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location');
            if (!location) break;
            current = await assertFetchableUrl(new URL(location, current).toString());
            continue;
        }
        break;
    }

    if (!response) throw new Error('The download failed.');
    if (!response.ok) throw new Error(`The server answered HTTP ${response.status}.`);

    const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const allowedTypes = new Set(['image/gif', 'application/octet-stream', 'binary/octet-stream', 'image/pjpeg', 'image/png']);
    if (contentType && !allowedTypes.has(contentType)) {
        throw new Error(`Unexpected content type: ${contentType}. Download a direct GIF link.`);
    }

    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > limits.maxDownloadBytes) {
        throw new Error(`The file is ${formatSize(declared)}, above the ${formatSize(limits.maxDownloadBytes)} download limit.`);
    }

    const chunks = [];
    let total = 0;
    if (response.body) {
        for await (const chunk of response.body) {
            total += chunk.length;
            if (total > limits.maxDownloadBytes) {
                throw new Error(`The download exceeded the ${formatSize(limits.maxDownloadBytes)} limit.`);
            }
            chunks.push(Buffer.from(chunk));
        }
    }

    return importGifBuffer(Buffer.concat(chunks), {
        ...rawOptions,
        filename: rawOptions.filename || filenameFromUrl(current)
    });
}

async function findGifForAnimation(animationId, options) {
    const gifs = await listGifSources(options);
    const direct = gifs.find(gif => gif.animationId === animationId);
    if (direct) return direct;
    return gifs.find(gif => gif.file.toLowerCase() === `${animationId}${GIF_EXTENSION}`) || null;
}

/** Converts one GIF into its animation folder through the Phase 3 pipeline. */
async function convertAnimation(animationId, rawOptions = {}) {
    const options = resolveOptions(rawOptions);
    const id = sanitizeAnimationId(String(animationId || '').trim());
    const gif = await findGifForAnimation(id, options);
    if (!gif) throw new Error(`No source GIF produces the animation "${id}".`);

    const state = await readState(options.stateFile);
    const buffer = await fs.readFile(path.join(options.gifsDir, gif.file));
    const result = await writeAnimation(
        path.join(options.gifsDir, gif.file),
        gif.file,
        buffer,
        { ...options, force: true, allowOverwrite: rawOptions.confirm === true },
        state.entries
    );
    await writeState(options.stateFile, state);
    const animations = await writeManifest(options.charactersDir, await discoverAnimations(options.charactersDir));

    return {
        animationId: result.animationId,
        frameCount: result.frameCount,
        folder: path.join(options.charactersDir, result.animationId),
        status: result.status,
        animations
    };
}

async function renameAnimation(previousId, nextName, rawOptions = {}) {
    const options = resolveOptions(rawOptions);
    const from = sanitizeAnimationId(String(previousId || '').trim());
    const to = sanitizeAnimationId(String(nextName || '').trim());
    if (from === to) return { previousId: from, animationId: to, changed: false };

    const source = path.join(options.charactersDir, from);
    const target = path.join(options.charactersDir, to);
    if (!(await pathExists(source))) throw new Error(`Animation "${from}" does not exist.`);
    if (await pathExists(target)) throw new Error(`Animation "${to}" already exists.`);

    await fs.rename(source, target);
    const metadata = (await readMetadata(target)) || {};
    metadata.animationId = to;
    metadata.renamedAt = new Date().toISOString();
    await fs.writeFile(path.join(target, METADATA_NAME), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
    const animations = await writeManifest(options.charactersDir, await discoverAnimations(options.charactersDir));

    return { previousId: from, animationId: to, changed: true, animations };
}

async function deleteAnimation(animationId, rawOptions = {}) {
    const options = resolveOptions(rawOptions);
    const id = sanitizeAnimationId(String(animationId || '').trim());
    const folder = path.join(options.charactersDir, id);
    if (!(await pathExists(folder))) throw new Error(`Animation "${id}" does not exist.`);

    const mappedGifts = Array.isArray(rawOptions.giftIds) ? rawOptions.giftIds : [];
    if (mappedGifts.length && rawOptions.confirm !== true) {
        const error = new Error(
            `"${id}" is used by ${mappedGifts.length} gift mapping(s): ${mappedGifts.join(', ')}. Confirm to delete it.`
        );
        error.code = 'EMAPPED';
        error.giftIds = mappedGifts;
        throw error;
    }

    await fs.rm(folder, { recursive: true, force: true });
    const animations = await writeManifest(options.charactersDir, await discoverAnimations(options.charactersDir));
    return { animationId: id, removed: true, giftIds: mappedGifts, animations };
}

function boundedMetadataNumber(patch, field, minimum, maximum) {
    if (patch[field] === undefined || patch[field] === null || patch[field] === '') return undefined;
    const number = Number(patch[field]);
    if (!Number.isFinite(number) || number < minimum || number > maximum) {
        throw new Error(`${field} must be between ${minimum} and ${maximum}.`);
    }
    return number;
}

/** Applies operator overrides and keeps them across re-conversions. */
async function updateAnimationMetadata(animationId, patch = {}, rawOptions = {}) {
    const options = resolveOptions(rawOptions);
    const id = sanitizeAnimationId(String(animationId || '').trim());
    const folder = path.join(options.charactersDir, id);
    const metadata = await readMetadata(folder);
    if (!metadata) throw new Error(`Animation "${id}" has no metadata to edit.`);

    const next = { ...metadata, animationId: id };

    if (patch.reset === true) {
        next.fps = Number(metadata.sourceFps) > 0 ? Number(metadata.sourceFps) : metadata.fps;
        next.loop = metadata.sourceLoop !== false;
        next.playbackSpeed = 1;
        next.defaultDurationMs = Number(metadata.durationMs) || 0;
        next.overrides = null;
    } else {
        const fps = boundedMetadataNumber(patch, 'fps', 1, 120);
        const playbackSpeed = boundedMetadataNumber(patch, 'playbackSpeed', 0.25, 3);
        const defaultDurationMs = boundedMetadataNumber(patch, 'defaultDurationMs', 0, 300000);
        if (fps !== undefined) next.fps = Math.round(fps * 10) / 10;
        if (playbackSpeed !== undefined) next.playbackSpeed = Math.round(playbackSpeed * 100) / 100;
        if (defaultDurationMs !== undefined) next.defaultDurationMs = Math.round(defaultDurationMs);
        if (patch.loop !== undefined) {
            if (typeof patch.loop !== 'boolean') throw new Error('loop must be true or false.');
            next.loop = patch.loop;
        }
        next.overrides = {
            fps: next.fps,
            loop: next.loop,
            playbackSpeed: next.playbackSpeed,
            defaultDurationMs: next.defaultDurationMs
        };
    }

    next.editedAt = new Date().toISOString();
    const temporary = path.join(folder, `.metadata-${process.pid}-${Date.now()}.tmp`);
    await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, path.join(folder, METADATA_NAME));
    const animations = await writeManifest(options.charactersDir, await discoverAnimations(options.charactersDir));

    return { metadata: next, animations };
}

/** Animation ids that exist as converted folders right now. */
async function characterAnimationIds(rawOptions = {}) {
    const options = resolveOptions(rawOptions);
    return new Set((await discoverAnimations(options.charactersDir)).map(animation => animation.animationId));
}

module.exports = {
    limitsFromEnv,
    sanitizeFileName,
    inspectGifBuffer,
    listGifSources,
    librarySnapshot,
    importGifBuffer,
    downloadGifFromUrl,
    assertFetchableUrl,
    isPrivateAddress,
    convertAnimation,
    renameAnimation,
    deleteAnimation,
    updateAnimationMetadata,
    characterAnimationIds,
    findGifForAnimation,
    readReport,
    filenameFromUrl
};
