/* ─────────────────────────────────────────────────────────
   TikTok Live — Control Panel JS
   © 2026 TikTok Live — xxx.com
   Zalo: xxx | Website: https://xxx.com
───────────────────────────────────────────────────────── */

/* ═══ TAB NAVIGATION ════════════════════════════════════ */
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('tab-' + btn.dataset.tab)?.classList.add('active');
    });
});

/* ═══ UI ELEMENT REFS ════════════════════════════════════ */
const ui = {
    // Navbar status
    statusDot:      document.getElementById('status-dot'),
    statusTitle:    document.getElementById('status-title'),
    // Card status (tab live)
    statusCardDot:  document.getElementById('status-card-dot'),
    statusTitleCard:document.getElementById('status-title-card'),
    statusMessage:  document.getElementById('status-message'),
    // Live tab
    username:       document.getElementById('username'),
    connect:        document.getElementById('connect'),
    disconnect:     document.getElementById('disconnect'),
    // Test lab
    stopDemo:       document.getElementById('stop-demo'),
    // Session
    reset:          document.getElementById('reset'),
    // Events
    userIndex:      document.getElementById('user-index'),
    // Rules
    joinMode:       document.getElementById('join-mode'),
    giftAlwaysJoins:document.getElementById('gift-always-joins'),
    masterRules:    document.getElementById('master-rules'),
    masterRuleTemplate: document.getElementById('master-rule-template'),
    addMasterRule:  document.getElementById('add-master-rule'),
    saveMaster:     document.getElementById('save-master'),
    masterMessage:  document.getElementById('master-message'),
    recentGifts:    document.getElementById('recent-gifts'),
    // Background manager
    bgList:         document.getElementById('bg-list'),
    bgPreview:      document.getElementById('bg-preview'),
    bgCurrentName:  document.getElementById('bg-current-name'),
    bgCurrentDetail:document.getElementById('bg-current-detail'),
    bgStatus:       document.getElementById('bg-status'),
    bgMessage:      document.getElementById('bg-message'),
    bgFit:          document.getElementById('bg-fit'),
    bgRefresh:      document.getElementById('bg-refresh'),
    bgDefault:      document.getElementById('bg-default'),
    bgTransform:    document.getElementById('bg-transform'),
    bgFlipH:        document.getElementById('bg-flip-h'),
    bgFlipV:        document.getElementById('bg-flip-v'),
    bgTransformApply: document.getElementById('bg-transform-apply'),
    bgTransformReset: document.getElementById('bg-transform-reset'),
    bgTransformCurrent: document.getElementById('bg-transform-current'),
    bgTransformHint: document.getElementById('bg-transform-hint'),
    metrics: {
        events:   document.getElementById('metric-events'),
        members:  document.getElementById('metric-members'),
        chats:    document.getElementById('metric-chats'),
        gifts:    document.getElementById('metric-gifts'),
        diamonds: document.getElementById('metric-diamonds'),
        likes:    document.getElementById('metric-likes'),
    },
};

/* ═══ STATE ══════════════════════════════════════════════ */
let socket;
let reconnectTimer;
let masterConfig = { joinMode: 'keyword_only', giftAlwaysJoins: true, rules: [] };
const recentGifts = new Map();

/* ═══ WEBSOCKET ══════════════════════════════════════════ */
function send(message) {
    if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
    }
}

function setStatus(data) {
    const state = data.state || '';
    ui.statusDot.className = 'status-dot ' + state;
    if (ui.statusCardDot) ui.statusCardDot.className = 'status-card-dot ' + state;

    const names = {
        idle:         'Ready',
        connecting:   'Connecting…',
        connected:    '🔴 LIVE',
        demo:         '🧪 DEMO',
        disconnected: 'Disconnected',
        ended:        'Live ended',
        error:        'Connection error',
    };
    const label = names[state] || state;
    ui.statusTitle.textContent = label;
    if (ui.statusTitleCard) ui.statusTitleCard.textContent = label;
    if (ui.statusMessage)   ui.statusMessage.textContent = data.message || '';
    ui.connect.disabled = state === 'connecting';

    // Pulse the badge while a real LIVE is running
    const liveBadge = document.getElementById('live-badge');
    if (liveBadge) liveBadge.classList.toggle('is-live', state === 'connected');
}

