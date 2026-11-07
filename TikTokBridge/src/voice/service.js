'use strict';

const crypto = require('node:crypto');
const { defaultVoiceConfig } = require('./defaults');
const { sanitizeVoiceConfig, loadVoiceConfig, saveVoiceConfig } = require('./config');
const { VoiceAudioCache } = require('./audio-cache');
const { VoiceQueue } = require('./queue');
const { chooseDialogue, renderDialogue } = require('./dialogue');
const { normalizeUsername } = require('./username-pronunciation');
const providers = require('./providers');

const PRIORITIES = {
    test: 9,
    topdj: 7,
    vip: 6,
    gift: 5,
    welcome: 4,
    follow: 3,
    share: 2,
    random: 1
};

const CATEGORY_LABELS = {
    welcome: 'Welcome',
    gift: 'Gift',
    follow: 'Follow',
    share: 'Share',
    vip: 'VIP',
    topdj: 'Top DJ',
    random: 'Random MC',
    test: 'Test'
};

function text(value, maximum, fallback = '') {
    return String(value ?? '')
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maximum) || fallback;
}

function createVoiceService({ configPath, broadcast, broadcastToRole, logger = console } = {}) {
    if (!configPath) throw new Error('A voice config path is required.');
    if (typeof broadcast !== 'function' || typeof broadcastToRole !== 'function') {
        throw new Error('Voice service requires broadcast callbacks.');
    }

    let config = defaultVoiceConfig();
    let queue = new VoiceQueue(config);
    let audioCache = new VoiceAudioCache({ ttlMs: 20 * 60 * 1000, maxEntries: 48 });
    let current = null;
    let busy = false;
    let started = false;
    let lastError = '';
    let lastGenerationMs = 0;
    let lastAck = null;
    let finishTimer = null;
    let randomTimer = null;
    let startedAt = Date.now();
    let playbackGeneration = 0;
    let likeBurst = 0;
    let pumpScheduled = false;

    const lastDialogueByCategory = new Map();
    const categoryForGift = event => {
        const action = String(event.action || '').toLowerCase();
        const diamonds = Math.max(0, Number(event.diamondCount) || 0);
        if (action === 'topdj') return 'topdj';
        if (action === 'vip' || diamonds >= 100) return 'vip';
        return 'gift';
    };

    function publicConfig() {
        return JSON.parse(JSON.stringify(config));
    }

    function statusPayload() {
        return {
            enabled: config.enabled,
            provider: config.provider,
            voice: config.voice,
            voiceGender: config.voiceGender,
            persona: config.persona,
            queueSize: queue.size,
            current: current ? {
                id: current.id,
                category: current.category,
                text: current.text,
                priority: current.priority,
                startedAt: current.startedAt || 0,
                durationMs: current.durationMs || 0
            } : null,
            busy,
            lastError,
            lastGenerationMs,
            lastAck,
            providerStatus: config.provider ? providers.providerStatus(config.provider) : null,
            providers: providers.listProviders(),
            audioCache: audioCache.snapshot(),
            startedAt
        };
    }

    function broadcastStatus() {
        broadcastToRole('control', { type: 'voice_status', ...statusPayload() });
    }

    function broadcastConfig() {
        const payload = { type: 'voice_config', config: publicConfig() };
        broadcast(payload);
        broadcastStatus();
    }

    function schedulePump() {
        if (pumpScheduled) return;
        pumpScheduled = true;
        setTimeout(() => {
            pumpScheduled = false;
            void pump();
        }, 0);
    }

    async function synthesizeWithFallback(item) {
        const attempts = [];
        const primary = providers.PROVIDERS[item.provider] ? item.provider : config.provider;
        attempts.push(primary);
        if (primary !== 'windows') attempts.push('windows');
        let lastFailure = null;
        for (const providerId of attempts) {
            const status = providers.providerStatus(providerId);
            if (!status.available) continue;
            const started = Date.now();
            try {
                const result = await providers.synthesize({
                    provider: providerId,
                    text: item.text,
                    voice: item.voice || config.voice,
                    speed: item.speed || config.speed,
                    gender: item.voiceGender || config.voiceGender
                });
                lastGenerationMs = Date.now() - started;
                if (providerId !== primary) {
                    logger.warn?.(`[voice] ${primary} failed; used ${providerId} fallback.`);
                    lastError = `${CATEGORY_LABELS[item.category] || item.category}: primary voice failed; used ${providerId} fallback.`;
                } else {
                    lastError = '';
                }
                return result;
            } catch (error) {
                lastFailure = error;
                lastError = `${providerId}: ${error.message}`;
                logger.warn?.(`[voice] ${providerId} synthesis failed: ${error.message}`);
            }
        }
        throw lastFailure || new Error('No TTS provider is available.');
    }

    function voiceIsEnabled(category) {
        if (!config.enabled) return false;
        if (category === 'test') return true;
        return config.events[category] !== false;
    }

    function makeSpeechFor(category, event = {}) {
        const previous = lastDialogueByCategory.get(category);
        const chosen = chooseDialogue(config.dialogues, category, {
            persona: config.persona,
            previousId: previous
        });
        if (!chosen) return null;
        const rawName = event.uniqueId || event.nickname || event.userId || '';
        const pronounced = normalizeUsername(rawName, config.username, config.pronunciations);
        const gift = text(event.giftName, 80, 'gift');
        const diamonds = Math.max(0, Number(event.diamondCount) || 0);
        const rendered = renderDialogue(chosen.text, {
            name: pronounced.spoken,
            gift,
            diamonds
        });
        if (!rendered) return null;
        lastDialogueByCategory.set(category, chosen.id);
        return {
            text: rendered,
            templateId: chosen.id,
            username: pronounced.original,
            spokenUsername: pronounced.spoken,
            usernameOverridden: pronounced.overridden
        };
    }

    function enqueueAnnouncement(category, event = {}, options = {}) {
        if (!options.force && !voiceIsEnabled(category)) return { accepted: false, reason: 'disabled' };
        const speech = options.text
            ? {
                text: text(options.text, 280, ''),
                templateId: options.templateId || '',
                username: '',
                spokenUsername: ''
            }
            : makeSpeechFor(category, event);
        if (!speech || !speech.text) return { accepted: false, reason: 'no-dialogue' };

        const now = Date.now();
        const userId = text(event.userId, 128, '');
        const dedupeKey = options.dedupeKey ||
            (event.eventId ? `voice:${category}:${event.eventId}` : `voice:${category}:${userId}:${Math.floor(now / 2500)}`);

        // A rapid gift streak or repeated gift should update the pending line,
        // never create one spoken line per gift packet.
        if (!options.force && (category === 'gift' || category === 'vip' || category === 'topdj')) {
            const pending = queue.find(item =>
                item.category === category &&
                item.userId === userId &&
                item.templateId === speech.templateId &&
                now - item.createdAt < 6000
            );
            if (pending) {
                pending.diamonds = Math.max(0, Number(pending.diamonds) || 0) + (Number(event.diamondCount) || 0);
                pending.text = renderDialogue(pending.rawTemplate, {
                    name: pending.spokenUsername,
                    gift: pending.gift,
                    diamonds: pending.diamonds
                });
                queue.update(pending.id, pending);
                return { accepted: true, merged: true, item: pending };
            }
        }

        const item = {
            category,
            priority: options.priority || PRIORITIES[category] || 1,
            text: speech.text,
            templateId: speech.templateId,
            rawTemplate: options.rawTemplate || '',
            userId,
            username: speech.username,
            spokenUsername: speech.spokenUsername,
            usernameOverridden: speech.usernameOverridden,
            gift: text(event.giftName, 80, 'gift'),
            diamonds: Number(event.diamondCount) || 0,
            dedupeKey,
            createdAt: now,
            expiresAt: now + (options.expireMs || config.expireMs),
            bypassCooldown: Boolean(options.bypassCooldown),
            force: Boolean(options.force)
        };
        if (!item.rawTemplate) {
            item.rawTemplate = speech.templateId
                ? (config.dialogues[category] || []).find(line => line.id === speech.templateId)?.text || ''
                : '';
        }
        const result = queue.enqueue(item, now);
        if (result.accepted) {
            schedulePump();
            broadcastStatus();
        }
        return result;
    }

    function enqueueRandom() {
        if (!voiceIsEnabled('random') || !config.random.enabled || busy || queue.size > 0) return false;
        const event = { eventId: `random-${Date.now()}` };
        return enqueueAnnouncement('random', event, {
            force: false,
            dedupeKey: `voice:random:${Math.floor(Date.now() / 10000)}`
        }).accepted === true;
    }

    function scheduleRandom(delayOverride) {
        if (randomTimer) clearTimeout(randomTimer);
        randomTimer = null;
        if (!started || !config.enabled || !config.random.enabled || !config.events.random) return;
        const min = Math.max(30, Number(config.random.minSeconds) || 150);
        const max = Math.max(min, Number(config.random.maxSeconds) || 300);
        const delayMs = delayOverride === undefined
            ? (min + Math.random() * (max - min)) * 1000
            : Math.max(5000, Number(delayOverride) || 0);
        randomTimer = setTimeout(() => {
            randomTimer = null;
            if (!busy && queue.size === 0) enqueueRandom();
            scheduleRandom();
        }, delayMs);
        randomTimer.unref?.();
    }

    function finishCurrent(id) {
        if (!current || current.id !== id) return;
        if (finishTimer) clearTimeout(finishTimer);
        finishTimer = null;
        current = null;
        busy = false;
        broadcastStatus();
        schedulePump();
    }

    async function pump() {
        if (!started || busy || !config.enabled) return;
        const item = queue.dequeue();
        if (!item) {
            schedulePump();
            return;
        }
        if (item.expiresAt && item.expiresAt <= Date.now()) {
            schedulePump();
            return;
        }

        busy = true;
        item.startedAt = Date.now();
        current = item;
        const requestGeneration = playbackGeneration;
        broadcastStatus();

        try {
            const result = await synthesizeWithFallback(item);
            if (requestGeneration !== playbackGeneration || current !== item || !started) {
                // Stop/clear was pressed while the provider was generating. Do
                // not let an obsolete WAV start after the operator stopped it.
                if (current === item) current = null;
                busy = false;
                broadcastStatus();
                schedulePump();
                return;
            }
            const cacheKey = crypto.createHash('sha256').update([
                result.provider,
                result.voice,
                config.speed,
                item.text
            ].join('|')).digest('hex');
            const audio = audioCache.put(result.buffer, {
                cacheKey,
                provider: result.provider,
                voice: result.voice,
                durationMs: result.durationMs
            });
            item.durationMs = audio.durationMs;
            item.audioId = audio.id;
            item.audioUrl = audio.url;

            const announcement = {
                type: 'voice_announcement',
                id: item.id,
                url: audio.url,
                text: item.text,
                category: item.category,
                categoryLabel: CATEGORY_LABELS[item.category] || item.category,
                priority: item.priority,
                durationMs: audio.durationMs,
                volume: config.volume,
                duckLevel: config.duckLevel,
                duckFadeMs: config.duckFadeMs,
                voice: result.voice,
                provider: result.provider,
                createdAt: Date.now()
            };
            broadcastToRole('overlay', announcement);
            broadcastToRole('control', {
                type: 'voice_current',
                id: item.id,
                category: item.category,
                text: item.text,
                durationMs: audio.durationMs,
                audioUrl: audio.url,
                provider: result.provider,
                voice: result.voice
            });
            broadcastStatus();

            // Unity normally confirms playback, but the queue must advance even
            // when no overlay is connected or an acknowledgement is lost.
            finishTimer = setTimeout(() => finishCurrent(item.id), Math.max(1200, audio.durationMs + 350));
            finishTimer.unref?.();
        } catch (error) {
            lastError = error.message;
            logger.error?.(`[voice] announcement failed: ${error.message}`);
            current = null;
            busy = false;
            broadcastStatus();
            schedulePump();
        }
    }

    async function updateConfig(input) {
        const previous = config;
        config = sanitizeVoiceConfig(input);
        config.voice = providers.resolveVoice(config.provider, config.voice, config.voiceGender);
        if (previous.provider !== config.provider || !config.voice) {
            config.voice = providers.resolveVoice(config.provider, config.voice, config.voiceGender);
        }
        await saveVoiceConfig(configPath, config);
        queue.configure(config);
        audioCache = new VoiceAudioCache({ ttlMs: 20 * 60 * 1000, maxEntries: 48 });
        likeBurst = 0;
        scheduleRandom();
        broadcastConfig();
        return publicConfig();
    }

    function onGameEvent(event) {
        if (!started || !config.enabled || !event || typeof event !== 'object') return;
        if (event.type === 'like') {
            likeBurst += Math.max(0, Number(event.likeCount) || 0);
            if (likeBurst >= 50) {
                likeBurst = 0;
                enqueueRandom();
            }
            return;
        }

        let category = null;
        if (event.type === 'member' && event.joinedNow !== false) category = 'welcome';
        else if (event.type === 'chat' && event.joinedNow === true) category = 'welcome';
        else if (event.type === 'gift') category = categoryForGift(event);
        else if (event.type === 'follow') category = 'follow';
        else if (event.type === 'share') category = 'share';
        if (!category || !voiceIsEnabled(category)) return;

        const result = enqueueAnnouncement(category, event);
        if (!result.accepted && result.reason && result.reason !== 'duplicate' && result.reason !== 'cooldown') {
            logger.debug?.(`[voice] ${category} skipped: ${result.reason}`);
        }
    }

    function queueTest(input = {}) {
        const sample = text(input.text, 280, 'Yo! This is your Cloud Disco MC. Let\'s get this party started!');
        return enqueueAnnouncement('test', {
            eventId: `test-${Date.now()}`,
            uniqueId: input.username || '',
            nickname: input.username || ''
        }, {
            text: sample,
            force: true,
            bypassCooldown: true,
            priority: PRIORITIES.test,
            dedupeKey: `voice:test:${Date.now()}`,
            rawTemplate: ''
        });
    }

    async function preview(input = {}) {
        const provider = input.provider || config.provider;
        const gender = input.voiceGender || config.voiceGender;
        const voice = providers.resolveVoice(provider, input.voice || config.voice, gender);
        const username = input.username
            ? normalizeUsername(input.username, config.username, config.pronunciations)
            : null;
        const rawText = input.text || (username
            ? `Welcome to Cloud Disco, ${username.spoken}! Let\'s get this party started!`
            : 'Yo! This is your Cloud Disco MC. Let\'s get this party started!');
        const speech = text(rawText, 500, 'Cloud Disco!');
        const result = await synthesizeWithFallback({
            text: speech,
            voice,
            speed: Number(input.speed) || config.speed,
            voiceGender: gender,
            category: 'test',
            provider
        });
        const audio = audioCache.put(result.buffer, {
            provider: result.provider,
            voice: result.voice,
            durationMs: result.durationMs
        });
        return {
            audioUrl: audio.url,
            durationMs: audio.durationMs,
            text: speech,
            provider: result.provider,
            voice: result.voice,
            spokenUsername: username ? username.spoken : '',
            usernameOverridden: username ? username.overridden : false
        };
    }

    function pronounce(username) {
        return normalizeUsername(username, config.username, config.pronunciations);
    }

    function stopCurrent() {
        playbackGeneration += 1;
        if (finishTimer) clearTimeout(finishTimer);
        finishTimer = null;
        if (current) {
            broadcastToRole('overlay', {
                type: 'voice_control',
                action: 'stop',
                id: current.id
            });
        }
        current = null;
        busy = false;
        broadcastStatus();
    }

    function clearQueue() {
        const count = queue.clear();
        broadcastStatus();
        return count;
    }

    function acknowledge(input = {}) {
        lastAck = {
            id: text(input.id, 80, ''),
            ok: input.ok !== false,
            error: text(input.error, 180, ''),
            at: Date.now()
        };
        if (input.ok === false) lastError = lastAck.error || 'Unity could not play the announcement.';
        broadcastStatus();
        return lastAck;
    }

    async function start() {
        const loaded = await loadVoiceConfig(configPath);
        config = sanitizeVoiceConfig(loaded.config);
        config.voice = providers.resolveVoice(config.provider, config.voice, config.voiceGender);
        if (loaded.error) logger.warn?.(`[voice] ${loaded.error}`);
        queue = new VoiceQueue(config);
        audioCache = new VoiceAudioCache({ ttlMs: 20 * 60 * 1000, maxEntries: 48 });
        started = true;
        startedAt = Date.now();
        scheduleRandom();
        return publicConfig();
    }

    function dispose() {
        started = false;
        playbackGeneration += 1;
        if (randomTimer) clearTimeout(randomTimer);
        if (finishTimer) clearTimeout(finishTimer);
        randomTimer = null;
        finishTimer = null;
        clearQueue();
        current = null;
        busy = false;
        audioCache.clear();
    }

    return {
        start,
        dispose,
        onGameEvent,
        updateConfig,
        queueTest,
        preview,
        pronounce,
        stopCurrent,
        clearQueue,
        acknowledge,
        publicConfig,
        getStatus: statusPayload,
        getAudio: id => audioCache.get(id),
        publicProviders: providers.listProviders,
        broadcastConfig,
        // Exposed for tests and the control panel without mutating live state.
        _queue: () => queue
    };
}

module.exports = { createVoiceService, PRIORITIES, CATEGORY_LABELS };
