'use strict';

/**
 * Loudness normalization + output gain for TTS WAVs.
 *
 * TTS providers return wildly different levels (Kokoro float32 peaks around
 * 0.4–0.7, SAPI often sits close to full scale). The bridge normalizes RMS to a
 * common target, applies an optional output gain, and then runs a soft peak
 * limiter. The resulting WAV is cached once, so Unity never has to apply a
 * second gain stage. Unsupported layouts are returned untouched.
 */
const TARGET_RMS_DB = -20;
const LIMIT_THRESHOLD = 0.78;
const LIMIT_CEILING = 0.98;
const MAX_NORMALIZATION_GAIN = 6;

function readWavLayout(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 44 ||
        buffer.toString('ascii', 0, 4) !== 'RIFF' ||
        buffer.toString('ascii', 8, 12) !== 'WAVE') {
        return null;
    }
    let offset = 12;
    let format = 0;
    let bits = 0;
    let channels = 0;
    let dataOffset = -1;
    let dataSize = 0;
    while (offset + 8 <= buffer.length) {
        const id = buffer.toString('ascii', offset, offset + 4);
        const size = buffer.readUInt32LE(offset + 4);
        const start = offset + 8;
        if (id === 'fmt ' && start + 16 <= buffer.length) {
            format = buffer.readUInt16LE(start);
            channels = buffer.readUInt16LE(start + 2);
            bits = buffer.readUInt16LE(start + 14);
        } else if (id === 'data') {
            dataOffset = start;
            dataSize = Math.min(size, Math.max(0, buffer.length - start));
            break;
        }
        offset = start + size + (size % 2);
        if (size <= 0) break;
    }
    const stride = bits / 8;
    if (dataOffset < 0 || dataSize <= 0 || channels < 1 ||
        ![16, 24, 32, 64].includes(bits) || !(format === 1 || format === 3) ||
        stride <= 0 || dataSize % stride !== 0) {
        return null;
    }
    return { format, bits, channels, dataOffset, dataSize, stride };
}

function sampleReader(buffer, layout) {
    return index => {
        if (layout.format === 3 && layout.bits === 32) return buffer.readFloatLE(index);
        if (layout.format === 3 && layout.bits === 64) return buffer.readDoubleLE(index);
        if (layout.format === 1 && layout.bits === 16) return buffer.readInt16LE(index) / 32768;
        if (layout.format === 1 && layout.bits === 32) return buffer.readInt32LE(index) / 2147483648;
        if (layout.format === 1 && layout.bits === 24) {
            let value = buffer[index] | (buffer[index + 1] << 8) | (buffer[index + 2] << 16);
            if (value & 0x800000) value |= ~0xFFFFFF;
            return value / 8388608;
        }
        return 0;
    };
}

function sampleWriter(buffer, layout) {
    return (index, sample) => {
        if (layout.format === 3 && layout.bits === 32) {
            buffer.writeFloatLE(sample, index);
        } else if (layout.format === 3 && layout.bits === 64) {
            buffer.writeDoubleLE(sample, index);
        } else if (layout.format === 1 && layout.bits === 16) {
            buffer.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample * 32768))), index);
        } else if (layout.format === 1 && layout.bits === 32) {
            buffer.writeInt32LE(Math.max(-2147483648, Math.min(2147483647, Math.round(sample * 2147483648))), index);
        } else if (layout.format === 1 && layout.bits === 24) {
            const value = Math.max(-8388608, Math.min(8388607, Math.round(sample * 8388608)));
            buffer[index] = value & 0xFF;
            buffer[index + 1] = (value >> 8) & 0xFF;
            buffer[index + 2] = (value >> 16) & 0xFF;
        }
    };
}

function measureWav(buffer) {
    const layout = readWavLayout(buffer);
    if (!layout) return { durationMs: 0, peak: 0, rms: 0, peakDb: -Infinity, rmsDb: -Infinity };
    const readSample = sampleReader(buffer, layout);
    let peak = 0;
    let sumSquares = 0;
    let count = 0;
    for (let index = layout.dataOffset; index + layout.stride <= layout.dataOffset + layout.dataSize; index += layout.stride) {
        const sample = readSample(index);
        const absolute = Math.abs(sample);
        if (absolute > peak) peak = absolute;
        sumSquares += sample * sample;
        count += 1;
    }
    if (!count) return { durationMs: 0, peak: 0, rms: 0, peakDb: -Infinity, rmsDb: -Infinity };
    const rms = Math.sqrt(sumSquares / count);
    return {
        peak,
        rms,
        peakDb: peak > 0 ? 20 * Math.log10(peak) : -Infinity,
        rmsDb: rms > 0 ? 20 * Math.log10(rms) : -Infinity
    };
}

