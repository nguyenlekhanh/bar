/* DJ Music Manager — admin-only file/playlist/playback control. */
(function () {
    'use strict';

    const API = '/api/music';
    const HEADERS = { 'x-control-panel': '1' };
    const $ = id => document.getElementById(id);
    const state = {
        snapshot: null,
        busy: false,
        poll: null
    };

    const ui = {
        message: $('music-message'),
        files: $('music-stat-files'),
        playlistCount: $('music-stat-playlist'),
        stateText: $('music-stat-state'),
        unity: $('music-stat-unity'),
        current: $('music-current'),
        currentDetail: $('music-current-detail'),
        badge: $('music-state-badge'),
        progress: $('music-progress-bar'),
        prev: $('music-prev'),
        play: $('music-play'),
        next: $('music-next'),
        refresh: $('music-refresh'),
        shuffle: $('music-shuffle'),
        repeat: $('music-repeat'),
        master: $('music-master-volume'),
        masterValue: $('music-master-value'),
        trackVolume: $('music-track-volume'),
        trackValue: $('music-track-value'),
        file: $('music-file'),
        upload: $('music-upload'),
        libraryRefresh: $('music-library-refresh'),
        library: $('music-library'),
        playlist: $('music-playlist'),
        playlistCountLabel: $('music-playlist-count'),
        diagUnity: $('music-diag-unity'),
        diagVolume: $('music-diag-volume'),
        diagPosition: $('music-diag-position'),
        diagCommand: $('music-diag-command'),
        diagAck: $('music-diag-ack'),
        diagError: $('music-diag-error')
    };

    if (!ui.library || !ui.playlist) return;

    function setMessage(text, error = false) {
        ui.message.textContent = text || '';
        ui.message.style.color = error ? 'var(--danger)' : '';
    }

    async function request(path, options = {}) {
        const response = await fetch(path, {
            cache: 'no-store',
            ...options,
            headers: { ...HEADERS, ...(options.headers || {}) }
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
        return data;
    }

    function formatBytes(bytes) {
        const value = Number(bytes) || 0;
        if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
        if (value >= 1024) return `${Math.round(value / 1024)} KB`;
        return `${value} B`;
    }

    function formatTime(seconds) {
        const total = Math.max(0, Number(seconds) || 0);
        return `${Math.floor(total / 60)}:${String(Math.floor(total % 60)).padStart(2, '0')}`;
    }

    function percent(value) {
        return `${Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 100)}%`;
    }

    function applyPayload(payload) {
        const snapshot = payload?.snapshot || payload;
        if (!snapshot || !Array.isArray(snapshot.library)) return;
        state.snapshot = snapshot;
        render();
    }

    function makeButton(label, className, handler, disabled = false) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = className;
        button.textContent = label;
        button.disabled = disabled;
        button.addEventListener('click', handler);
        return button;
    }

    function currentTrack() {
        const snapshot = state.snapshot;
        if (!snapshot) return '';
        return snapshot.actual?.track || snapshot.current || '';
    }

    function render() {
        const snapshot = state.snapshot;
        if (!snapshot) return;
        const actual = snapshot.actual || {};
        const library = snapshot.library || [];
        const playlist = snapshot.playlist || [];
        const connected = Boolean(snapshot.unityConnected);
        const playing = Boolean(actual.playing);
        const loading = Boolean(actual.loading);
        const track = currentTrack();
        const duration = Number(actual.duration) || 0;
        const position = Number(actual.position) || 0;

        ui.files.textContent = String(library.filter(item => item.valid).length);
        ui.playlistCount.textContent = String(playlist.length);
        ui.stateText.textContent = loading ? 'Loading' : playing ? 'Playing' : actual.paused ? 'Paused' : 'Stopped';
        ui.unity.textContent = connected ? 'Connected' : 'Offline';
        ui.current.textContent = track || 'No track selected';
        ui.currentDetail.textContent = duration > 0
            ? `${formatTime(position)} / ${formatTime(duration)} · ${percent(actual.volume)} actual`
            : 'Waiting for a track to load…';
        ui.badge.textContent = loading ? 'Loading' : playing ? 'Playing' : actual.paused ? 'Paused' : 'Stopped';
        ui.badge.className = `music-badge${playing ? ' is-playing' : ''}`;
        ui.progress.style.width = duration > 0 ? `${Math.min(100, (position / duration) * 100)}%` : '0%';
        ui.play.textContent = playing ? '⏸ Pause' : '▶ Play';
        ui.play.disabled = playlist.length === 0 || state.busy;
        ui.prev.disabled = playlist.length === 0 || state.busy;
        ui.next.disabled = playlist.length === 0 || state.busy;
        ui.shuffle.checked = Boolean(snapshot.shuffle);
        ui.repeat.checked = snapshot.repeat !== false;
        ui.master.value = Number(snapshot.masterVolume) || 0;
        ui.masterValue.textContent = percent(snapshot.masterVolume);
        const trackGain = snapshot.trackVolumes?.[track] ?? 1;
        ui.trackVolume.value = trackGain;
        ui.trackVolume.disabled = !track;
        ui.trackValue.textContent = percent(trackGain);

        ui.diagUnity.textContent = connected ? 'Connected — commands are delivered' : 'Offline — settings are saved locally';
        ui.diagVolume.textContent = `${percent(actual.volume)} actual · ${percent(snapshot.masterVolume)} master`;
        ui.diagPosition.textContent = `${formatTime(position)} / ${formatTime(duration)}`;
        ui.diagCommand.textContent = snapshot.lastCommand
            ? `${snapshot.lastCommand.action} · ${snapshot.lastCommand.track || '—'} · ${snapshot.lastCommand.sent ? 'sent' : 'not sent'}`
            : 'None';
        ui.diagAck.textContent = snapshot.lastAck
            ? `${snapshot.lastAck.ok ? 'OK' : 'Failed'} · ${snapshot.lastAck.commandId || '—'}${snapshot.lastAck.error ? ` · ${snapshot.lastAck.error}` : ''}`
            : 'None';
        ui.diagError.textContent = snapshot.lastError || 'None';

        renderLibrary(library);
        renderPlaylist(playlist);
        if (snapshot.pending?.length) {
            setMessage(`${snapshot.pending.length} new file(s) are still being copied; they will appear after the file size is stable.`);
        }
    }

    function renderLibrary(library) {
        if (!library.length) {
            ui.library.replaceChildren(Object.assign(document.createElement('span'), {
                className: 'muted',
                textContent: 'No supported music files found in DJ_MUSIC.'
            }));
            return;
        }
        ui.library.replaceChildren(...library.map(item => {
            const row = document.createElement('div');
            row.className = `music-row${item.valid ? '' : ' is-invalid'}`;
            const info = document.createElement('div');
            info.className = 'music-row-info';
            const name = document.createElement('span');
            name.className = 'music-row-name';
            name.textContent = item.file;
            const meta = document.createElement('span');
            meta.className = 'music-row-meta';
            meta.textContent = item.valid
                ? `${formatBytes(item.bytes)} · ${(item.mime || '').replace('audio/', '').toUpperCase()}`
                : `⚠ ${item.error || 'Invalid audio file'}`;
            info.append(name, meta);
            const actions = document.createElement('div');
            actions.className = 'music-row-actions';
            actions.append(
                makeButton('▶ Play', 'btn btn-secondary btn-sm', () => sendCommand('play', { track: item.file }), !item.valid || state.busy),
                makeButton('✕ Remove', 'btn btn-danger btn-sm', () => removeFile(item.file), state.busy)
            );
            row.append(info, actions);
            return row;
        }));
    }

    function renderPlaylist(playlist) {
        ui.playlistCountLabel.textContent = `${playlist.length} track${playlist.length === 1 ? '' : 's'}`;
        if (!playlist.length) {
            ui.playlist.replaceChildren(Object.assign(document.createElement('span'), {
                className: 'muted',
                textContent: 'Playlist is empty. Upload a supported audio file or rescan DJ_MUSIC.'
            }));
            return;
        }
        ui.playlist.replaceChildren(...playlist.map((file, index) => {
            const row = document.createElement('div');
            row.className = 'music-row';
            const order = document.createElement('span');
            order.className = 'music-row-order';
            order.textContent = String(index + 1);
            const info = document.createElement('div');
            info.className = 'music-row-info';
            const name = document.createElement('span');
            name.className = 'music-row-name';
            name.textContent = file;
            if (file === currentTrack()) name.classList.add('is-current');
            const meta = document.createElement('span');
            meta.className = 'music-row-meta';
            meta.textContent = file === currentTrack() ? 'Current track' : 'Queued';
            info.append(name, meta);
            const actions = document.createElement('div');
            actions.className = 'music-row-actions';
            actions.append(
                makeButton('↑', 'btn btn-secondary btn-sm music-icon-btn', () => reorder(index, -1), index === 0 || state.busy),
                makeButton('↓', 'btn btn-secondary btn-sm music-icon-btn', () => reorder(index, 1), index === playlist.length - 1 || state.busy),
                makeButton('▶', 'btn btn-secondary btn-sm music-icon-btn', () => sendCommand('play', { track: file }), state.busy)
            );
            row.append(order, info, actions);
            return row;
        }));
    }

    async function refresh() {
        try {
            const payload = await request(API);
            applyPayload(payload);
        } catch (error) {
            setMessage(`Could not read the music library: ${error.message}`, true);
        }
    }

    async function sendCommand(action, extra = {}) {
        state.busy = true;
        try {
            const result = await request(`${API}/command`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action, ...extra })
            });
            applyPayload(result);
            setMessage(result.message || `Music command ${action} accepted.`, result.sent === false);
        } catch (error) {
            setMessage(error.message, true);
        } finally {
            state.busy = false;
            if (state.snapshot) render();
        }
    }

    async function setSettings(settings) {
        try {
            const result = await request(API, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(settings)
            });
            applyPayload(result);
            setMessage('Music settings saved.');
        } catch (error) {
            setMessage(error.message, true);
        }
    }

    async function reorder(index, direction) {
        const playlist = [...(state.snapshot?.playlist || [])];
        const target = index + direction;
        if (target < 0 || target >= playlist.length) return;
        [playlist[index], playlist[target]] = [playlist[target], playlist[index]];
        await setSettings({ playlist });
    }

    async function removeFile(file) {
        if (!window.confirm(`Remove "${file}" from DJ_MUSIC? This deletes the file from disk.`)) return;
        state.busy = true;
        try {
            const result = await request(`${API}/remove`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ file })
            });
            applyPayload(result);
            setMessage(result.message || 'Music file removed.');
        } catch (error) {
            setMessage(error.message, true);
        } finally {
            state.busy = false;
            if (state.snapshot) render();
        }
    }

    async function uploadFiles() {
        const files = [...(ui.file.files || [])];
        if (!files.length) return setMessage('Choose one or more MP3, WAV or OGG files first.', true);
        state.busy = true;
        ui.upload.disabled = true;
        try {
            for (const file of files) {
                setMessage(`Uploading ${file.name}…`);
                const result = await request(`${API}/upload?name=${encodeURIComponent(file.name)}`, {
                    method: 'POST',
                    headers: { 'Content-Type': file.type || 'application/octet-stream' },
                    body: file
                });
                applyPayload(result);
            }
            ui.file.value = '';
            setMessage('Music upload complete.');
        } catch (error) {
            setMessage(error.message, true);
        } finally {
            state.busy = false;
            ui.upload.disabled = false;
            if (state.snapshot) render();
        }
    }

    let volumeTimer = null;
    ui.master.addEventListener('input', () => {
        ui.masterValue.textContent = percent(ui.master.value);
    });
    ui.master.addEventListener('change', () => {
        clearTimeout(volumeTimer);
        volumeTimer = setTimeout(() => setSettings({ volume: Number(ui.master.value) }), 150);
    });
    ui.trackVolume.addEventListener('input', () => {
        ui.trackValue.textContent = percent(ui.trackVolume.value);
    });
    ui.trackVolume.addEventListener('change', () => {
        const track = currentTrack();
        if (track) sendCommand('set_track_volume', { track, trackVolume: Number(ui.trackVolume.value) });
    });

    ui.play.addEventListener('click', () => sendCommand(state.snapshot?.actual?.playing ? 'pause' : 'play'));
    ui.prev.addEventListener('click', () => sendCommand('previous'));
    ui.next.addEventListener('click', () => sendCommand('next'));
    ui.refresh.addEventListener('click', () => sendCommand('rescan'));
    ui.libraryRefresh.addEventListener('click', refresh);
    ui.upload.addEventListener('click', uploadFiles);
    ui.shuffle.addEventListener('change', () => setSettings({ shuffle: ui.shuffle.checked }));
    ui.repeat.addEventListener('change', () => setSettings({ repeat: ui.repeat.checked }));

    if (window.controlBridge) {
        window.controlBridge.onMessage(message => {
            if (message.type === 'music_state') applyPayload(message);
            if (message.type === 'music_ack') {
                setMessage(message.ok === false ? `Unity rejected the music command: ${message.error || 'unknown error'}` : 'Unity confirmed the music command.', message.ok === false);
            }
        });
    }

    refresh();
    // WebSocket updates are primary; this bounded poll recovers after a
    // reconnect or a dropped state broadcast without flooding the bridge.
    state.poll = setInterval(() => {
        if (document.getElementById('tab-music')?.classList.contains('active')) refresh();
    }, 5000);
})();
