'use strict';

/**
 * Lightweight BS.1770-style loudness analysis.
 *
 * This is intentionally local and dependency-free. It uses the standard
 * K-weighting shape (high shelf plus high-pass), 400 ms blocks with 75%
 * overlap, absolute/relative gating, and a 4x oversampled true-peak estimate.
 * Values are suitable for comparing TTS voices and for normalization; they are
 * not a replacement for a certified broadcast loudness meter.
 */

const ABSOLUTE_GATE_LUFS = -70;
const BLOCK_SECONDS = 0.4;
const HOP_SECONDS = 0.1;

function highShelfCoefficients(sampleRate) {
    const f0 = 1681.974450955533;
    const gainDb = 3.999843853973347;
    const slope = 1.0;
    const A = 10 ** (gainDb / 40);
    const w0 = 2 * Math.PI * f0 / sampleRate;
    const cos = Math.cos(w0);
    const sin = Math.sin(w0);
    const sqrtA = Math.sqrt(A);
    const alpha = sin / 2 * Math.sqrt((A + 1 / A) * (1 / slope - 1) + 2);
    const a0 = (A + 1) - (A - 1) * cos + 2 * sqrtA * alpha;
    return {
        b0: A * ((A + 1) + (A - 1) * cos + 2 * sqrtA * alpha) / a0,
        b1: -2 * A * ((A - 1) + (A + 1) * cos) / a0,
        b2: A * ((A + 1) + (A - 1) * cos - 2 * sqrtA * alpha) / a0,
        a1: 2 * ((A - 1) - (A + 1) * cos) / a0,
        a2: ((A + 1) - (A - 1) * cos - 2 * sqrtA * alpha) / a0
    };
}

function highPassCoefficients(sampleRate) {
    const f0 = 38.13547087602444;
    const Q = 0.5003270373238773;
    const w0 = 2 * Math.PI * f0 / sampleRate;
    const cos = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * Q);
    const a0 = 1 + alpha;
    return {
        b0: (1 + cos) / 2 / a0,
        b1: -(1 + cos) / a0,
        b2: (1 + cos) / 2 / a0,
        a1: -2 * cos / a0,
        a2: (1 - alpha) / a0
    };
}

function filterChannel(samples, coefficients) {
    const output = new Float64Array(samples.length);
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    const { b0, b1, b2, a1, a2 } = coefficients;
    for (let index = 0; index < samples.length; index += 1) {
        const x0 = samples[index];
        const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        output[index] = y0;
        x2 = x1;
        x1 = x0;
        y2 = y1;
        y1 = y0;
    }
    return output;
}

function cubicAt(s0, s1, s2, s3, t) {
    // Catmull-Rom interpolation; used only for the true-peak estimate.
    return 0.5 * ((2 * s1) +
        (-s0 + s2) * t +
        (2 * s0 - 5 * s1 + 4 * s2 - s3) * t * t +
        (-s0 + 3 * s1 - 3 * s2 + s3) * t * t * t);
}

function estimateTruePeak(channels) {
    let peak = 0;
    for (const samples of channels) {
        if (!samples || samples.length === 0) continue;
        for (let index = 0; index < samples.length; index += 1) {
            const s1 = samples[index];
            peak = Math.max(peak, Math.abs(s1));
            if (index + 1 >= samples.length) continue;
            const s0 = samples[Math.max(0, index - 1)];
            const s2 = samples[index + 1];
            const s3 = samples[Math.min(samples.length - 1, index + 2)];
            for (const t of [0.25, 0.5, 0.75]) {
                peak = Math.max(peak, Math.abs(cubicAt(s0, s1, s2, s3, t)));
            }
        }
    }
    return peak;
}