function setMetrics(data) {
    for (const [key, el] of Object.entries(ui.metrics)) {
        el.textContent = Number(data[key] || 0).toLocaleString('en-US');
    }
}

/* ═══ MASTER RULES ═══════════════════════════════════════ */
function makeRuleId() {
    return `rule-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function emptyRule(overrides = {}) {
    return {
        id: makeRuleId(), enabled: true, source: 'gift', trigger: '',
        giftId: '', match: 'exact', action: 'dance', displayDiamonds: 0,
        durationMs: 3000, label: '', variant: '', fireworkBursts: 0, ...overrides,
    };
}

function setMasterMessage(msg, error = false) {
    ui.masterMessage.textContent = msg || '';
    ui.masterMessage.classList.toggle('error', error);
}

function updateRuleSource(row) {
    const source  = row.querySelector('[data-field="source"]').value;
    const giftId  = row.querySelector('[data-field="giftId"]');
    giftId.disabled     = source !== 'gift';
    giftId.placeholder  = source === 'gift' ? 'ID (if any)' : 'Not used for chat';

    // Update the left border and badge colour by source type
    row.dataset.src = source;
    const badge = row.querySelector('[data-src-label]');
    if (badge) {
        badge.textContent = source === 'gift' ? 'GIFT' : 'CHAT';
        badge.className   = `src-badge ${source}`;
    }
}

function createRuleRow(rule) {
    const row = ui.masterRuleTemplate.content.firstElementChild.cloneNode(true);
    row.dataset.ruleId = rule.id || makeRuleId();
    for (const input of row.querySelectorAll('[data-field]')) {
        const field = input.dataset.field;
        if (field === 'durationSeconds') input.value = (Number(rule.durationMs) || 0) / 1000;
        else if (input.type === 'checkbox') input.checked = rule[field] !== false;
        else input.value = rule[field] ?? '';
    }
    row.querySelector('[data-field="source"]').addEventListener('change', () => updateRuleSource(row));
    row.querySelector('[data-command="delete"]').addEventListener('click', () => row.remove());
    row.querySelector('[data-command="test"]').addEventListener('click', () => {
        const config = readMasterFromUi();
        send({ type: 'master_save', master: config });
        send({ type: 'master_test', ruleId: row.dataset.ruleId, diamonds: 100 });
        setMasterMessage('Testing this rule on Unity…');
    });
    updateRuleSource(row);
    return row;
}

function renderMaster(config) {
    masterConfig = config || masterConfig;
    ui.joinMode.value        = masterConfig.joinMode || 'keyword_only';
    ui.giftAlwaysJoins.checked = masterConfig.giftAlwaysJoins !== false;
    ui.masterRules.replaceChildren(...(masterConfig.rules || []).map(createRuleRow));
}

function readMasterFromUi() {
    const rules = [...ui.masterRules.querySelectorAll('.master-rule-row')].map(row => ({
        id:              row.dataset.ruleId,
        enabled:         row.querySelector('[data-field="enabled"]').checked,
        source:          row.querySelector('[data-field="source"]').value,
        trigger:         row.querySelector('[data-field="trigger"]').value.trim(),
        giftId:          row.querySelector('[data-field="giftId"]').value.trim(),
        match:           row.querySelector('[data-field="match"]').value,
        action:          row.querySelector('[data-field="action"]').value,
        displayDiamonds: Number(row.querySelector('[data-field="displayDiamonds"]').value) || 0,
        durationMs:      Math.round((Number(row.querySelector('[data-field="durationSeconds"]').value) || 0) * 1000),
        label:           row.querySelector('[data-field="label"]').value.trim(),
        variant:         row.querySelector('[data-field="variant"]').value,
        fireworkBursts:  Number(row.querySelector('[data-field="fireworkBursts"]').value) || 0,
    }));
    return { joinMode: ui.joinMode.value, giftAlwaysJoins: ui.giftAlwaysJoins.checked, rules };
}

/* ═══ GIFT CATALOG ═══════════════════════════════════════ */
function observeGift(data) {
    const key = String(data.giftId || data.giftName || 'gift');
    recentGifts.set(key, data);
    while (recentGifts.size > 60) recentGifts.delete(recentGifts.keys().next().value);
    renderGiftCatalog();
}

function renderGiftCatalog() {
    ui.recentGifts.replaceChildren(
        ...[...recentGifts.values()].reverse().map(gift => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'gift-catalog-item';
            if (gift.giftPictureUrl) {
                const img = document.createElement('img');
                img.src = gift.giftPictureUrl;
                img.alt = '';
                img.loading = 'lazy';
                btn.append(img);
            }
            const span = document.createElement('span');
            span.textContent = `${gift.giftName || 'Gift'} · ID ${gift.giftId || '?'} · ${gift.diamondCount || 0}💎`;
            btn.append(span);
            btn.addEventListener('click', () => {
                ui.masterRules.append(createRuleRow(emptyRule({
                    source: 'gift', trigger: gift.giftName || '',
                    giftId: String(gift.giftId || ''),
                    displayDiamonds: Number(gift.diamondCount) || 0, action: 'dance',
                })));
                setMasterMessage('Gift added to the bottom of the list. Choose an action, then press Save & apply.');
            });
            return btn;
        })
    );
}

/* ═══ BACKGROUND MANAGER ═════════════════════════════════ */
let backgroundState = null;
let backgroundAck = null;
let backgroundList = { images: [], videos: [] };

function setBackgroundMessage(text, error = false) {
    if (!ui.bgMessage) return;
    ui.bgMessage.textContent = text || '';
    ui.bgMessage.classList.toggle('error', error);
}

function setBackgroundStatus(text, state = '') {
    if (!ui.bgStatus) return;
    ui.bgStatus.textContent = text;
    ui.bgStatus.className = `bg-status${state ? ' is-' + state : ''}`;
}

const bgVideoMeta = new Map();
// Big clips are not fetched just to draw a thumbnail; the operator presses
// "Preview" and the browser downloads only what it needs then.
const BG_AUTO_THUMB_BYTES = 20 * 1024 * 1024;

function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(value >= 100 * 1024 * 1024 ? 0 : 1)} MB`;
    if (value >= 1024) return `${Math.round(value / 1024)} KB`;
    return `${value} B`;
}

