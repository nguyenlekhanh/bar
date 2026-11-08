'use strict';

const { analyzeSamples } = require('./loudness');

/**
 * Voice loudness pipeline.
 *
 * Input formats are preserved (float32, PCM16, PCM24, PCM32; mono or stereo).
 * The voice is normalized to a fixed pre-gain integrated loudness, the
 * operator's output gain is applied, and a smooth limiter keeps the sample peak
 * below a headroom ceiling. True peak is estimated at 4x oversampling.
 *
 * With the default +6 dB output gain:
 *   normalization target -22.5 LUFS + 6 dB -> about -16.5 LUFS final,
 *   before any gain reduction from the limiter.
 */
const TARGET_PRE_GAIN_LUFS = -22.5;
const LIMIT_THRESHOLD = 0.70;
// -1.7 dBFS sample ceiling leaves room for the 4x true-peak estimate.
const LIMIT_CEILING = 0.82;
const MAX_NORMALIZATION_GAIN_DB = 12;
const TRUE_PEAK_CEILING_DB = -1;

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
    let sampleRate = 0;
    let byteRate = 0;
    let dataOffset = -1;
    let dataSize = 0;
    while (offset + 8 <= buffer.length) {
        const id = buffer.toString('ascii', offset, offset + 4);
        const size = buffer.readUInt32LE(offset + 4);
        const start = offset + 8;
        if (id === 'fmt ' && start + 16 <= buffer.length) {
            const formatTag = buffer.readUInt16LE(start);
            channels = buffer.readUInt16LE(start + 2);
            sampleRate = buffer.readUInt32LE(start + 4);
            byteRate = buffer.readUInt32LE(start + 8);
            bits = buffer.readUInt16LE(start + 14);
            // WAVE_FORMAT_EXTENSIBLE stores the effective PCM/float format in
            // the first two bytes of the SubFormat GUID.
            format = formatTag === 0xFFFE && start + 26 <= buffer.length
                ? buffer.readUInt16LE(start + 24)
                : formatTag;
        } else if (id === 'data') {
            dataOffset = start;
            dataSize = Math.min(size, Math.max(0, buffer.length - start));
            break;
        }
        offset = start + size + (size % 2);
        if (size <= 0) break;
    }
    const bytesPerSample = bits / 8;
    const frameSize = bytesPerSample * channels;
    if (dataOffset < 0 || dataSize <= 0 || channels < 1 || sampleRate <= 0 ||
        byteRate <= 0 || ![16, 24, 32, 64].includes(bits) ||
        !(format === 1 || format === 3) || frameSize <= 0 ||
        dataSize % frameSize !== 0) {
        return null;
    }
    return {
        format,
        bits,
        channels,
        sampleRate,
        byteRate,
        bytesPerSample,
        frameSize,
        dataOffset,
        dataSize,
        frameCount: dataSize / frameSize
    };
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

function readWavChannels(buffer, layout) {
    const readSample = sampleReader(buffer, layout);
    const channels = Array.from({ length: layout.channels }, () =>
        new Float64Array(layout.frameCount));
    for (let frame = 0; frame < layout.frameCount; frame += 1) {
        const frameOffset = layout.dataOffset + frame * layout.frameSize;
        for (let channel = 0; channel < layout.channels; channel += 1) {
            channels[channel][frame] = readSample(frameOffset + channel * layout.bytesPerSample);
        }
    }
    return channels;
}

function emptyMeasurement() {
    return {
        durationMs: 0,
        sampleRate: 0,
        channels: 0,
        bits: 0,
        format: 0,
        peak: 0,
        rms: 0,
        peakDb: -Infinity,
        rmsDb: -Infinity,
        lufs: -Infinity,
        integratedLufs: -Infinity,
        truePeak: 0,
        truePeakDb: -Infinity,
        blockCount: 0,
        gatedBlockCount: 0
    };
}

