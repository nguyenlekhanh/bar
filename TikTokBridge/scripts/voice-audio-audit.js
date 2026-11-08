'use strict';

/**
 * Measured before/after audit for the real Kokoro -> WAV pipeline.
 * Raw synthesis is the "before"; amplifyWav is the "after" path used by the
 * bridge before caching and sending the WAV to Unity.
 */
const { PROVIDERS } = require('../src/voice/providers');
const { amplifyWav, measureWav, readWavLayout } = require('../src/voice/wav-gain');

const CASES = [
    ['short', 'Cloud Disco!'],
    ['long', 'Welcome to the Cloud Disco family. Keep the energy high, drop a follow, and let us make this room unforgettable tonight.'],
    ['username', 'Shout out to Cool DJ Twenty Twenty-five! Thanks for bringing the energy.'],
    ['idle', 'The room is quiet right now. If you are here, say hello in chat and let us get this party moving.'],
    ['event', 'Thank you for the Rose, Alex! That is a beautiful gift and it means a lot.']
];

(async () => {
    const rows = [];
    for (const voice of ['am_michael', 'af_heart']) {
        for (const [caseName, text] of CASES) {
            const generated = await PROVIDERS.kokoro.synthesize({
                text,
                voice,
                speed: 1,
                gender: voice.startsWith('am_') ? 'male' : 'female'
            });
            const before = measureWav(generated.buffer);
            const layout = readWavLayout(generated.buffer);
            const processed = amplifyWav(generated.buffer, 6);
            rows.push({
                voice,
                case: caseName,
                text,
                provider: 'kokoro',
                input: {
                    durationMs: generated.durationMs,
                    sampleRate: before.sampleRate,
                    bits: before.bits,
                    format: before.format,
                    channels: before.channels,
                    peakDb: round(before.peakDb),
                    rmsDb: round(before.rmsDb),
                    lufs: round(before.integratedLufs),
                    truePeakDb: round(before.truePeakDb)
                },
                output: {
                    durationMs: processed.output.durationMs,
                    sampleRate: processed.output.sampleRate,
                    bits: processed.output.bits,
                    format: processed.output.format,
                    channels: processed.output.channels,
                    peakDb: round(processed.outputPeakDb),
                    rmsDb: round(processed.outputRmsDb),
                    lufs: round(processed.outputLufs),
                    truePeakDb: round(processed.outputTruePeakDb),
                    peak: round(processed.peak, 3)
                },
                gain: {
                    normalizationDb: round(processed.normalizationGainDb),
                    outputDb: processed.outputGainDb,
                    totalDb: round(processed.gainDb)
                },
                limited: processed.limited,
                clipped: processed.clipped,
                formatPreserved: Boolean(layout &&
                    processed.output.sampleRate === before.sampleRate &&
                    processed.output.bits === before.bits &&
                    processed.output.channels === before.channels)
            });
        }
    }
    const maxOutputLufs = Math.max(...rows.map(row => row.output.lufs));
    const maxTruePeak = Math.max(...rows.map(row => row.output.truePeakDb));
    const minOutputLufs = Math.min(...rows.map(row => row.output.lufs));
    const clipped = rows.filter(row => row.clipped).length;
    console.log(JSON.stringify({
        target: '-22.5 LUFS pre-gain + 6 dB output gain (~-16.5 LUFS final)',
        truePeakCeiling: '-1 dBTP requested; sample ceiling 0.82 (-1.7 dBFS)',
        summary: { rows: rows.length, minOutputLufs, maxOutputLufs, maxTruePeak, clipped },
        rows
    }, null, 2));
    if (clipped > 0 || maxTruePeak > -1) {
        console.error(`Audit failed: clipped=${clipped}, maxTruePeak=${maxTruePeak}`);
        process.exitCode = 1;
    }
})().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});

function round(value, digits = 2) {
    return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}