function formatDuration(seconds) {
    const total = Number(seconds);
    if (!Number.isFinite(total) || total <= 0) return '';
    const minutes = Math.floor(total / 60);
    const rest = total - minutes * 60;
    return `${minutes}:${rest < 10 ? '0' : ''}${rest.toFixed(1)}`;
}

function backgroundKindLabel(background) {
    return background && background.type === 'video' ? 'VIDEO' : 'IMAGE';
}

function backgroundUrlFor(item) {
    if (!item) return '';
    if (item.url) return item.url;
    if (item.legacy || item.file === 'nenamphu.png') return '/backgrounds/legacy/nenamphu.png';
    return `/backgrounds/${item.type === 'video' ? 'videos' : 'images'}/${encodeURIComponent(item.file)}`;
}

function backgroundDetail(background, meta) {
    const parts = [
        backgroundKindLabel(background),
        background.fitMode || 'native',
    ];
    if (background && background.type === 'video') parts.push(transformLabel(transformFromConfig(background)));
    parts.push(`gen ${background.generation}`);
    if (meta && meta.width && meta.height) parts.push(`${meta.width}×${meta.height}`);
    if (meta && meta.duration) parts.push(formatDuration(meta.duration));
    return parts.join(' · ');
}

/** Duration and pixel size come from the browser's own decoder, cached per URL. */
function probeVideoMeta(url) {
    if (!url) return Promise.resolve(null);
    if (bgVideoMeta.has(url)) return Promise.resolve(bgVideoMeta.get(url));
    return new Promise(resolve => {
        const video = document.createElement('video');
        const finish = meta => {
            bgVideoMeta.set(url, meta);
            video.removeAttribute('src');
            try { video.load(); } catch { /* ignore */ }
            resolve(meta);
        };
        video.preload = 'metadata';
        video.muted = true;
        video.playsInline = true;
        video.addEventListener('loadedmetadata', () => finish({
            width: video.videoWidth || 0,
            height: video.videoHeight || 0,
            duration: Number.isFinite(video.duration) ? video.duration : 0,
        }), { once: true });
        video.addEventListener('error', () => finish({ width: 0, height: 0, duration: 0 }), { once: true });
        video.src = url;
    });
}

