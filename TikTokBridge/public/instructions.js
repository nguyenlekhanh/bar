/* Live Instruction Overlay — control tab.
   Uses the same control WebSocket and control-panel REST guards as the rest
   of the dashboard. Overlay clients never receive these controls. */
(() => {
    const MAX_LINES = 30;
    const MAX_ICON_BYTES = 256 * 1024;
    const ICONS = [
        { id: 'zoom', glyph: '🔍', label: 'Zoom camera' },
        { id: 'change', glyph: '🔄', label: 'Change character' },
        { id: 'walk', glyph: '🚶', label: 'Walk around' },
        { id: 'ruler', glyph: '📏', label: 'Big character' },
        { id: 'crown', glyph: '👑', label: 'Top DJ' },
        { id: 'fire', glyph: '🔥', label: 'VIP light show' },
        { id: 'gift', glyph: '🎁', label: 'Gift' },
        { id: 'heart', glyph: '❤️', label: 'Heart' },
        { id: 'star', glyph: '⭐', label: 'Star' },
        { id: 'music', glyph: '🎵', label: 'Music' },
        { id: 'mic', glyph: '🎤', label: 'Microphone' },
        { id: 'dice', glyph: '🎲', label: 'Dice' },
        { id: 'image', glyph: '🖼', label: 'Image / custom' },
    ];
    const ICON_BY_ID = new Map(ICONS.map(icon => [icon.id, icon]));

    const els = {
        position: document.getElementById('instruction-position'),
        width: document.getElementById('instruction-width'),
        font: document.getElementById('instruction-font'),
        iconSize: document.getElementById('instruction-icon-size'),
        spacing: document.getElementById('instruction-spacing'),
        marginX: document.getElementById('instruction-margin-x'),
        marginY: document.getElementById('instruction-margin-y'),
        maxLines: document.getElementById('instruction-max-lines'),
        opacity: document.getElementById('instruction-opacity'),
        opacityValue: document.getElementById('instruction-opacity-value'),
        scroll: document.getElementById('instruction-scroll'),
        lines: document.getElementById('instruction-lines'),
        template: document.getElementById('instruction-line-template'),
        add: document.getElementById('instruction-add'),
        save: document.getElementById('instruction-save'),
        preview: document.getElementById('instruction-preview'),
        previewButton: document.getElementById('instruction-preview-btn'),
        message: document.getElementById('instruction-message'),
        count: document.getElementById('instruction-count'),
        empty: document.getElementById('instruction-empty'),
    };
    if (!els.lines) return;

    const state = { dirty: false, dragRow: null, config: null };

    function defaultConfig() {
        return {
            position: 'top-right', marginX: 26, marginY: 92,
            fontSize: 34, iconSize: 44, lineSpacing: 10, panelWidth: 500,
            opacity: 0.58, maxVisibleLines: 6, scroll: true, lines: [],
        };
    }

    function clamp(value, minimum, maximum, fallback) {
        const number = Number(value);
        if (!Number.isFinite(number)) return fallback;
        return Math.min(maximum, Math.max(minimum, number));
    }

    function setMessage(text, error = false) {
        els.message.textContent = text || '';
        els.message.classList.toggle('error', error);
    }

    function makeId() {
        return `line-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    }

    function colorValue(value, fallback) {
        return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value) : fallback;
    }

    function fillIconOptions(select, icon, iconFile) {
        const previous = select.value;
        select.replaceChildren();
        for (const item of ICONS) {
            const option = document.createElement('option');
            option.value = item.id;
            option.textContent = `${item.glyph} ${item.label}`;
            select.append(option);
        }
        if (iconFile) {
            const option = document.createElement('option');
            option.value = `custom:${iconFile}`;
            option.textContent = `🖼 Custom: ${iconFile}`;
            select.append(option);
        }
        const wanted = iconFile ? `custom:${iconFile}` : (icon || 'image');
        select.value = [...select.options].some(option => option.value === wanted) ? wanted : previous || 'image';
    }

    function updateCustomPreview(row) {
        const image = row.querySelector('[data-field="custom-preview"]');
        const select = row.querySelector('[data-field="icon"]');
        const custom = String(select.value || '').startsWith('custom:');
        if (!image) return;
        if (!custom) {
            image.hidden = true;
            image.removeAttribute('src');
            return;
        }
        image.hidden = false;
        image.src = `/assets/instruction-icons/${encodeURIComponent(select.value.slice(7))}`;
    }

    function markDirty() {
        state.dirty = true;
        updateCount();
        renderPreview();
    }

    function updateCount() {
        const count = els.lines.querySelectorAll('.instruction-line').length;
        els.count.textContent = `${count} / ${MAX_LINES}`;
        els.empty.classList.toggle('is-visible', count === 0);
    }

    function createRow(line = {}) {
        const row = els.template.content.firstElementChild.cloneNode(true);
        row.dataset.id = line.id || makeId();
        const title = row.querySelector('[data-field="title"]');
        const subtitle = row.querySelector('[data-field="subtitle"]');
        const select = row.querySelector('[data-field="icon"]');
        const textColor = row.querySelector('[data-field="textColor"]');
        const iconColor = row.querySelector('[data-field="iconColor"]');
        const enabled = row.querySelector('[data-field="enabled"]');
        const highlight = row.querySelector('[data-field="highlight"]');

        title.value = line.title || '';
        subtitle.value = line.subtitle || '';
        fillIconOptions(select, line.icon || 'image', line.iconFile || '');
        textColor.value = colorValue(line.textColor, '#ffffff');
        iconColor.value = colorValue(line.iconColor, '#ffd54a');
        enabled.checked = line.enabled !== false;
        highlight.checked = line.highlight === true;
        row.classList.toggle('is-disabled', !enabled.checked);
        row.classList.toggle('is-highlight', highlight.checked);

        select.addEventListener('change', () => {
            if (!String(select.value).startsWith('custom:')) fillIconOptions(select, select.value, '');
            updateCustomPreview(row);
            markDirty();
        });
        [title, subtitle, textColor, iconColor].forEach(input => {
            input.addEventListener('input', markDirty);
            input.addEventListener('change', markDirty);
        });
        enabled.addEventListener('change', () => {
            row.classList.toggle('is-disabled', !enabled.checked);
            markDirty();
        });
        highlight.addEventListener('change', () => {
            row.classList.toggle('is-highlight', highlight.checked);
            markDirty();
        });

        row.querySelector('[data-command="delete"]').addEventListener('click', () => {
            row.remove();
            updateCount();
            markDirty();
        });

        const fileInput = row.querySelector('[data-command="file"]');
        row.querySelector('[data-command="upload"]').addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', () => uploadIcon(row, fileInput));

        const handle = row.querySelector('.instruction-drag');
        handle.addEventListener('dragstart', event => {
            state.dragRow = row;
            row.classList.add('is-dragging');
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', row.dataset.id);
        });
        handle.addEventListener('dragend', () => {
            state.dragRow = null;
            row.classList.remove('is-dragging');
            markDirty();
        });
        row.addEventListener('dragover', event => {
            if (!state.dragRow || state.dragRow === row) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
        });
        row.addEventListener('drop', event => {
            event.preventDefault();
            if (!state.dragRow || state.dragRow === row) return;
            const before = event.clientY < row.getBoundingClientRect().top + row.offsetHeight / 2;
            els.lines.insertBefore(state.dragRow, before ? row : row.nextSibling);
            markDirty();
        });

        updateCustomPreview(row);
        return row;
    }

    function renderConfig(config) {
        const source = config && typeof config === 'object' ? config : defaultConfig();
        state.config = source;
        state.dirty = false;
        els.position.value = source.position || 'top-right';
        els.width.value = clamp(source.panelWidth, 200, 720, 500);
        els.font.value = clamp(source.fontSize, 20, 60, 34);
        els.iconSize.value = clamp(source.iconSize, 24, 80, 44);
        els.spacing.value = clamp(source.lineSpacing, 0, 30, 10);
        els.marginX.value = clamp(source.marginX, 0, 200, 26);
        els.marginY.value = clamp(source.marginY, 0, 240, 92);
        els.maxLines.value = clamp(source.maxVisibleLines, 1, 20, 6);
        els.opacity.value = clamp(source.opacity, 0, 0.9, 0.58);
        els.opacityValue.textContent = `${Math.round(Number(els.opacity.value) * 100)}%`;
        els.scroll.checked = source.scroll !== false;

        const lines = Array.isArray(source.lines) ? source.lines.slice(0, MAX_LINES) : [];
        els.lines.replaceChildren(...lines.map(createRow));
        updateCount();
        renderPreview();
    }

    function readConfig() {
        const lines = [...els.lines.querySelectorAll('.instruction-line')].map(row => {
            const iconValue = row.querySelector('[data-field="icon"]').value;
            const custom = iconValue.startsWith('custom:');
            return {
                id: row.dataset.id,
                title: row.querySelector('[data-field="title"]').value.trim(),
                subtitle: row.querySelector('[data-field="subtitle"]').value.trim(),
                icon: custom ? 'image' : iconValue,
                iconFile: custom ? iconValue.slice(7) : '',
                textColor: row.querySelector('[data-field="textColor"]').value,
                iconColor: row.querySelector('[data-field="iconColor"]').value,
                enabled: row.querySelector('[data-field="enabled"]').checked,
                highlight: row.querySelector('[data-field="highlight"]').checked,
            };
        }).filter(line => line.title || line.subtitle);
        return {
            position: els.position.value,
            marginX: clamp(els.marginX.value, 0, 200, 26),
            marginY: clamp(els.marginY.value, 0, 240, 92),
            fontSize: clamp(els.font.value, 20, 60, 34),
            iconSize: clamp(els.iconSize.value, 24, 80, 44),
            lineSpacing: clamp(els.spacing.value, 0, 30, 10),
            panelWidth: clamp(els.width.value, 200, 720, 500),
            opacity: clamp(els.opacity.value, 0, 0.9, 0.58),
            maxVisibleLines: clamp(els.maxLines.value, 1, 20, 6),
            scroll: els.scroll.checked,
            lines,
        };
    }

    function renderPreview() {
        if (!els.preview) return;
        const config = readConfig();
        const frameWidth = els.preview.clientWidth || 320;
        const scale = frameWidth / 1080;
        const enabled = config.lines.filter(line => line.enabled);
        const visible = enabled.slice(0, config.maxVisibleLines);
        const marginX = config.marginX * scale;
        const marginY = config.marginY * scale;

        const panel = document.createElement('div');
        panel.className = 'instruction-preview-panel';
        panel.style.width = `${Math.min(config.panelWidth, 720) * scale}px`;
        panel.style.padding = `${Math.max(5, 13 * scale)}px`;
        panel.style.background = `rgba(3, 6, 18, ${config.opacity})`;
        if (config.position.includes('bottom')) panel.style.bottom = `${marginY}px`;
        else panel.style.top = `${marginY}px`;
        if (config.position.includes('left')) panel.style.left = `${marginX}px`;
        else if (config.position.includes('right')) panel.style.right = `${marginX}px`;
        else {
            panel.style.left = '50%';
            panel.style.transform = 'translateX(-50%)';
        }

        for (const line of visible) {
            const row = document.createElement('div');
            row.className = `instruction-preview-line${line.highlight ? ' is-highlight' : ''}`;
            row.style.color = line.iconColor;
            row.style.marginBottom = `${config.lineSpacing * scale}px`;
            const icon = document.createElement('span');
            icon.className = 'instruction-preview-icon';
            icon.style.width = `${config.iconSize * scale}px`;
            icon.style.fontSize = `${config.iconSize * scale}px`;
            icon.style.color = line.iconColor;
            if (line.iconFile) {
                const img = document.createElement('img');
                img.src = `/assets/instruction-icons/${encodeURIComponent(line.iconFile)}`;
                img.alt = '';
                img.style.width = '100%';
                img.style.height = '100%';
                img.style.objectFit = 'contain';
                icon.append(img);
            } else {
                icon.textContent = (ICON_BY_ID.get(line.icon) || ICON_BY_ID.get('image')).glyph;
            }

            const copy = document.createElement('div');
            copy.className = 'instruction-preview-copy';
            const title = document.createElement('div');
            title.className = 'instruction-preview-title';
            title.style.fontSize = `${Math.max(6, config.fontSize * scale)}px`;
            title.style.color = line.textColor;
            title.textContent = line.title || line.subtitle;
            copy.append(title);
            if (line.subtitle) {
                const subtitle = document.createElement('div');
                subtitle.className = 'instruction-preview-subtitle';
                subtitle.style.fontSize = `${Math.max(5, config.fontSize * 0.62 * scale)}px`;
                subtitle.style.color = line.textColor;
                subtitle.textContent = line.subtitle;
                copy.append(subtitle);
            }
            row.append(icon, copy);
            panel.append(row);
        }

        if (enabled.length > visible.length) {
            const more = document.createElement('span');
            more.className = 'instruction-preview-more';
            more.textContent = `+${enabled.length - visible.length} more${config.scroll ? ' · rotating' : ''}`;
            panel.append(more);
        }
        if (!enabled.length) {
            const empty = document.createElement('div');
            empty.className = 'instruction-preview-subtitle';
            empty.style.fontSize = '9px';
            empty.style.color = 'rgba(255,255,255,.55)';
            empty.textContent = 'No enabled lines';
            panel.append(empty);
        }
        els.preview.replaceChildren(panel);
    }

    async function uploadIcon(row, input) {
        const file = input.files && input.files[0];
        input.value = '';
        if (!file) return;
        if (file.type !== 'image/png' && !file.name.toLowerCase().endsWith('.png')) {
            return setMessage('Choose a PNG image.', true);
        }
        if (file.size > MAX_ICON_BYTES) {
            return setMessage('The icon is larger than 256 KB.', true);
        }
        setMessage('Uploading icon…');
        try {
            const response = await fetch('/api/instruction-icons', {
                method: 'POST',
                headers: { 'Content-Type': 'image/png', 'x-control-panel': '1' },
                body: await file.arrayBuffer(),
            });
            const body = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(body.error || 'Could not upload the icon.');
            const select = row.querySelector('[data-field="icon"]');
            fillIconOptions(select, 'image', body.file);
            select.value = `custom:${body.file}`;
            updateCustomPreview(row);
            markDirty();
            setMessage(`Uploaded ${body.file} (${body.width}×${body.height}).`);
        } catch (error) {
            setMessage(error.message, true);
        }
    }

    async function save() {
        const config = readConfig();
        if (!config.lines.length) {
            return setMessage('Add at least one instruction line before applying.', true);
        }
        setMessage('Saving instructions…');
        try {
            const response = await fetch('/api/instructions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-control-panel': '1' },
                body: JSON.stringify(config),
            });
            const body = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(body.error || 'Could not save the instructions.');
            renderConfig(body.config);
            const clients = Number(body.overlayClients) || 0;
            setMessage(clients
                ? `Saved and pushed to ${clients} Unity overlay${clients === 1 ? '' : 's'}.`
                : 'Saved. No Unity overlay is connected; it will receive this on reconnect.');
        } catch (error) {
            setMessage(error.message, true);
        }
    }

    async function load() {
        try {
            const response = await fetch('/api/instructions', { cache: 'no-store' });
            const body = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(body.error || 'Could not read instructions.');
            renderConfig(body.config);
            setMessage('Loaded. Changes preview locally until you press Save & apply.');
        } catch (error) {
            renderConfig(defaultConfig());
            setMessage(`Could not load instructions: ${error.message}`, true);
        }
    }

    els.add.addEventListener('click', () => {
        if (els.lines.querySelectorAll('.instruction-line').length >= MAX_LINES) {
            return setMessage(`The maximum is ${MAX_LINES} lines.`, true);
        }
        const row = createRow({ title: '', subtitle: '', icon: 'image', enabled: true });
        els.lines.append(row);
        updateCount();
        markDirty();
        row.querySelector('[data-field="title"]').focus();
    });
    els.save.addEventListener('click', save);
    els.previewButton.addEventListener('click', renderPreview);
    els.opacity.addEventListener('input', () => {
        els.opacityValue.textContent = `${Math.round(Number(els.opacity.value) * 100)}%`;
        markDirty();
    });
    [els.position, els.width, els.font, els.iconSize, els.spacing, els.marginX, els.marginY,
        els.maxLines, els.scroll].forEach(input => {
        input.addEventListener('input', markDirty);
        input.addEventListener('change', markDirty);
    });

    // A second dashboard updates through the bridge; never overwrite unsaved work silently.
    if (window.controlBridge && typeof window.controlBridge.onMessage === 'function') {
        window.controlBridge.onMessage(data => {
            if (!data || typeof data !== 'object') return;
            if (data.type === 'instruction_config') {
                // The initial config arrives on the same socket as the GET load;
                // it is not a change from another tab when the revision matches.
                if (state.config && Number(data.config?.revision) === Number(state.config.revision)) return;
                if (state.dirty) {
                    setMessage('Instructions changed in another Control tab. Your unsaved edits are kept — press Save & apply to overwrite.', true);
                    return;
                }
                renderConfig(data.config);
                setMessage('Instructions updated from another Control tab.');
            }
            if (data.type === 'instruction_saved') {
                renderConfig(data.config);
                setMessage(data.message || 'Instructions saved and applied.');
            }
        });
    }

    load();
})();
