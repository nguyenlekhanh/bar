'use strict';

const assert = require('node:assert/strict');
const { amplifyWav, readWavLayout, measureWav } = require('../src/voice/wav-gain');

function makeWav(format, bits, channels) {
    const sampleRate = 24000;
    const frames = 24000;
    const bytes = bits / 8;
    const dataSize = frames * channels * bytes;
    const wav = Buffer.alloc(44 + dataSize);
    wav.write('RIFF', 0, 'ascii');
    wav.writeUInt32LE(36 + dataSize, 4);
    wav.write('WAVE', 8, 'ascii');
    wav.write('fmt ', 12, 'ascii');
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(format, 20);
    wav.writeUInt16LE(channels, 22);
    wav.writeUInt32LE(sampleRate, 24);
    wav.writeUInt32LE(sampleRate * channels * bytes, 28);
    wav.writeUInt16LE(channels * bytes, 32);
    wav.writeUInt16LE(bits, 34);
    wav.write('data', 36, 'ascii');
    wav.writeUInt32LE(dataSize, 40);
    for (let frame = 0; frame < frames; frame += 1) {
        const sample = 0.05 * Math.sin(2 * Math.PI * 220 * frame / sampleRate);
        for (let channel = 0; channel < channels; channel += 1) {
            const offset = 44 + (frame * channels + channel) * bytes;
            if (format === 3) wav.writeFloatLE(sample, offset);
            else if (bits === 16) wav.writeInt16LE(Math.round(sample * 32768), offset);
            else if (bits === 24) {
                const value = Math.round(sample * 8388608);
                wav.writeUInt8(value & 0xFF, offset);
                wav.writeUInt8((value >> 8) & 0xFF, offset + 1);
                wav.writeUInt8((value >> 16) & 0xFF, offset + 2);
            } else wav.writeInt32LE(Math.round(sample * 2147483648), offset);
        }
    }
    return wav;
}

const cases = [
    [3, 32, 1], [1, 16, 1], [1, 24, 1], [1, 32, 1],
    [3, 32, 2], [1, 16, 2], [1, 24, 2]
];
const results = [];
for (const [format, bits, channels] of cases) {
    const wav = makeWav(format, bits, channels);
    const beforeLayout = readWavLayout(wav);
    const before = measureWav(wav);
    const processed = amplifyWav(wav, 6);
    const afterLayout = readWavLayout(processed.buffer);
    assert.equal(afterLayout.format, format, `format ${format}/${bits}/${channels} changed`);
    assert.equal(afterLayout.bits, bits, `bit depth ${bits} changed`);
    assert.equal(afterLayout.channels, channels, `channels ${channels} changed`);
    assert.equal(afterLayout.sampleRate, 24000, 'sample rate changed');
    assert(processed.applied, 'processing should apply');
    assert(processed.outputPeak > before.peakDb || processed.limited, 'output should gain or limit');
    assert(!processed.clipped, 'output must not clip');
    assert(Number.isFinite(afterLayout.frameCount), 'frame count must stay valid');
    results.push({
        format: format === 3 ? 'float' : 'PCM',
        bits,
        channels,
        inputPeakDb: Number(before.peakDb.toFixed(2)),
        outputPeakDb: Number(processed.outputPeakDb.toFixed(2)),
        outputLufs: Number(processed.outputLufs.toFixed(2)),
        truePeakDb: Number(processed.outputTruePeakDb.toFixed(2)),
        preserved: true
    });
}
console.log(JSON.stringify({ cases: results.length, results }, null, 2));
