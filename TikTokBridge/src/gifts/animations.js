'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

/**
 * Allow-listed animations.
 *
 * `effect` is the only thing the Unity overlay dispatches on, and it is owned by
 * this table — never by a config file or a client message. A mapping can
 * therefore only ever select one of the effects the overlay already implements:
 * there is no file path, no resource name and no script name in the wire
 * format, so a bad mapping cannot reach arbitrary content.
 */
const ANIMATIONS = Object.freeze([
    { id: 'dance', label: 'Dance', effect: 'dance', durationMs: 5000 },
    { id: 'dragon_dance', label: 'Dragon dance', effect: 'dance', durationMs: 8000 },
    { id: 'jump', label: 'Jump', effect: 'jump', durationMs: 950 },
    { id: 'walk', label: 'Walk around', effect: 'walk', durationMs: 5000 },
    { id: 'change_character', label: 'Change character', effect: 'change', durationMs: 2500 },
    { id: 'grow', label: 'Grow', effect: 'grow', durationMs: 8000 },
    { id: 'heart_effect', label: 'Heart effect', effect: 'spotlight', durationMs: 6000 },
    { id: 'spotlight', label: 'Spotlight', effect: 'spotlight', durationMs: 6000 },
    { id: 'fireworks', label: 'Fireworks', effect: 'fireworks', durationMs: 8000 },
    { id: 'party_burst', label: 'Party burst', effect: 'party', durationMs: 6000 }
]);

const ANIMATIONS_BY_ID = new Map(ANIMATIONS.map(animation => [animation.id, animation]));
const MAPPING_KEYS = new Set(['giftId', 'animationId']);
const MAX_MAPPINGS = 500;
// TikTok gift IDs are numeric, but TikFinity occasionally sends ids with a
// vendor suffix, so keep the alphabet narrow but not numeric-only.
const GIFT_ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

function catalogMessage() {
    return ANIMATIONS.map(animation => ({ ...animation }));
}

/** Resolves one gift ID to its allow-listed animation, or null for the fallback. */
function resolveGiftAnimation(mappings, giftId) {
    const key = String(giftId || '').trim();
    if (!key) return null;
    const mapping = (mappings || []).find(item => item.giftId === key);
    if (!mapping) return null;
    return ANIMATIONS_BY_ID.get(mapping.animationId) || null;
}

/**
 * Resolves one animation id to what the overlay must do with it. Catalog
 * animations carry an effect the overlay implements; converted GIF folders
 * carry a character animation id the avatar plays itself.
 */
function resolveAnimationTarget(animationId, characterIds) {
    const id = String(animationId || '').trim();
    if (!id) return null;
    const effect = ANIMATIONS_BY_ID.get(id);
    if (effect) {
        return { animationId: effect.id, effect: effect.effect, durationMs: effect.durationMs };
    }
    if (characterIds && characterIds.has(id)) {
        return { animationId: id, character: id };
    }
    return null;
}

/** Resolves a gift to its mapping target, or null when unmapped/unknown. */
function resolveGiftTarget(mappings, giftId, characterIds) {
    const key = String(giftId || '').trim();
    if (!key) return null;
    const mapping = (mappings || []).find(item => item.giftId === key);
    if (!mapping) return null;
    return resolveAnimationTarget(mapping.animationId, characterIds);
}

function sanitizeGiftAnimations(input, options = {}) {
    let raw;
    if (Array.isArray(input)) raw = input;
    else if (input === undefined || input === null) raw = [];
    else if (typeof input === 'object') raw = input.giftAnimations === undefined ? [] : input.giftAnimations;
    else return { error: 'giftAnimations must be a list.' };
    if (!Array.isArray(raw)) return { error: 'giftAnimations must be a list.' };
    if (raw.length > MAX_MAPPINGS) return { error: `At most ${MAX_MAPPINGS} mappings are allowed.` };

    const seen = new Set();
    const mappings = [];
    for (const [index, item] of raw.entries()) {
        const position = index + 1;
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            return { error: `Mapping ${position} must be an object.` };
        }
        for (const key of Object.keys(item)) {
            if (!MAPPING_KEYS.has(key)) return { error: `Mapping ${position} has an unknown field: ${key}.` };
        }
        const giftId = String(item.giftId ?? '').trim();
        const animationId = String(item.animationId ?? '').trim();
        if (!GIFT_ID_PATTERN.test(giftId)) {
            return { error: `Mapping ${position} has an invalid gift ID: ${giftId || '(empty)'}.` };
        }
        const known = ANIMATIONS_BY_ID.has(animationId) ||
            (options.allowedIds instanceof Set && options.allowedIds.has(animationId)) ||
            (Array.isArray(options.allowedIds) && options.allowedIds.includes(animationId));
        if (!known) {
            return { error: `Mapping ${position} uses an unknown animation: ${animationId || '(empty)'}.` };
        }
        if (seen.has(giftId)) return { error: `Gift ID ${giftId} is mapped more than once.` };
        seen.add(giftId);
        mappings.push({ giftId, animationId });
    }

    mappings.sort((a, b) => a.giftId.localeCompare(b.giftId));
    return { value: mappings };
}

/** Reads the persisted mapping; a missing or broken file means "no mappings". */
async function loadGiftAnimations(filePath, options = {}) {
    let raw;
    try {
        raw = await fs.readFile(filePath, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') return { mappings: [] };
        return { mappings: [], error: `Could not read ${path.basename(filePath)}: ${error.message}` };
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        return { mappings: [], error: `Could not parse ${path.basename(filePath)}: ${error.message}` };
    }

    const result = sanitizeGiftAnimations(parsed, options);
    if (result.error) return { mappings: [], error: result.error };
    return { mappings: result.value };
}

/** Persists the mapping atomically so a crash mid-write cannot truncate it. */
async function saveGiftAnimations(filePath, mappings) {
    const directory = path.dirname(filePath);
    await fs.mkdir(directory, { recursive: true });
    const payload = `${JSON.stringify({ giftAnimations: mappings }, null, 2)}\n`;
    const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
    await fs.writeFile(temporary, payload, 'utf8');
    await fs.rename(temporary, filePath);
    return mappings;
}

module.exports = {
    ANIMATIONS,
    catalogMessage,
    resolveGiftTarget,
    resolveAnimationTarget,
    resolveGiftAnimation,
    sanitizeGiftAnimations,
    loadGiftAnimations,
    saveGiftAnimations
};
