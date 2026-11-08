'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {
    MAX_UPLOAD_BYTES,
    clampVolume,
    defaultMusicState,
    isSupportedAudio,
    safeMusicPath,
    sanitizeMusicState,
    sanitizePlaylist,
    sanitizeTrackVolumes,
    scanMusicFolder,
    validateAudioBuffer,
    validateFileName
} = require('./library');

const COMMANDS = new Set([
    'play', 'pause', 'stop', 'next', 'previous', 'load', 'settings',
    'set_volume', 'set_shuffle', 'set_repeat', 'set_track_volume', 'rescan'
]);

function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function atomicWrite(file, contents) {
    const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    return fs.writeFile(temporary, contents, 'utf8')
        .then(() => fs.rename(temporary, file))
        .catch(async error => {
            await fs.rm(temporary, { force: true }).catch(() => {});
            throw error;
        });
}

async function readVolumeFile(folder, fallback) {
    try {
        const raw = (await fs.readFile(path.join(folder, 'VOLUME.txt'), 'utf8')).trim().replace(',', '.');
        let value = Number(raw);
        if (!Number.isFinite(value)) return fallback;
        if (value > 1) value /= 100;
        return clampVolume(value, fallback);
    } catch {
        return fallback;
    }
}

/**
 * Owns the DJ_MUSIC catalogue and the playback *intent*. Unity remains the
 * only audio engine; this service sends commands and records the state Unity
 * reports, so the panel never invents a current track or a playback state.
 */
