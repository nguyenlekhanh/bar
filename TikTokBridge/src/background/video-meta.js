'use strict';

/**
 * Reads the orientation/size/duration a video file declares for itself.
 *
 * Phone clips store a rotation matrix (0/90/180/270) in the MP4 `tkhd` box and
 * expect the player to apply it. Unity's VideoPlayer ignores that matrix, so the
 * bridge reads it here and the config carries it to Unity, which turns the
 * backdrop geometry instead. Results are cached per path+mtime+size.
 *
 * Only the MP4 family is parsed. WebM/Matroska has no standard rotation
 * metadata, so it reports "no rotation" without ever reading the (possibly huge)
 * file — the 89 MB clips in DJ_VIDEO must not be opened for this.
 *
 * The file is walked box by box using small header reads, so a `moov` stored
 * after a multi-gigabyte `mdat` (the common "not faststart" export) is found
 * without loading the media data.
 */

const fs = require('node:fs/promises');
const path = require('node:path');

const CONTAINERS = new Set(['.mp4', '.m4v', '.mov']);
const MAX_BOX_HEADER_BYTES = 16;
const MAX_MOOV_BYTES = 8 * 1024 * 1024;
const MAX_TOP_LEVEL_BOXES = 256;
const cache = new Map();

function near(value, target) {
    return Math.abs(value - target) < 0.01;
}

/** tkhd matrix (a,b,c,d) → clockwise display rotation in degrees. */
function rotationFromMatrix(a, b, c, d) {
    if (near(a, 1) && near(d, 1) && near(b, 0) && near(c, 0)) return 0;
    if (near(a, 0) && near(b, 1) && near(c, -1) && near(d, 0)) return 90;
    if (near(a, -1) && near(d, -1) && near(b, 0) && near(c, 0)) return 180;
    if (near(a, 0) && near(b, -1) && near(c, 1) && near(d, 0)) return 270;
    return 0;
}

/** Parses sibling boxes inside [start, end) of an in-memory buffer. */
function parseBoxes(buffer, start, end) {
    const boxes = [];
    let offset = start;
    while (offset + 8 <= end) {
        let size = buffer.readUInt32BE(offset);
        const type = buffer.toString('latin1', offset + 4, offset + 8);
        let headerSize = 8;
        if (size === 1) {
            if (offset + 16 > end) break;
            const big = buffer.readBigUInt64BE(offset + 8);
            if (big > BigInt(Number.MAX_SAFE_INTEGER)) break;
            size = Number(big);
            headerSize = 16;
        } else if (size === 0) {
            size = end - offset;
        }
        if (size < headerSize || offset + size > end) break;
        boxes.push({ type, bodyStart: offset + headerSize, bodyEnd: offset + size });
        offset += size;
    }
    return boxes;
}

function findBox(boxes, type) {
    return boxes.find(box => box.type === type) || null;
}

function parseTkhd(buffer, box) {
    const body = box.bodyStart;
    if (body + 4 > box.bodyEnd) return null;
    const isV1 = buffer[body] === 1;
    const matrixAt = body + (isV1 ? 52 : 40);
    const sizeAt = body + (isV1 ? 88 : 76);
    if (sizeAt + 8 > box.bodyEnd) return null;

    const a = buffer.readInt32BE(matrixAt) / 65536;
    const b = buffer.readInt32BE(matrixAt + 4) / 65536;
    const c = buffer.readInt32BE(matrixAt + 12) / 65536;
    const d = buffer.readInt32BE(matrixAt + 16) / 65536;
    const width = Math.round(buffer.readUInt32BE(sizeAt) / 65536);
    const height = Math.round(buffer.readUInt32BE(sizeAt + 4) / 65536);

    return { rotation: rotationFromMatrix(a, b, c, d), width, height };
}

function parseMvhd(buffer, box) {
    const body = box.bodyStart;
    if (body + 4 > box.bodyEnd) return null;
    const isV1 = buffer[body] === 1;
    const timescaleAt = body + (isV1 ? 20 : 12);
    const durationAt = body + (isV1 ? 24 : 16);
    if (durationAt + (isV1 ? 8 : 4) > box.bodyEnd) return null;

    const timescale = buffer.readUInt32BE(timescaleAt);
    const duration = isV1 ? Number(buffer.readBigUInt64BE(durationAt)) : buffer.readUInt32BE(durationAt);
    if (!timescale || !duration) return null;
    return duration / timescale;
}