/** Grabs one frame for the tile; only called when the file is small enough. */
function captureVideoFrame(url) {
    return new Promise(resolve => {
        const video = document.createElement('video');
        let settled = false;
        const finish = frame => {
            if (settled) return;
            settled = true;
            video.removeAttribute('src');
            try { video.load(); } catch { /* ignore */ }
            resolve(frame);
        };
        video.preload = 'auto';
        video.muted = true;
        video.playsInline = true;
        video.addEventListener('loadeddata', () => {
            try { video.currentTime = Math.min(1, Math.max(0.1, (video.duration || 2) / 3)); }
            catch { finish(null); }
        }, { once: true });
        video.addEventListener('seeked', () => {
            try {
                const width = 240;
                const height = Math.max(1, Math.round(width * ((video.videoHeight || 9) / Math.max(1, video.videoWidth || 16))));
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                canvas.getContext('2d').drawImage(video, 0, 0, width, height);
                finish(canvas.toDataURL('image/jpeg', 0.72));
            } catch { finish(null); }
        }, { once: true });
        video.addEventListener('error', () => finish(null), { once: true });
        video.src = url;
    });
}

function previewBackground(item) {
    if (!ui.bgPreview) return;
    const url = backgroundUrlFor(item);
    if (!url) return;

    if (item.type === 'video') {
        const video = document.createElement('video');
        video.src = url;
        video.controls = true;
        video.autoplay = true;
        video.muted = true;
        video.loop = true;
        video.playsInline = true;
        video.preload = 'auto';
        ui.bgPreview.replaceChildren(video);
        probeVideoMeta(url).then(meta => {
            if (!meta || !backgroundState || backgroundState.file !== item.file) return;
            ui.bgCurrentDetail.textContent = backgroundDetail(backgroundState, meta);
        });
    } else {
        const image = document.createElement('img');
        image.src = url;
        image.alt = '';
        ui.bgPreview.replaceChildren(image);
    }

    setBackgroundMessage(`Previewing ${item.file} (not applied yet).`);
}

function setAckStatus(ack) {
    const at = ack.at ? new Date(ack.at).toLocaleTimeString('en-US') : '—';
    if (ack.ok === false) {
        return setBackgroundStatus(
            `Unity could not apply ${ack.file || 'background'}: ${ack.error || 'unknown error'} (${at}).`,
            'error'
        );
    }
    const dims = ack.width && ack.height ? ` · ${ack.width}×${ack.height}` : '';
    const duration = ack.duration ? ` · ${formatDuration(ack.duration)}` : '';
    const transform = backgroundState && backgroundState.type === 'video'
        ? ` · ${transformLabel(transformFromConfig(backgroundState))}`
        : '';
    setBackgroundStatus(`Unity applied ${ack.file}${dims}${duration}${transform} at ${at}.`, 'ok');
}

function renderBackgroundCurrent(background, ack) {
    backgroundState = background || null;
    if (ack !== undefined && ack !== null) backgroundAck = ack;

    if (background && background.url) {
        const element = document.createElement(background.type === 'video' ? 'video' : 'img');
        element.src = background.url;
        if (background.type === 'video') {
            element.controls = true;
            element.autoplay = true;
            element.muted = true;
            element.loop = true;
            element.playsInline = true;
            element.preload = 'metadata';
        } else {
            element.alt = '';
        }
        ui.bgPreview.replaceChildren(element);
    } else {
        ui.bgPreview.replaceChildren(Object.assign(document.createElement('span'), {
            className: 'muted', textContent: 'No background yet'
        }));
    }

    ui.bgCurrentName.textContent = background ? background.file : '—';
    ui.bgCurrentDetail.textContent = background ? backgroundDetail(background) : '—';
    if (background) ui.bgFit.value = background.fitMode || 'native';
    // Mirror what the bridge stored, so the operator sees the live settings and
    // not just what they last clicked.
    syncTransformControls(transformFromConfig(background));
    transformControlsAvailable(true);

    if (background && background.type === 'video') {
        probeVideoMeta(background.url).then(meta => {
            if (!meta || !backgroundState || backgroundState.generation !== background.generation) return;
            ui.bgCurrentDetail.textContent = backgroundDetail(background, meta);
        });
    }

    if (!background) {
        setBackgroundStatus('No background configured.', '');
    } else if (backgroundAck && backgroundAck.generation === background.generation) {
        setAckStatus(backgroundAck);
    } else {
        setBackgroundStatus('Saved. Unity has not confirmed yet (not connected or still loading).', 'pending');
    }

    renderBackgroundList();
}

