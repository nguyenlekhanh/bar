/* ═══════════════════════════════════════════════════════════
   ÔNG CHÚ MMO — TikTok Live Bridge Server
   © 2025 ÔNG CHÚ MMO — ongchummo.com
   Phát hành theo giấy phép MIT. Xem file ../LICENSE.
═══════════════════════════════════════════════════════════ */

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs/promises');
const WebSocket = require('ws');
const { TikTokLiveConnection } = require('tiktok-live-connector');
const { getServerSettings, loadEnvironmentFile } = require('./src/config/environment');

loadEnvironmentFile();

const { normalizeTikFinityMessage } = require('./src/tiktok/normalize-tikfinity-event');
const {
    normalizeChat,
    normalizeMember,
    normalizeGift,
    normalizeLike,
    normalizeSocial,
    isPendingGiftStreak
} = require('./src/tiktok/normalize-event');

const gameConfig = require('./config/game.json');
const giftConfig = require('./config/gifts.json');
const initialMasterConfig = require('./config/master.json');
const initialObservedGifts = require('./config/observed-gifts.json');
const { normalizeText, sanitizeMasterConfig, resolveMasterRule, applyRule, applyBuiltInChatCommand } = require('./src/master/rules');
const {
    catalogMessage: animationCatalogMessage,
    resolveGiftAnimation,
    resolveGiftTarget,
    resolveAnimationTarget,
    sanitizeGiftAnimations,
    loadGiftAnimations,
    saveGiftAnimations
} = require('./src/gifts/animations');
const {
    sanitizeGameEvent,
    isLoopbackAddress,
    isAllowedHost,
    isAllowedOrigin,
    consumeRateLimit
} = require('./src/security');
const {
    LEGACY_FILE,
    defaultBackground,
    validateBackground,
    listBackgroundFiles,
    resolveBackgroundPath,
    backgroundUrl,
    loadBackgroundConfig,
    saveBackgroundConfig
} = require('./src/background/registry');
const { startAutoConversion } = require('./src/gifs/pipeline');
const gifManager = require('./src/gifs/manager');
const {
    defaultInstructionConfig,
    sanitizeInstructionConfig,
    loadInstructionConfig,
    saveInstructionConfig
} = require('./src/instructions/config');
const { saveInstructionIcon, MAX_ICON_BYTES } = require('./src/instructions/icons');
const { createVoiceService } = require('./src/voice/service');
const { createMusicService, MAX_UPLOAD_BYTES: MAX_MUSIC_UPLOAD_BYTES } = require('./src/music/service');

const app = express();
const server = http.createServer(app);

const { port: PORT, host: HOST, allowLan: ALLOW_LAN } = getServerSettings();
const wss = new WebSocket.Server({
    noServer: true,
    maxPayload: 32 * 1024,
    perMessageDeflate: false,
    clientTracking: true
});
const publicDir = path.join(__dirname, 'public');
const assetsDir = path.join(__dirname, 'assets');
const gifsDir = path.join(assetsDir, 'gifs');
const masterConfigPath = process.env.MASTER_CONFIG
    ? path.resolve(process.env.MASTER_CONFIG)
    : path.join(__dirname, 'config', 'master.json');
const observedGiftsPath = path.join(__dirname, 'config', 'observed-gifts.json');
const giftAnimationsPath = process.env.GIFT_ANIMATIONS_CONFIG
    ? path.resolve(process.env.GIFT_ANIMATIONS_CONFIG)
    : path.join(__dirname, 'config', 'gift-animations.json');
const backgroundsRoot = process.env.BACKGROUND_ROOT
    ? path.resolve(process.env.BACKGROUND_ROOT)
    : path.join(__dirname, '..', 'LiveAssets', 'Backgrounds');
const legacyBackgroundPath = path.join(__dirname, '..', 'LiveAssets', LEGACY_FILE);
// Operators keep their clips in DJ_VIDEO, so it is part of the catalogue.
const djVideoDir = process.env.BACKGROUND_EXTRA_VIDEO_DIR
    ? path.resolve(process.env.BACKGROUND_EXTRA_VIDEO_DIR)
    : path.join(__dirname, '..', 'DJ_VIDEO');
const backgroundScanOptions = { extraVideoDirs: [djVideoDir] };
const backgroundConfigPath = process.env.BACKGROUND_CONFIG
    ? path.resolve(process.env.BACKGROUND_CONFIG)
    : path.join(__dirname, 'config', 'background.json');
const instructionConfigPath = process.env.INSTRUCTION_CONFIG
    ? path.resolve(process.env.INSTRUCTION_CONFIG)
    : path.join(__dirname, 'config', 'instructions.json');
const instructionIconsDir = path.join(assetsDir, 'instruction-icons');
const musicDir = process.env.DJ_MUSIC_DIR
    ? path.resolve(process.env.DJ_MUSIC_DIR)
    : path.join(__dirname, '..', 'DJ_MUSIC');
const musicStatePath = process.env.MUSIC_STATE
    ? path.resolve(process.env.MUSIC_STATE)
    : path.join(__dirname, 'config', 'music.json');
const voiceConfigPath = process.env.VOICE_CONFIG
    ? path.resolve(process.env.VOICE_CONFIG)
    : path.join(__dirname, 'config', 'voice.json');
const LIVE_PROVIDER = String(process.env.LIVE_PROVIDER || gameConfig.liveProvider || 'tikfinity').toLowerCase();
const TIKFINITY_WS_URL = String(process.env.TIKFINITY_WS_URL || gameConfig.tikfinityWsUrl || 'ws://127.0.0.1:21213/');

let liveConnection = null;
let connectionAttempt = 0;
let desiredUsername = null;
let reconnectTimer = null;
let reconnectFailures = 0;
let demoTimer = null;
const demoTimeouts = new Set();
let connectionStatus = {
    state: 'idle',
    username: null,
    message: 'Not connected'
};
let metrics = createMetrics();
let masterConfig = sanitizeMasterConfig(initialMasterConfig);
const recentEventIds = new Map();
const sessionPlayers = new Map();
const sessionVipScores = new Map();
const observedGifts = new Map((Array.isArray(initialObservedGifts) ? initialObservedGifts : [])
    .map(gift => [String(gift.giftId || gift.giftName || ''), gift])
    .filter(([key]) => key));
let observedGiftSaveTimer = null;
let giftAnimationMappings = [];
// Converted GIF folders, refreshed after every manager change and at startup.
let animationRegistry = new Set();
let backgroundConfig = defaultBackground();
let backgroundAck = { file: '', generation: -1, at: 0 };
let instructionConfig = defaultInstructionConfig();

// The voice service owns English dialogue, username pronunciation, the TTS
// providers, the bounded audio cache and the single-speaker queue. It is
// deliberately separate from the gameplay event broadcast so reconnects cannot
// duplicate a spoken announcement.
const voiceService = createVoiceService({
    configPath: voiceConfigPath,
    broadcast,
    broadcastToRole,
    logger: console
});
const musicService = createMusicService({
    musicDir,
    statePath: musicStatePath,
    broadcastToRole,
    getOverlayCount: () => overlayClientCount(),
    logger: console
});

if (!ALLOW_LAN && !isLoopbackAddress(HOST) && HOST.toLowerCase() !== 'localhost') {
    throw new Error('Từ chối mở Node ra mạng LAN. Chỉ đặt ALLOW_LAN=1 khi đã có lớp xác thực bên ngoài.');
}

function createMetrics() {
    return {
        source: 'idle',
        events: 0,
        members: 0,
        chats: 0,
        gifts: 0,
        diamonds: 0,
        likes: 0,
        startedAt: null
    };
}

app.disable('x-powered-by');
app.use((req, res, next) => {
    if (!isAllowedHost(req.headers.host, PORT, ALLOW_LAN)) {
        return res.status(403).type('text/plain').send('Forbidden');
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', [
        "default-src 'self'",
        "base-uri 'none'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: https:",
        "media-src 'self' blob:",
        `connect-src 'self' ws://127.0.0.1:${PORT} ws://localhost:${PORT}`
    ].join('; '));
    if (req.path.startsWith('/api/') || req.path.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-store');
    }
    next();
});

const staticOptions = { dotfiles: 'deny', fallthrough: true, etag: true, index: ['index.html'] };
app.get('/', (_req, res) => res.redirect('/control.html'));
app.use(express.static(publicDir, staticOptions));
app.use('/assets', express.static(assetsDir, staticOptions));
app.use('/vendor/three', express.static(path.join(__dirname, 'node_modules', 'three', 'build'), staticOptions));
app.get(`/backgrounds/legacy/${LEGACY_FILE}`, (_req, res) => {
    res.sendFile(legacyBackgroundPath, error => {
        if (error && !res.headersSent) res.status(404).type('text/plain').send('Not found');
    });
});

/**
 * Serves background media from wherever it actually lives
 * (LiveAssets/Backgrounds/{images,videos} or DJ_VIDEO). The path is rebuilt
 * from the folder root on every request, so a crafted name cannot escape, and
 * sendFile keeps HTTP Range support, which video playback needs.
 */
app.get('/backgrounds/:kind/:file', (req, res) => {
    const type = req.params.kind === 'videos' ? 'video' : req.params.kind === 'images' ? 'image' : null;
    if (!type) return res.status(404).type('text/plain').send('Not found');

    const resolved = resolveBackgroundPath(backgroundsRoot, { type, file: req.params.file }, backgroundScanOptions);
    if (resolved.error || !resolved.exists) return res.status(404).type('text/plain').send('Not found');

    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(resolved.absolute, error => {
        if (error && !res.headersSent) res.status(404).type('text/plain').send('Not found');
    });
});

app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', appId: 'ongchu-mmo-live-bridge', version: '1.0.0' });
});

