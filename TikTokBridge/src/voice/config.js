'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { defaultVoiceConfig, AUTONOMOUS_CATEGORIES } = require('./defaults');
const { sanitizeDialogues } = require('./dialogue');
const { normalizePronunciations } = require('./username-pronunciation');
const { clampInt } = require('./queue');

const PROVIDERS = new Set(['kokoro', 'windows', 'openai']);
const PERSONAS = new Set(['club', 'friendly', 'vip']);
const USERNAME_MODES = new Set(['smart', 'digits', 'cardinal']);

function clampNumber(value, minimum, maximum, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(maximum, Math.max(minimum, number));
}

function text(value, maximum, fallback = '') {
    return String(value ?? '')
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maximum) || fallback;
}

function sanitizeVoiceConfig(input) {
    const defaults = defaultVoiceConfig();
    const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const provider = PROVIDERS.has(String(source.provider)) ? String(source.provider) : defaults.provider;
    const voiceGender = source.voiceGender === 'female' ? 'female' : 'male';
    const events = source.events && typeof source.events === 'object' ? source.events : {};
    const cooldowns = source.cooldownsMs && typeof source.cooldownsMs === 'object' ? source.cooldownsMs : {};
    const random = source.random && typeof source.random === 'object' ? source.random : {};
    const autonomous = source.autonomous && typeof source.autonomous === 'object' ? source.autonomous : {};
    const username = source.username && typeof source.username === 'object' ? source.username : {};
    const requestedCategories = Array.isArray(autonomous.categories)
        ? autonomous.categories.map(category => String(category)).filter(category => AUTONOMOUS_CATEGORIES.includes(category))
        : [];
    const autonomousCategories = requestedCategories.length
        ? [...new Set(requestedCategories)]
        : defaults.autonomous.categories.slice();

    return {
        version: 1,
        enabled: source.enabled !== false,
        provider,
        persona: PERSONAS.has(String(source.persona)) ? String(source.persona) : defaults.persona,
        // Windows SAPI voice ids contain spaces (for example
        // "Microsoft David Desktop"); keep them intact.
        voice: text(source.voice, 64, defaults.voice).replace(/[^A-Za-z0-9 _.:-]/g, ''),
        voiceGender,
        language: 'en-US',
        speed: Number(clampNumber(source.speed, 0.7, 1.35, defaults.speed).toFixed(2)),
        volume: Number(clampNumber(source.volume, 0, 1, defaults.volume).toFixed(2)),
        boostDb: Number(clampNumber(source.boostDb, 0, 18, defaults.boostDb).toFixed(1)),
        duckLevel: Number(clampNumber(source.duckLevel, 0.05, 1, defaults.duckLevel).toFixed(2)),
        duckAttackMs: clampInt(
            source.duckAttackMs ?? source.duckFadeMs,
            80, 2000, defaults.duckAttackMs
        ),
        duckReleaseMs: clampInt(
            source.duckReleaseMs ?? source.duckFadeMs,
            80, 2000, defaults.duckReleaseMs
        ),
        // Legacy alias kept for older overlays and existing settings files.
        duckFadeMs: clampInt(source.duckFadeMs, 80, 2000, defaults.duckFadeMs),
        maxQueue: clampInt(source.maxQueue, 1, 50, defaults.maxQueue),
        expireMs: clampInt(source.expireMs, 5000, 300000, defaults.expireMs),
        random: {
            // Retained for older settings files and as the fallback cadence when
            // Idle Detection is turned off. Autonomous speech uses this gate.
            enabled: events.random !== false && random.enabled !== false,
            minSeconds: clampInt(random.minSeconds, 30, 3600, defaults.random.minSeconds),
            maxSeconds: clampInt(random.maxSeconds, 60, 7200, defaults.random.maxSeconds)
        },
        autonomous: {
            enabled: autonomous.enabled !== false,
            idleDetection: autonomous.idleDetection !== false,
            idleSeconds: clampInt(autonomous.idleSeconds, 3, 300, defaults.autonomous.idleSeconds),
            allowZeroViewers: autonomous.allowZeroViewers !== false,
            randomDialogue: autonomous.randomDialogue !== false,
            maxPerHour: clampInt(autonomous.maxPerHour, 1, 360, defaults.autonomous.maxPerHour),
            categories: autonomousCategories
        },
        events: {
            welcome: events.welcome !== false,
            gift: events.gift !== false,
            follow: events.follow !== false,
            share: events.share !== false,
            vip: events.vip !== false,
            topdj: events.topdj !== false,
            random: events.random !== false
        },
        cooldownsMs: {
            welcome: clampInt(cooldowns.welcome, 0, 600000, defaults.cooldownsMs.welcome),
            gift: clampInt(cooldowns.gift, 0, 600000, defaults.cooldownsMs.gift),
            follow: clampInt(cooldowns.follow, 0, 600000, defaults.cooldownsMs.follow),
            share: clampInt(cooldowns.share, 0, 600000, defaults.cooldownsMs.share),
            vip: clampInt(cooldowns.vip, 0, 600000, defaults.cooldownsMs.vip),
            topdj: clampInt(cooldowns.topdj, 0, 600000, defaults.cooldownsMs.topdj),
            random: clampInt(cooldowns.random, 0, 600000, defaults.cooldownsMs.random)
        },
        username: {
            mode: USERNAME_MODES.has(String(username.mode)) ? String(username.mode) : 'smart',
            maxChars: clampInt(username.maxChars, 8, 160, defaults.username.maxChars),
            maxWords: clampInt(username.maxWords, 1, 24, defaults.username.maxWords)
        },
        dialogues: sanitizeDialogues(source.dialogues || defaults.dialogues),
        pronunciations: normalizePronunciations(source.pronunciations)
    };
}

async function loadVoiceConfig(filePath) {
    try {
        const raw = await fs.readFile(filePath, 'utf8');
        return { config: sanitizeVoiceConfig(JSON.parse(raw)), error: '' };
    } catch (error) {
        if (error.code === 'ENOENT') return { config: defaultVoiceConfig(), error: '' };
        return {
            config: defaultVoiceConfig(),
            error: `Voice settings could not be read (${error.message}); defaults are active.`
        };
    }
}

async function saveVoiceConfig(filePath, config) {
    const sanitized = sanitizeVoiceConfig(config);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(sanitized, null, 2)}\n`, 'utf8');
    try {
        await fs.rename(temporary, filePath);
    } catch (error) {
        // Windows can refuse replacing an existing file while an editor holds it.
        // The temporary file is still complete, so a remove + rename is the safe
        // fallback rather than leaving a partially written settings file.
        if (error.code === 'EEXIST' || error.code === 'EPERM') {
            await fs.rm(filePath, { force: true });
            await fs.rename(temporary, filePath);
        } else {
            await fs.rm(temporary, { force: true });
            throw error;
        }
    }
    return sanitized;
}

module.exports = {
    PROVIDERS,
    PERSONAS,
    USERNAME_MODES,
    sanitizeVoiceConfig,
    loadVoiceConfig,
    saveVoiceConfig
};