function renderBackgroundList() {
    if (!ui.bgList) return;
    const items = [...backgroundList.images, ...backgroundList.videos];
    if (!items.length) {
        ui.bgList.replaceChildren(Object.assign(document.createElement('span'), {
            className: 'muted',
            textContent: 'No files yet. Drop images into LiveAssets/Backgrounds/images, videos into DJ_VIDEO or LiveAssets/Backgrounds/videos, then press ↻ Refresh.',
        }));
        return;
    }

    ui.bgList.replaceChildren(...items.map(buildBackgroundCard));
}

function buildBackgroundCard(item) {
    const isVideo = item.type === 'video';
    const url = backgroundUrlFor(item);
    const isActive = Boolean(backgroundState && backgroundState.file === item.file);

    const card = document.createElement('div');
    card.className = 'bg-item';
    if (isActive) card.classList.add('is-active');

    const thumb = document.createElement('div');
    thumb.className = 'bg-thumb';

    const image = document.createElement('img');
    image.alt = '';
    image.loading = 'lazy';
    if (!isVideo) image.src = url;
    thumb.append(image);

    if (isVideo) {
        const play = document.createElement('span');
        play.className = 'bg-play';
        play.textContent = '▶';
        thumb.append(play);
    }

    const kind = document.createElement('span');
    kind.className = `bg-kind${isVideo ? ' is-video' : ''}`;
    kind.textContent = isVideo ? 'VIDEO' : 'IMAGE';
    thumb.append(kind);

    const name = document.createElement('p');
    name.className = 'bg-name';
    name.textContent = item.file;
    name.title = item.file;

    const meta = document.createElement('p');
    meta.className = 'bg-meta';
    const folderTag = item.folder && item.folder !== 'videos' && item.folder !== 'images' ? item.folder : '';
    const renderMeta = extra => {
        const parts = [formatBytes(item.bytes)];
        if (folderTag) parts.push(folderTag);
        if (extra && extra.width && extra.height) parts.push(`${extra.width}×${extra.height}`);
        if (extra && extra.duration) parts.push(formatDuration(extra.duration));
        meta.textContent = parts.join(' · ');
    };
    renderMeta();

    if (!isVideo) {
        image.addEventListener('load', () => {
            if (image.naturalWidth) renderMeta({ width: image.naturalWidth, height: image.naturalHeight });
        }, { once: true });
    } else if (Number(item.bytes) > 0 && Number(item.bytes) <= BG_AUTO_THUMB_BYTES) {
        probeVideoMeta(url).then(result => {
            if (!result) return;
            renderMeta(result);
            captureVideoFrame(url).then(frame => { if (frame) image.src = frame; });
        });
    }

    const actions = document.createElement('div');
    actions.className = 'bg-actions';

    const apply = document.createElement('button');
    apply.type = 'button';
    apply.className = isActive ? 'btn btn-secondary btn-sm' : 'btn btn-primary btn-sm';
    apply.textContent = isActive ? 'In use' : 'Apply';
    apply.disabled = isActive;
    apply.addEventListener('click', () => applyBackground(item));
    actions.append(apply);

    if (isVideo) {
        const watch = document.createElement('button');
        watch.type = 'button';
        watch.className = 'btn btn-secondary btn-sm';
        watch.textContent = Number(item.bytes) > BG_AUTO_THUMB_BYTES ? 'Preview' : 'View';
        watch.addEventListener('click', () => previewBackground({ ...item, url }));
        actions.append(watch);
    }

    card.append(thumb, name, meta, actions);

    if (item.warning) {
        const warn = document.createElement('p');
        warn.className = 'bg-warn';
        warn.textContent = `⚠ ${item.warning}`;
        card.append(warn);
    }

    return card;
}

async function refreshBackgrounds() {
    setBackgroundMessage('Refreshing the list…');
    try {
        const [listResponse, currentResponse] = await Promise.all([
            fetch('/api/backgrounds', { cache: 'no-store' }),
            fetch('/api/background', { cache: 'no-store' }),
        ]);
        if (listResponse.ok) backgroundList = await listResponse.json();
        if (currentResponse.ok) {
            const current = await currentResponse.json();
            renderBackgroundCurrent(current.background, current.ack || null);
        }
        renderBackgroundList();
        setBackgroundMessage(`Loaded ${backgroundList.images.length + backgroundList.videos.length} background file(s).`);
    } catch (error) {
        setBackgroundMessage('Could not read the background list: ' + error.message, true);
    }
}

