(function () {
    'use strict';

    const API = '/api/voice';
    const HEADERS = { 'x-control-panel': '1' };
    const CATEGORIES = [
        ['welcome', 'Welcome'],
        ['gift', 'Gift'],
        ['follow', 'Follow'],
        ['share', 'Share'],
        ['vip', 'VIP'],
        ['topdj', 'TOP DJ'],
        ['random', 'Random MC']
    ];
    const $ = id => document.getElementById(id);

    const state = {
        config: null,
        providers: [],
        status: null,
        overrides: [],
        category: 'welcome',
        loading: false,
        poll: null,
        previewUrl: ''
    };

    function setMessage(text, error = false) {
        const node = $('voice-message');
        if (!node) return;
        node.textContent = text || '';
        node.style.color = error ? 'var(--danger)' : '';
    }

    function setValue(id, value) {
        const node = $(id);
        if (node) node.value = value;
    }

    function setChecked(id, value) {
        const node = $(id);
        if (node) node.checked = Boolean(value);
    }

    function numberValue(id, fallback) {
        const value = Number($(id)?.value);
        return Number.isFinite(value) ? value : fallback;
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

    function providerById(id) {
        return state.providers.find(provider => provider.id === id) || state.providers[0] || null;
    }

    function populateProviders(selected) {
        const select = $('voice-provider');
        if (!select) return;
        select.replaceChildren(...state.providers.map(provider => {
            const option = document.createElement('option');
            option.value = provider.id;
            option.textContent = `${provider.label}${provider.status?.available ? '' : ' — unavailable'}`;
            return option;
        }));
        select.value = selected || state.config?.provider || 'kokoro';
    }

    function populateVoices(providerId, selected, gender) {
        const select = $('voice-voice');
        if (!select) return;
        const provider = providerById(providerId);
        const voices = provider?.voices || [];
        select.replaceChildren(...voices.map(voice => {
            const option = document.createElement('option');
            option.value = voice.id;
            option.textContent = `${voice.label}${voice.gender === 'female' ? ' (F)' : ' (M)'}`;
            return option;
        }));
        const match = voices.find(voice => voice.id === selected) ||
            voices.find(voice => voice.gender === gender) || voices[0];
        if (match) select.value = match.id;
    }

    function populateFields() {
        const config = state.config;
        if (!config) return;
        setChecked('voice-enabled', config.enabled);
        populateProviders(config.provider);
        setValue('voice-gender', config.voiceGender);
        populateVoices(config.provider, config.voice, config.voiceGender);
        setValue('voice-persona', config.persona);
        setValue('voice-speed', config.speed);
        setValue('voice-volume', config.volume);
        setValue('voice-duck-level', config.duckLevel);
        setValue('voice-duck-fade', config.duckFadeMs);
        for (const key of ['welcome', 'gift', 'follow', 'share', 'vip', 'topdj', 'random']) {
            setChecked(`voice-event-${key}`, config.events?.[key] !== false);
        }
        setValue('voice-max-queue', config.maxQueue);
        setValue('voice-expire', config.expireMs);
        setValue('voice-random-min', config.random?.minSeconds);
        setValue('voice-random-max', config.random?.maxSeconds);
        document.querySelectorAll('[data-voice-cooldown]').forEach(input => {
            input.value = config.cooldownsMs?.[input.dataset.voiceCooldown] ?? 0;
        });
        setValue('voice-username-mode', config.username?.mode || 'smart');
        setValue('voice-username-max-chars', config.username?.maxChars || 40);
        setValue('voice-username-max-words', config.username?.maxWords || 8);
        state.overrides = Array.isArray(config.pronunciations) ? config.pronunciations.slice() : [];
        renderOverrides();
        renderDialogueCategoryOptions();
        renderDialogues();
        syncRangeLabels();
        renderStatus();
    }

    function syncRangeLabels() {
        const speed = numberValue('voice-speed', 1);
        const volume = numberValue('voice-volume', 1);
        const duck = numberValue('voice-duck-level', 0.22);
        const fade = numberValue('voice-duck-fade', 350);
        setValue('voice-speed-value', `${speed.toFixed(2)}×`);
        setValue('voice-volume-value', `${Math.round(volume * 100)}%`);
        setValue('voice-duck-level-value', `${Math.round(duck * 100)}%`);
        setValue('voice-duck-fade-value', `${Math.round(fade)} ms`);
    }

    function renderDialogueCategoryOptions() {
        const select = $('voice-dialogue-category');
        if (!select) return;
        select.replaceChildren(...CATEGORIES.map(([value, label]) => {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = label;
            return option;
        }));
        if (!CATEGORIES.some(([value]) => value === state.category)) state.category = 'welcome';
        select.value = state.category;
    }

    function currentDialogueLines() {
        return Array.isArray(state.config?.dialogues?.[state.category])
            ? state.config.dialogues[state.category]
            : [];
    }

    function renderDialogues() {
        const host = $('voice-dialogues');
        if (!host) return;
        const lines = currentDialogueLines();
        const count = $('voice-dialogue-count');
        if (count) count.textContent = `${lines.filter(line => line.enabled !== false).length} enabled / ${lines.length} saved`;
        host.replaceChildren();
        if (!lines.length) {
            const empty = document.createElement('p');
            empty.className = 'muted';
            empty.textContent = 'No lines in this category. Add one, or save the shipped defaults from a category that still has them.';
            host.appendChild(empty);
            return;
        }
        lines.forEach((line, index) => {
            const row = document.createElement('div');
            row.className = `voice-dialogue-row${line.enabled === false ? ' off' : ''}`;
            row.dataset.index = String(index);

            const enabled = document.createElement('input');
            enabled.type = 'checkbox';
            enabled.checked = line.enabled !== false;
            enabled.title = 'Enable this dialogue variation';
            enabled.addEventListener('change', () => {
                line.enabled = enabled.checked;
                row.classList.toggle('off', !enabled.checked);
                renderDialogues();
            });

            const input = document.createElement('input');
            input.type = 'text';
            input.value = line.text || '';
            input.maxLength = 260;
            input.placeholder = 'English (US) dialogue with {name}, {gift}, {diamonds}';
            input.addEventListener('input', () => { line.text = input.value; });

            const actions = document.createElement('div');
            actions.className = 'voice-dialogue-actions';
            const preview = document.createElement('button');
            preview.type = 'button';
            preview.className = 'voice-icon-btn';
            preview.title = 'Preview this line in the browser';
            preview.textContent = '🔊';
            preview.addEventListener('click', () => previewDialogue(line.text));
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'voice-icon-btn danger';
            remove.title = 'Delete this line';
            remove.textContent = '🗑';
            remove.addEventListener('click', () => {
                lines.splice(index, 1);
                renderDialogues();
            });
            actions.append(preview, remove);
            row.append(enabled, input, actions);
            host.appendChild(row);
        });
    }

    function addDialogue() {
        if (!state.config) return;
        state.config.dialogues = state.config.dialogues || {};
        const lines = Array.isArray(state.config.dialogues[state.category])
            ? state.config.dialogues[state.category]
            : [];
        const next = lines.length + 1;
        lines.push({
            id: `${state.category}-custom-${Date.now()}`,
            text: '',
            enabled: true
        });
        state.config.dialogues[state.category] = lines;
        renderDialogues();
        const host = $('voice-dialogues');
        const inputs = host?.querySelectorAll('input[type="text"]');
        inputs?.[inputs.length - 1]?.focus();
        setMessage(`Added variation ${next}; write an English line and save.`);
    }

    function renderOverrides() {
        const host = $('voice-pronunciations');
        if (!host) return;
        host.replaceChildren();
        if (!state.overrides.length) {
            const empty = document.createElement('span');
            empty.className = 'muted';
            empty.textContent = 'No manual overrides yet.';
            host.appendChild(empty);
            return;
        }
        state.overrides.forEach((item, index) => {
            const chip = document.createElement('span');
            chip.className = 'voice-override-chip';
            const name = document.createElement('strong');
            name.textContent = `@${item.username}`;
            const spoken = document.createElement('span');
            spoken.textContent = `→ ${item.spoken}`;
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.title = 'Remove override';
            remove.textContent = '×';
            remove.addEventListener('click', () => {
                state.overrides.splice(index, 1);
                renderOverrides();
            });
            chip.append(name, spoken, remove);
            host.appendChild(chip);
        });
    }

    function addOverride() {
        const username = $('voice-override-username')?.value.trim().replace(/^@+/, '');
        const spoken = $('voice-override-spoken')?.value.trim();
        if (!username || !spoken) {
            setMessage('Enter both the original username and how it should be spoken.', true);
            return;
        }
        const existing = state.overrides.find(item => item.username.toLowerCase() === username.toLowerCase());
        if (existing) existing.spoken = spoken;
        else state.overrides.push({ username, spoken });
        $('voice-override-username').value = '';
        $('voice-override-spoken').value = '';
        renderOverrides();
        setMessage(`Override added for @${username}. Save to persist it.`);
    }

    function collectConfig() {
        if (!state.config) throw new Error('Voice settings are still loading.');
        const dialogues = {};
        for (const [category] of CATEGORIES) {
            const lines = Array.isArray(state.config.dialogues?.[category])
                ? state.config.dialogues[category]
                : [];
            dialogues[category] = lines
                .map((line, index) => ({
                    id: line.id || `${category}-${index + 1}`,
                    text: String(line.text || '').trim(),
                    enabled: line.enabled !== false
                }))
                .filter(line => line.text);
        }

        const cooldownsMs = {};
        // The cooldown controls use data attributes, not ids; read the live values
        // directly so saving a dialogue edit cannot silently reset anti-spam policy.
        document.querySelectorAll('[data-voice-cooldown]').forEach(input => {
            cooldownsMs[input.dataset.voiceCooldown] = Math.max(0, Number(input.value) || 0);
        });

        return {
            ...state.config,
            enabled: $('voice-enabled')?.checked !== false,
            provider: $('voice-provider')?.value || state.config.provider,
            voice: $('voice-voice')?.value || state.config.voice,
            voiceGender: $('voice-gender')?.value || state.config.voiceGender,
            persona: $('voice-persona')?.value || state.config.persona,
            speed: numberValue('voice-speed', state.config.speed),
            volume: numberValue('voice-volume', state.config.volume),
            duckLevel: numberValue('voice-duck-level', state.config.duckLevel),
            duckFadeMs: numberValue('voice-duck-fade', state.config.duckFadeMs),
            maxQueue: numberValue('voice-max-queue', state.config.maxQueue),
            expireMs: numberValue('voice-expire', state.config.expireMs),
            random: {
                enabled: $('voice-event-random')?.checked !== false,
                minSeconds: numberValue('voice-random-min', state.config.random?.minSeconds || 150),
                maxSeconds: numberValue('voice-random-max', state.config.random?.maxSeconds || 300)
            },
            events: {
                welcome: $('voice-event-welcome')?.checked !== false,
                gift: $('voice-event-gift')?.checked !== false,
                follow: $('voice-event-follow')?.checked !== false,
                share: $('voice-event-share')?.checked !== false,
                vip: $('voice-event-vip')?.checked !== false,
                topdj: $('voice-event-topdj')?.checked !== false,
                random: $('voice-event-random')?.checked !== false
            },
            cooldownsMs,
            username: {
                mode: $('voice-username-mode')?.value || 'smart',
                maxChars: numberValue('voice-username-max-chars', 40),
                maxWords: numberValue('voice-username-max-words', 8)
            },
            dialogues,
            pronunciations: state.overrides.slice()
        };
    }

    async function saveConfig() {
        if (state.loading) return;
        state.loading = true;
        try {
            const payload = collectConfig();
            const result = await request(API, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ config: payload })
            });
            state.config = result.config;
            state.providers = result.providers || state.providers;
            state.status = result.status || state.status;
            populateFields();
            renderStatus();
            setMessage(result.message || 'Voice settings saved.');
        } catch (error) {
            setMessage(error.message, true);
        } finally {
            state.loading = false;
        }
    }

    async function load() {
        try {
            const result = await request(API);
            state.config = result.config;
            state.providers = result.providers || [];
            state.status = result.status || null;
            populateFields();
            setMessage('Voice settings loaded.');
        } catch (error) {
            setMessage(`Could not load voice settings: ${error.message}`, true);
        }
    }

    function statusText() {
        const status = state.status;
        if (!status) return;
        const engine = $('voice-status-engine');
        if (engine) {
            const info = status.providerStatus;
            const provider = providerById(status.provider);
            engine.textContent = `${provider?.label || status.provider || '—'} — ${info?.available ? (info.loaded ? 'ready' : 'available') : 'unavailable'}`;
        }
        const current = $('voice-status-current');
        if (current) {
            current.textContent = status.current?.text || 'Idle';
            current.classList.toggle('speaking', Boolean(status.current));
        }
        const queue = $('voice-status-queue');
        if (queue) queue.textContent = String(status.queueSize || 0);
        const ack = $('voice-status-ack');
        if (ack) {
            ack.textContent = status.lastAck
                ? `${status.lastAck.ok ? 'Playing' : 'Error'} — ${new Date(status.lastAck.at).toLocaleTimeString()}`
                : 'No playback acknowledged yet.';
        }
        const error = $('voice-status-error');
        if (error) {
            error.textContent = status.lastError || 'None';
            error.classList.toggle('has-error', Boolean(status.lastError));
        }
    }

    function renderStatus() {
        statusText();
    }

    async function refreshStatus() {
        try {
            const response = await fetch(API, { headers: HEADERS, cache: 'no-store' });
            if (!response.ok) return;
            const data = await response.json();
            state.status = data.status;
            if (data.providers) state.providers = data.providers;
            statusText();
        } catch { /* bridge may be restarting */ }
    }

    function playAudio(url) {
        const audio = $('voice-preview-audio');
        if (!audio || !url) return;
        if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
        state.previewUrl = '';
        audio.src = `${url}?t=${Date.now()}`;
        audio.play().catch(error => setMessage(`Browser could not play the preview: ${error.message}`, true));
    }

    async function previewText(text) {
        try {
            const result = await request(`${API}/preview`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text,
                    provider: $('voice-provider')?.value,
                    voice: $('voice-voice')?.value,
                    voiceGender: $('voice-gender')?.value,
                    speed: numberValue('voice-speed', 1)
                })
            });
            playAudio(result.audioUrl);
            setMessage(`Preview: ${result.provider} / ${result.voice}${result.durationMs ? ` · ${(result.durationMs / 1000).toFixed(1)}s` : ''}`);
        } catch (error) {
            setMessage(error.message, true);
        }
    }

    function previewDialogue(text) {
        if (!text) {
            setMessage('Write a dialogue line first.', true);
            return;
        }
        const rendered = String(text)
            .replace(/\{name\}/gi, 'Alex')
            .replace(/\{gift\}/gi, 'Rose')
            .replace(/\{diamonds\}/gi, '100');
        return previewText(rendered);
    }

    async function pronounceTest() {
        const username = $('voice-username-test')?.value.trim();
        if (!username) {
            setMessage('Type a username to test its pronunciation.', true);
            return;
        }
        try {
            const result = await request(`${API}/pronounce`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username })
            });
            const node = $('voice-pronounced');
            if (node) {
                const pronunciation = result.pronunciation;
                node.textContent = `“${pronunciation.spoken}”${pronunciation.overridden ? ' (manual override)' : ''}${pronunciation.truncated ? ' — shortened' : ''}`;
                node.classList.remove('empty');
            }
            return result.pronunciation;
        } catch (error) {
            setMessage(error.message, true);
            return null;
        }
    }

    async function previewUsername() {
        const pronunciation = await pronounceTest();
        if (pronunciation) await previewText(`${pronunciation.spoken}!`);
    }

    async function testVoice() {
        try {
            const result = await request(`${API}/test`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text: $('voice-test-text')?.value.trim() || undefined,
                    username: $('voice-username-test')?.value.trim() || undefined
                })
            });
            state.status = result.status || state.status;
            renderStatus();
            setMessage('Test announcement queued for Unity and the stream audio path.');
        } catch (error) {
            setMessage(error.message, true);
        }
    }

    async function stopVoice() {
        try {
            const result = await request(`${API}/stop`, { method: 'POST' });
            state.status = result.status || state.status;
            renderStatus();
            setMessage('Current voice announcement stopped.');
        } catch (error) {
            setMessage(error.message, true);
        }
    }

    async function clearQueue() {
        try {
            const result = await request(`${API}/clear`, { method: 'POST' });
            state.status = result.status || state.status;
            renderStatus();
            setMessage(`Cleared ${result.cleared} pending announcement(s).`);
        } catch (error) {
            setMessage(error.message, true);
        }
    }

    function wire() {
        $('voice-save')?.addEventListener('click', saveConfig);
        $('voice-save-name')?.addEventListener('click', saveConfig);
        $('voice-dialogue-add')?.addEventListener('click', addDialogue);
        $('voice-dialogue-category')?.addEventListener('change', event => {
            state.category = event.target.value;
            renderDialogues();
        });
        $('voice-override-add')?.addEventListener('click', addOverride);
        $('voice-pronounce')?.addEventListener('click', pronounceTest);
        $('voice-preview-username')?.addEventListener('click', previewUsername);
        $('voice-preview')?.addEventListener('click', () => previewText($('voice-test-text')?.value.trim()));
        $('voice-test')?.addEventListener('click', testVoice);
        $('voice-stop')?.addEventListener('click', stopVoice);
        $('voice-clear')?.addEventListener('click', clearQueue);
        $('voice-speed')?.addEventListener('input', syncRangeLabels);
        $('voice-volume')?.addEventListener('input', syncRangeLabels);
        $('voice-duck-level')?.addEventListener('input', syncRangeLabels);
        $('voice-duck-fade')?.addEventListener('input', syncRangeLabels);
        $('voice-provider')?.addEventListener('change', event => {
            populateVoices(event.target.value, '', $('voice-gender')?.value || 'male');
        });
        $('voice-gender')?.addEventListener('change', event => {
            populateVoices($('voice-provider')?.value, '', event.target.value);
        });
        $('voice-username-test')?.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                pronounceTest();
            }
        });
        document.querySelectorAll('.tab-btn').forEach(button => {
            if (button.dataset.tab !== 'voice') return;
            button.addEventListener('click', () => {
                if (!state.config) load();
                refreshStatus();
            });
        });
        state.poll = setInterval(() => {
            if (document.getElementById('tab-voice')?.classList.contains('active')) refreshStatus();
        }, 3000);
    }

    wire();
    load();
})();
