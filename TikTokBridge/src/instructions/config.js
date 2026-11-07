'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_LINES = 30;
const MAX_FILE_BYTES = 64 * 1024;
const POSITIONS = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'top-center', 'bottom-center'];
const BUILTIN_ICONS = [
    'zoom', 'change', 'walk', 'ruler', 'crown', 'fire',
    'gift', 'heart', 'star', 'music', 'mic', 'dice', 'image'
];
const ICON_FILE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}\.png$/;
const LINE_ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

function defaultInstructionConfig() {
    return {
        version: 1,
        revision: 0,
        position: 'top-right',
        marginX: 26,
        marginY: 92,
        fontSize: 34,
        iconSize: 44,
        lineSpacing: 10,
        panelWidth: 500,
        opacity: 0.58,
        maxVisibleLines: 6,
        scroll: true,
        lines: [
            line('zoom-guide', 'ZOOM CAMERA', 'Send a Rose to zoom in', 'zoom', '#FFFFFF', '#FFD54A'),
            line('change-guide', 'CHANGE CHARACTER', 'TikTok gift changes the dancer', 'change', '#FFFFFF', '#67E8F9'),
            line('walk-guide', 'WALK AROUND', 'Finger Heart makes the dancer walk', 'walk', '#FFFFFF', '#4ADE80'),
            line('ruler-guide', 'BIG CHARACTER', 'Big Heart grows the dancer', 'ruler', '#FFFFFF', '#F9A8D4'),
            line('topdj-guide', 'TOP DJ', 'Electro gift takes the DJ stage', 'crown', '#FFFFFF', '#FDE047'),
            line('vip-guide', 'VIP LIGHT SHOW', 'VIP gifts trigger the spotlight', 'fire', '#FFFFFF', '#FB7185')
        ]
    };
}

function line(id, title, subtitle, icon, textColor, iconColor, enabled = true, highlight = false) {
    return { id, title, subtitle, icon, iconFile: '', textColor, iconColor, enabled, highlight };
}

function cleanText(value, maxLength) {
    return String(value ?? '')
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLength);
}

function clampNumber(value, fallback, minimum, maximum, integer = false) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    const clamped = Math.min(maximum, Math.max(minimum, number));
    return integer ? Math.round(clamped) : Math.round(clamped * 100) / 100;
}

function cleanColor(value, fallback) {
    return COLOR_PATTERN.test(String(value || '')) ? String(value).toUpperCase() : fallback;
}

function cleanIcon(value) {
    const icon = String(value || '').trim().toLowerCase();
    return BUILTIN_ICONS.includes(icon) ? icon : 'image';
}

function cleanIconFile(value) {
    const file = String(value || '').trim().toLowerCase();
    return ICON_FILE_PATTERN.test(file) ? file : '';
}

function sanitizeInstructionConfig(input) {
    const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const inputLines = Array.isArray(source.lines) ? source.lines : [];
    if (inputLines.length > MAX_LINES) {
        return { error: `Too many instruction lines. The maximum is ${MAX_LINES}.` };
    }

    const usedIds = new Set();
    const lines = [];
    for (let index = 0; index < inputLines.length; index += 1) {
        const inputLine = inputLines[index];
        if (!inputLine || typeof inputLine !== 'object' || Array.isArray(inputLine)) continue;

        const title = cleanText(inputLine.title, 60);
        const subtitle = cleanText(inputLine.subtitle, 90);
        if (!title && !subtitle) continue;

        const icon = cleanIcon(inputLine.icon);
        const iconFile = icon === 'image' ? cleanIconFile(inputLine.iconFile) : '';
        let id = String(inputLine.id || '').trim();
        if (!LINE_ID_PATTERN.test(id)) id = `line-${index + 1}`;
        if (usedIds.has(id)) id = `${id}-${index + 1}`;
        while (usedIds.has(id)) id = `${id}-${index + 1}`;
        usedIds.add(id);

        lines.push({
            id,
            title,
            subtitle,
            icon,
            iconFile,
            textColor: cleanColor(inputLine.textColor, '#FFFFFF'),
            iconColor: cleanColor(inputLine.iconColor, '#FFD54A'),
            enabled: inputLine.enabled !== false,
            highlight: inputLine.highlight === true
        });
    }

    const value = {
        version: 1,
        revision: clampNumber(source.revision, 0, 0, 1000000, true),
        position: POSITIONS.includes(String(source.position)) ? String(source.position) : 'top-right',
        marginX: clampNumber(source.marginX, 26, 0, 200, true),
        marginY: clampNumber(source.marginY, 92, 0, 240, true),
        fontSize: clampNumber(source.fontSize, 34, 20, 60, true),
        iconSize: clampNumber(source.iconSize, 44, 24, 80, true),
        lineSpacing: clampNumber(source.lineSpacing, 10, 0, 30, true),
        panelWidth: clampNumber(source.panelWidth, 500, 200, 720, true),
        opacity: clampNumber(source.opacity, 0.58, 0, 0.9),
        maxVisibleLines: clampNumber(source.maxVisibleLines, 6, 1, 20, true),
        scroll: source.scroll !== false,
        lines
    };
    return { value };
}

async function loadInstructionConfig(filePath) {
    let content;
    try {
        const info = await fs.stat(filePath);
        if (!info.isFile() || info.size > MAX_FILE_BYTES) {
            return { config: defaultInstructionConfig(), error: 'Instruction config is too large or not a file.' };
        }
        content = await fs.readFile(filePath, 'utf8');
    } catch (error) {
        if (error.code !== 'ENOENT') {
            return { config: defaultInstructionConfig(), error: error.message };
        }
        const config = defaultInstructionConfig();
        await saveInstructionConfig(filePath, config);
        return { config };
    }

    let parsed;
    try {
        parsed = JSON.parse(content);
    } catch {
        return { config: defaultInstructionConfig(), error: 'Instruction config is not valid JSON.' };
    }
    const result = sanitizeInstructionConfig(parsed);
    if (result.error) return { config: defaultInstructionConfig(), error: result.error };
    return { config: result.value };
}

async function saveInstructionConfig(filePath, config) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function instructionMessage(config) {
    return { type: 'instruction_config', config };
}

module.exports = {
    MAX_LINES,
    POSITIONS,
    BUILTIN_ICONS,
    ICON_FILE_PATTERN,
    defaultInstructionConfig,
    sanitizeInstructionConfig,
    loadInstructionConfig,
    saveInstructionConfig,
    instructionMessage
};
