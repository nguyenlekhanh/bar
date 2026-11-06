'use strict';

/**
 * Minimal, dependency-free GIF87a/GIF89a decoder.
 *
 * Produces composited RGBA frames with the original timing, transparency and
 * canvas size preserved. It intentionally supports only what animated GIFs use:
 * global/local colour tables, LZW data, interlacing, graphic-control extensions
 * (delay, transparency index, disposal method) and the NETSCAPE2.0 loop block.
 */

const MAX_DIMENSION = 4096;
const MAX_FRAMES = 2000;

function isGif(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 13) return false;
    const signature = buffer.subarray(0, 6).toString('ascii');
    return signature === 'GIF87a' || signature === 'GIF89a';
}

function readColorTable(buffer, offset, size) {
    const table = new Uint8Array(size * 3);
    table.set(buffer.subarray(offset, offset + size * 3));
    return table;
}

/** Reads a chain of length-prefixed sub-blocks; returns the concatenated data. */
function readSubBlocks(buffer, offset) {
    const chunks = [];
    let cursor = offset;
    while (cursor < buffer.length) {
        const size = buffer[cursor];
        cursor += 1;
        if (size === 0) break;
        if (cursor + size > buffer.length) throw new Error('truncated GIF sub-block');
        chunks.push(buffer.subarray(cursor, cursor + size));
        cursor += size;
    }
    return { data: Buffer.concat(chunks), offset: cursor };
}

/** LZW decoding for one image frame. Returns indices into the active palette. */
function decodeLzw(data, minCodeSize, pixelCount) {
    const clearCode = 1 << minCodeSize;
    const endCode = clearCode + 1;
    const output = new Uint8Array(pixelCount);

    let dictionary = [];
    let dictionaryLength = 0;
    let codeSize = minCodeSize + 1;
    let previous = null;
    let written = 0;

    const reset = () => {
        dictionary = new Array(4096);
        for (let code = 0; code < clearCode; code += 1) {
            dictionary[code] = [code];
        }
        dictionaryLength = endCode + 1;
        codeSize = minCodeSize + 1;
        previous = null;
    };
    reset();

    let bitBuffer = 0;
    let bitCount = 0;
    let byteIndex = 0;
    const emit = sequence => {
        for (let index = 0; index < sequence.length && written < pixelCount; index += 1) {
            output[written] = sequence[index];
            written += 1;
        }
    };

    while (written < pixelCount) {
        while (bitCount < codeSize) {
            if (byteIndex >= data.length) {
                return { pixels: output, complete: written >= pixelCount };
            }
            bitBuffer |= data[byteIndex] << bitCount;
            byteIndex += 1;
            bitCount += 8;
        }
        const code = bitBuffer & ((1 << codeSize) - 1);
        bitBuffer >>= codeSize;
        bitCount -= codeSize;

        if (code === clearCode) {
            reset();
            continue;
        }
        if (code === endCode) break;

        let entry;
        if (code < dictionaryLength && dictionary[code]) {
            entry = dictionary[code];
        } else if (code === dictionaryLength && previous) {
            entry = previous.concat(previous[0]);
        } else {
            // Corrupt stream: emit what we have so the frame is not silently dropped.
            break;
        }

        emit(entry);
        if (previous && dictionaryLength < 4096) {
            dictionary[dictionaryLength] = previous.concat(entry[0]);
            dictionaryLength += 1;
            if (dictionaryLength === (1 << codeSize) && codeSize < 12) codeSize += 1;
        }
        previous = entry;
    }

    return { pixels: output, complete: true };
}

function interlacedRowOrder(height) {
    const order = [];
    for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) {
        for (let row = start; row < height; row += step) order.push(row);
    }
    return order;
}

/**
 * Decodes a GIF buffer.
 * @returns {{width:number,height:number,frames:Array<{rgba:Buffer,delayMs:number}>,
 *            loopCount:number,fps:number,hasTransparency:boolean,declaredFrameCount:number}}
 */
