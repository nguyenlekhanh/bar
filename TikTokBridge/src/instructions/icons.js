'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_ICON_BYTES = 256 * 1024;
const MAX_ICON_DIMENSION = 512;

/**
 * Only a real PNG header is accepted. Unity still decodes the file with
 * LoadImage and falls back to a built-in icon if decoding fails.
 */
function inspectPng(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 33) return { error: 'The icon is not a PNG file.' };
    if (buffer.length > MAX_ICON_BYTES) return { error: 'The icon is larger than 256 KB.' };
    if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return { error: 'The icon is not a PNG file.' };
    if (buffer.readUInt32BE(8) !== 13 || buffer.toString('ascii', 12, 16) !== 'IHDR') {
        return { error: 'The PNG header is invalid.' };
    }
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    if (width < 1 || height < 1 || width > MAX_ICON_DIMENSION || height > MAX_ICON_DIMENSION) {
        return { error: `Icons must be between 1 and ${MAX_ICON_DIMENSION} pixels.` };
    }
    if (width !== height) return { error: 'Instruction icons must be square PNG images.' };
    return { width, height };
}

async function saveInstructionIcon(buffer, directory) {
    const inspection = inspectPng(buffer);
    if (inspection.error) return inspection;

    const digest = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
    const file = `icon-${digest}.png`;
    await fs.mkdir(directory, { recursive: true });
    const target = path.join(directory, file);
    try {
        await fs.writeFile(target, buffer, { flag: 'wx' });
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
    }
    return {
        file,
        width: inspection.width,
        height: inspection.height,
        bytes: buffer.length,
        url: `/assets/instruction-icons/${file}`
    };
}

module.exports = {
    PNG_SIGNATURE,
    MAX_ICON_BYTES,
    MAX_ICON_DIMENSION,
    inspectPng,
    saveInstructionIcon
};
