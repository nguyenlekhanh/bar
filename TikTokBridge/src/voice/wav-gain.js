'use strict';

/**
 * Add gain to a WAV while keeping the peak below full scale. Kokoro emits
 * 32-bit IEEE float WAVs; Windows SAPI and OpenAI may emit PCM16. Unsupported
 * WAV layouts are returned untouched rather than corrupted.
 */
function amplifyWav(buffer, boostDb) {
    const requestedDb = Math.max(0, Math.min(12, Number(boostDb) || 0));
    if (!Buffer.isBuffer(buffer) || buffer.length < 44 || requestedDb < 0.05 ||
        buffer.toString('ascii', 0, 4) !== 'RIFF' ||
        buffer.toString('ascii', 8, 12) !== 'WAVE') {
        return { buffer, applied: false, gainDb: 0 };
    }

    let offset = 12;
    let format = 0;
    let bits = 0;
    let dataOffset = -1;
    let dataSize = 0;
    while (offset + 8 <= buffer.length) {
        const id = buffer.toString('ascii', offset, offset + 4);
        const size = buffer.readUInt32LE(offset + 4);
        const start = offset + 8;
        if (id === 'fmt ' && start + 16 <= buffer.length) {
            format = buffer.readUInt16LE(start);
            bits = buffer.readUInt16LE(start + 14);
        } else if (id === 'data') {
            dataOffset = start;
            dataSize = Math.min(size, Math.max(0, buffer.length - start));
            break;
        }
        offset = start + size + (size % 2);
        if (size <= 0) break;
    }
    if (dataOffset < 0 || dataSize <= 0) return { buffer, applied: false, gainDb: 0 };

    const stride = bits / 8;
    if (![16, 24, 32, 64].includes(bits) || !(format === 1 || format === 3)) {
        return { buffer, applied: false, gainDb: 0 };
    }
    if (stride <= 0 || dataSize % stride !== 0) return { buffer, applied: false, gainDb: 0 };

    const readSample = index => {
        if (format === 3 && bits === 32) return buffer.readFloatLE(index);
        if (format === 3 && bits === 64) return buffer.readDoubleLE(index);
        if (format === 1 && bits === 16) return buffer.readInt16LE(index) / 32768;
        if (format === 1 && bits === 32) return buffer.readInt32LE(index) / 2147483648;
        if (format === 1 && bits === 24) {
            let value = buffer[index] | (buffer[index + 1] << 8) | (buffer[index + 2] << 16);
            if (value & 0x800000) value |= ~0xFFFFFF;
            return value / 8388608;
        }
        return 0;
    };

    let peak = 0;
    for (let index = dataOffset; index + stride <= dataOffset + dataSize; index += stride) {
        const sample = Math.abs(readSample(index));
        if (sample > peak) peak = sample;
    }
    if (peak <= 0.000001) return { buffer, applied: false, gainDb: 0 };

    // Requested gain is capped so the boosted peak stays just below full scale.
    const gain = Math.min(10 ** (requestedDb / 20), 0.98 / peak);
    if (gain <= 1.001) return { buffer, applied: false, gainDb: 0 };

    const output = Buffer.from(buffer);
    for (let index = dataOffset; index + stride <= dataOffset + dataSize; index += stride) {
        const sample = readSample(index) * gain;
        if (format === 3 && bits === 32) {
            output.writeFloatLE(Math.max(-1, Math.min(1, sample)), index);
        } else if (format === 3 && bits === 64) {
            output.writeDoubleLE(Math.max(-1, Math.min(1, sample)), index);
        } else if (format === 1 && bits === 16) {
            output.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample * 32768))), index);
        } else if (format === 1 && bits === 32) {
            output.writeInt32LE(Math.max(-2147483648, Math.min(2147483647, Math.round(sample * 2147483648))), index);
        } else if (format === 1 && bits === 24) {
            const value = Math.max(-8388608, Math.min(8388607, Math.round(sample * 8388608)));
            output[index] = value & 0xFF;
            output[index + 1] = (value >> 8) & 0xFF;
            output[index + 2] = (value >> 16) & 0xFF;
        }
    }

    return { buffer: output, applied: true, gainDb: requestedDb };
}

module.exports = { amplifyWav };