app.get('/api/config', (_req, res) => {
    res.json({ game: gameConfig, gifts: giftConfig, master: masterConfig, observedGifts: [...observedGifts.values()] });
});

app.get('/api/gifs', async (_req, res) => {
    try {
        const files = await fs.readdir(gifsDir);
        res.json(files.filter(file => file.toLowerCase().endsWith('.gif')));
    } catch (error) {
        if (error.code === 'ENOENT') return res.json([]);
        console.error('Không thể đọc thư mục GIF:', error);
        res.status(500).json({ error: 'Could not read the GIF list.' });
    }
});

app.get('/api/backgrounds', async (_req, res) => {
    try {
        res.json(await backgroundCatalog());
    } catch (error) {
        console.error('Không thể đọc thư mục background:', error.message);
        res.status(500).json({ error: 'Could not read the background list.' });
    }
});

app.get('/api/background', (_req, res) => {
    res.json({ background: backgroundPayload(), ack: backgroundAck });
});

const backgroundBodyParser = express.json({ limit: '16kb' });
app.post('/api/background', backgroundBodyParser, async (req, res) => {
    const result = await applyBackgroundRequest(req.body?.background ?? req.body);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ background: result.background, message: 'Background sent to Unity.' });
});

/* ── Live Instruction Overlay ─────────────────────────── */
app.get('/api/instructions', (_req, res) => {
    res.json({ config: instructionConfig });
});

const instructionBodyParser = express.json({ limit: '64kb' });
app.post('/api/instructions', controlPanelOnly, instructionBodyParser, async (req, res) => {
    const result = await applyInstructionRequest(req.body);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({
        config: result.config,
        overlayClients: result.overlayClients,
        message: 'Instructions saved and sent to Unity.'
    });
});

const instructionIconParser = (req, res, next) => {
    express.raw({ type: 'image/png', limit: MAX_ICON_BYTES })(req, res, error => {
        if (!error) return next();
        if (error.type === 'entity.too.large') {
            return res.status(413).json({ error: 'The icon is larger than 256 KB.' });
        }
        return res.status(400).json({ error: 'The PNG upload could not be read.' });
    });
};

app.post('/api/instruction-icons', controlPanelOnly, instructionIconParser, async (req, res) => {
    try {
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
            return res.status(400).json({ error: 'No PNG file received.' });
        }
        const saved = await saveInstructionIcon(req.body, instructionIconsDir);
        if (saved.error) return res.status(400).json({ error: saved.error });
        res.json({ ...saved, message: 'Icon uploaded.' });
    } catch (error) {
        console.error('Could not save instruction icon:', error.message);
        res.status(500).json({ error: 'Could not save the icon.' });
    }
});

/* ── DJ MUSIC MANAGER ──────────────────────────────────── */
const musicBodyParser = express.json({ limit: '64kb' });
const musicUploadParser = (req, res, next) => {
    express.raw({ type: () => true, limit: MAX_MUSIC_UPLOAD_BYTES })(req, res, error => {
        if (!error) return next();
        if (error.type === 'entity.too.large') {
            return res.status(413).json({ error: 'The music file is larger than 100 MB.' });
        }
        return res.status(400).json({ error: 'The music upload could not be read.' });
    });
};

app.get('/api/music', controlPanelOnly, (_req, res) => {
    res.json(musicService.getSnapshot());
});

app.post('/api/music', controlPanelOnly, musicBodyParser, async (req, res) => {
    try {
        const result = await musicService.updateSettings(req.body || {});
        res.json({ ...result, message: 'Music settings saved.' });
    } catch (error) {
        res.status(400).json({ error: error.message || 'Could not save music settings.' });
    }
});

app.post('/api/music/command', controlPanelOnly, musicBodyParser, async (req, res) => {
    const result = await musicService.command(req.body?.action, req.body || {});
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ ...result, message: result.message || 'Music command accepted.' });
});

app.post('/api/music/upload', controlPanelOnly, musicUploadParser, async (req, res) => {
    try {
        const name = String(req.query.name || '');
        const result = await musicService.upload(name, req.body);
        if (!result.ok) return res.status(result.conflict ? 409 : 400).json({ error: result.error });
        res.status(201).json({ ...result, message: 'Music file uploaded.' });
    } catch (error) {
        console.error('Could not upload music:', error.message);
        res.status(500).json({ error: 'Could not upload the music file.' });
    }
});

app.post('/api/music/remove', controlPanelOnly, musicBodyParser, async (req, res) => {
    const result = await musicService.remove(req.body?.file);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ ...result, message: result.switchedTo ? `Removed. Switched to ${result.switchedTo}.` : 'Music file removed.' });
});

/* ── LIVE AI DJ / VOICE MANAGER ─────────────────────────── */
const voiceBodyParser = express.json({ limit: '128kb' });

app.get('/api/voice', controlPanelOnly, (_req, res) => {
    res.json({
        config: voiceService.publicConfig(),
        providers: voiceService.publicProviders(),
        status: voiceService.getStatus()
    });
});

app.post('/api/voice', controlPanelOnly, voiceBodyParser, async (req, res) => {
    try {
        const config = await voiceService.updateConfig(req.body?.config ?? req.body);
        res.json({
            config,
            providers: voiceService.publicProviders(),
            status: voiceService.getStatus(),
            message: 'Voice settings saved and applied.'
        });
    } catch (error) {
        res.status(400).json({ error: error.message || 'Could not save voice settings.' });
    }
});

app.post('/api/voice/pronounce', controlPanelOnly, voiceBodyParser, (req, res) => {
    const username = String(req.body?.username || '').slice(0, 80);
    res.json({ pronunciation: voiceService.pronounce(username) });
});

app.post('/api/voice/preview', controlPanelOnly, voiceBodyParser, async (req, res) => {
    try {
        const preview = await voiceService.preview(req.body || {});
        res.json({ ...preview, message: 'Voice preview generated.' });
    } catch (error) {
        res.status(503).json({ error: error.message || 'Could not generate the voice preview.' });
    }
});

app.post('/api/voice/test', controlPanelOnly, voiceBodyParser, (req, res) => {
    const result = voiceService.queueTest(req.body || {});
    if (!result.accepted) return res.status(409).json({ error: `Voice test was not queued: ${result.reason}.` });
    res.json({ queued: true, item: result.item, status: voiceService.getStatus() });
});

app.post('/api/voice/autonomous/test', controlPanelOnly, (_req, res) => {
    const result = voiceService.queueAutonomousTest();
    if (!result.accepted) return res.status(409).json({ error: `Autonomous MC test was not queued: ${result.reason}.` });
    res.json({ queued: true, item: result.item, status: voiceService.getStatus() });
});

app.post('/api/voice/test-audio', controlPanelOnly, (_req, res) => {
    const result = voiceService.queueTestAudio();
    if (!result.accepted) return res.status(409).json({ error: `Audio test was not queued: ${result.reason}.` });
    res.json({ queued: true, item: result.item, status: voiceService.getStatus() });
});

app.post('/api/voice/stop', controlPanelOnly, (_req, res) => {
    voiceService.stopCurrent();
    res.json({ stopped: true, status: voiceService.getStatus() });
});

app.post('/api/voice/clear', controlPanelOnly, (_req, res) => {
    const cleared = voiceService.clearQueue();
    res.json({ cleared, status: voiceService.getStatus() });
});

app.get('/api/voice/audio/:file', (req, res) => {
    const match = String(req.params.file || '').match(/^([a-f0-9]{32})\.wav$/i);
    if (!match) return res.status(404).type('text/plain').send('Not found');
    const audio = voiceService.getAudio(match[1]);
    if (!audio) return res.status(404).type('text/plain').send('Voice audio expired.');
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Content-Length', audio.buffer.length);
    res.setHeader('Cache-Control', 'private, max-age=0, no-store');
    res.setHeader('Accept-Ranges', 'none');
    res.end(audio.buffer);
});

const giftAnimationsBodyParser = express.json({ limit: '64kb' });
app.get('/api/gift-animations', (_req, res) => {
    res.json(giftAnimationsMessage());
});

app.post('/api/gift-animations', giftAnimationsBodyParser, async (req, res) => {
    const result = sanitizeGiftAnimations(req.body ? req.body.giftAnimations : [], {
        allowedIds: animationRegistry
    });
    if (result.error) return res.status(400).json({ error: result.error });
    giftAnimationMappings = result.value;
    await saveGiftAnimations(giftAnimationsPath, giftAnimationMappings);
    broadcastToRole('control', giftAnimationsMessage());
    res.json({ giftAnimations: giftAnimationMappings, message: 'Gift animations saved and applied.' });
});

/* ── GIF Manager (Phase 4) — control panel only ────────── */
const gifLimits = gifManager.limitsFromEnv();

/**
 * Administrative routes are refused unless the caller is the same-origin
 * control panel. The bridge only listens on loopback, so this is layered
 * defence rather than authentication: overlay clients never call these paths.
 */
function controlPanelOnly(req, res, next) {
    if (req.get('x-control-panel') !== '1') {
        return res.status(403).json({ error: 'Control panel request required.' });
    }
    if (!isAllowedOrigin(req.headers.origin, PORT)) {
        return res.status(403).json({ error: 'Origin not allowed.' });
    }
    next();
}

const managerJsonBody = express.json({ limit: '16kb' });
const gifUploadParser = (req, res, next) => {
    express.raw({ type: () => true, limit: gifLimits.maxBytes })(req, res, error => {
        if (!error) return next();
        if (error.type === 'entity.too.large') {
            const megabytes = Math.round(gifLimits.maxBytes / (1024 * 1024));
            return res.status(413).json({ error: `GIF is larger than the ${megabytes} MB limit.` });
        }
        return res.status(400).json({ error: 'The upload could not be read.' });
    });
};