function applyBackground(item, transformOverride) {
    const isVideo = item.type === 'video';
    const transform = transformOverride || transformFromConfig(item);
    const background = {
        file: item.file,
        type: isVideo ? 'video' : 'image',
        fitMode: ui.bgFit.value,
        loop: true,
    };
    // Only a video has an orientation; the bridge rejects transforms on images.
    if (isVideo) background.transform = transform;
    if (socket?.readyState === WebSocket.OPEN) {
        send({ type: 'set_background', background });
    } else {
        fetch('/api/background', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ background }),
        }).then(response => response.json().then(body => ({ ok: response.ok, body })))
          .then(({ ok, body }) => {
              if (!ok) throw new Error(body.error || 'Could not apply the background.');
              renderBackgroundCurrent(body.background, null);
              setBackgroundMessage(body.message || 'Background applied.');
          })
          .catch(error => setBackgroundMessage(error.message, true));
        return;
    }
    setBackgroundStatus('Sending the configuration to Unity…', 'pending');
    setBackgroundMessage('Applying ' + item.file + '…');
}

function applyBackgroundReply(data) {
    if (!data.background) return;
    renderBackgroundCurrent(data.background, null);
    setBackgroundMessage(data.message || 'Background applied.');
}

function confirmBackgroundAck(data) {
    backgroundAck = {
        file: data.file,
        generation: data.generation,
        ok: data.ok !== false,
        error: data.error || '',
        width: data.width || 0,
        height: data.height || 0,
        duration: data.duration || 0,
        at: data.at,
    };
    if (backgroundState && backgroundAck.generation === backgroundState.generation) setAckStatus(backgroundAck);
}

/* ── Video transform (rotation + flip) ─────────────────── */
const bgRotations = [0, 90, 180, 270];
const bgTransform = { rotation: 0, flipHorizontal: false, flipVertical: false };

function transformFromConfig(background) {
    const source = background && background.transform ? background.transform : {};
    const raw = source.rotation !== undefined ? source.rotation : background && background.rotation;
    return {
        rotation: bgRotations.includes(Number(raw)) ? Number(raw) : 0,
        flipHorizontal: source.flipHorizontal === true,
        flipVertical: source.flipVertical === true,
    };
}

function transformLabel(transform) {
    const parts = [`${transform.rotation}°`];
    if (transform.flipHorizontal) parts.push('flip H');
    if (transform.flipVertical) parts.push('flip V');
    return parts.join(' · ');
}