function measureWav(buffer) {
    const layout = readWavLayout(buffer);
    if (!layout) return emptyMeasurement();
    const channels = readWavChannels(buffer, layout);
    const analysis = analyzeSamples(channels, layout.sampleRate);
    return {
        ...analysis,
        channels: layout.channels,
        bits: layout.bits,
        format: layout.format,
        lufs: analysis.integratedLufs
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
 * @returns {object} The processed buffer plus input/output measurements.
 */
function amplifyWav(buffer, boostDb) {
    const requestedDb = Math.max(0, Math.min(18, Number(boostDb) || 0));
    const layout = readWavLayout(buffer);
    if (!layout) {
        const measured = measureWav(buffer);
        return {
            buffer,
            applied: false,
            gainDb: 0,
            normalizationGainDb: 0,
            totalGainDb: 0,
            limited: false,
            clipped: false,
            targetLufs: TARGET_PRE_GAIN_LUFS,
            outputGainDb: requestedDb,
            input: measured,
            output: measured,
            inputPeakDb: measured.peakDb,
            inputRmsDb: measured.rmsDb,
            inputLufs: measured.lufs,
            inputTruePeakDb: measured.truePeakDb,
            outputPeakDb: measured.peakDb,
            outputRmsDb: measured.rmsDb,
            outputLufs: measured.lufs,
            outputTruePeakDb: measured.truePeakDb,
            peak: measured.peak,
            rms: measured.rms,
            lufs: measured.lufs,
            truePeak: measured.truePeak,
            truePeakDb: measured.truePeakDb
        };
    }

    const input = measureWav(buffer);
    if (!input || input.peak <= 0.000001 || !Number.isFinite(input.lufs)) {
        return {
            buffer,
            applied: false,
            gainDb: 0,
            normalizationGainDb: 0,
            totalGainDb: 0,
            limited: false,
            clipped: false,
            targetLufs: TARGET_PRE_GAIN_LUFS,
            outputGainDb: requestedDb,
            input,
            output: input,
            inputPeakDb: input.peakDb,
            inputRmsDb: input.rmsDb,
            inputLufs: input.lufs,
            inputTruePeakDb: input.truePeakDb,
            outputPeakDb: input.peakDb,
            outputRmsDb: input.rmsDb,
            outputLufs: input.lufs,
            outputTruePeakDb: input.truePeakDb,
            peak: input.peak,
            rms: input.rms,
            lufs: input.lufs,
            truePeak: input.truePeak,
            truePeakDb: input.truePeakDb
        };
    }

    const normalizationGainDb = Math.max(
        -MAX_NORMALIZATION_GAIN_DB,
        Math.min(MAX_NORMALIZATION_GAIN_DB, TARGET_PRE_GAIN_LUFS - input.lufs)
    );
    const totalGainDb = normalizationGainDb + requestedDb;
    const totalGain = 10 ** (totalGainDb / 20);
    const readSample = sampleReader(buffer, layout);
    const output = Buffer.from(buffer);
    const writeSample = sampleWriter(output, layout);
    let limited = false;
    for (let index = layout.dataOffset; index < layout.dataOffset + layout.dataSize; index += layout.bytesPerSample) {
        const raw = readSample(index) * totalGain;
        if (Math.abs(raw) > LIMIT_THRESHOLD) limited = true;
        writeSample(index, softLimit(raw));
    }
    const outputMeasurement = measureWav(output);
    return {
        buffer: output,
        applied: true,
        gainDb: totalGainDb,
        normalizationGainDb,
        totalGainDb,
        limited,
        clipped: outputMeasurement.truePeak >= 0.999,
        truePeakOverCeiling: outputMeasurement.truePeakDb > TRUE_PEAK_CEILING_DB,
        outputPeak: outputMeasurement.peak,
        targetLufs: TARGET_PRE_GAIN_LUFS,
        outputGainDb: requestedDb,
        input,
        output: outputMeasurement,
        inputPeakDb: input.peakDb,
        inputRmsDb: input.rmsDb,
        inputLufs: input.lufs,
        inputTruePeakDb: input.truePeakDb,
        outputPeakDb: outputMeasurement.peakDb,
        outputRmsDb: outputMeasurement.rmsDb,
        outputLufs: outputMeasurement.lufs,
        outputTruePeakDb: outputMeasurement.truePeakDb,
        peak: outputMeasurement.peak,
        rms: outputMeasurement.rms,
        lufs: outputMeasurement.lufs,
        truePeak: outputMeasurement.truePeak,
        truePeakDb: outputMeasurement.truePeakDb
    };
}

module.exports = {
    TRUE_PEAK_CEILING_DB,
    TARGET_PRE_GAIN_LUFS,
    amplifyWav,
    measureWav,
    readWavLayout
};