function giftIdsForAnimation(animationId) {
    return giftAnimationMappings
        .filter(mapping => mapping.animationId === animationId)
        .map(mapping => mapping.giftId);
}

function overlayClientCount() {
    let total = 0;
    for (const client of wss.clients) {
        if (client.role === 'overlay' && client.readyState === WebSocket.OPEN) total += 1;
    }
    return total;
}

// Ten test gifts per ten seconds: a stuck button must not flood Unity.
const testGiftWindow = { startedAt: 0, count: 0 };
function allowTestGift(now = Date.now()) {
    if (!testGiftWindow.startedAt || now - testGiftWindow.startedAt >= 10000) {
        testGiftWindow.startedAt = now;
        testGiftWindow.count = 0;
    }
    testGiftWindow.count += 1;
    return testGiftWindow.count <= 10;
}

const TEST_GIFT_ID_PATTERN = /^[A-Za-z0-9_.-]{1,40}$/;
const TEST_VIEWER_COUNTS = new Set([1, 10, 30, 60, 400]);

let activeTestSession = null;

function clearTestTimers(session) {
    for (const timer of session.timers) clearTimeout(timer);
    session.timers.clear();
    if (session.watchdog) clearTimeout(session.watchdog);
    session.watchdog = null;
}

function scheduleTestStep(session, delay, work) {
    const timer = setTimeout(() => {
        session.timers.delete(timer);
        if (activeTestSession !== session) return;
        work();
    }, delay);
    session.timers.add(timer);
}

function testViewer(session, index) {
    const suffix = session.viewers === 1 ? '' : ` ${index}`;
    return {
        userId: `gif-test-${session.id}-${index}`,
        uniqueId: `gif_test_${session.id}_${index}`,
        nickname: `${session.nickname}${suffix}`,
        avatar: ''
    };
}

function emitTestMember(viewer) {
    processGameEvent({
        type: 'member',
        action: 'join',
        joinedNow: true,
        eventId: `test-join-${viewer.userId}-${Date.now()}`,
        testEvent: true,
        ...viewer
    });
}

function sendTestProgress(session) {
    broadcastToRole('control', {
        type: 'test_gift_progress',
        sessionId: session.id,
        animationId: session.animationId,
        sent: session.sent,
        total: session.total,
        acked: session.acked.size,
        viewers: session.viewers
    });
}

function emitTestGiftEvent(session, index) {
    const viewer = testViewer(session, index);
    const eventId = `test-gift-${session.id}-${session.sent + 1}`;
    session.eventIds.add(eventId);
    session.userIds.add(viewer.userId);

    processGameEvent({
        type: 'gift',
        eventId,
        ...viewer,
        giftId: session.giftId,
        giftName: session.giftName,
        repeatCount: session.repeatCount,
        unitDiamondCount: session.unitDiamonds,
        diamondCount: session.unitDiamonds * session.repeatCount,
        testEvent: true,
        testAnimationId: session.animationId
    });

    session.sent += 1;
    const stride = Math.max(1, Math.floor(session.total / 8));
    if (session.sent === 1 || session.sent === session.total || session.sent % stride === 0) {
        sendTestProgress(session);
    }
    if (session.sent >= session.total) {
        session.completed = true;
        broadcastToRole('control', {
            type: 'test_gift_complete',
            sessionId: session.id,
            animationId: session.animationId,
            sent: session.sent,
            total: session.total,
            acked: session.acked.size,
            viewers: session.viewers
        });
    }
    return eventId;
}

/** Removes only the avatars/users a test created; real viewers are untouched. */
function stopTestSession(reason = 'stopped', session = activeTestSession) {
    if (!session) return null;
    clearTestTimers(session);
    if (activeTestSession === session) activeTestSession = null;

    const userIds = [...session.userIds];
    for (const userId of userIds) {
        sessionPlayers.delete(userId);
        sessionVipScores.delete(userId);
    }
    if (userIds.length) {
        const message = { type: 'remove_players', userIds };
        broadcastToRole('overlay', message);
        broadcastToRole('control', message);
    }

    const summary = {
        type: 'test_gift_stopped',
        sessionId: session.id,
        animationId: session.animationId,
        viewers: session.viewers,
        sent: session.sent,
        total: session.total,
        acked: session.acked.size,
        completion: session.completed ? 'completed' : 'stopped',
        reason,
        userIds
    };
    broadcastToRole('control', summary);
    return summary;
}

/**
 * Runs a live animation test through the normal event pipeline (the same
 * processGameEvent path Test Lab uses). Join and gift events are spaced out so
 * hundreds of viewers never arrive as one burst, and the explicit animation
 * override applies to these events only — saved mappings are never touched.
 */
function handleTestGift(ws, message) {
    const requestId = typeof message.requestId === 'string' ? message.requestId.slice(0, 64) : '';
    const animationId = String(message.animationId || '').trim().slice(0, 64);
    const reply = payload => send(ws, { type: 'test_gift_result', requestId, animationId, ...payload });

    const target = resolveAnimationTarget(animationId, animationRegistry);
    if (!target) {
        return reply({ ok: false, stage: 'rejected', message: `Unknown animation ID: ${animationId || '(empty)'}.` });
    }

    const giftId = String(message.giftId || '').trim() || 'test-gift';
    if (!TEST_GIFT_ID_PATTERN.test(giftId)) {
        return reply({
            ok: false,
            stage: 'rejected',
            message: 'Gift ID must be 1-40 characters: letters, numbers, dot, dash or underscore.'
        });
    }

    if (activeTestSession) {
        if (!activeTestSession.completed) {
            return reply({
                ok: false,
                stage: 'busy',
                message: 'A live test is already running. Stop it before starting another.'
            });
        }
        // A finished test is replaced so its fake viewers never accumulate.
        stopTestSession('replaced');
    }

    if (!allowTestGift()) {
        return reply({
            ok: false,
            stage: 'rate_limited',
            message: 'Too many test events. Wait a few seconds and try again.'
        });
    }

    const overlayClients = overlayClientCount();
    if (overlayClients === 0) {
        return reply({
            ok: false,
            stage: 'no_overlay',
            overlayClients: 0,
            message: 'No Unity overlay is connected, so nothing would play.'
        });
    }

    const requestedViewers = Math.floor(Number(message.viewers) || 1);
    const viewers = TEST_VIEWER_COUNTS.has(requestedViewers) ? requestedViewers : 1;
    const giftsPerViewer = Math.min(5, Math.max(1, Math.floor(Number(message.gifts) || 1)));
    const repeatCount = Math.min(99, Math.max(1, Math.floor(Number(message.repeatCount) || 1)));
    const unitDiamonds = Math.min(100000, Math.max(1, Math.floor(Number(message.diamonds) || 1)));
    const nickname = String(message.nickname || 'GIF_Test_Viewer')
        .replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80) || 'GIF_Test_Viewer';
    const giftName = String(message.giftName || animationId)
        .replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 100) || animationId;
    const total = viewers * giftsPerViewer;

    const joinGap = Math.max(5, Math.min(40, Math.floor(4000 / viewers)));
    const interval = Math.min(500, Math.max(5,
        Number(message.intervalMs) || Math.max(15, Math.min(150, Math.floor(20000 / total)))));

    const session = {
        id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        animationId,
        target,
        viewers,
        giftsPerViewer,
        repeatCount,
        unitDiamonds,
        nickname,
        giftName,
        giftId,
        sent: 0,
        total,
        acked: new Set(),
        eventIds: new Set(),
        userIds: new Set(),
        timers: new Set(),
        watchdog: null,
        startedAt: Date.now(),
        completed: false
    };
    activeTestSession = session;

    const details = {
        sessionId: session.id,
        animationId: target.animationId,
        kind: target.character ? 'character' : 'effect',
        giftId,
        repeatCount,
        unitDiamonds,
        diamondCount: unitDiamonds * repeatCount,
        viewers,
        total,
        overlayClients
    };

    // A single gift is fired synchronously so the reply can name its event.
    if (total === 1) {
        const viewer = testViewer(session, 1);
        session.userIds.add(viewer.userId);
        emitTestMember(viewer);
        const eventId = emitTestGiftEvent(session, 1);
        session.watchdog = setTimeout(() => stopTestSession('timeout'), 120000);
        return reply({
            ok: true,
            stage: 'broadcast',
            eventId,
            ...details,
            message: `Event sent to ${overlayClients} Unity overlay(s).`
        });
    }

    for (let index = 1; index <= viewers; index += 1) {
        scheduleTestStep(session, index * joinGap, () => {
            const viewer = testViewer(session, index);
            session.userIds.add(viewer.userId);
            emitTestMember(viewer);
        });
    }

    const giftStart = viewers * joinGap + 120;
    for (let gift = 0; gift < giftsPerViewer; gift += 1) {
        for (let index = 1; index <= viewers; index += 1) {
            scheduleTestStep(session, giftStart + (gift * viewers + index) * interval, () => {
                emitTestGiftEvent(session, index);
            });
        }
    }

    session.watchdog = setTimeout(() => stopTestSession('timeout'), giftStart + total * interval + 120000);

    return reply({
        ok: true,
        stage: 'scheduled',
        ...details,
        message: `Testing ${target.animationId} with ${viewers} viewer(s) · ${total} gift event(s).`
    });
}

async function managerSnapshot() {
    const snapshot = await gifManager.librarySnapshot();
    const usedBy = {};
    for (const animation of snapshot.animations) {
        usedBy[animation.animationId] = giftIdsForAnimation(animation.animationId);
    }
    return { ...snapshot, giftAnimations: giftAnimationMappings, usedBy };
}

async function afterAnimationChange() {
    await refreshGiftAnimations();
    broadcastToRole('control', giftAnimationsMessage());
}