function handlerType(buffer, hdlr) {
    const at = hdlr.bodyStart + 8;
    if (at + 4 > hdlr.bodyEnd) return '';
    return buffer.toString('latin1', at, at + 4);
}

/**
 * Reads rotation/size/duration out of a buffer that starts with a `moov` box.
 * @returns {{ rotation:number, width:number, height:number, duration:number } | null}
 */
function extract(buffer) {
    const top = parseBoxes(buffer, 0, buffer.length);
    if (!top.length) return null;

    let duration = 0;
    let track = null;

    for (const box of top) {
        if (box.type !== 'moov') continue;
        const moovChildren = parseBoxes(buffer, box.bodyStart, box.bodyEnd);

        const mvhd = findBox(moovChildren, 'mvhd');
        if (mvhd) duration = parseMvhd(buffer, mvhd) || 0;

        for (const child of moovChildren) {
            if (child.type !== 'trak') continue;
            const trakChildren = parseBoxes(buffer, child.bodyStart, child.bodyEnd);
            const tkhd = findBox(trakChildren, 'tkhd');
            const mdia = findBox(trakChildren, 'mdia');
            if (!tkhd || !mdia) continue;

            const hdlr = findBox(parseBoxes(buffer, mdia.bodyStart, mdia.bodyEnd), 'hdlr');
            if (!hdlr || handlerType(buffer, hdlr) !== 'vide') continue;

            const parsed = parseTkhd(buffer, tkhd);
            if (parsed) {
                track = parsed;
                break;
            }
        }
        if (track) break;
    }

    if (!track) return null;

    const quarterTurn = track.rotation === 90 || track.rotation === 270;
    return {
        rotation: track.rotation,
        width: quarterTurn ? track.height : track.width,
        height: quarterTurn ? track.width : track.height,
        duration,
    };
}

async function readSlice(handle, start, length) {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead);
}

/**
 * Walks the top-level boxes with header-only reads and returns the `moov` box
 * location. Never touches `mdat`, so file size does not matter.
 */
async function locateMoov(handle, fileSize) {
    let offset = 0;
    for (let index = 0; index < MAX_TOP_LEVEL_BOXES && offset + 8 <= fileSize; index += 1) {
        const header = await readSlice(handle, offset, MAX_BOX_HEADER_BYTES);
        if (header.length < 8) return null;

        let size = header.readUInt32BE(0);
        const type = header.toString('latin1', 4, 8);
        let headerSize = 8;
        if (size === 1) {
            if (header.length < 16) return null;
            const big = header.readBigUInt64BE(8);
            if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
            size = Number(big);
            headerSize = 16;
        } else if (size === 0) {
            size = fileSize - offset;
        }
        if (size < headerSize) return null;

        if (type === 'moov') return { offset, size: Math.min(size, MAX_MOOV_BYTES) };
        offset += size;
    }
    return null;
}

/**
 * @returns {Promise<{ rotation:number, width:number, height:number, duration:number } | null>}
 */
async function readVideoMeta(filePath) {
    const extension = path.extname(String(filePath || '')).toLowerCase();
    if (!CONTAINERS.has(extension)) return null;

    let stat;
    try {
        stat = await fs.stat(filePath);
    } catch {
        return null;
    }
    if (!stat.isFile() || stat.size <= 0) return null;

    const key = `${filePath}|${stat.mtimeMs}|${stat.size}`;
    if (cache.has(key)) return cache.get(key);

    let meta = null;
    let handle = null;
    try {
        handle = await fs.open(filePath, 'r');
        const moov = await locateMoov(handle, stat.size);
        if (moov) meta = extract(await readSlice(handle, moov.offset, moov.size));
    } catch {
        meta = null;
    } finally {
        if (handle) await handle.close().catch(() => { });
    }

    if (cache.size > 200) cache.clear();
    cache.set(key, meta);
    return meta;
}

function clearVideoMetaCache() {
    cache.clear();
}

module.exports = {
    CONTAINERS,
    readVideoMeta,
    clearVideoMetaCache,
    _internal: { parseBoxes, extract, rotationFromMatrix }
};