function createMusicService({
    musicDir,
    statePath,
    broadcastToRole,
    getOverlayCount = () => 0,
    logger = console,
    scanIntervalMs = 1500,
    stableMs = 700
} = {}) {
    if (!musicDir) throw new Error('A DJ_MUSIC directory is required.');
    if (!statePath) throw new Error('A music state path is required.');
    if (typeof broadcastToRole !== 'function') throw new Error('Music service requires broadcastToRole.');

    let settings = defaultMusicState();
    let library = [];
    let pending = [];
    let libraryExists = true;
    let actual = {
        playing: false,
        paused: false,
        loading: false,
        track: '',
        position: 0,
        duration: 0,
        volume: 0,
        shuffle: false,
        repeat: true,
        error: ''
    };
    let lastAck = null;
    let lastError = '';
    let lastCommand = null;
    let lastCommandKey = '';
    let lastCommandAt = 0;
    let commandSequence = 0;
    let revision = 0;
    let started = false;
    let stateLoaded = false;
    let scanTimer = null;
    let saveTimer = null;
    let savePromise = Promise.resolve();
    let lastScanError = '';
    let lastScanAt = 0;
    let lastEmittedSignature = '';
    const seen = new Map();

    const validLibrary = () => library.filter(item => item.valid);
    const validPlaylist = () => settings.playlist.filter(file => validLibrary().some(item => item.file === file));

    function trackVolume(file) {
        return settings.trackVolumes[file] ?? 1;
    }

    function trackVolumeArrays() {
        const names = Object.keys(settings.trackVolumes).filter(file => isSupportedAudio(file));
        return {
            trackVolumeNames: names,
            trackVolumeValues: names.map(file => settings.trackVolumes[file])
        };
    }

    function baseConfig() {
        return {
            playlist: settings.playlist.slice(),
            current: settings.current,
            shuffle: settings.shuffle,
            repeat: settings.repeat,
            masterVolume: settings.volume,
            playbackPreference: settings.playbackPreference,
            ...trackVolumeArrays(),
            revision
        };
    }

    function configMessage() {
        return { type: 'music_config', ...baseConfig() };
    }

    function snapshot() {
        return {
            type: 'music_state',
            library: library.slice(),
            pending: pending.slice(),
            playlist: settings.playlist.slice(),
            current: settings.current,
            actual: { ...actual },
            shuffle: settings.shuffle,
            repeat: settings.repeat,
            masterVolume: settings.volume,
            masterVolumeActual: actual.volume,
            playbackPreference: settings.playbackPreference,
            trackVolumes: { ...settings.trackVolumes },
            unityConnected: getOverlayCount() > 0,
            libraryExists,
            lastAck,
            lastError,
            lastCommand,
            lastScanError,
            lastScanAt,
            revision,
            updatedAt: Date.now()
        };
    }

    function stateSignature() {
        return JSON.stringify({
            library: library.map(item => [item.file, item.valid, item.bytes, item.error]),
            pending,
            playlist: settings.playlist,
            current: settings.current,
            actual,
            shuffle: settings.shuffle,
            repeat: settings.repeat,
            volume: settings.volume,
            trackVolumes: settings.trackVolumes,
            lastAck,
            lastError,
            revision
        });
    }

    function emitState(force = false) {
        const signature = stateSignature();
        if (!force && signature === lastEmittedSignature) return;
        lastEmittedSignature = signature;
        broadcastToRole('control', snapshot());
    }

    function emitConfig() {
        broadcastToRole('overlay', configMessage());
    }

    function saveNow() {
        if (saveTimer) {
            clearTimeout(saveTimer);
            saveTimer = null;
        }
        const payload = {
            version: 1,
            playlist: settings.playlist.slice(),
            current: settings.current,
            shuffle: settings.shuffle,
            repeat: settings.repeat,
            volume: settings.volume,
            trackVolumes: { ...settings.trackVolumes },
            playbackPreference: settings.playbackPreference
        };
        savePromise = savePromise
            .catch(() => {})
            .then(async () => {
                await fs.mkdir(path.dirname(statePath), { recursive: true });
                await atomicWrite(statePath, `${JSON.stringify(payload, null, 2)}\n`);
            })
            .catch(error => {
                lastError = `Could not save music settings: ${error.message}`;
                logger.warn?.(`[music] ${lastError}`);
            });
        return savePromise;
    }

    function scheduleSave() {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            saveTimer = null;
            void saveNow();
        }, 250);
        saveTimer.unref?.();
    }

    async function writeVolumeFile() {
        try {
            await fs.mkdir(musicDir, { recursive: true });
            const temporary = path.join(musicDir, `.VOLUME.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`);
            await fs.writeFile(temporary, `${settings.volume.toFixed(2)}\n`, 'utf8');
            await fs.rename(temporary, path.join(musicDir, 'VOLUME.txt'));
        } catch (error) {
            lastError = `Could not update VOLUME.txt: ${error.message}`;
            logger.warn?.(`[music] ${lastError}`);
        }
    }

    async function applyScan(initial = false, forceStable = false) {
        try {
            const result = await scanMusicFolder(musicDir, {
                seen,
                initial,
                force: forceStable,
                stableMs
            });
            library = result.library;
            pending = result.pending;
            libraryExists = result.exists;
            lastScanAt = Date.now();
            lastScanError = '';
            if (!result.exists) {
                // A temporarily missing/moved folder must not erase the saved
                // playlist. Keep the order ready for when DJ_MUSIC returns.
                emitState(true);
                return { ok: true, library, pending, playlist: settings.playlist };
            }

            const available = new Set(validLibrary().map(item => item.file));
            let playlist = settings.playlist.filter(file => available.has(file));
            for (const item of validLibrary()) {
                if (!playlist.includes(item.file)) playlist.push(item.file);
            }
            const playlistChanged = playlist.length !== settings.playlist.length ||
                playlist.some((file, index) => file !== settings.playlist[index]);
            settings.playlist = playlist;

            // Drop values for deleted tracks, but keep the persisted order.
            const oldVolumeKeys = Object.keys(settings.trackVolumes);
            settings.trackVolumes = sanitizeTrackVolumes(settings.trackVolumes, available);
            const volumeKeysChanged = oldVolumeKeys.length !== Object.keys(settings.trackVolumes).length;

            let currentChanged = false;
            if (!settings.current || !available.has(settings.current)) {
                const next = playlist[0] || '';
                if (settings.current !== next) {
                    settings.current = next;
                    currentChanged = true;
                }
            }
            if (actual.track && !available.has(actual.track)) {
                actual.track = '';
                actual.playing = false;
                actual.paused = false;
                actual.position = 0;
                actual.duration = 0;
                actual.error = 'The current track was removed.';
            }

            if (playlistChanged || currentChanged) {
                revision += 1;
                scheduleSave();
                emitConfig();
            }
            if (volumeKeysChanged) scheduleSave();
            emitState();
            if (initial) emitConfig();
            return { ok: true, library, pending, playlist: settings.playlist };
        } catch (error) {
            lastScanError = error.message;
            lastError = `Could not scan DJ_MUSIC: ${error.message}`;
            logger.warn?.(`[music] ${lastError}`);
            emitState(true);
            return { ok: false, error: lastError };
        }
    }

    function selectNext(direction = 1, source = settings.current) {
        const playlist = validPlaylist();
        if (!playlist.length) return null;
        if (settings.shuffle && playlist.length > 1) {
            const candidates = playlist.filter(file => file !== source);
            return candidates[Math.floor(Math.random() * candidates.length)] || null;
        }
        const currentIndex = playlist.indexOf(source);
        let index;
        if (currentIndex < 0) {
            index = direction > 0 ? 0 : playlist.length - 1;
        } else {
            index = currentIndex + direction;
            if (index >= playlist.length || index < 0) {
                if (!settings.repeat) return null;
                index = (index + playlist.length) % playlist.length;
            }
        }
        return playlist[index] || null;
    }

    function commandPayload(action, target, extra = {}) {
        return {
            type: 'music_command',
            commandId: '',
            action,
            track: target || settings.current || '',
            ...baseConfig(),
            ...extra
        };
    }

    function sendCommand(action, target = '', extra = {}) {
        const key = `${action}:${target}`;
        const now = Date.now();
        // A double-click or two panel tabs must not start the same transition
        // twice. Reuse the previous command id for an identical quick click.
        if (action !== 'settings' && action !== 'set_volume' && key === lastCommandKey && now - lastCommandAt < 250) {
            return {
                ok: true,
                sent: Boolean(lastCommand?.sent),
                duplicate: true,
                commandId: lastCommand?.commandId || '',
                message: 'The same music command was already sent.'
            };
        }
        const commandId = `music-${now.toString(36)}-${++commandSequence}`;
        const payload = commandPayload(action, target, extra);
        payload.commandId = commandId;
        const connected = getOverlayCount() > 0;
        if (connected) broadcastToRole('overlay', payload);
        lastCommand = {
            commandId,
            action,
            track: target || settings.current || '',
            sent: connected,
            at: now
        };
        lastCommandKey = key;
        lastCommandAt = now;
        if (!connected) lastError = 'No Unity overlay is connected; the setting was saved locally.';
        return {
            ok: true,
            sent: connected,
            commandId,
            duplicate: false,
            message: connected
                ? `Sent ${action} to Unity.`
                : 'No Unity overlay is connected; the setting was saved locally.'
        };
    }

    async function command(action, input = {}) {
        const normalized = String(action || '').toLowerCase();
        if (!COMMANDS.has(normalized)) return { ok: false, error: `Unknown music command: ${action}.` };
        if (normalized === 'rescan') {
            const result = await applyScan(false, true);
            if (!result.ok) return result;
            emitConfig();
            emitState(true);
            return { ok: true, message: 'DJ_MUSIC rescanned.', snapshot: snapshot() };
        }
        if (normalized === 'set_shuffle') {
            settings.shuffle = input.shuffle === true;
            scheduleSave();
            const result = sendCommand('settings', settings.current);
            emitState(true);
            return { ...result, snapshot: snapshot() };
        }
        if (normalized === 'set_repeat') {
            settings.repeat = input.repeat !== false;
            scheduleSave();
            const result = sendCommand('settings', settings.current);
            emitState(true);
            return { ...result, snapshot: snapshot() };
        }
        if (normalized === 'set_volume') {
            settings.volume = clampVolume(input.masterVolume ?? input.volume, settings.volume);
            scheduleSave();
            await writeVolumeFile();
            const result = sendCommand('volume', settings.current, { masterVolume: settings.volume });
            emitState(true);
            return { ...result, snapshot: snapshot() };
        }
        if (normalized === 'set_track_volume') {
            const track = input.track || settings.current;
            const checked = validateFileName(track);
            if (checked.error) return { ok: false, error: checked.error };
            if (!validPlaylist().includes(checked.value)) return { ok: false, error: 'That track is not in the current playlist.' };
            const value = Math.max(0, Math.min(1, finite(input.trackVolume, 1)));
            settings.trackVolumes[checked.value] = value;
            scheduleSave();
            const result = sendCommand('volume', settings.current, {
                track: checked.value,
                trackVolume: value,
                ...trackVolumeArrays()
            });
            emitState(true);
            return { ...result, snapshot: snapshot() };
        }
        if (normalized === 'pause') {
            settings.playbackPreference = 'paused';
            scheduleSave();
            const result = sendCommand('pause');
            emitState(true);
            return { ...result, snapshot: snapshot() };
        }
        if (normalized === 'play') {
            const target = input.track ? validateFileName(input.track) : null;
            if (target?.error) return { ok: false, error: target.error };
            const track = target?.value || settings.current || validPlaylist()[0];
            if (!track || !validPlaylist().includes(track)) return { ok: false, error: 'There is no playable track in DJ_MUSIC.' };
            settings.current = track;
            settings.playbackPreference = 'playing';
            scheduleSave();
            const result = sendCommand('play', track);
            emitState(true);
            return { ...result, snapshot: snapshot() };
        }
        if (normalized === 'load') {
            const target = validateFileName(input.track);
            if (target.error || !validPlaylist().includes(target.value)) {
                return { ok: false, error: target.error || 'That track is not in the current playlist.' };
            }
            settings.current = target.value;
            settings.playbackPreference = 'playing';
            scheduleSave();
            const result = sendCommand('load', target.value);
            emitState(true);
            return { ...result, snapshot: snapshot() };
        }
        if (normalized === 'next' || normalized === 'previous') {
            const target = selectNext(normalized === 'next' ? 1 : -1);
            if (!target) return { ok: false, error: normalized === 'next' ? 'End of playlist.' : 'Start of playlist.' };
            settings.current = target;
            settings.playbackPreference = 'playing';
            scheduleSave();
            const result = sendCommand('play', target);
            emitState(true);
            return { ...result, snapshot: snapshot() };
        }
        if (normalized === 'stop') {
            settings.playbackPreference = 'paused';
            scheduleSave();
            const result = sendCommand('stop');
            emitState(true);
            return { ...result, snapshot: snapshot() };
        }
        const result = sendCommand('settings', settings.current);
        emitState(true);
        return { ...result, snapshot: snapshot() };
    }

    async function updateSettings(input = {}) {
        const source = input.config && typeof input.config === 'object' ? input.config : input;
        let changed = false;
        if (Object.prototype.hasOwnProperty.call(source, 'volume') ||
            Object.prototype.hasOwnProperty.call(source, 'masterVolume')) {
            settings.volume = clampVolume(source.masterVolume ?? source.volume, settings.volume);
            changed = true;
            await writeVolumeFile();
        }
        if (Object.prototype.hasOwnProperty.call(source, 'shuffle')) {
            settings.shuffle = source.shuffle === true;
            changed = true;
        }
        if (Object.prototype.hasOwnProperty.call(source, 'repeat')) {
            settings.repeat = source.repeat !== false;
            changed = true;
        }
        if (Object.prototype.hasOwnProperty.call(source, 'trackVolumes')) {
            settings.trackVolumes = sanitizeTrackVolumes(source.trackVolumes, new Set(validLibrary().map(item => item.file)));
            changed = true;
        }
        if (Array.isArray(source.playlist)) {
            const available = new Set(validLibrary().map(item => item.file));
            const requested = sanitizePlaylist(source.playlist, available);
            // The catalogue is authoritative: any valid file omitted by a
            // reorder request is appended rather than silently removed.
            for (const item of validLibrary()) {
                if (!requested.includes(item.file)) requested.push(item.file);
            }
            settings.playlist = requested;
            changed = true;
        }
        if (typeof source.current === 'string') {
            const checked = validateFileName(source.current);
            if (!checked.error && settings.playlist.includes(checked.value)) {
                settings.current = checked.value;
                changed = true;
            }
        }
        if (!settings.current && settings.playlist.length) settings.current = settings.playlist[0];
        if (changed) {
            scheduleSave();
            revision += 1;
            emitConfig();
            sendCommand('settings', settings.current);
            emitState(true);
        }
        return { ok: true, snapshot: snapshot(), changed };
    }

    async function upload(name, buffer) {
        const checked = validateAudioBuffer(buffer, name);
        if (checked.error) return { ok: false, error: checked.error };
        const safe = safeMusicPath(musicDir, checked.value);
        if (safe.error) return { ok: false, error: safe.error };
        await fs.mkdir(musicDir, { recursive: true });
        try {
            await fs.access(safe.absolute);
            return { ok: false, error: 'A music file with that name already exists.', conflict: true };
        } catch {
            // Expected: the destination does not exist yet.
        }

        const temporary = path.join(musicDir, `.music-upload-${process.pid}-${crypto.randomBytes(5).toString('hex')}.tmp`);
        try {
            await fs.writeFile(temporary, buffer, { flag: 'wx' });
            await fs.rename(temporary, safe.absolute);
        } catch (error) {
            await fs.rm(temporary, { force: true }).catch(() => {});
            return { ok: false, error: `Could not save the music file: ${error.message}` };
        }

        const result = await applyScan(false, true);
        if (!result.ok) return result;
        if (!settings.playlist.includes(checked.value)) settings.playlist.push(checked.value);
        if (!settings.current) settings.current = checked.value;
        revision += 1;
        scheduleSave();
        emitConfig();
        emitState(true);
        return { ok: true, file: checked.value, snapshot: snapshot() };
    }

    async function remove(file) {
        const safe = safeMusicPath(musicDir, file);
        if (safe.error) return { ok: false, error: safe.error };
        try {
            await fs.unlink(safe.absolute);
        } catch (error) {
            if (error.code === 'ENOENT') return { ok: false, error: 'The music file no longer exists.' };
            return { ok: false, error: `Could not remove the music file: ${error.message}` };
        }

        const wasCurrent = settings.current === safe.file;
        const wasPlaying = actual.playing && actual.track === safe.file;
        await applyScan(false, true);
        const next = settings.current || validPlaylist()[0] || '';
        settings.current = next;
        if (wasCurrent || !next) {
            settings.playbackPreference = next ? settings.playbackPreference : 'paused';
            revision += 1;
            scheduleSave();
        }
        if (wasPlaying && next) sendCommand('play', next);
        else emitConfig();
        emitState(true);
        return { ok: true, file: safe.file, snapshot: snapshot(), switchedTo: wasPlaying ? next : '' };
    }

    async function start() {
        if (started) return snapshot();
        started = true;
        settings = defaultMusicState();
        try {
            const raw = await fs.readFile(statePath, 'utf8');
            const parsed = JSON.parse(raw);
            settings = sanitizeMusicState(parsed, null);
            stateLoaded = true;
        } catch (error) {
            if (error.code !== 'ENOENT') {
                lastError = `Could not read saved music settings: ${error.message}`;
                logger.warn?.(`[music] ${lastError}`);
            }
        }
        if (!stateLoaded) settings.volume = await readVolumeFile(musicDir, settings.volume);
        // An initial scan includes existing, fully-copied files. The normal
        // scan then waits for a file's size to remain unchanged before listing
        // a new copy.
        await applyScan(true, true);
        scanTimer = setInterval(() => { void applyScan(false, false); }, Math.max(250, scanIntervalMs));
        scanTimer.unref?.();
        return snapshot();
    }

    async function stop() {
        if (scanTimer) clearInterval(scanTimer);
        scanTimer = null;
        if (saveTimer) {
            clearTimeout(saveTimer);
            saveTimer = null;
        }
        await saveNow();
        started = false;
    }

    return {
        start,
        stop,
        command,
        updateSettings,
        upload,
        remove,
        applyScan,
        getSnapshot: snapshot,
        configMessage,
        acknowledge(message) {
            if (!message || typeof message !== 'object') return;
            lastAck = {
                commandId: String(message.commandId || '').slice(0, 80),
                ok: message.ok !== false,
                error: String(message.error || '').slice(0, 200),
                at: Date.now()
            };
            if (lastAck.ok) lastError = '';
            else lastError = lastAck.error || 'Unity reported a music error.';
            if (typeof message.track === 'string') {
                const checked = validateFileName(message.track);
                if (!checked.error && settings.playlist.includes(checked.value)) settings.current = checked.value;
            }
            if (typeof message.playing === 'boolean') {
                settings.playbackPreference = message.playing ? 'playing' : 'paused';
                scheduleSave();
            }
            emitState(true);
        },
        updateActual(message) {
            if (!message || typeof message !== 'object') return;
            const checked = typeof message.track === 'string' ? validateFileName(message.track) : { error: 'missing' };
            const track = checked.error ? '' : checked.value;
            const trackIsKnown = track && settings.playlist.includes(track);
            actual = {
                playing: message.playing === true,
                paused: message.paused === true,
                loading: message.loading === true,
                track: trackIsKnown ? track : (actual.track || ''),
                position: Math.max(0, finite(message.position)),
                duration: Math.max(0, finite(message.duration)),
                volume: clampVolume(message.musicVolume ?? message.volume, actual.volume),
                shuffle: typeof message.shuffle === 'boolean' ? message.shuffle : settings.shuffle,
                repeat: typeof message.repeat === 'boolean' ? message.repeat : settings.repeat,
                error: String(message.error || '').slice(0, 200)
            };
            if (trackIsKnown) {
                settings.current = track;
                if (message.playing === true) settings.playbackPreference = 'playing';
                else if (message.playing === false) settings.playbackPreference = 'paused';
                scheduleSave();
            }
            if (actual.error) lastError = actual.error;
            emitState(true);
        },
        get revision() { return revision; },
        __test: { settings: () => ({ ...settings }), seen, applyScan }
    };
}

module.exports = {
    COMMANDS,
    createMusicService,
    MAX_UPLOAD_BYTES
};