function softLimit(sample) {
    const absolute = Math.abs(sample);
    if (absolute <= LIMIT_THRESHOLD) return sample;
    const range = LIMIT_CEILING - LIMIT_THRESHOLD;
    const limited = LIMIT_THRESHOLD + range *
        Math.tanh((absolute - LIMIT_THRESHOLD) / range);
    return Math.sign(sample) * Math.min(LIMIT_CEILING, limited);
}

/**
 * @param {Buffer} buffer WAV bytes.
 * @param {number} boostDb Additional output gain, clamped to 0–18 dB.
 * @returns {{buffer: Buffer, applied: boolean, gainDb: number, normalizationGainDb: number,
 *   totalGainDb: number, limited: boolean, inputPeakDb: number, inputRmsDb: number,
 *   outputPeakDb: number, outputRmsDb: number, peak: number, rms: number}}
 */
function amplifyWav(buffer, boostDb) {
    const requestedDb = Math.max(0, Math.min(18, Number(boostDb) || 0));
    const layout = readWavLayout(buffer);
    if (!layout) {
        const measured = measureWav(buffer);
        return {
            buffer, applied: false, gainDb: 0, normalizationGainDb: 0, totalGainDb: 0,
            limited: false, inputPeakDb: measured.peakDb, inputRmsDb: measured.rmsDb,
            outputPeakDb: measured.peakDb, outputRmsDb: measured.rmsDb,
            peak: measured.peak, rms: measured.rms
        };
    }

    const readSample = sampleReader(buffer, layout);
    const writeSample = sampleWriter(buffer, layout);
    let peak = 0;
    let sumSquares = 0;
    let count = 0;
    for (let index = layout.dataOffset; index + layout.stride <= layout.dataOffset + layout.dataSize; index += layout.stride) {
        const sample = readSample(index);
        const absolute = Math.abs(sample);
        if (absolute > peak) peak = absolute;
        sumSquares += sample * sample;
        count += 1;
    }
    if (!count || peak <= 0.000001) {
        return {
            buffer, applied: false, gainDb: 0, normalizationGainDb: 0, totalGainDb: 0,
            limited: false, inputPeakDb: -Infinity, inputRmsDb: -Infinity,
            outputPeakDb: -Infinity, outputRmsDb: -Infinity, peak: 0, rms: 0
        };
    }

    const rms = Math.sqrt(sumSquares / count);
    const targetRms = 10 ** (TARGET_RMS_DB / 20);
    const normalizationGain = rms > 0
        ? Math.min(MAX_NORMALIZATION_GAIN, targetRms / rms)
        : 1;
    const outputGain = 10 ** (requestedDb / 20);
    const totalGain = normalizationGain * outputGain;
    const normalizationGainDb = normalizationGain > 0 ? 20 * Math.log10(normalizationGain) : 0;
    const totalGainDb = totalGain > 0 ? 20 * Math.log10(totalGain) : 0;

    if (Math.abs(totalGain - 1) < 0.001) {
        return {
            buffer, applied: false, gainDb: 0, normalizationGainDb, totalGainDb: 0,
            limited: false, inputPeakDb: 20 * Math.log10(peak), inputRmsDb: 20 * Math.log10(rms),
            outputPeakDb: 20 * Math.log10(peak), outputRmsDb: 20 * Math.log10(rms),
            peak, rms
        };
    }

    const output = Buffer.from(buffer);
    let outputPeak = 0;
    let outputSumSquares = 0;
    let limited = false;
    for (let index = layout.dataOffset; index + layout.stride <= layout.dataOffset + layout.dataSize; index += layout.stride) {
        const raw = readSample(index) * totalGain;
        const sample = softLimit(raw);
        if (Math.abs(raw) > LIMIT_CEILING) limited = true;
        if (Math.abs(sample) > outputPeak) outputPeak = Math.abs(sample);
        outputSumSquares += sample * sample;
        writeSample(index, sample);
    }
    const outputRms = Math.sqrt(outputSumSquares / count);
    return {
        buffer: output,
        applied: true,
        gainDb: totalGainDb,
        normalizationGainDb,
        totalGainDb,
        limited,
        inputPeakDb: 20 * Math.log10(peak),
        inputRmsDb: 20 * Math.log10(rms),
        outputPeakDb: outputPeak > 0 ? 20 * Math.log10(outputPeak) : -Infinity,
        outputRmsDb: outputRms > 0 ? 20 * Math.log10(outputRms) : -Infinity,
        peak: outputPeak,
        rms: outputRms
    };
}

module.exports = { amplifyWav, measureWav };
