'use strict';

/**
 * Minimal RGBA PNG writer (8-bit, colour type 6, no interlacing).
 * Enough for exporting GIF frames losslessly: alpha, exact dimensions, no
 * resampling, so the original aspect ratio and transparency survive untouched.
 */

const zlib = require('node:zlib');

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let index = 0; index < 256; index += 1) {
        let value = index;
        for (let bit = 0; bit < 8; bit += 1) {
            value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
        }
        table[index] = value;
    }
    return table;
})();

function crc32(buffer) {
    let crc = -1;
    for (let index = 0; index < buffer.length; index += 1) {
        crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typeBuffer = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
    return Buffer.concat([length, typeBuffer, data, crc]);
}

/** Encodes one raw RGBA buffer (width*height*4 bytes) into a PNG buffer. */
function encodePng(rgba, width, height) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
        throw new Error('PNG requires a positive integer size');
    }
    if (rgba.length !== width * height * 4) {
        throw new Error(`PNG pixel buffer is ${rgba.length} bytes, expected ${width * height * 4}`);
    }

    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;   // bit depth
    header[9] = 6;   // colour type: truecolour with alpha
    header[10] = 0;  // deflate
    header[11] = 0;  // adaptive filtering
    header[12] = 0;  // no interlacing

    const stride = width * 4;
    const raw = Buffer.alloc((stride + 1) * height);
    for (let row = 0; row < height; row += 1) {
        raw[row * (stride + 1)] = 0; // filter type 0 (None) keeps pixels exact
        rgba.copy(raw, row * (stride + 1) + 1, row * stride, row * stride + stride);
    }

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header),
        chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0))
    ]);
}

module.exports = { encodePng, crc32 };
