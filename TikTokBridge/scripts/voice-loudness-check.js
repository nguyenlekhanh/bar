'use strict';

const { PROVIDERS } = require('../src/voice/providers');
const { amplifyWav, measureWav } = require('../src/voice/wav-gain');

const TEXT = 'Cloud Disco, let the music move you!';

(async () => {
    const results = [];
    for (const voice of ['am_michael', 'af_heart']) {
        const generated = await PROVIDERS.kokoro.synthesize({
            text: TEXT,
            voice,
            speed: 1,
            gender: voice.startsWith('am_') ? 'male' : 'female'
        });
        const input = measureWav(generated.buffer);
        const processed = amplifyWav(generated.buffer, 6);
        results.push({
            voice,
            provider: 'kokoro',
            durationMs: generated.durationMs,
            inputPeakDb: Number(input.peakDb.toFixed(2)),
            inputRmsDb: Number(input.rmsDb.toFixed(2)),
            inputLufs: Number(input.integratedLufs.toFixed(2)),
            inputTruePeakDb: Number(input.truePeakDb.toFixed(2)),
            outputGainDb: 6,
            normalizationGainDb: Number(processed.normalizationGainDb.toFixed(2)),
            outputPeakDb: Number(processed.outputPeakDb.toFixed(2)),
            outputRmsDb: Number(processed.outputRmsDb.toFixed(2)),
            outputLufs: Number(processed.outputLufs.toFixed(2)),
            outputTruePeakDb: Number(processed.outputTruePeakDb.toFixed(2)),
            outputPeak: Number(processed.peak.toFixed(3)),
            limited: processed.limited,
            clipped: processed.clipped
        });
    }
    console.log(JSON.stringify({ text: TEXT, results }, null, 2));
})().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
