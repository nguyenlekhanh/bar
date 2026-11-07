'use strict';

const { DIALOGUE_CATEGORIES, AUTONOMOUS_CATEGORIES, DEFAULT_DIALOGUES } = require('./defaults');

const MAX_LINES_PER_CATEGORY = 50;
const MAX_DIALOGUE_LENGTH = 260;
const ALLOWED_PLACEHOLDERS = new Set(['name', 'gift', 'diamonds']);

function cleanDialogueText(value) {
    return String(value ?? '')
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\r?\n+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_DIALOGUE_LENGTH);
}

function sanitizeDialogueText(value) {
    return cleanDialogueText(value).replace(/\{([^{}]+)\}/g, (whole, name) =>
        ALLOWED_PLACEHOLDERS.has(String(name).trim().toLowerCase()) ? `{${String(name).trim().toLowerCase()}}` : ''
    );
}

function dialogueId(value, fallback) {
    const id = String(value || '')
        .trim()
        .replace(/[^A-Za-z0-9_-]/g, '-')
        .slice(0, 64);
    return id || fallback;
}

function sanitizeDialogues(input) {
    const output = {};
    for (const category of DIALOGUE_CATEGORIES) {
        // A missing category is a legacy settings file (or a newly shipped
        // category); use its shipped seed. An explicitly empty category stays
        // empty so an operator can intentionally disable a whole pool.
        const source = input && Object.prototype.hasOwnProperty.call(input, category)
            ? (Array.isArray(input[category]) ? input[category] : [])
            : (DEFAULT_DIALOGUES[category] || []);
        const seen = new Set();
        const lines = [];
        for (const item of source) {
            const text = sanitizeDialogueText(item?.text);
            if (!text) continue;
            const id = dialogueId(item?.id, `${category}-${lines.length + 1}`);
            if (seen.has(id)) continue;
            seen.add(id);
            lines.push({ id, text, enabled: item?.enabled !== false });
            if (lines.length >= MAX_LINES_PER_CATEGORY) break;
        }
        output[category] = lines;
    }
    return output;
}

function renderDialogue(template, values = {}) {
    const name = String(values.name || 'TikTok friend').trim() || 'TikTok friend';
    const gift = String(values.gift || 'gift').trim() || 'gift';
    const diamonds = Math.max(0, Math.floor(Number(values.diamonds) || 0));
    return cleanDialogueText(
        String(template || '')
            .replace(/\{name\}/gi, name)
            .replace(/\{gift\}/gi, gift)
            .replace(/\{diamonds\}/gi, diamonds ? String(diamonds) : '')
    );
}

function enabledLines(dialogues, category) {
    return Array.isArray(dialogues?.[category])
        ? dialogues[category].filter(line => line.enabled !== false && cleanDialogueText(line.text))
        : [];
}

/**
 * Picks a line without repeating the immediately previous line in the same
 * category. Persona changes the random pool so VIP HOST does not sound like a
 * generic floor host.
 */
function chooseDialogue(dialogues, category, options = {}) {
    const requestedCategory = DIALOGUE_CATEGORIES.includes(category) ? category : 'random';
    let pool = enabledLines(dialogues, requestedCategory);

    if (requestedCategory === 'random' && options.persona === 'vip') {
        const vip = enabledLines(dialogues, 'vip');
        if (vip.length) pool = vip;
    } else if (requestedCategory === 'random' && options.persona === 'friendly') {
        const welcome = enabledLines(dialogues, 'welcome');
        const random = enabledLines(dialogues, 'random');
        pool = [...welcome, ...random];
    }

    if (!pool.length) return null;
    const previous = options.previousId ? String(options.previousId) : '';
    const candidates = pool.length > 1 ? pool.filter(line => line.id !== previous) : pool;
    const selected = candidates[Math.floor(Math.random() * candidates.length)] || pool[0];
    return selected ? { ...selected } : null;
}

function chooseDialogueFromCategories(dialogues, categories, options = {}) {
    const allowed = (Array.isArray(categories) ? categories : [])
        .filter(category => AUTONOMOUS_CATEGORIES.includes(category));
    let pool = allowed.flatMap(category => enabledLines(dialogues, category));
    // Autonomous lines must stand on their own without inventing a viewer or
    // gift. Placeholder-only lines belong to event announcements.
    pool = pool.filter(line => !/\{(name|gift|diamonds)\}/i.test(line.text));
    if (!pool.length) {
        pool = AUTONOMOUS_CATEGORIES.flatMap(category => enabledLines(dialogues, category))
            .filter(line => !/\{(name|gift|diamonds)\}/i.test(line.text));
    }
    if (!pool.length) return null;
    const previous = options.previousId ? String(options.previousId) : '';
    const candidates = pool.length > 1 ? pool.filter(line => line.id !== previous) : pool;
    const selected = candidates[Math.floor(Math.random() * candidates.length)] || pool[0];
    return selected ? { ...selected } : null;
}

function defaultDialogueConfig() {
    return sanitizeDialogues(DEFAULT_DIALOGUES);
}

module.exports = {
    DIALOGUE_CATEGORIES,
    MAX_LINES_PER_CATEGORY,
    sanitizeDialogueText,
    sanitizeDialogues,
    renderDialogue,
    chooseDialogue,
    chooseDialogueFromCategories,
    enabledLines,
    defaultDialogueConfig
};