async function convertImportedGif(imported) {
    try {
        const result = await gifManager.convertAnimation(imported.animationId, { confirm: false });
        return { ok: true, animationId: result.animationId, frameCount: result.frameCount, folder: result.folder };
    } catch (error) {
        // A name clash is reported, never forced: the panel asks first.
        return { ok: false, code: error.code || '', error: error.message };
    }
}

app.get('/api/gif-manager', async (_req, res) => {
    try {
        res.json(await managerSnapshot());
    } catch (error) {
        console.error('GIF manager snapshot failed:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/gif-manager/upload', controlPanelOnly, gifUploadParser, async (req, res) => {
    try {
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
            return res.status(400).json({ error: 'No file received.' });
        }
        const imported = await gifManager.importGifBuffer(req.body, { filename: req.query.filename });
        const conversion = req.query.convert === '1' && !imported.duplicate
            ? await convertImportedGif(imported)
            : null;
        if (conversion && conversion.ok) await afterAnimationChange();
        res.json({
            imported,
            conversion,
            snapshot: await managerSnapshot(),
            message: imported.duplicate
                ? `That GIF is already stored as ${imported.storedName}.`
                : `Added ${imported.storedName}.`
        });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post('/api/gif-manager/download', controlPanelOnly, managerJsonBody, async (req, res) => {
    try {
        const url = req.body ? req.body.url : '';
        const imported = await gifManager.downloadGifFromUrl(url);
        const conversion = req.body && req.body.convert === true && !imported.duplicate
            ? await convertImportedGif(imported)
            : null;
        if (conversion && conversion.ok) await afterAnimationChange();
        res.json({
            imported,
            conversion,
            snapshot: await managerSnapshot(),
            message: imported.duplicate
                ? `That GIF is already stored as ${imported.storedName}.`
                : `Downloaded ${imported.storedName}.`
        });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post('/api/gif-manager/convert', controlPanelOnly, managerJsonBody, async (req, res) => {
    try {
        const body = req.body || {};
        const result = await gifManager.convertAnimation(body.animationId, { confirm: body.confirm === true });
        await afterAnimationChange();
        res.json({ ...result, snapshot: await managerSnapshot(), message: `Converted ${result.animationId}.` });
    } catch (error) {
        const status = error.code === 'EEXIST' ? 409 : 400;
        res.status(status).json({ error: error.message, code: error.code || '' });
    }
});

app.post('/api/gif-manager/rename', controlPanelOnly, managerJsonBody, async (req, res) => {
    try {
        const body = req.body || {};
        const previousId = String(body.animationId || '');
        const result = await gifManager.renameAnimation(previousId, body.newName);
        let migratedGiftIds = [];
        if (result.changed) {
            migratedGiftIds = giftIdsForAnimation(previousId);
            if (migratedGiftIds.length) {
                giftAnimationMappings = giftAnimationMappings.map(mapping => (
                    mapping.animationId === previousId
                        ? { ...mapping, animationId: result.animationId }
                        : mapping
                ));
                await saveGiftAnimations(giftAnimationsPath, giftAnimationMappings);
            }
            await afterAnimationChange();
        }
        res.json({
            ...result,
            migratedGiftIds,
            snapshot: await managerSnapshot(),
            message: result.changed
                ? `Renamed ${previousId} to ${result.animationId}` +
                  (migratedGiftIds.length ? ` and moved ${migratedGiftIds.length} gift mapping(s).` : '.')
                : 'The animation already has that name.'
        });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post('/api/gif-manager/metadata', controlPanelOnly, managerJsonBody, async (req, res) => {
    try {
        const body = req.body || {};
        const result = await gifManager.updateAnimationMetadata(body.animationId, body);
        await afterAnimationChange();
        res.json({
            metadata: result.metadata,
            snapshot: await managerSnapshot(),
            message: `Saved playback settings for ${result.metadata.animationId}.`
        });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post('/api/gif-manager/delete', controlPanelOnly, managerJsonBody, async (req, res) => {
    try {
        const body = req.body || {};
        const animationId = String(body.animationId || '');
        const giftIds = giftIdsForAnimation(animationId);
        const result = await gifManager.deleteAnimation(animationId, {
            giftIds,
            confirm: body.confirm === true
        });
        if (giftIds.length) {
            giftAnimationMappings = giftAnimationMappings.filter(mapping => mapping.animationId !== animationId);
            await saveGiftAnimations(giftAnimationsPath, giftAnimationMappings);
        }
        await afterAnimationChange();
        res.json({
            ...result,
            removedGiftMappings: giftIds,
            snapshot: await managerSnapshot(),
            message: `Deleted ${animationId}` +
                (giftIds.length ? ` and removed ${giftIds.length} gift mapping(s).` : '.')
        });
    } catch (error) {
        if (error.code === 'EMAPPED') {
            return res.status(409).json({ error: error.message, code: error.code, giftIds: error.giftIds });
        }
        res.status(400).json({ error: error.message, code: error.code || '' });
    }
});

app.use((_req, res) => res.status(404).type('text/plain').send('Not found'));

async function refreshAnimationRegistry() {
    try {
        animationRegistry = await gifManager.characterAnimationIds();
    } catch (error) {
        console.error('GIF animation registry refresh failed:', error.message);
    }
    return animationRegistry;
}

async function refreshGiftAnimations() {
    // The registry must exist before mappings load, or mappings that point at
    // converted GIF folders would be rejected as unknown.
    await refreshAnimationRegistry();
    const loaded = await loadGiftAnimations(giftAnimationsPath, { allowedIds: animationRegistry });
    giftAnimationMappings = loaded.mappings;
    if (loaded.error) console.error('Gift animation mapping ignored:', loaded.error);
}

function giftAnimationsMessage() {
    return {
        type: 'gift_animations',
        giftAnimations: giftAnimationMappings,
        animations: animationCatalogMessage(),
        characterAnimations: [...animationRegistry].sort()
    };
}

function broadcast(data) {
    const payload = JSON.stringify(data);
    for (const client of wss.clients) {
        if (client.readyState !== WebSocket.OPEN) continue;
        if (client.bufferedAmount > 512 * 1024) {
            client.terminate();
            continue;
        }
        client.send(payload);
    }
}

function send(ws, data) {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 512 * 1024) return ws.terminate();
    ws.send(JSON.stringify(data));
}

function broadcastToRole(role, data) {
    const payload = JSON.stringify(data);
    for (const client of wss.clients) {
        if (client.readyState !== WebSocket.OPEN || client.role !== role) continue;
        if (client.bufferedAmount > 512 * 1024) {
            client.terminate();
            continue;
        }
        client.send(payload);
    }
}

async function backgroundCatalog() {
    const listing = await listBackgroundFiles(backgroundsRoot, backgroundScanOptions);
    let legacyBytes = 0;
    try {
        const info = await fs.stat(legacyBackgroundPath);
        if (info.isFile()) legacyBytes = info.size;
    } catch {
        legacyBytes = 0;
    }
    if (legacyBytes > 0 && !listing.images.some(item => item.file.toLowerCase() === LEGACY_FILE)) {
        listing.images.unshift({ file: LEGACY_FILE, type: 'image', bytes: legacyBytes, legacy: true });
        listing.all = [...listing.images, ...listing.videos];
    }
    return listing;
}

function backgroundPayload() {
    return { ...backgroundConfig, url: backgroundUrl(backgroundConfig) };
}

function clampDimension(value) {
    const size = Math.round(Number(value) || 0);
    return size > 0 && size <= 16384 ? size : 0;
}

function clampDuration(value) {
    const seconds = Number(value);
    return Number.isFinite(seconds) ? Math.max(0, Math.min(86400, seconds)) : 0;
}

async function applyBackgroundRequest(input) {
    const catalog = await backgroundCatalog();
    const available = [...catalog.images, ...catalog.videos];
    const validation = validateBackground(input || {}, { available });
    if (validation.error) return { ok: false, error: validation.error };

    // When the operator sends a transform, that is the approved orientation. When
    // they don't, fall back to the rotation the media declares for itself — never
    // to a rotation invented by the client.
    const source = input && typeof input === 'object' ? input : {};
    const explicitTransform = source.transform !== undefined || source.rotation !== undefined;
    const entry = available.find(item => String(item.file).toLowerCase() === validation.value.file.toLowerCase());
    const autoRotation = validation.value.type === 'video' ? Number(entry && entry.rotation) || 0 : 0;
    const transform = validation.value.type !== 'video'
        ? { rotation: 0, flipHorizontal: false, flipVertical: false }
        : explicitTransform
            ? validation.value.transform
            : { rotation: autoRotation, flipHorizontal: false, flipVertical: false };

    const next = {
        ...validation.value,
        rotation: transform.rotation,
        transform,
        generation: (Number(backgroundConfig.generation) || 0) + 1
    };
    backgroundConfig = next;
    await saveBackgroundConfig(backgroundConfigPath, next);
    backgroundAck = { file: '', generation: -1, ok: true, error: '', width: 0, height: 0, duration: 0, at: 0 };

    const message = { type: 'background_config', action: 'set', background: backgroundPayload() };
    broadcastToRole('overlay', message);
    broadcastToRole('control', message);
    return { ok: true, background: backgroundPayload() };
}

async function refreshInstructionConfig() {
    const loaded = await loadInstructionConfig(instructionConfigPath);
    instructionConfig = loaded.config;
    if (loaded.error) console.error('Could not read instruction config:', loaded.error);
}

async function applyInstructionRequest(input) {
    const result = sanitizeInstructionConfig(input);
    if (result.error) return { ok: false, error: result.error };

    instructionConfig = {
        ...result.value,
        revision: (Number(instructionConfig.revision) || 0) + 1
    };
    await saveInstructionConfig(instructionConfigPath, instructionConfig);
    broadcast({ type: 'instruction_config', config: instructionConfig });
    return { ok: true, config: instructionConfig, overlayClients: overlayClientCount() };
}

async function refreshBackgroundConfig() {
    const catalog = await backgroundCatalog();
    backgroundConfig = await loadBackgroundConfig(backgroundConfigPath, {
        available: [...catalog.images, ...catalog.videos]
    });
}

function setStatus(state, username, message) {
    connectionStatus = { state, username, message };
    broadcast({ type: 'status', ...connectionStatus });

    // The autonomous MC follows the actual LIVE connection lifecycle, not the
    // Unity WebSocket and not a viewer count. A reconnect keeps the same LIVE
    // session; only connecting/ended/idle/demo stop or replace it.
    if (state === 'connected' && username) {
        voiceService.setLiveSessionActive(true, { state, viewerCount: 0 });
    } else if (state === 'reconnecting' && username) {
        if (voiceService.getStatus().liveSession.active) {
            voiceService.setLiveSessionActive(true, { state });
        }
    } else if (state === 'connecting' || state === 'ended' || state === 'idle' || state === 'demo') {
        voiceService.setLiveSessionActive(false, { state });
    }
}

function broadcastMetrics() {
    broadcast({ type: 'metrics', ...metrics });
}

function giftCatalogMessage() {
    return {
        type: 'gift_catalog',
        gifts: [...observedGifts.values()].sort((a, b) =>
            (Number(a.diamondCount) || 0) - (Number(b.diamondCount) || 0) ||
            String(a.giftName || '').localeCompare(String(b.giftName || '')))
    };
}

function viewerGuideMessage() {
    const joinRule = (masterConfig.rules || []).find(rule => rule.enabled && rule.source === 'chat' && rule.action === 'join');
    const giftRules = (masterConfig.rules || [])
        .filter(rule => rule.enabled && rule.source === 'gift' &&
            (Number(rule.displayDiamonds) > 0 || (rule.giftId && observedGifts.has(String(rule.giftId)))));
    const actionOrder = new Map([['walk', 0], ['medal', 1], ['fireworks', 2], ['grow', 3], ['topdj', 4]]);
    const items = giftRules
        .filter(rule => actionOrder.has(rule.action))
        .sort((a, b) => actionOrder.get(a.action) - actionOrder.get(b.action))
        .slice(0, 5)
        .map(rule => {
            const learned = rule.giftId ? observedGifts.get(String(rule.giftId)) : null;
            return {
                giftId: rule.giftId || learned?.giftId || '',
                giftName: learned?.giftName || String(rule.trigger || '').split(',')[0].trim() || 'Gift',
                diamondCount: Number(learned?.diamondCount) || Number(rule.displayDiamonds) || 0,
                giftPictureUrl: learned?.giftPictureUrl || '',
                label: rule.label || rule.action.toUpperCase()
            };
        });
    const zoomRule = giftRules.find(rule => rule.action === 'camera');
    const zoomLearned = zoomRule?.giftId ? observedGifts.get(String(zoomRule.giftId)) : null;
    return {
        type: 'viewer_guide',
        joinCommand: joinRule ? String(joinRule.trigger || '').split(',')[0].trim() : '',
        zoomGiftName: zoomLearned?.giftName || (zoomRule ? String(zoomRule.trigger || '').split(',')[0].trim() : ''),
        guideItems: items
    };
}

function scheduleObservedGiftSave() {
    clearTimeout(observedGiftSaveTimer);
    observedGiftSaveTimer = setTimeout(() => {
        observedGiftSaveTimer = null;
        fs.writeFile(observedGiftsPath, `${JSON.stringify([...observedGifts.values()], null, 2)}\n`, 'utf8')
            .catch(error => console.error('Không thể lưu thư viện gift:', error));
    }, 250);
}

function learnObservedGift(event) {
    const giftId = String(event.giftId || '').trim();
    const giftName = String(event.giftName || 'Gift').trim();
    const key = giftId || giftName.toLocaleLowerCase('vi');
    if (!key) return;
    const previous = observedGifts.get(key) || {};
    const repeats = Math.max(1, Number(event.repeatCount) || 1);
    const unitDiamonds = Math.max(0,
        Number(event.unitDiamondCount) || Math.round((Number(event.diamondCount) || 0) / repeats));
    const learnedGift = {
        ...previous,
        giftId,
        giftName,
        diamondCount: unitDiamonds || Number(previous.diamondCount) || 0,
        giftPictureUrl: nonEmpty(event.giftPictureUrl, previous.giftPictureUrl || ''),
        lastSeenAt: Date.now()
    };
    observedGifts.set(key, learnedGift);
    if (observedGifts.size > 500) {
        const oldest = [...observedGifts.entries()]
            .sort((a, b) => (Number(a[1].lastSeenAt) || 0) - (Number(b[1].lastSeenAt) || 0));
        for (let index = 0; index < oldest.length - 500; index += 1) observedGifts.delete(oldest[index][0]);
    }
    let masterChanged = false;
    for (const rule of masterConfig.rules || []) {
        if (!giftId) break;
        if (rule.source !== 'gift' || rule.giftId) continue;
        const aliases = String(rule.trigger || '').split(',').map(normalizeText).filter(Boolean);
        if (!aliases.includes(normalizeText(giftName))) continue;
        rule.giftId = giftId;
        rule.displayDiamonds = unitDiamonds || rule.displayDiamonds || 0;
        masterChanged = true;
        break;
    }
    if (masterChanged) {
        fs.writeFile(masterConfigPath, `${JSON.stringify(masterConfig, null, 2)}\n`, 'utf8')
            .catch(error => console.error('Không thể tự gắn Gift ID vào Master:', error));
        broadcast({ type: 'master_config', master: masterConfig });
    }
    scheduleObservedGiftSave();
    broadcast(giftCatalogMessage());
    broadcast(viewerGuideMessage());
}

function isRealObservedGift(event) {
    const giftId = String(event.giftId || '');
    return event.userId !== 'master-test' && !giftId.startsWith('demo-') && !giftId.startsWith('master-');
}

function resetSessionState(source = metrics.source) {
    metrics = { ...createMetrics(), source, startedAt: source === 'idle' ? null : Date.now() };
    sessionPlayers.clear();
    sessionVipScores.clear();
    recentEventIds.clear();
    voiceService.setLiveViewerCount(0);
}

function createSnapshot() {
    pruneSessionPlayers();
    return {
        type: 'snapshot',
        players: [...sessionPlayers.values()],
        vipScores: [...sessionVipScores.values()]
    };
}

function pruneSessionPlayers(now = Date.now()) {
    const cutoff = now - Math.max(1000, Number(gameConfig.playerTtlMs) || 600000);
    for (const [userId, player] of sessionPlayers) {
        if ((Number(player.lastActive) || 0) < cutoff) sessionPlayers.delete(userId);
    }
    const maximum = Math.max(1, Number(gameConfig.maxPlayers) || 200);
    if (sessionPlayers.size <= maximum) return;
    const oldest = [...sessionPlayers.values()]
        .sort((a, b) => (Number(a.lastActive) || 0) - (Number(b.lastActive) || 0));
    for (let index = 0; index < oldest.length - maximum; index += 1) {
        sessionPlayers.delete(oldest[index].userId);
    }
}

function normalizeUsername(value) {
    if (typeof value !== 'string') return null;
    const username = value.trim().replace(/^@/, '');
    return /^[A-Za-z0-9._]{2,24}$/.test(username) ? username : null;
}

function nonEmpty(value, fallback = '') {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function dedupeKey(event) {
    if (event.eventId) return `id:${event.eventId}`;
    return `fallback:${[
        event.type,
        event.userId,
        event.giftId,
        event.giftName,
        event.repeatCount,
        event.diamondCount,
        event.likeCount,
        event.comment
    ].map(value => String(value ?? '')).join('|')}`;
}

function isDuplicate(event) {
    const now = Date.now();
    const key = dedupeKey(event);
    const previous = recentEventIds.get(key);
    const retentionMs = event.eventId ? 10 * 60 * 1000 : 2500;
    if (previous && now - previous < retentionMs) return true;
    recentEventIds.set(key, now);
    if (recentEventIds.size > 2000) {
        for (const [id, timestamp] of recentEventIds) {
            if (now - timestamp > 10 * 60 * 1000) recentEventIds.delete(id);
        }
        while (recentEventIds.size > 2000) recentEventIds.delete(recentEventIds.keys().next().value);
    }
    return false;
}

function resolveGiftRule(event) {
    const exact = giftConfig.byGiftId[String(event.giftId)];
    if (exact) return exact;
    const giftName = normalizeGiftName(event.giftName);
    const named = (giftConfig.byGiftName || []).find(rule =>
        (rule.aliases || []).some(alias => normalizeGiftName(alias) === giftName)
    );
    if (named) return named;
    const value = Number(event.diamondCount) || 0;
    return [...giftConfig.diamondBands]
        .sort((a, b) => b.minimum - a.minimum)
        .find(rule => value >= rule.minimum);
}

function normalizeGiftName(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLocaleLowerCase('vi');
}

function emitGameEvent(event) {
    if (isDuplicate(event)) return;
    const now = Date.now();
    let giftRule = null;
    if (event.type === 'gift') {
        giftRule = event.masterRuleId ? null : resolveGiftRule(event);
        if (giftRule) {
            event.action = giftRule.action;
            event.durationMs = giftRule.durationMs;
            event.label = giftRule.label;
            event.variant = giftRule.variant;
            event.fireworkBursts = giftRule.fireworkBursts;
        }
    }
    if (event.userId && !event.spectatorOnly) {
        const previous = sessionPlayers.get(event.userId) || {};
        const playerState = {
            ...previous,
            userId: event.userId,
            uniqueId: nonEmpty(event.uniqueId, previous.uniqueId || event.userId),
            nickname: nonEmpty(event.nickname, previous.nickname || event.uniqueId || 'TikTok user'),
            avatar: nonEmpty(event.avatar, previous.avatar || ''),
            lastActive: now
        };
        if (event.type === 'gift') {
            playerState.giftPower =
                Math.max(0, Number(previous.giftPower) || 0) +
                Math.max(0, Number(event.diamondCount) || 0);
            if (event.action === 'medal') {
                playerState.titleLabel = event.label;
                playerState.titleVariant = event.variant || 'fire';
                playerState.titleExpiresAt = now + Math.max(3000, Number(event.durationMs) || 60000);
            }
        }
        sessionPlayers.set(event.userId, playerState);
        pruneSessionPlayers(now);
    }
    metrics.events += 1;
    if (event.type === 'member') metrics.members += 1;
    if (event.type === 'chat') metrics.chats += 1;
    if (event.type === 'gift') {
        metrics.gifts += 1;
        metrics.diamonds += event.diamondCount;
        const vip = sessionVipScores.get(event.userId) || {
            userId: event.userId,
            nickname: event.nickname,
            avatar: event.avatar,
            score: 0
        };
        vip.nickname = nonEmpty(event.nickname, vip.nickname || 'TikTok user');
        vip.avatar = nonEmpty(event.avatar, vip.avatar || '');
        vip.score += event.diamondCount;
        sessionVipScores.set(event.userId, vip);
    }
    if (event.type === 'like') metrics.likes += event.likeCount;
    broadcast(event);
    broadcastMetrics();
    voiceService.setLiveViewerCount(sessionPlayers.size);
    voiceService.onGameEvent(event);
}

function processGameEvent(inputEvent) {
    const safeEvent = sanitizeGameEvent(inputEvent);
    if (!safeEvent) return;
    const event = applyBuiltInChatCommand(applyRule(safeEvent, resolveMasterRule(masterConfig, safeEvent)));
    const isTestEvent = Boolean(inputEvent && inputEvent.testEvent === true);
    const testAnimationId = isTestEvent ? String(inputEvent.testAnimationId || '').trim().slice(0, 64) : '';
    const isKnownPlayer = event.userId && sessionPlayers.has(event.userId);
    const joinsByKeyword = event.type === 'chat' && event.action === 'join';
    const joinsBySocial = event.type === 'follow' || event.type === 'share';
    // Joining the live is the same join the "hey" comment rule produces: same
    // action, same spawn path, same welcome shot. Both triggers share the
    // sessionPlayers identity, so joining and then commenting is one player.
    const joinsByMember = event.type === 'member';
    if (joinsByMember && !event.action) event.action = 'join';
    event.joinedNow = Boolean((joinsByKeyword || joinsBySocial || joinsByMember) && !isKnownPlayer);
    if (!isTestEvent && metrics.source !== 'demo' && masterConfig.joinMode === 'keyword_only' && !isKnownPlayer) {
        const joinsByGift = event.type === 'gift' && masterConfig.giftAlwaysJoins;
        event.spectatorOnly = !(joinsByKeyword || joinsByGift || joinsBySocial || joinsByMember);
    }
    // A live test always shows the animation on a real avatar.
    if (isTestEvent) event.spectatorOnly = false;
    if (event.type === 'gift') {
        // A simulated test must never teach the gift catalog a fake gift.
        if (isRealObservedGift(event) && !isTestEvent) {
            learnObservedGift(event);
            broadcast({
                type: 'gift_observed',
                giftId: event.giftId,
                giftName: event.giftName,
                diamondCount: event.unitDiamondCount || Math.round(event.diamondCount / Math.max(1, event.repeatCount || 1)),
                giftPictureUrl: event.giftPictureUrl || ''
            });
        }
    }
    if (event.type === 'gift') {
        // Gift rules decide the action; the mapping only adds an animation on
        // top of it. Catalog ids carry an overlay effect, converted GIF folders
        // carry a character animation the avatar plays itself.
        const target = resolveGiftTarget(giftAnimationMappings, event.giftId, animationRegistry);
        if (target) {
            event.animationId = target.animationId;
            if (target.effect) {
                event.animationEffect = target.effect;
                event.animationDurationMs = target.durationMs;
            }
            if (target.character) {
                event.animationCharacter = target.character;
            }
        }
        // An explicitly chosen test animation wins for this event only; the saved
        // mapping is never modified.
        if (testAnimationId) {
            const override = resolveAnimationTarget(testAnimationId, animationRegistry);
            if (override) {
                event.animationId = override.animationId;
                if (override.effect) {
                    event.animationEffect = override.effect;
                    event.animationDurationMs = override.durationMs;
                    delete event.animationCharacter;
                } else {
                    event.animationCharacter = override.character;
                    delete event.animationEffect;
                    delete event.animationDurationMs;
                }
            }
        }
    }
    emitGameEvent(event);
}

function stopDemo() {
    if (demoTimer) clearInterval(demoTimer);
    demoTimer = null;
    for (const timeout of demoTimeouts) clearTimeout(timeout);
    demoTimeouts.clear();
}

function mockUser(index, manualName = null) {
    return {
        userId: manualName ? manualName : `demo-${index}`,
        uniqueId: manualName ? manualName : `dancer_${index}`,
        nickname: manualName ? manualName : `Dancer ${index}`,
        avatar: ''
    };
}

function emitDemoMember(index, manualName = null) {
    processGameEvent({
        type: 'member',
        action: 'join',
        joinedNow: true,
        eventId: `demo-join-${Date.now()}-${Math.random()}`,
        ...mockUser(index, manualName)
    });
}

function emitDemoAction(action, userIndex = 1, value = 1, giftName = '', manualName = null) {
    const user = mockUser(userIndex, manualName);
    const eventId = `demo-${action}-${Date.now()}-${Math.random()}`;
    if (action === 'member') return emitDemoMember(userIndex, manualName);
    if (action === 'dance') {
        return processGameEvent({ type: 'chat', eventId, ...user, comment: 'dance' });
    }
    if (action === 'jump') {
        return processGameEvent({ type: 'chat', eventId, ...user, comment: 'jump' });
    }
    if (action === 'walk') {
        return processGameEvent({ type: 'chat', eventId, ...user, comment: 'walk' });
    }
    if (action === 'change') {
        return processGameEvent({ type: 'chat', eventId, ...user, comment: 'change' });
    }
    if (action === 'like') {
        return processGameEvent({ type: 'like', eventId, ...user, likeCount: value });
    }
    if (action === 'follow' || action === 'share') {
        return processGameEvent({ type: action, eventId, ...user });
    }
    if (action === 'gift') {
        const demoGiftNames = {
            1: 'Rose',
            5: 'Dance Pop',
            20: 'Camera Star',
            50: 'Fire Crown',
            100: 'VIP Gift',
            200: 'Super VIP',
            500: 'Firework Rain',
            1000: 'Party Universe'
        };
        return processGameEvent({
            type: 'gift',
            eventId,
            ...user,
            giftId: `demo-${value}`,
            giftName: giftName || demoGiftNames[value] || (value >= 100 ? 'Fireworks' : value >= 10 ? 'VIP Gift' : 'Rose'),
            repeatCount: 1,
            diamondCount: value
        });
    }
}

function startDemo(count) {
    stopDemo();
    resetSessionState('demo');
    setStatus('demo', null, `Demo mode: ${count} viewer${count === 1 ? '' : 's'}`);
    broadcast({ type: 'reset' });

    for (let index = 1; index <= count; index += 1) {
        const timeout = setTimeout(() => {
            demoTimeouts.delete(timeout);
            emitDemoMember(index);
        }, index * 35);
        demoTimeouts.add(timeout);
    }

    demoTimer = setInterval(() => {
        const userIndex = 1 + Math.floor(Math.random() * count);
        const roll = Math.random();
        if (roll < 0.45) emitDemoAction('dance', userIndex);
        else if (roll < 0.65) emitDemoAction('walk', userIndex);
        else if (roll < 0.78) emitDemoAction('change', userIndex);
        else if (roll < 0.93) emitDemoAction('like', userIndex, 10);
        else emitDemoAction('gift', userIndex, Math.random() < 0.2 ? 100 : 10);
    }, 700);
}

async function disconnectCurrentConnection() {
    const previous = liveConnection;
    liveConnection = null;
    if (!previous) return;
    try {
        if (typeof previous.disconnect === 'function') await previous.disconnect();
        else if (typeof previous.close === 'function') previous.close();
    } catch (error) {
        console.warn('Không thể đóng kết nối TikTok cũ:', error.message);
    }
}

function cancelReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
}

function scheduleReconnect(username) {
    if (!username || desiredUsername !== username || reconnectTimer) return;
    const delayMs = Math.min(30000, 2000 * (2 ** Math.min(reconnectFailures, 4)));
    reconnectFailures += 1;
    setStatus(
        'reconnecting',
        username,
        LIVE_PROVIDER === 'tikfinity'
            ? `TikFinity Desktop not found. Retrying in ${Math.ceil(delayMs / 1000)}s...`
            : `TikTok disconnected. Reconnecting in ${Math.ceil(delayMs / 1000)}s...`
    );
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (desiredUsername === username) {
            void connectToLiveProvider(username, { resetSession: false, isReconnect: true });
        }
    }, delayMs);
}

async function connectToTikFinity(username, options = {}) {
    const resetSession = options.resetSession !== false;
    const isReconnect = options.isReconnect === true;
    stopDemo();
    cancelReconnect();
    desiredUsername = username;
    const attempt = ++connectionAttempt;
    await disconnectCurrentConnection();

    if (resetSession) {
        resetSessionState('tiktok');
        broadcast({ type: 'reset' });
        broadcastMetrics();
    }
    setStatus(
        isReconnect ? 'reconnecting' : 'connecting',
        username,
        isReconnect ? 'Reconnecting to TikFinity Desktop...' : 'Connecting to TikFinity Desktop...'
    );

    const connection = new WebSocket(TIKFINITY_WS_URL);
    liveConnection = connection;
    const active = () => attempt === connectionAttempt && liveConnection === connection;

    connection.on('open', () => {
        if (!active()) return;
        reconnectFailures = 0;
        setStatus('connected', username, `TikFinity connected for @${username}`);
        broadcastMetrics();
        console.log(`Đã kết nối TikFinity tại ${TIKFINITY_WS_URL}`);
    });
    connection.on('message', payload => {
        if (!active()) return;
        for (const event of normalizeTikFinityMessage(payload)) processGameEvent(event);
    });
    connection.on('error', error => {
        console.warn(`TikFinity WebSocket: ${error.message}`);
    });
    connection.on('close', () => {
        if (!active()) return;
        liveConnection = null;
        scheduleReconnect(username);
    });
}

function connectToLiveProvider(username, options = {}) {
    return LIVE_PROVIDER === 'tikfinity'
        ? connectToTikFinity(username, options)
        : connectToTikTok(username, options);
}

function attachTikTokEvents(connection) {
    const active = () => liveConnection === connection;
    // EventEmitter treats an unhandled `error` event as fatal. Keep the bridge
    // alive and let connect/reconnect report the connection state instead.
    connection.on('error', error => {
        console.warn('TikTok connection error:', error?.message || error);
    });
    connection.on('member', data => active() && processGameEvent(normalizeMember(data)));
    connection.on('chat', data => active() && processGameEvent(normalizeChat(data)));
    connection.on('like', data => active() && processGameEvent(normalizeLike(data)));
    connection.on('follow', data => active() && processGameEvent(normalizeSocial('follow', data)));
    connection.on('share', data => active() && processGameEvent(normalizeSocial('share', data)));
    connection.on('gift', data => {
        if (!active()) return;
        const event = normalizeGift(data);
        if (!isPendingGiftStreak(event)) processGameEvent(event);
    });
}

async function connectToTikTok(username, options = {}) {
    const resetSession = options.resetSession !== false;
    const isReconnect = options.isReconnect === true;
    stopDemo();
    cancelReconnect();
    desiredUsername = username;
    const attempt = ++connectionAttempt;
    await disconnectCurrentConnection();

    if (resetSession) {
        resetSessionState('tiktok');
        broadcast({ type: 'reset' });
        broadcastMetrics();
    }
    setStatus(
        isReconnect ? 'reconnecting' : 'connecting',
        username,
        isReconnect ? `Reconnecting to @${username}...` : `Connecting to @${username}...`
    );
    let connection;
    try {
        connection = new TikTokLiveConnection(username, {
            signApiKey: process.env.EULER_API_KEY || undefined,
            processInitialData: false,
            enableExtendedGiftInfo: false
        });
    } catch (error) {
        liveConnection = null;
        console.error(`Không thể tạo kết nối @${username}:`, error.message);
        setStatus('error', username, `Could not start the TikTok connection: ${error.message}`);
        return;
    }
    liveConnection = connection;
    attachTikTokEvents(connection);

    connection.on('streamEnd', () => {
        if (liveConnection !== connection) return;
        liveConnection = null;
        desiredUsername = null;
        cancelReconnect();
        setStatus('ended', username, `Live @${username} has ended`);
    });
    connection.on('disconnected', () => {
        if (liveConnection !== connection) return;
        liveConnection = null;
        scheduleReconnect(username);
    });

    try {
        const state = await connection.connect();
        if (attempt !== connectionAttempt || liveConnection !== connection) {
            await connection.disconnect().catch(() => {});
            return;
        }
        reconnectFailures = 0;
        setStatus('connected', username, `Connected @${username}`);
        broadcastMetrics();
        console.log(`Đã kết nối @${username}, room ${state.roomId}`);
    } catch (error) {
        if (attempt !== connectionAttempt) return;
        liveConnection = null;
        console.error(`Không thể kết nối @${username}:`, error.message);
        if (desiredUsername === username) scheduleReconnect(username);
    }
}

async function handleClientMessage(ws, message) {
    if (message.type === 'ping') {
        return send(ws, { type: 'pong', timestamp: Date.now() });
    }

    if (message.type === 'register') {
        if (ws.registered) return send(ws, { type: 'error', message: 'Client is already registered.' });
        if (message.role !== 'control' && message.role !== 'overlay') {
            return send(ws, { type: 'error', message: 'Invalid client role.' });
        }
        ws.role = message.role;
        ws.registered = true;
        send(ws, { type: 'config', game: gameConfig, gifts: giftConfig });
        send(ws, { type: 'status', ...connectionStatus });
        send(ws, { type: 'metrics', ...metrics });
        send(ws, { type: 'background_config', action: 'set', background: backgroundPayload() });
        send(ws, { type: 'instruction_config', config: instructionConfig });
        send(ws, { type: 'voice_config', config: voiceService.publicConfig() });
        if (ws.role === 'overlay') send(ws, musicService.configMessage());
        if (ws.role === 'control') send(ws, musicService.getSnapshot());
        if (ws.role === 'control') send(ws, { type: 'voice_status', ...voiceService.getStatus() });
        if (ws.role === 'control') send(ws, { type: 'master_config', master: masterConfig });
        if (ws.role === 'control') send(ws, giftCatalogMessage());
        if (ws.role === 'control') send(ws, giftAnimationsMessage());
        if (ws.role === 'overlay') {
            send(ws, createSnapshot());
            send(ws, viewerGuideMessage());
        }
        return;
    }

    if (!ws.registered) return send(ws, { type: 'error', message: 'Client is not registered.' });

    const controlOnly = message.type === 'master_save' ||
        message.type === 'master_test' ||
        message.type === 'set_gift_animations' ||
        message.type === 'set_instruction_config' ||
        message.type === 'test_gift_stop' ||
        message.type === 'voice_test' ||
        message.type === 'voice_stop' ||
        message.type === 'voice_clear';
    const operatorOnly = new Set([
        'set_username', 'disconnect_tiktok', 'demo_start', 'demo_stop', 'demo_event', 'reset_game'
    ]).has(message.type);
    if (controlOnly && ws.role !== 'control') {
        return send(ws, { type: 'error', message: 'This command is only for the Control panel.' });
    }
    if (operatorOnly && ws.role !== 'control' && !ws.nativeClient) {
        return send(ws, { type: 'error', message: 'Client has no control permission.' });
    }

    if (message.type === 'voice_ack') {
        if (ws.role !== 'overlay') {
            return send(ws, { type: 'error', message: 'Only Unity can acknowledge voice playback.' });
        }
        return voiceService.acknowledge(message);
    }

    if (message.type === 'voice_diagnostics') {
        if (ws.role !== 'overlay') {
            return send(ws, { type: 'error', message: 'Only Unity can report voice diagnostics.' });
        }
        return voiceService.recordUnityDiagnostics(message);
    }

    if (message.type === 'music_ack') {
        if (ws.role !== 'overlay') {
            return send(ws, { type: 'error', message: 'Only Unity can acknowledge music commands.' });
        }
        return musicService.acknowledge(message);
    }

    if (message.type === 'music_state') {
        if (ws.role !== 'overlay') {
            return send(ws, { type: 'error', message: 'Only Unity can report music state.' });
        }
        return musicService.updateActual(message);
    }

    if (message.type === 'animation_ack') {
        if (ws.role !== 'overlay') {
            return send(ws, { type: 'error', message: 'Only Unity can acknowledge animation playback.' });
        }
        const session = activeTestSession;
        const eventId = String(message.eventId || '').slice(0, 120);
        // Acks are only trusted for events this test session actually sent.
        if (!session || !eventId || !session.eventIds.has(eventId)) return;
        const ok = message.ok !== false;
        if (ok) session.acked.add(eventId);
        broadcastToRole('control', {
            type: 'animation_ack',
            confirmed: true,
            sessionId: session.id,
            eventId,
            animationId: String(message.animationId || '').slice(0, 64),
            ok,
            sent: session.sent,
            total: session.total,
            acked: session.acked.size,
            at: Date.now()
        });
        return;
    }

    if (message.type === 'test_gift_stop') {
        if (ws.role !== 'control') {
            return send(ws, { type: 'error', message: 'Only the Control panel may stop a live test.' });
        }
        const summary = stopTestSession('stopped');
        if (!summary) return send(ws, { type: 'test_gift_stopped', message: 'No live test was running.' });
        return;
    }

    if (message.type === 'set_background') {
        if (ws.role !== 'control') {
            return send(ws, { type: 'error', message: 'This command is only for the Control panel.' });
        }
        const result = await applyBackgroundRequest(message.background);
        if (!result.ok) return send(ws, { type: 'error', message: result.error });
        return send(ws, {
            type: 'background_saved',
            background: result.background,
            message: 'Background applied.'
        });
    }

    if (message.type === 'set_instruction_config') {
        if (ws.role !== 'control') {
            return send(ws, { type: 'error', message: 'Only the Control panel may change instructions.' });
        }
        const result = await applyInstructionRequest(message.config);
        if (!result.ok) return send(ws, { type: 'error', message: result.error });
        return send(ws, {
            type: 'instruction_saved',
            config: result.config,
            overlayClients: result.overlayClients,
            message: 'Instructions saved and sent to Unity.'
        });
    }

    if (message.type === 'voice_test') {
        const result = voiceService.queueTest({
            text: message.text,
            username: message.username
        });
        if (!result.accepted) return send(ws, {
            type: 'voice_test_result',
            queued: false,
            message: `Voice test was not queued: ${result.reason}.`
        });
        return send(ws, {
            type: 'voice_test_result',
            queued: true,
            item: result.item,
            message: 'Voice test queued for Unity.'
        });
    }

    if (message.type === 'voice_stop') {
        voiceService.stopCurrent();
        return send(ws, { type: 'voice_stopped', message: 'Voice stopped.' });
    }

    if (message.type === 'voice_clear') {
        const cleared = voiceService.clearQueue();
        return send(ws, { type: 'voice_cleared', cleared, message: `Cleared ${cleared} pending voice line(s).` });
    }

    if (message.type === 'background_ack') {
        if (ws.role !== 'overlay') {
            return send(ws, { type: 'error', message: 'Only Unity can acknowledge a background change.' });
        }
        backgroundAck = {
            file: String(message.file || '').slice(0, 80),
            generation: Number.isInteger(message.generation) ? message.generation : 0,
            ok: message.ok !== false,
            error: typeof message.error === 'string' ? message.error.slice(0, 160) : '',
            width: clampDimension(message.width),
            height: clampDimension(message.height),
            duration: clampDuration(message.duration),
            at: Date.now()
        };
        return broadcastToRole('control', { type: 'background_ack', ...backgroundAck });
    }

    if (message.type === 'master_save') {
        masterConfig = sanitizeMasterConfig(message.master);
        await fs.writeFile(masterConfigPath, `${JSON.stringify(masterConfig, null, 2)}\n`, 'utf8');
        broadcast({ type: 'master_config', master: masterConfig });
        broadcast(viewerGuideMessage());
        return send(ws, { type: 'master_saved', message: 'Master saved and applied.' });
    }

    if (message.type === 'master_test') {
        const rule = masterConfig.rules.find(item => item.id === message.ruleId && item.enabled);
        if (!rule) return send(ws, { type: 'error', message: 'Master rule to test was not found.' });
        const user = { userId: 'master-test', uniqueId: 'master_test', nickname: 'Master Test', avatar: '' };
        if (rule.source === 'chat') {
            return processGameEvent({
                type: 'chat',
                eventId: `master-test-${Date.now()}`,
                ...user,
                comment: rule.trigger.split(',')[0].trim()
            });
        }
        return processGameEvent({
            type: 'gift',
            eventId: `master-test-${Date.now()}`,
            ...user,
            giftId: rule.giftId || `master-${rule.id}`,
            giftName: rule.trigger.split(',')[0].trim() || 'Master Gift',
            repeatCount: 1,
            diamondCount: Math.max(1, Number(message.diamonds) || 1)
        });
    }

    if (message.type === 'set_gift_animations') {
        const result = sanitizeGiftAnimations(message.giftAnimations, { allowedIds: animationRegistry });
        if (result.error) return send(ws, { type: 'error', message: result.error });
        giftAnimationMappings = result.value;
        await saveGiftAnimations(giftAnimationsPath, giftAnimationMappings);
        broadcastToRole('control', giftAnimationsMessage());
        return send(ws, { type: 'gift_animations_saved', message: 'Gift animations saved and applied.' });
    }

    if (message.type === 'set_username') {
        const username = normalizeUsername(message.username);
        if (!username) {
            return send(ws, {
                type: 'error',
                message: 'Username may only contain letters, digits, dots or underscores.'
            });
        }
        return connectToLiveProvider(username);
    }

    if (message.type === 'disconnect_tiktok') {
        desiredUsername = null;
        reconnectFailures = 0;
        cancelReconnect();
        connectionAttempt += 1;
        await disconnectCurrentConnection();
        setStatus('idle', null, 'Disconnected');
        return;
    }

    if (message.type === 'demo_start') {
        desiredUsername = null;
        reconnectFailures = 0;
        cancelReconnect();
        connectionAttempt += 1;
        await disconnectCurrentConnection();
        const count = Math.min(gameConfig.maxPlayers, Math.max(1, Number(message.count) || 20));
        return startDemo(count);
    }
    if (message.type === 'demo_stop') {
        stopDemo();
        setStatus('idle', null, 'Demo stopped');
        return;
    }
    if (message.type === 'demo_event') {
        // The GIF Manager's "Test Live" button reuses this message; the extra
        // fields only add a one-event animation override.
        if (message.animationId) {
            if (ws.role !== 'control') {
                return send(ws, { type: 'error', message: 'Only the Control panel may run a live animation test.' });
            }
            return handleTestGift(ws, message);
        }
        return emitDemoAction(
            String(message.action || 'dance'),
            Math.max(1, Number(message.userIndex) || 1),
            Math.max(1, Number(message.value) || 1),
            String(message.giftName || ''),
            message.manualUsername || null
        );
    }
    if (message.type === 'reset_game') {
        const source = metrics.source;
        const startedAt = metrics.startedAt;
        resetSessionState(source);
        metrics.startedAt = startedAt;
        voiceService.clearQueue();
        voiceService.stopCurrent();
        broadcast({ type: 'reset' });
        broadcastMetrics();
        return;
    }

    send(ws, { type: 'error', message: 'Unsupported command.' });
}

function rejectUpgrade(socket, status = '403 Forbidden') {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
}

server.on('upgrade', (request, socket, head) => {
    const remoteAddress = request.socket.remoteAddress;
    const origin = request.headers.origin || '';
    if ((!ALLOW_LAN && !isLoopbackAddress(remoteAddress)) ||
        !isAllowedHost(request.headers.host, PORT, ALLOW_LAN) ||
        !isAllowedOrigin(origin, PORT)) {
        return rejectUpgrade(socket);
    }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
});

wss.on('connection', (ws, request) => {
    ws.registered = false;
    ws.role = null;
    ws.nativeClient = !request.headers.origin && isLoopbackAddress(request.socket.remoteAddress);
    ws.rateLimit = { windowStartedAt: Date.now(), count: 0 };
    ws.invalidMessages = 0;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    send(ws, { type: 'status', ...connectionStatus });
    ws.on('message', (rawMessage, isBinary) => {
        if (isBinary) return ws.close(1003, 'Text messages only');
        let message;
        try {
            message = JSON.parse(rawMessage.toString());
        } catch {
            ws.invalidMessages += 1;
            if (ws.invalidMessages >= 3) return ws.close(1008, 'Invalid messages');
            return send(ws, { type: 'error', message: 'Invalid payload.' });
        }
        if (!message || typeof message !== 'object' || Array.isArray(message) ||
            typeof message.type !== 'string' || message.type.length > 40) {
            return send(ws, { type: 'error', message: 'Invalid command structure.' });
        }
        // One acknowledgement per broadcast gift is normal overlay traffic, not
        // a command flood; everything else still shares the command rate limit.
        const skipsRateLimit = message.type === 'animation_ack' || message.type === 'voice_ack' ||
            message.type === 'voice_diagnostics' || message.type === 'music_ack' || message.type === 'music_state';
        if (!skipsRateLimit && !consumeRateLimit(ws.rateLimit)) {
            return ws.close(1008, 'Rate limit exceeded');
        }
        void handleClientMessage(ws, message).catch(error => {
            console.error('Không thể xử lý lệnh WebSocket:', error?.message || error);
            send(ws, { type: 'error', message: 'Could not process the command.' });
        });
    });
    ws.on('error', error => console.warn('WebSocket client error:', error.message));
});

const heartbeatTimer = setInterval(() => {
    for (const ws of wss.clients) {
        if (!ws.isAlive) {
            ws.terminate();
            continue;
        }
        ws.isAlive = false;
        ws.ping();
    }
}, 30000);
heartbeatTimer.unref();

server.requestTimeout = 10000;
server.headersTimeout = 5000;
server.keepAliveTimeout = 5000;
server.maxHeadersCount = 64;

refreshInstructionConfig()
    .catch(error => console.error('Could not read instruction config:', error.message))
    .then(() => refreshBackgroundConfig())
    .catch(error => console.error('Không thể đọc cấu hình background:', error.message))
    .then(() => refreshGiftAnimations())
    .catch(error => console.error('Could not read the gift animation mapping:', error.message))
    .then(() => voiceService.start())
    .catch(error => console.error('Could not read the voice configuration:', error.message))
    .then(() => musicService.start())
    .catch(error => console.error('Could not start the music manager:', error.message))
    .finally(() => {
        server.listen(PORT, HOST, () => {
            console.log(`TikTok Live Game: http://${HOST}:${PORT}`);
            console.log(`Bảng điều khiển: http://${HOST}:${PORT}/control.html`);
            const voice = voiceService.getStatus();
            console.log(`[voice] provider=${voice.provider} enabled=${voice.enabled} available=${voice.providerStatus?.available === true}`);
            // Any GIF dropped into assets/gifs becomes a Unity animation on its
            // own; set GIF_AUTOCONVERT=0 to keep the bridge read-only on disk.
            if (process.env.GIF_AUTOCONVERT !== '0') {
                startAutoConversion({ logger: message => console.log(`[gifs] ${message}`) });
            }
        });
    });

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`\n❌ Lỗi: Cổng ${PORT} đang bị chương trình khác chiếm.`);
        console.error(`   Có thể bạn đã chạy server trước đó mà chưa tắt.\n`);
        console.error(`   Cách khắc phục:`);
        console.error(`   1. Tắt cửa sổ cmd/terminal cũ đang chạy server`);
        console.error(`   2. Hoặc chạy lệnh: npx kill-port ${PORT}`);
        console.error(`   3. Nếu chỉ dùng Control Panel, có thể đổi PORT trong file .env.`);
        console.error(`      Bản game dựng sẵn cần PORT=3000.\n`);
        process.exit(1);
    } else {
        console.error('Lỗi server:', err);
        process.exit(1);
    }
});

async function shutdown() {
    stopDemo();
    voiceService.dispose();
    await musicService.stop();
    clearInterval(heartbeatTimer);
    desiredUsername = null;
    cancelReconnect();
    connectionAttempt += 1;
    await disconnectCurrentConnection();
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
