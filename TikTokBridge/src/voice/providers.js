'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const KOKORO_MODEL = process.env.VOICE_KOKORO_MODEL || 'onnx-community/Kokoro-82M-v1.0-ONNX';
const KOKORO_DTYPE = process.env.VOICE_KOKORO_DTYPE || 'q8';

const KOKORO_VOICES = [
    { id: 'am_michael', label: 'Michael — American Male, deep and natural', gender: 'male', language: 'en-US', quality: 'C+' },
    { id: 'am_fenrir', label: 'Fenrir — American Male, punchy club energy', gender: 'male', language: 'en-US', quality: 'C+' },
    { id: 'am_puck', label: 'Puck — American Male, bright and playful', gender: 'male', language: 'en-US', quality: 'C+' },
    { id: 'af_heart', label: 'Heart — American Female, warm and natural', gender: 'female', language: 'en-US', quality: 'A' },
    { id: 'af_bella', label: 'Bella — American Female, bright and energetic', gender: 'female', language: 'en-US', quality: 'A-' },
    { id: 'af_nicole', label: 'Nicole — American Female, smooth host voice', gender: 'female', language: 'en-US', quality: 'B-' }
];

const WINDOWS_VOICES = [
    { id: 'Microsoft David Desktop', label: 'David — Windows offline male', gender: 'male', language: 'en-US', quality: 'legacy' },
    { id: 'Microsoft Mark', label: 'Mark — Windows offline male', gender: 'male', language: 'en-US', quality: 'legacy' },
    { id: 'Microsoft Zira Desktop', label: 'Zira — Windows offline female', gender: 'female', language: 'en-US', quality: 'legacy' }
];

const OPENAI_VOICES = [
    { id: 'onyx', label: 'Onyx — Cloud male, deep announcer', gender: 'male', language: 'en-US', quality: 'cloud' },
    { id: 'echo', label: 'Echo — Cloud male, energetic host', gender: 'male', language: 'en-US', quality: 'cloud' },
    { id: 'nova', label: 'Nova — Cloud female, bright host', gender: 'female', language: 'en-US', quality: 'cloud' },
    { id: 'shimmer', label: 'Shimmer — Cloud female, warm party MC', gender: 'female', language: 'en-US', quality: 'cloud' }
];

let kokoroPromise = null;
let kokoroLoaded = false;

function clampSpeed(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(1.35, Math.max(0.7, number)) : 1;
}

function cleanSpeechText(value) {
    return String(value || '')
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 500);
}

function resolveVoice(providerId, voiceId, gender = 'male') {
    const provider = PROVIDERS[providerId] || PROVIDERS.kokoro;
    const requested = provider.voices.find(voice => voice.id === voiceId);
    if (requested) return requested.id;
    const byGender = provider.voices.find(voice => voice.gender === gender);
    return (byGender || provider.voices[0]).id;
}

async function loadKokoro() {
    if (kokoroLoaded && kokoroPromise) return kokoroPromise;
    if (!kokoroPromise) {
        kokoroPromise = (async () => {
            const { KokoroTTS } = require('kokoro-js');
            const tts = await KokoroTTS.from_pretrained(KOKORO_MODEL, {
                dtype: KOKORO_DTYPE,
                device: 'cpu'
            });
            kokoroLoaded = true;
            return tts;
        })().catch(error => {
            kokoroPromise = null;
            kokoroLoaded = false;
            throw error;
        });
    }
    return kokoroPromise;
}

async function synthesizeKokoro({ text, voice, speed, gender = 'male' }) {
    const tts = await loadKokoro();
    const selected = resolveVoice('kokoro', voice, gender);
    const audio = await tts.generate(cleanSpeechText(text), {
        voice: selected,
        speed: clampSpeed(speed)
    });
    const wav = Buffer.from(audio.toWav());
    return {
        buffer: wav,
        provider: 'kokoro',
        voice: selected,
        sampleRate: Number(audio.sampling_rate) || 24000,
        durationMs: Math.round((audio.audio.length / (Number(audio.sampling_rate) || 24000)) * 1000)
    };
}

function windowsVoiceId(voice, gender) {
    const requested = WINDOWS_VOICES.find(item => item.id === voice);
    if (requested) return requested.id;
    return (WINDOWS_VOICES.find(item => item.gender === gender) || WINDOWS_VOICES[0]).id;
}