function syncTransformControls(transform) {
    bgTransform.rotation = transform.rotation;
    bgTransform.flipHorizontal = transform.flipHorizontal;
    bgTransform.flipVertical = transform.flipVertical;

    document.querySelectorAll('#bg-rot-buttons [data-rot]').forEach(button => {
        const active = Number(button.dataset.rot) === transform.rotation;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    if (ui.bgFlipH) ui.bgFlipH.checked = transform.flipHorizontal;
    if (ui.bgFlipV) ui.bgFlipV.checked = transform.flipVertical;
    if (ui.bgTransformCurrent) ui.bgTransformCurrent.textContent = `Applied: ${transformLabel(transform)}`;
}

function readTransformControls() {
    return {
        rotation: bgTransform.rotation,
        flipHorizontal: Boolean(ui.bgFlipH && ui.bgFlipH.checked),
        flipVertical: Boolean(ui.bgFlipV && ui.bgFlipV.checked),
    };
}

function transformControlsAvailable() {
    const video = Boolean(backgroundState && backgroundState.type === 'video');
    if (ui.bgTransform) ui.bgTransform.hidden = !video;
    [ui.bgTransformApply, ui.bgTransformReset, ui.bgFlipH, ui.bgFlipV].forEach(element => {
        if (element) element.disabled = !video;
    });
    document.querySelectorAll('#bg-rot-buttons [data-rot]').forEach(button => {
        button.disabled = !video;
    });
    if (ui.bgTransformHint) {
        ui.bgTransformHint.textContent = video
            ? 'Press "Apply to Live" to push it to Unity now, no restart needed.'
            : 'Select a video to rotate or flip. PNG/JPG images are unaffected.';
    }
}

document.querySelectorAll('#bg-rot-buttons [data-rot]').forEach(button => {
    button.addEventListener('click', () => {
        if (!backgroundState || backgroundState.type !== 'video') return;
        syncTransformControls({ ...readTransformControls(), rotation: Number(button.dataset.rot) });
    });
});
[ui.bgFlipH, ui.bgFlipV].forEach(element => {
    if (!element) return;
    element.addEventListener('change', () => {
        if (!backgroundState || backgroundState.type !== 'video') return;
        syncTransformControls(readTransformControls());
    });
});
if (ui.bgTransformApply) ui.bgTransformApply.addEventListener('click', () => {
    if (!backgroundState || backgroundState.type !== 'video') return;
    applyBackground(backgroundState, readTransformControls());
});
if (ui.bgTransformReset) ui.bgTransformReset.addEventListener('click', () => {
    if (!backgroundState || backgroundState.type !== 'video') return;
    const reset = { rotation: 0, flipHorizontal: false, flipVertical: false };
    syncTransformControls(reset);
    applyBackground(backgroundState, reset);
});

if (ui.bgRefresh) ui.bgRefresh.addEventListener('click', refreshBackgrounds);
if (ui.bgDefault) ui.bgDefault.addEventListener('click', () => {
    applyBackground({ file: 'nenamphu.png', type: 'image' });
    ui.bgFit.value = 'native';
});
if (ui.bgFit) ui.bgFit.addEventListener('change', () => {
    if (backgroundState) applyBackground(backgroundState);
});

/* ═══ SOCKET ═════════════════════════════════════════════ */
function connectSocket() {
    clearTimeout(reconnectTimer);
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${protocol}//${location.host}`);

    socket.addEventListener('open', () => {
        send({ type: 'register', role: 'control' });
    });

    socket.addEventListener('message', event => {
        let data;
        try { data = JSON.parse(event.data); } catch { return; }
        if (data.type === 'status' || data.type === 'error') setStatus(data);
        if (data.type === 'metrics')        setMetrics(data);
        if (data.type === 'master_config')  renderMaster(data.master);
        if (data.type === 'master_saved')   setMasterMessage(data.message || 'Master saved.');
        if (data.type === 'gift_observed')  observeGift(data);
        if (data.type === 'gift_catalog') {
            recentGifts.clear();
            for (const g of data.gifts || [])
                recentGifts.set(String(g.giftId || g.giftName || 'gift'), g);
            renderGiftCatalog();
        }
        if (data.type === 'background_config') renderBackgroundCurrent(data.background, null);
        if (data.type === 'background_saved')  applyBackgroundReply(data);
        if (data.type === 'background_ack')    confirmBackgroundAck(data);
        if (data.type === 'error') setMasterMessage(data.message || 'Something went wrong.', true);
    });

    socket.addEventListener('close', () => {
        setStatus({ state: 'disconnected', message: 'Reconnecting to the server…' });
        reconnectTimer = setTimeout(connectSocket, 2000);
    });

    socket.addEventListener('error', () => socket.close());
}

/* ═══ EVENT LISTENERS ════════════════════════════════════ */
ui.connect.addEventListener('click', () => {
    const username = ui.username.value.trim();
    if (username) send({ type: 'set_username', username });
});
ui.username.addEventListener('keydown', e => { if (e.key === 'Enter') ui.connect.click(); });
ui.disconnect.addEventListener('click', () => send({ type: 'disconnect_tiktok' }));
ui.stopDemo.addEventListener('click',   () => send({ type: 'demo_stop' }));
ui.reset.addEventListener('click',     () => send({ type: 'reset_game' }));
ui.addMasterRule.addEventListener('click', () => ui.masterRules.append(createRuleRow(emptyRule())));
ui.saveMaster.addEventListener('click', () => {
    send({ type: 'master_save', master: readMasterFromUi() });
    setMasterMessage('Saving and applying…');
});

document.querySelectorAll('[data-demo-count]').forEach(btn => {
    btn.addEventListener('click', () =>
        send({ type: 'demo_start', count: Number(btn.dataset.demoCount) })
    );
});

document.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () =>
        send({
            type:      'demo_event',
            action:    btn.dataset.action,
            value:     Number(btn.dataset.value) || 1,
            giftName:  btn.dataset.giftName || '',
            userIndex: Number(ui.userIndex.value) || 1,
        })
    );
});

/* ═══ INIT ═══════════════════════════════════════════════ */
connectSocket();
refreshBackgrounds();
