'use strict';

const crypto = require('node:crypto');
const { defaultVoiceConfig } = require('./defaults');
const { sanitizeVoiceConfig, loadVoiceConfig, saveVoiceConfig } = require('./config');
const { VoiceAudioCache } = require('./audio-cache');
const { VoiceQueue } = require('./queue');
const { chooseDialogue, chooseDialogueFromCategories, renderDialogue } = require('./dialogue');
const { normalizeUsername } = require('./username-pronunciation');
const { amplifyWav } = require('./wav-gain');
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
    quiet: 'Quiet room',
    music: 'Music commentary',
    energy: 'Party energy',
    engage: 'Audience engagement',
    dj: 'DJ personality',
    gift: 'Gift',
    follow: 'Follow',
    share: 'Share',
    vip: 'VIP',
    topdj: 'Top DJ',
    random: 'Random MC',
    test: 'Test'
};

const HOUR_MS = 60 * 60 * 1000;

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
    let lastAudio = null;
    let finishTimer = null;
    let idleTimer = null;
    let startedAt = Date.now();
    let playbackGeneration = 0;
    let pumpScheduled = false;

    // LIVE lifecycle and autonomous scheduler state.
    let liveSessionActive = false;
    let liveSessionState = 'inactive';
    let liveStartedAt = 0;
    let liveViewerCount = 0;
    let lastActivityAt = 0;
    let lastActivityReason = '';
    let lastAnnouncementFinishedAt = 0;
    let lastAutonomousAt = 0;
    let lastAutonomousLineId = '';
    let autonomousScheduled = false;
    let autonomousCount = 0;
    let totalAutonomous = 0;
    let hourlyAutonomous = [];
    let fixedIntervalMs = 0;

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

    function hourlyCount(now = Date.now()) {
        hourlyAutonomous = hourlyAutonomous.filter(at => now - at < HOUR_MS);
        return hourlyAutonomous.length;
    }

    function newFixedInterval() {
        const min = Math.max(30, Number(config.random.minSeconds) || 150);
        const max = Math.max(min, Number(config.random.maxSeconds) || 300);
        return (min + Math.random() * (max - min)) * 1000;
    }

    function autonomousEnabled() {
        return Boolean(
            started &&
            liveSessionActive &&
            config.enabled &&
            config.autonomous.enabled &&
            config.autonomous.randomDialogue &&
            config.events.random &&
            config.random.enabled
        );
    }

    /**
     * Timestamp at which the next autonomous line may be generated. Returning 0
     * means "do not arm a timer" (LIVE inactive, manually disabled, zero-viewer
     * permission off, or the hourly cap has been reached).
     */
    function nextAutonomousAt(now = Date.now()) {
        if (!autonomousEnabled()) return 0;
        if (!config.autonomous.allowZeroViewers && liveViewerCount <= 0) return 0;
        if (hourlyCount(now) >= config.autonomous.maxPerHour) return 0;

        const anchor = Math.max(
            liveStartedAt || 0,
            lastActivityAt || 0,
            lastAnnouncementFinishedAt || 0
        );
        if (config.autonomous.idleDetection) {
            return anchor + Math.max(3, Number(config.autonomous.idleSeconds) || 10) * 1000;
        }
        // Fixed random cadence is the documented fallback when idle detection is
        // switched off. Activity resets it just like the idle countdown.
        return Math.max(anchor, lastAutonomousAt || 0) + (fixedIntervalMs || newFixedInterval());
    }

    function statusPayload() {
        const now = Date.now();
        const due = nextAutonomousAt(now);
        const count = hourlyCount(now);
        return {
            enabled: config.enabled,
            provider: config.provider,
            voice: config.voice,
            voiceGender: config.voiceGender,
            persona: config.persona,
            volume: config.volume,
            boostDb: config.boostDb,
            queueSize: queue.size,
            current: current ? {
                id: current.id,
                category: current.category,
                text: current.text,
                priority: current.priority,
                startedAt: current.startedAt || 0,
                durationMs: current.durationMs || 0,
                autonomous: Boolean(current.autonomous)
            } : null,
            busy,
            lastError,
            lastGenerationMs,
            lastAck,
            lastAudio,
            ducking: {
                level: config.duckLevel,
                fadeMs: config.duckFadeMs,
                active: Boolean(current)
            },
            providerStatus: config.provider ? providers.providerStatus(config.provider) : null,
            providers: providers.listProviders(),
            audioCache: audioCache.snapshot(),
            startedAt,
            liveSession: {
                active: liveSessionActive,
                state: liveSessionState,
                startedAt: liveStartedAt || null,
                viewerCount: liveViewerCount
            },
            autonomous: {
                enabled: config.autonomous.enabled,
                idleDetection: config.autonomous.idleDetection,
                idleSeconds: config.autonomous.idleSeconds,
                allowZeroViewers: config.autonomous.allowZeroViewers,
                randomDialogue: config.autonomous.randomDialogue,
                maxPerHour: config.autonomous.maxPerHour,
                categories: config.autonomous.categories.slice(),
                liveActive: liveSessionActive,
                liveState: liveSessionState,
                lastActivityAt: lastActivityAt || null,
                lastActivityReason,
                secondsSinceLastActivity: lastActivityAt ? Math.max(0, Math.floor((now - lastActivityAt) / 1000)) : null,
                nextAnnouncementAt: due || null,
                secondsUntilNext: due ? Math.max(0, Math.ceil((due - now) / 1000)) : null,
                sessionCount: autonomousCount,
                totalCount: totalAutonomous,
                hourlyCount: count,
                limitReached: count >= config.autonomous.maxPerHour,
                queueBlocked: Boolean(current) || queue.size > 0 || autonomousScheduled,
                schedulerActive: Boolean(idleTimer),
                lastAutonomousAt: lastAutonomousAt || null,
                lastLineId: lastAutonomousLineId || ''
            }
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

    function scheduleIdle(delayOverride) {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = null;
        if (!started || !liveSessionActive || !autonomousEnabled()) return;
        const now = Date.now();
        const due = nextAutonomousAt(now);
        if (!due) {
            // The hourly cap or zero-viewer permission can make the normal due
            // timestamp unavailable. Re-check periodically so the scheduler
            // resumes without requiring another event.
            idleTimer = setTimeout(onIdleTick, 30000);
            idleTimer.unref?.();
            return;
        }
        let delay = delayOverride === undefined ? due - now : Number(delayOverride) || 0;
        if (busy || current || queue.size > 0 || autonomousScheduled) {
            delay = Math.max(delay, 500);
        }
        delay = Math.max(100, delay);
        idleTimer = setTimeout(onIdleTick, delay);
        idleTimer.unref?.();
    }

    function chooseAutonomousDialogue() {
        return chooseDialogueFromCategories(
            config.dialogues,
            config.autonomous.categories,
            { previousId: lastAutonomousLineId }
        );
    }

    function enqueueAutonomous() {
        if (!autonomousEnabled() || busy || current || queue.size > 0 || autonomousScheduled) {
            return false;
        }
        const chosen = chooseAutonomousDialogue();
        if (!chosen) return false;
        const now = Date.now();
        const result = enqueueAnnouncement('random', { eventId: `autonomous-${now}` }, {
            text: chosen.text,
            templateId: chosen.id,
            force: true,
            bypassCooldown: true,
            priority: PRIORITIES.random,
            dedupeKey: `voice:autonomous:${now}`,
            autonomous: true
        });
        if (!result.accepted) return false;
        autonomousScheduled = true;
        lastAutonomousLineId = chosen.id;
        broadcastStatus();
        return true;
    }

    function onIdleTick() {
        idleTimer = null;
        if (!autonomousEnabled()) {
            broadcastStatus();
            return;
        }
        if (busy || current || queue.size > 0 || autonomousScheduled) {
            scheduleIdle(500);
            return;
        }
        const now = Date.now();
        const due = nextAutonomousAt(now);
        if (!due) {
            scheduleIdle(30000);
            return;
        }
        if (now < due) {
            scheduleIdle(due - now);
            return;
        }
        if (!enqueueAutonomous()) {
            scheduleIdle(1000);
            return;
        }
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
            const generationStarted = Date.now();
            try {
                const result = await providers.synthesize({
                    provider: providerId,
                    text: item.text,
                    voice: item.voice || config.voice,
                    speed: item.speed || config.speed,
                    gender: item.voiceGender || config.voiceGender
                });
                lastGenerationMs = Date.now() - generationStarted;
                if (providerId !== primary) {
                    logger.warn?.(`[voice] ${primary} failed; used ${providerId} fallback.`);
                    lastError = `${CATEGORY_LABELS[item.category] || item.category}: primary voice failed; used ${providerId} fallback.`;
                } else {
                    lastError = '';
                }
                const boosted = amplifyWav(result.buffer, config.boostDb);
                return {
                    ...result,
                    buffer: boosted.applied ? boosted.buffer : result.buffer,
                    audioGain: boosted
                };
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
            force: Boolean(options.force),
            autonomous: Boolean(options.autonomous),
            test: Boolean(options.test)
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

    function finishCurrent(id) {
        if (!current || current.id !== id) return;
        const wasAutonomous = Boolean(current.autonomous);
        if (finishTimer) clearTimeout(finishTimer);
        finishTimer = null;
        current = null;
        busy = false;
        lastAnnouncementFinishedAt = Date.now();
        if (wasAutonomous) autonomousScheduled = false;
        broadcastStatus();
        schedulePump();
        scheduleIdle();
    }

    async function pump() {
        if (!started || busy || !config.enabled) return;
        const item = queue.dequeue();
        if (!item) {
            // Do not re-arm schedulePump here: an empty queue would create an
            // endless zero-delay loop that starves the idle timer.
            scheduleIdle();
            return;
        }
        if (item.expiresAt && item.expiresAt <= Date.now()) {
            if (item.autonomous) autonomousScheduled = false;
            if (queue.size > 0) schedulePump();
            else scheduleIdle();
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
                if (item.autonomous) autonomousScheduled = false;
                broadcastStatus();
                schedulePump();
                scheduleIdle();
                return;
            }
            const cacheKey = crypto.createHash('sha256').update([
                result.provider,
                result.voice,
                config.speed,
                config.boostDb,
                item.text
            ].join('|')).digest('hex');
            const audio = audioCache.put(result.buffer, {
                cacheKey,
                provider: result.provider,
                voice: result.voice,
                durationMs: result.durationMs,
                boostDb: config.boostDb,
                normalizationGainDb: result.audioGain?.normalizationGainDb || 0
            });
            item.durationMs = audio.durationMs;
            item.audioId = audio.id;
            item.audioUrl = audio.url;
            lastAudio = {
                provider: result.provider,
                voice: result.voice,
                durationMs: audio.durationMs,
                peakDb: audio.peakDb,
                rmsDb: audio.rmsDb,
                boostDb: config.boostDb,
                normalizationGainDb: result.audioGain?.normalizationGainDb || 0,
                limited: Boolean(result.audioGain?.limited),
                at: Date.now()
            };

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
                autonomous: Boolean(item.autonomous),
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
                voice: result.voice,
                autonomous: Boolean(item.autonomous)
            });

            if (item.autonomous && !item.test) {
                autonomousCount += 1;
                totalAutonomous += 1;
                lastAutonomousAt = Date.now();
                hourlyAutonomous.push(lastAutonomousAt);
            }
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
            if (item.autonomous) autonomousScheduled = false;
            broadcastStatus();
            schedulePump();
            scheduleIdle();
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
        fixedIntervalMs = newFixedInterval();
        scheduleIdle();
        broadcastConfig();
        return publicConfig();
    }

    function markActivity(reason) {
        if (!liveSessionActive) return;
        lastActivityAt = Date.now();
        lastActivityReason = text(reason, 40, 'activity');
        // If the MC is already speaking, this records the event; the countdown
        // starts from the later of activity and speech completion.
        scheduleIdle();
    }

    function onGameEvent(event) {
        if (!started || !config.enabled || !liveSessionActive || !event || typeof event !== 'object') return;
        markActivity(event.type || 'event');
        if (event.type === 'like') return;

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

    function setLiveSessionActive(active, info = {}) {
        const next = Boolean(active);
        if (next === liveSessionActive) {
            if (info.state) liveSessionState = String(info.state);
            broadcastStatus();
            scheduleIdle();
            return;
        }
        liveSessionActive = next;
        liveSessionState = text(info.state, 40, next ? 'connected' : 'inactive');
        if (next) {
            const now = Date.now();
            liveStartedAt = now;
            liveViewerCount = Math.max(0, Number(info.viewerCount) || 0);
            lastActivityAt = now;
            lastActivityReason = 'live-start';
            lastAnnouncementFinishedAt = 0;
            lastAutonomousAt = 0;
            lastAutonomousLineId = '';
            autonomousScheduled = false;
            autonomousCount = 0;
            hourlyAutonomous = [];
            fixedIntervalMs = newFixedInterval();
            scheduleIdle();
        } else {
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = null;
            autonomousScheduled = false;
            if (finishTimer) clearTimeout(finishTimer);
            finishTimer = null;
            if (current) {
                broadcastToRole('overlay', { type: 'voice_control', action: 'stop', id: current.id });
            }
            current = null;
            busy = false;
            queue.clear();
            lastActivityAt = 0;
            lastAnnouncementFinishedAt = 0;
            liveStartedAt = 0;
            liveViewerCount = 0;
        }
        broadcastStatus();
    }

    function setLiveViewerCount(count) {
        const next = Math.max(0, Math.floor(Number(count) || 0));
        if (next === liveViewerCount) return;
        liveViewerCount = next;
        if (liveSessionActive) {
            broadcastStatus();
            scheduleIdle();
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

    function queueAutonomousTest() {
        const chosen = chooseAutonomousDialogue();
        if (!chosen) return { accepted: false, reason: 'no-dialogue' };
        return enqueueAnnouncement('random', { eventId: `autonomous-test-${Date.now()}` }, {
            text: chosen.text,
            templateId: chosen.id,
            force: true,
            bypassCooldown: true,
            priority: PRIORITIES.test,
            dedupeKey: `voice:autonomous-test:${Date.now()}`,
            autonomous: true,
            test: true
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
            durationMs: result.durationMs,
            boostDb: config.boostDb,
            normalizationGainDb: result.audioGain?.normalizationGainDb || 0
        });
        return {
            audioUrl: audio.url,
            durationMs: audio.durationMs,
            text: speech,
            provider: result.provider,
            voice: result.voice,
            spokenUsername: username ? username.spoken : '',
            usernameOverridden: username ? username.overridden : false,
            peakDb: audio.peakDb,
            rmsDb: audio.rmsDb
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
        autonomousScheduled = false;
        // Manual stop also respects the operator: wait for a fresh idle period
        // instead of immediately replacing the stopped line.
        lastAnnouncementFinishedAt = Date.now();
        broadcastStatus();
        scheduleIdle();
    }

    function clearQueue() {
        const count = queue.clear();
        if (!current) autonomousScheduled = false;
        broadcastStatus();
        scheduleIdle();
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
        fixedIntervalMs = newFixedInterval();
        started = true;
        startedAt = Date.now();
        scheduleIdle();
        return publicConfig();
    }

    function dispose() {
        started = false;
        playbackGeneration += 1;
        if (idleTimer) clearTimeout(idleTimer);
        if (finishTimer) clearTimeout(finishTimer);
        idleTimer = null;
        finishTimer = null;
        liveSessionActive = false;
        liveSessionState = 'inactive';
        queue.clear();
        current = null;
        busy = false;
        autonomousScheduled = false;
        audioCache.clear();
    }

    return {
        start,
        dispose,
        onGameEvent,
        updateConfig,
        queueTest,
        queueAutonomousTest,
        preview,
        pronounce,
        stopCurrent,
        clearQueue,
        acknowledge,
        setLiveSessionActive,
        setLiveViewerCount,
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