function decodeGif(buffer) {
    if (!isGif(buffer)) throw new Error('not a GIF file');

    const width = buffer.readUInt16LE(6);
    const height = buffer.readUInt16LE(8);
    if (!width || !height) throw new Error('GIF has no canvas size');
    if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
        throw new Error(`GIF is too large (${width}x${height}, max ${MAX_DIMENSION})`);
    }
    const packed = buffer[10];
    const hasGlobalTable = (packed & 0x80) !== 0;
    const globalTableSize = hasGlobalTable ? 2 ** ((packed & 0x07) + 1) : 0;
    let offset = 13;
    const globalTable = hasGlobalTable ? readColorTable(buffer, offset, globalTableSize) : null;
    if (hasGlobalTable) offset += globalTableSize * 3;

    const pixelCount = width * height;
    // The canvas starts fully transparent so GIFs with holes stay transparent.
    let canvas = Buffer.alloc(pixelCount * 4, 0);
    let restoreTo = null;

    const frames = [];
    let hasTransparency = false;
    let loopCount = 1;
    let pendingDelay = 10;
    let pendingTransparentIndex = -1;
    let pendingDisposal = 0;

    while (offset < buffer.length) {
        const marker = buffer[offset];
        offset += 1;
        if (marker === 0x3b) break;

        if (marker === 0x21) {
            const label = buffer[offset];
            offset += 1;
            if (label === 0xf9) {
                const size = buffer[offset];
                offset += 1;
                if (size !== 4) throw new Error('malformed graphic control extension');
                const flags = buffer[offset];
                pendingDisposal = (flags >> 2) & 0x07;
                pendingTransparentIndex = (flags & 0x01) !== 0 ? buffer[offset + 3] : -1;
                if (pendingTransparentIndex >= 0) hasTransparency = true;
                const delay = buffer.readUInt16LE(offset + 1);
                pendingDelay = delay === 0 ? 10 : delay * 10;
                offset += size;
                offset = readSubBlocks(buffer, offset).offset;
                continue;
            }
            if (label === 0xff) {
                const size = buffer[offset];
                offset += 1;
                const app = buffer.subarray(offset, offset + size).toString('ascii');
                offset += size;
                const block = readSubBlocks(buffer, offset);
                offset = block.offset;
                if (app.startsWith('NETSCAPE') && block.data.length >= 3 && block.data[0] === 1) {
                    const declared = block.data.readUInt16LE(1);
                    loopCount = declared === 0 ? Infinity : declared;
                }
                continue;
            }
            offset = readSubBlocks(buffer, offset).offset;
            continue;
        }

        if (marker !== 0x2c) {
            throw new Error(`unexpected GIF block 0x${marker.toString(16)}`);
        }

        const left = buffer.readUInt16LE(offset);
        const top = buffer.readUInt16LE(offset + 2);
        const frameWidth = buffer.readUInt16LE(offset + 4);
        const frameHeight = buffer.readUInt16LE(offset + 6);
        const imagePacked = buffer[offset + 8];
        offset += 9;

        const hasLocalTable = (imagePacked & 0x80) !== 0;
        const localTableSize = hasLocalTable ? 2 ** ((imagePacked & 0x07) + 1) : 0;
        const palette = hasLocalTable ? readColorTable(buffer, offset, localTableSize) : globalTable;
        if (hasLocalTable) offset += localTableSize * 3;
        if (!palette) throw new Error('GIF frame has no colour table');

        const interlaced = (imagePacked & 0x40) !== 0;
        const minCodeSize = buffer[offset];
        offset += 1;
        const block = readSubBlocks(buffer, offset);
        offset = block.offset;

        if (!frameWidth || !frameHeight) continue;
        const framePixels = frameWidth * frameHeight;
        const { pixels } = decodeLzw(block.data, minCodeSize, framePixels);

        if (pendingDisposal === 3) restoreTo = Buffer.from(canvas);

        const rows = interlaced ? interlacedRowOrder(frameHeight) : null;
        for (let row = 0; row < frameHeight; row += 1) {
            const canvasY = top + (rows ? rows[row] : row);
            if (canvasY >= height) continue;
            for (let column = 0; column < frameWidth; column += 1) {
                const canvasX = left + column;
                if (canvasX >= width) continue;
                const index = pixels[row * frameWidth + column];
                // The transparent index is the GIF's "see through" colour: the
                // canvas keeps whatever was underneath it.
                if (index === pendingTransparentIndex) continue;
                const colorOffset = index * 3;
                const canvasOffset = (canvasY * width + canvasX) * 4;
                canvas[canvasOffset] = palette[colorOffset];
                canvas[canvasOffset + 1] = palette[colorOffset + 1];
                canvas[canvasOffset + 2] = palette[colorOffset + 2];
                canvas[canvasOffset + 3] = 255;
            }
        }

        frames.push({ rgba: Buffer.from(canvas), delayMs: pendingDelay });
        if (frames.length > MAX_FRAMES) throw new Error(`GIF has more than ${MAX_FRAMES} frames`);

        if (pendingDisposal === 2) {
            for (let row = top; row < top + frameHeight && row < height; row += 1) {
                const rowStart = (row * width + left) * 4;
                const rowEnd = Math.min(width, left + frameWidth);
                for (let column = left; column < rowEnd; column += 1) {
                    const index = rowStart + (column - left) * 4;
                    canvas[index] = 0;
                    canvas[index + 1] = 0;
                    canvas[index + 2] = 0;
                    canvas[index + 3] = 0;
                }
            }
        } else if (pendingDisposal === 3 && restoreTo) {
            canvas = restoreTo;
            restoreTo = null;
        }

        pendingDelay = 10;
        pendingTransparentIndex = -1;
        pendingDisposal = 0;
    }

    if (!frames.length) throw new Error('GIF contains no frames');

    const averageDelay = frames.reduce((sum, frame) => sum + frame.delayMs, 0) / frames.length;
    const fps = averageDelay > 0 ? Math.round(10000 / averageDelay) / 10 : 10;

    return {
        width,
        height,
        frames,
        loopCount,
        fps: fps > 0 ? fps : 10,
        hasTransparency,
        declaredFrameCount: frames.length
    };
}

module.exports = { decodeGif, isGif };
