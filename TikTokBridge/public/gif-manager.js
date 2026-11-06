/* ─────────────────────────────────────────────────────────
   GIF Manager tab — Phase 4
   Import → parse → convert → library → gift mappings.
   Every administrative call carries X-Control-Panel: 1, which the
   bridge requires before it touches GIF files.
───────────────────────────────────────────────────────── */
(() => {
    const CONTROL_HEADERS = { 'x-control-panel': '1' };
    const state = {
        snapshot: null,
        catalog: [],
        characterAnimations: [],
        mappings: [],
        busy: false
    };

    const el = id => document.getElementById(id);
    const ui = {
        statGifs: el('gm-stat-gifs'),
        statAnimations: el('gm-stat-animations'),
        statFailed: el('gm-stat-failed'),
        statFrames: el('gm-stat-frames'),
        pipeline: el('gm-pipeline'),
        message: el('gm-message'),
        file: el('gm-file'),
        upload: el('gm-upload'),
        uploadConvert: el('gm-upload-convert'),
        uploadProgress: el('gm-upload-progress'),
        uploadBar: el('gm-upload-bar'),
        uploadHint: el('gm-upload-hint'),
        url: el('gm-url'),
        download: el('gm-download'),
        downloadConvert: el('gm-download-convert'),
        downloadProgress: el('gm-download-progress'),
        downloadBar: el('gm-download-bar'),
        downloadHint: el('gm-download-hint'),
        previewCard: el('gm-preview-card'),
        previewTitle: el('gm-preview-title'),
        previewImg: el('gm-preview-img'),
        previewSpec: el('gm-preview-spec'),
        previewClose: el('gm-preview-close'),
        search: el('gm-search'),
        filter: el('gm-filter'),
        refresh: el('gm-refresh'),
        library: el('gm-library'),
        libraryCount: el('gm-library-count'),
        mappings: el('gm-mappings'),
        mappingsSearch: el('gm-mapping-search'),
        mappingsSave: el('gm-mappings-save'),
        mappingsRefresh: el('gm-mappings-refresh')
    };

    if (!ui.library) return;

    /* ── helpers ─────────────────────────────────────────── */
    function setMessage(text, isError = false) {
        ui.message.textContent = text || '';
        ui.message.classList.toggle('error', Boolean(isError));
    }

    function formatBytes(bytes) {
        const value = Number(bytes) || 0;
        if (value >= 1048576) return `${(value / 1048576).toFixed(1)} MB`;
        if (value >= 1024) return `${Math.round(value / 1024)} KB`;
        return `${value} B`;
    }

    function formatMs(ms) {
        const value = Number(ms) || 0;
        return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value} ms`;
    }

    function previewUrl(file) {
        return `/assets/gifs/${encodeURIComponent(file)}`;
    }

    function setProgress(kind, ratio) {
        const container = kind === 'upload' ? ui.uploadProgress : ui.downloadProgress;
        const bar = kind === 'upload' ? ui.uploadBar : ui.downloadBar;
        if (!container || !bar) return;
        container.hidden = ratio === null;
        if (ratio === null) return;
        if (ratio < 0) {
            bar.classList.add('indeterminate');
            bar.style.width = '';
        } else {
            bar.classList.remove('indeterminate');
            bar.style.width = `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`;
        }
    }

    async function parseResponse(response) {
        let payload = {};
        try { payload = await response.json(); } catch { payload = {}; }
        if (!response.ok) {
            const error = new Error(payload.error || `HTTP ${response.status}`);
            error.payload = payload;
            error.status = response.status;
            throw error;
        }
        return payload;
    }

    async function api(url, body) {
        return parseResponse(await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...CONTROL_HEADERS },
            body: JSON.stringify(body || {})
        }));
    }

    function setBusy(busy, label = '') {
        state.busy = busy;
        [ui.upload, ui.download, ui.refresh, ui.mappingsSave].forEach(button => {
            if (button) button.disabled = busy;
        });
        if (busy && label) setMessage(label);
    }

    /* ── rendering ───────────────────────────────────────── */
    function renderStats(snapshot) {
        const stats = snapshot.stats || {};
        ui.statGifs.textContent = String(stats.totalGifs ?? 0);
        ui.statAnimations.textContent = String(stats.convertedAnimations ?? 0);
        ui.statFailed.textContent = String(stats.failedConversions ?? 0);
        ui.statFrames.textContent = Number(stats.totalFrames ?? 0).toLocaleString('en-US');

        const pipeline = snapshot.pipeline || {};
        const limits = pipeline.limits || {};
        const lastRun = pipeline.lastRunAt ? new Date(pipeline.lastRunAt).toLocaleString() : 'never';
        ui.pipeline.textContent = [
            `Auto-convert ${pipeline.autoConvert ? 'on' : 'off'}`,
            `last run ${lastRun}`,
            `${pipeline.converted || 0} converted / ${pipeline.skipped || 0} skipped / ${pipeline.failed || 0} failed`,
            limits.maxBytes ? `limit ${formatBytes(limits.maxBytes)} · ${limits.maxFrames} frames · ${limits.maxDimension} px` : ''
        ].filter(Boolean).join(' · ');
    }

    function createSpecRow(term, value) {
        const dt = document.createElement('dt');
        dt.textContent = term;
        const dd = document.createElement('dd');
        dd.textContent = value;
        return [dt, dd];
    }

    function showPreview(entry) {
        if (!entry) return;
        ui.previewCard.hidden = false;
        ui.previewTitle.textContent = entry.animationId || entry.filename || 'Preview';
        ui.previewImg.src = previewUrl(entry.file || entry.storedName || '');
        ui.previewImg.alt = `Preview of ${entry.file || entry.storedName || 'GIF'}`;
        const delays = Array.isArray(entry.frameDelaysMs) ? entry.frameDelaysMs.slice(0, 12).join(', ') : '—';
        const rows = [
            ...createSpecRow('Source file', entry.file || entry.storedName || '—'),
            ...createSpecRow('Animation ID', entry.animationId || '—'),
            ...createSpecRow('Resolution', entry.width ? `${entry.width} × ${entry.height}` : '—'),
            ...createSpecRow('Frames', String(entry.frameCount ?? '—')),
            ...createSpecRow('Average FPS', entry.fps ? String(entry.fps) : '—'),
            ...createSpecRow('Duration', entry.durationMs ? formatMs(entry.durationMs) : '—'),
            ...createSpecRow('Per-frame delays', `${delays}${entry.frameDelaysMs && entry.frameDelaysMs.length > 12 ? '…' : ''}`),
            ...createSpecRow('Transparent', entry.transparent ? 'yes' : 'no'),
            ...createSpecRow('Loops', entry.loop ? 'yes' : 'no'),
            ...createSpecRow('Size', formatBytes(entry.bytes)),
            ...createSpecRow('SHA-256', entry.sha256 ? `${entry.sha256.slice(0, 16)}…` : '—')
        ];
        if (entry.error) rows.push(...createSpecRow('Parse error', entry.error));
        ui.previewSpec.replaceChildren(...rows);
        ui.previewCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    function buildEditForm(animation) {
        const form = document.createElement('form');
        form.className = 'gm-edit';
        form.hidden = true;

        const fields = [
            { name: 'fps', label: 'FPS', value: Number(animation.fps || 12).toFixed(1), step: '0.1', min: '1', max: '120' },
            { name: 'playbackSpeed', label: 'Playback speed', value: Number(animation.playbackSpeed || 1).toFixed(2), step: '0.05', min: '0.25', max: '3' },
            { name: 'defaultDurationMs', label: 'Default duration (ms)', value: Math.round(animation.defaultDurationMs || animation.durationMs || 0), step: '1', min: '0', max: '300000' }
        ];
        for (const field of fields) {
            const label = document.createElement('label');
            label.textContent = field.label;
            const input = document.createElement('input');
            input.type = 'number';
            input.name = field.name;
            input.step = field.step;
            input.min = field.min;
            input.max = field.max;
            input.value = field.value;
            label.append(input);
            form.append(label);
        }

        const loopRow = document.createElement('div');
        loopRow.className = 'gm-edit-row';
        const loopLabel = document.createElement('label');
        loopLabel.style.flexDirection = 'row';
        loopLabel.style.alignItems = 'center';
        loopLabel.style.gap = '6px';
        const loop = document.createElement('input');
        loop.type = 'checkbox';
        loop.name = 'loop';
        loop.checked = animation.loop !== false;
        loopLabel.append(loop, document.createTextNode('Loop playback'));
        loopRow.append(loopLabel);

        const actions = document.createElement('div');
        actions.className = 'gm-actions';
        const save = document.createElement('button');
        save.type = 'submit';
        save.textContent = 'Save';
        const reset = document.createElement('button');
        reset.type = 'button';
        reset.textContent = 'Use GIF values';
        actions.append(save, reset);
        loopRow.append(actions);
        form.append(loopRow);

        const values = () => ({
            animationId: animation.animationId,
            fps: Number(form.elements.fps.value),
            playbackSpeed: Number(form.elements.playbackSpeed.value),
            defaultDurationMs: Number(form.elements.defaultDurationMs.value),
            loop: loop.checked
        });

        form.addEventListener('submit', async event => {
            event.preventDefault();
            await run(async () => {
                const reply = await api('/api/gif-manager/metadata', values());
                applySnapshot(reply.snapshot);
                setMessage(reply.message || 'Saved.');
            });
        });
        reset.addEventListener('click', async () => {
            await run(async () => {
                const reply = await api('/api/gif-manager/metadata', {
                    animationId: animation.animationId,
                    reset: true
                });
                applySnapshot(reply.snapshot);
                setMessage(reply.message || 'Restored the GIF timing.');
            });
        });

        return form;
    }

    function buildCard(entry) {
        const card = document.createElement('article');
        card.className = 'gm-card';
        card.dataset.id = entry.animationId || entry.file;

        const thumb = document.createElement('div');
        thumb.className = 'gm-thumb';
        const image = document.createElement('img');
        image.loading = 'lazy';
        image.alt = `GIF ${entry.file}`;
        image.src = previewUrl(entry.file);
        thumb.append(image);

        const head = document.createElement('div');
        head.className = 'gm-card-head';
        const name = document.createElement('strong');
        name.textContent = entry.animationId || entry.file;
        const badge = document.createElement('span');
        badge.className = `gm-badge ${entry.status}`;
        badge.textContent = entry.status;
        head.append(name, badge);

        const meta = document.createElement('p');
        meta.className = 'gm-meta';
        meta.textContent = entry.ok
            ? `${entry.frameCount} frames · ${entry.width}×${entry.height} · ${entry.fps} fps · ${formatMs(entry.durationMs)}`
            : entry.error || 'Invalid GIF';

        const sub = document.createElement('p');
        sub.className = 'gm-sub';
        sub.textContent = entry.ok
            ? `${entry.file} · ${formatBytes(entry.bytes)} · ${entry.loop ? 'loops' : 'plays once'} · ${entry.transparent ? 'transparent' : 'opaque'}`
            : entry.file;

        const gifts = document.createElement('p');
        gifts.className = 'gm-gifts';
        const usedBy = (state.snapshot?.usedBy || {})[entry.animationId] || [];
        gifts.textContent = usedBy.length
            ? `Gifts: ${usedBy.join(', ')}`
            : entry.converted ? 'Not mapped to any gift' : '';

        const actions = document.createElement('div');
        actions.className = 'gm-actions';

        const action = (label, act) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.dataset.act = act;
            button.textContent = label;
            actions.append(button);
            return button;
        };

        action('Preview', 'preview').addEventListener('click', () => showPreview(entry));

        if (entry.ok) {
            if (!entry.converted) {
                action('Convert', 'convert').addEventListener('click', () => convert(entry, false));
            } else {
                action('Re-convert', 'convert').addEventListener('click', () => convert(entry, true));
                action('Rename', 'rename').addEventListener('click', () => rename(entry));
                action('Settings', 'edit').addEventListener('click', () => {
                    editForm.hidden = !editForm.hidden;
                });
                action('Delete', 'delete').addEventListener('click', () => remove(entry));
            }
        }

        const editForm = buildEditForm(entry.animation || { animationId: entry.animationId });
        card.append(thumb, head, meta, sub);
        if (gifts.textContent) card.append(gifts);
        card.append(actions, editForm);
        return card;
    }

    function renderLibrary() {
        const snapshot = state.snapshot;
        if (!snapshot) return;
        const query = (ui.search.value || '').trim().toLowerCase();
        const filter = ui.filter.value;

        const entries = (snapshot.gifs || []).filter(entry => {
            if (filter !== 'all' && entry.status !== filter) return false;
            if (!query) return true;
            return `${entry.file} ${entry.animationId}`.toLowerCase().includes(query);
        });

        ui.library.replaceChildren(...entries.map(buildCard));
        if (!entries.length) {
            const empty = document.createElement('span');
            empty.className = 'muted';
            empty.textContent = snapshot.gifs.length
                ? 'No GIF matches that search.'
                : 'No GIFs yet — upload one or paste a direct URL above.';
            ui.library.replaceChildren(empty);
        }
        ui.libraryCount.textContent = `${entries.length} of ${snapshot.gifs.length} GIF(s) · ` +
            `${snapshot.stats.convertedAnimations} animation folder(s) in Unity.`;
    }

    function animationOptions(selectedId) {
        const options = [];
        for (const animation of state.catalog) {
            const option = document.createElement('option');
            option.value = animation.id;
            option.textContent = `${animation.label} (${animation.id})`;
            if (animation.id === selectedId) option.selected = true;
            options.push(option);
        }
        for (const id of state.characterAnimations) {
            const option = document.createElement('option');
            option.value = id;
            option.textContent = `${id} (GIF)`;
            if (id === selectedId) option.selected = true;
            options.push(option);
        }
        return options;
    }

    function createMappingRow(mapping = { giftId: '', animationId: '' }) {
        const row = document.createElement('div');
        row.className = 'gm-mapping-row';

        const gift = document.createElement('input');
        gift.placeholder = 'Gift ID';
        gift.value = mapping.giftId || '';
        gift.dataset.field = 'giftId';

        const select = document.createElement('select');
        select.dataset.field = 'animationId';
        const options = animationOptions(mapping.animationId);
        if (!options.length) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = 'No animations yet';
            select.append(option);
        } else {
            select.append(...options);
        }

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'btn btn-danger btn-sm';
        remove.textContent = 'Remove';
        remove.addEventListener('click', () => row.remove());

        row.append(gift, select, remove);
        row.dataset.search = `${mapping.giftId || ''} ${mapping.animationId || ''}`.toLowerCase();
        return row;
    }

    function renderMappings() {
        if (!ui.mappings) return;
        const query = (ui.mappingsSearch?.value || '').trim().toLowerCase();
        const rows = state.mappings.map(createMappingRow);
        ui.mappings.replaceChildren(...rows);
        if (!state.mappings.length) {
            ui.mappings.replaceChildren(createMappingRow());
        }
        applyMappingFilter(query);
    }

    function applyMappingFilter(query) {
        if (!ui.mappings) return;
        [...ui.mappings.querySelectorAll('.gm-mapping-row')].forEach(row => {
            row.hidden = Boolean(query) && !(row.dataset.search || '').includes(query);
        });
    }

    function readMappings() {
        if (!ui.mappings) return [];
        return [...ui.mappings.querySelectorAll('.gm-mapping-row')]
            .map(row => ({
                giftId: row.querySelector('[data-field="giftId"]').value.trim(),
                animationId: row.querySelector('[data-field="animationId"]').value
            }))
            .filter(mapping => mapping.giftId || mapping.animationId);
    }

    function applySnapshot(snapshot) {
        if (!snapshot) return;
        state.snapshot = snapshot;
        state.characterAnimations = Array.isArray(snapshot.animations)
            ? snapshot.animations.map(animation => animation.animationId)
            : state.characterAnimations;
        state.mappings = Array.isArray(snapshot.giftAnimations)
            ? snapshot.giftAnimations.map(mapping => ({ ...mapping }))
            : state.mappings;
        renderStats(snapshot);
        renderLibrary();
        renderMappings();
    }

    /* ── actions ─────────────────────────────────────────── */
    async function run(work) {
        if (state.busy) return;
        setBusy(true);
        try {
            await work();
        } catch (error) {
            setMessage(error.message || 'Something went wrong.', true);
        } finally {
            setBusy(false);
            setProgress('upload', null);
            setProgress('download', null);
        }
    }

    async function load() {
        await run(async () => {
            const [snapshot, catalogReply] = await Promise.all([
                fetch('/api/gif-manager').then(parseResponse),
                fetch('/api/gift-animations').then(parseResponse)
            ]);
            state.catalog = Array.isArray(catalogReply.animations) ? catalogReply.animations : [];
            applySnapshot(snapshot);
            setMessage(`Loaded ${snapshot.stats.totalGifs} GIF(s) and ${snapshot.stats.convertedAnimations} animation(s).`);
        });
    }

    async function convert(entry, reconvert) {
        await run(async () => {
            try {
                const reply = await api('/api/gif-manager/convert', {
                    animationId: entry.animationId,
                    confirm: reconvert
                });
                applySnapshot(reply.snapshot);
                setMessage(`Converted ${reply.animationId}: ${reply.frameCount} frames → ${reply.folder}`);
            } catch (error) {
                if (error.status !== 409) throw error;
                const confirmed = window.confirm(
                    `${error.message}\n\nRe-converting replaces the existing frames. Continue?`
                );
                if (!confirmed) return setMessage('Conversion cancelled; the existing animation is unchanged.');
                const reply = await api('/api/gif-manager/convert', {
                    animationId: entry.animationId,
                    confirm: true
                });
                applySnapshot(reply.snapshot);
                setMessage(`Re-converted ${reply.animationId}: ${reply.frameCount} frames.`);
            }
        });
    }

    async function rename(entry) {
        const next = window.prompt('New animation ID (letters, numbers, _ and -)', entry.animationId);
        if (!next || next.trim() === entry.animationId) return;
        await run(async () => {
            const reply = await api('/api/gif-manager/rename', {
                animationId: entry.animationId,
                newName: next.trim()
            });
            applySnapshot(reply.snapshot);
            setMessage(reply.message || 'Renamed.');
        });
    }

    async function remove(entry) {
        const usedBy = (state.snapshot?.usedBy || {})[entry.animationId] || [];
        const warning = usedBy.length
            ? `"${entry.animationId}" is used by ${usedBy.length} gift mapping(s): ${usedBy.join(', ')}.\n\n` +
              'Deleting it also removes those mappings. Continue?'
            : `Delete the animation "${entry.animationId}" and its frames from Unity?`;
        if (!window.confirm(warning)) return;

        await run(async () => {
            const reply = await api('/api/gif-manager/delete', {
                animationId: entry.animationId,
                confirm: true
            });
            applySnapshot(reply.snapshot);
            setMessage(reply.message || 'Deleted.');
        });
    }

    function uploadGif() {
        const file = ui.file.files && ui.file.files[0];
        if (!file) return setMessage('Choose a GIF file first.', true);
        if (state.busy) return;

        const convertNow = ui.uploadConvert.checked ? '1' : '0';
        const request = new XMLHttpRequest();
        request.open('POST',
            `/api/gif-manager/upload?filename=${encodeURIComponent(file.name)}&convert=${convertNow}`);
        request.setRequestHeader('x-control-panel', '1');

        setBusy(true, `Uploading ${file.name}…`);
        setProgress('upload', 0);

        request.upload.addEventListener('progress', event => {
            if (event.lengthComputable) setProgress('upload', event.loaded / event.total);
        });
        request.addEventListener('load', () => {
            setBusy(false);
            setProgress('upload', null);
            let payload = {};
            try { payload = JSON.parse(request.responseText || '{}'); } catch { payload = {}; }
            if (request.status < 200 || request.status >= 300) {
                return setMessage(payload.error || `Upload failed (HTTP ${request.status}).`, true);
            }
            applySnapshot(payload.snapshot);
            showPreview(payload.imported);
            const conversion = payload.conversion;
            setMessage(payload.message + (conversion
                ? conversion.ok
                    ? ` Converted to ${conversion.frameCount} frames.`
                    : ` Conversion skipped: ${conversion.error}`
                : ''), Boolean(conversion && !conversion.ok));
        });
        request.addEventListener('error', () => {
            setBusy(false);
            setProgress('upload', null);
            setMessage('The upload was interrupted.', true);
        });
        request.send(file);
    }

    async function downloadGif() {
        const url = (ui.url.value || '').trim();
        if (!url) return setMessage('Paste a GIF URL first.', true);
        await run(async () => {
            setProgress('download', -1);
            const reply = await api('/api/gif-manager/download', {
                url,
                convert: ui.downloadConvert.checked
            });
            applySnapshot(reply.snapshot);
            showPreview(reply.imported);
            const conversion = reply.conversion;
            setMessage(reply.message + (conversion
                ? conversion.ok
                    ? ` Converted to ${conversion.frameCount} frames.`
                    : ` Conversion skipped: ${conversion.error}`
                : ''), Boolean(conversion && !conversion.ok));
        });
    }

    async function saveMappings() {
        await run(async () => {
            const reply = await api('/api/gift-animations', { giftAnimations: readMappings() });
            state.mappings = Array.isArray(reply.giftAnimations) ? reply.giftAnimations : [];
            const snapshot = await fetch('/api/gif-manager').then(parseResponse);
            applySnapshot(snapshot);
            setMessage('Gift mappings saved.');
        });
    }

    /* ── wiring ──────────────────────────────────────────── */
    if (ui.upload) ui.upload.addEventListener('click', uploadGif);
    if (ui.download) ui.download.addEventListener('click', downloadGif);
    if (ui.refresh) ui.refresh.addEventListener('click', load);
    if (ui.mappingsRefresh) ui.mappingsRefresh.addEventListener('click', load);
    if (ui.mappingsSave) ui.mappingsSave.addEventListener('click', saveMappings);
    if (ui.previewClose) ui.previewClose.addEventListener('click', () => { ui.previewCard.hidden = true; });
    if (ui.search) ui.search.addEventListener('input', renderLibrary);
    if (ui.filter) ui.filter.addEventListener('change', renderLibrary);
    if (ui.mappingsSearch) {
        ui.mappingsSearch.addEventListener('input', () => applyMappingFilter(ui.mappingsSearch.value.trim().toLowerCase()));
    }

    document.querySelectorAll('.tab-btn').forEach(button => {
        if (button.dataset.tab !== 'gifs') return;
        button.addEventListener('click', () => {
            if (!state.snapshot) load();
        });
    });

    // A newly saved mapping in the legacy card should refresh this view too.
    if (window.giftAnimationsSavedHook === undefined) {
        window.giftAnimationsSavedHook = true;
    }
})();