async function synthesizeWindows({ text, voice, speed, gender }) {
    if (process.platform !== 'win32') throw new Error('Windows SAPI is only available on Windows.');
    const output = path.join(os.tmpdir(), `cloud-disco-voice-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
    const script = path.join(os.tmpdir(), `cloud-disco-sapi-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`);
    const selectedVoice = windowsVoiceId(voice, gender);
    const rate = Math.max(-10, Math.min(10, Math.round((clampSpeed(speed) - 1) * 10)));
    const encoded = Buffer.from(cleanSpeechText(text), 'utf8').toString('base64');
    await fs.writeFile(script, [
        'param([string]$Voice,[string]$TextBase64,[int]$Rate,[string]$Output)',
        '$ErrorActionPreference = "Stop"',
        'Add-Type -AssemblyName System.Speech',
        '$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($TextBase64))',
        '$speech = New-Object System.Speech.Synthesis.SpeechSynthesizer',
        '$speech.SelectVoice($Voice)',
        '$speech.Rate = $Rate',
        '$speech.Volume = 100',
        '$speech.SetOutputToWaveFile($Output)',
        '$speech.Speak($text)',
        '$speech.Dispose()'
    ].join('\r\n'), 'utf8');
    try {
        await execFileAsync('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-File', script,
            '-Voice', selectedVoice,
            '-TextBase64', encoded,
            '-Rate', String(rate),
            '-Output', output
        ], { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 });
        const buffer = await fs.readFile(output);
        if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF') {
            throw new Error('Windows SAPI did not return a valid WAV file.');
        }
        return { buffer, provider: 'windows', voice: selectedVoice, sampleRate: 0, durationMs: 0 };
    } finally {
        await fs.rm(output, { force: true }).catch(() => {});
        await fs.rm(script, { force: true }).catch(() => {});
    }
}

async function synthesizeOpenAi({ text, voice, speed, gender }) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY is not configured.');
    const selected = resolveVoice('openai', voice, gender);
    const model = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
    const response = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model,
            voice: selected,
            input: cleanSpeechText(text),
            response_format: 'wav',
            speed: clampSpeed(speed),
            instructions: 'Speak like an energetic American nightclub DJ and party host. Keep it natural, warm, rhythmic, and human. Emphasize names and big moments.'
        })
    });
    if (!response.ok) {
        const detail = (await response.text()).slice(0, 240);
        throw new Error(`OpenAI TTS returned ${response.status}: ${detail}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF') {
        throw new Error('OpenAI TTS did not return a WAV file.');
    }
    return { buffer, provider: 'openai', voice: selected, sampleRate: 24000, durationMs: 0 };
}

const PROVIDERS = {
    kokoro: {
        id: 'kokoro',
        label: 'Kokoro local neural',
        local: true,
        voices: KOKORO_VOICES,
        synthesize: synthesizeKokoro
    },
    windows: {
        id: 'windows',
        label: 'Windows offline SAPI',
        local: true,
        voices: WINDOWS_VOICES,
        synthesize: synthesizeWindows
    },
    openai: {
        id: 'openai',
        label: 'OpenAI cloud (optional)',
        local: false,
        voices: OPENAI_VOICES,
        synthesize: synthesizeOpenAi
    }
};

function providerStatus(providerId) {
    const provider = PROVIDERS[providerId];
    if (providerId === 'kokoro') {
        return {
            id: 'kokoro',
            label: provider.label,
            local: true,
            available: true,
            loaded: kokoroLoaded,
            detail: kokoroLoaded
                ? 'Local neural model loaded and ready.'
                : 'Local neural model; the first announcement loads the cached model.'
        };
    }
    if (providerId === 'windows') {
        return {
            id: 'windows',
            label: provider.label,
            local: true,
            available: process.platform === 'win32',
            loaded: process.platform === 'win32',
            detail: process.platform === 'win32'
                ? 'Offline fallback using the installed Windows American English voices.'
                : 'Unavailable outside Windows.'
        };
    }
    return {
        id: 'openai',
        label: provider.label,
        local: false,
        available: Boolean(process.env.OPENAI_API_KEY),
        loaded: Boolean(process.env.OPENAI_API_KEY),
        detail: process.env.OPENAI_API_KEY
            ? 'Cloud provider configured from OPENAI_API_KEY.'
            : 'Optional; set OPENAI_API_KEY on the bridge to enable it.'
    };
}

function listProviders() {
    return Object.values(PROVIDERS).map(provider => ({
        id: provider.id,
        label: provider.label,
        local: provider.local,
        voices: provider.voices.map(voice => ({ ...voice })),
        status: providerStatus(provider.id)
    }));
}

async function synthesize(options) {
    const providerId = PROVIDERS[options.provider] ? options.provider : 'kokoro';
    const provider = PROVIDERS[providerId];
    const voice = resolveVoice(providerId, options.voice, options.gender);
    const result = await provider.synthesize({
        text: cleanSpeechText(options.text),
        voice,
        speed: options.speed,
        gender: options.gender
    });
    return { ...result, provider: providerId, voice };
}

async function warmUp(provider = 'kokoro') {
    if (provider !== 'kokoro') return providerStatus(provider);
    await loadKokoro();
    return providerStatus('kokoro');
}

module.exports = {
    PROVIDERS,
    listProviders,
    providerStatus,
    resolveVoice,
    synthesize,
    warmUp,
    cleanSpeechText
};