function analyzeSamples(channels, sampleRate) {
    if (!Array.isArray(channels) || channels.length === 0 || !(sampleRate > 0)) {
        return {
            durationMs: 0, sampleRate: 0, peak: 0, rms: 0,
            peakDb: -Infinity, rmsDb: -Infinity,
            integratedLufs: -Infinity, truePeak: 0, truePeakDb: -Infinity,
            blockCount: 0, gatedBlockCount: 0
        };
    }
    const frameCount = channels.reduce((minimum, channel) =>
        Math.min(minimum, channel.length), Number.POSITIVE_INFINITY);
    if (!Number.isFinite(frameCount) || frameCount <= 0) {
        return {
            durationMs: 0, sampleRate, peak: 0, rms: 0,
            peakDb: -Infinity, rmsDb: -Infinity,
            integratedLufs: -Infinity, truePeak: 0, truePeakDb: -Infinity,
            blockCount: 0, gatedBlockCount: 0
        };
    }

    const shelf = highShelfCoefficients(sampleRate);
    const highPass = highPassCoefficients(sampleRate);
    const weighted = channels.map(channel =>
        filterChannel(filterChannel(channel, shelf), highPass)
    );

    let peak = 0;
    let sumSquares = 0;
    let sampleCount = 0;
    for (const channel of channels) {
        for (let index = 0; index < frameCount; index += 1) {
            const sample = channel[index];
            const absolute = Math.abs(sample);
            if (absolute > peak) peak = absolute;
            sumSquares += sample * sample;
            sampleCount += 1;
        }
    }
    const rms = sampleCount > 0 ? Math.sqrt(sumSquares / sampleCount) : 0;

    const blockLength = Math.max(1, Math.round(BLOCK_SECONDS * sampleRate));
    const hopLength = Math.max(1, Math.round(HOP_SECONDS * sampleRate));
    const blocks = [];
    const effectiveLength = Math.min(frameCount, blockLength);
    const starts = frameCount <= blockLength
        ? [0]
        : Array.from({ length: Math.floor((frameCount - blockLength) / hopLength) + 1 }, (_, i) => i * hopLength);
    for (const start of starts) {
        const length = Math.min(effectiveLength, frameCount - start);
        if (length <= 0) continue;
        let energy = 0;
        for (const channel of weighted) {
            let sum = 0;
            for (let index = start; index < start + length; index += 1) {
                sum += channel[index] * channel[index];
            }
            energy += sum / length;
        }
        const loudness = energy > 0 ? -0.691 + 10 * Math.log10(energy) : -Infinity;
        blocks.push({ energy, loudness });
    }

    const absoluteGated = blocks.filter(block => block.loudness >= ABSOLUTE_GATE_LUFS);
    let integratedLufs = -Infinity;
    let gatedBlockCount = 0;
    if (absoluteGated.length > 0) {
        const absoluteMean = absoluteGated.reduce((sum, block) => sum + block.energy, 0) /
            absoluteGated.length;
        const relativeGate = -0.691 + 10 * Math.log10(Math.max(absoluteMean, 1e-20)) - 10;
        const relativeGated = absoluteGated.filter(block => block.loudness >= relativeGate);
        const finalBlocks = relativeGated.length > 0 ? relativeGated : absoluteGated;
        gatedBlockCount = finalBlocks.length;
        const finalMean = finalBlocks.reduce((sum, block) => sum + block.energy, 0) /
            finalBlocks.length;
        integratedLufs = finalMean > 0 ? -0.691 + 10 * Math.log10(finalMean) : -Infinity;
    }

    // True peak is measured on the original signal, not the K-weighted signal.
    const truePeak = Math.max(peak, estimateTruePeak(channels));
    return {
        durationMs: Math.round((frameCount / sampleRate) * 1000),
        sampleRate,
        peak,
        rms,
        peakDb: peak > 0 ? 20 * Math.log10(peak) : -Infinity,
        rmsDb: rms > 0 ? 20 * Math.log10(rms) : -Infinity,
        integratedLufs,
        truePeak,
        truePeakDb: truePeak > 0 ? 20 * Math.log10(truePeak) : -Infinity,
        blockCount: blocks.length,
        gatedBlockCount
    };
}

module.exports = {
    ABSOLUTE_GATE_LUFS,
    BLOCK_SECONDS,
    analyzeSamples,
    estimateTruePeak
};
