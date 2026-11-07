'use strict';

/**
 * A small, deterministic queue. The service owns synthesis and playback; this
 * module owns only ordering, anti-spam policy and bounds.
 */
class VoiceQueue {
    constructor(options = {}) {
        this.maxQueue = clampInt(options.maxQueue, 1, 50, 12);
        this.expireMs = clampInt(options.expireMs, 5000, 300000, 45000);
        this.cooldownsMs = { ...(options.cooldownsMs || {}) };
        this.items = [];
        this.cooldownUntil = new Map();
    }

    configure(options = {}) {
        this.maxQueue = clampInt(options.maxQueue, 1, 50, this.maxQueue);
        this.expireMs = clampInt(options.expireMs, 5000, 300000, this.expireMs);
        if (options.cooldownsMs && typeof options.cooldownsMs === 'object') {
            this.cooldownsMs = { ...options.cooldownsMs };
        }
        this.prune();
        this.trimToMaximum();
    }

    prune(now = Date.now()) {
        this.items = this.items.filter(item => !item.expiresAt || item.expiresAt > now);
        for (const [key, until] of this.cooldownUntil) {
            if (until <= now) this.cooldownUntil.delete(key);
        }
    }

    cooldownKey(category, userId) {
        return `${category}:${userId || 'global'}`;
    }

    /**
     * @returns {{accepted: boolean, reason?: string, item?: object, merged?: boolean}}
     */
    enqueue(item, now = Date.now()) {
        if (!item || !item.text) return { accepted: false, reason: 'empty' };
        this.prune(now);

        const dedupeKey = String(item.dedupeKey || '');
        if (dedupeKey && this.items.some(existing => existing.dedupeKey === dedupeKey)) {
            return { accepted: false, reason: 'duplicate' };
        }

        const cooldownKey = this.cooldownKey(item.category, item.userId);
        if (!item.bypassCooldown && this.cooldownUntil.has(cooldownKey)) {
            return { accepted: false, reason: 'cooldown' };
        }

        const entry = {
            ...item,
            id: String(item.id || `voice-${now}-${Math.random().toString(36).slice(2, 8)}`),
            createdAt: Number(item.createdAt) || now,
            expiresAt: Number(item.expiresAt) || now + this.expireMs,
            priority: clampInt(item.priority, 0, 10, 1)
        };

        if (this.items.length >= this.maxQueue) {
            const lowest = this.items.reduce((candidate, current) =>
                current.priority < candidate.priority ? current : candidate, this.items[0]);
            if (lowest && entry.priority <= lowest.priority) {
                return { accepted: false, reason: 'full' };
            }
            this.items = this.items.filter(existing => existing !== lowest);
        }

        this.items.push(entry);
        this.sort();
        if (!item.bypassCooldown) {
            const cooldown = clampInt(this.cooldownsMs[item.category], 0, 600000, 0);
            if (cooldown > 0) this.cooldownUntil.set(cooldownKey, now + cooldown);
        }
        return { accepted: true, item: entry };
    }

    sort() {
        this.items.sort((a, b) =>
            (b.priority - a.priority) ||
            (a.createdAt - b.createdAt) ||
            String(a.id).localeCompare(String(b.id))
        );
    }

    dequeue(now = Date.now()) {
        this.prune(now);
        return this.items.shift() || null;
    }

    find(predicate) {
        return this.items.find(predicate) || null;
    }

    update(id, patch) {
        const item = this.items.find(candidate => candidate.id === id);
        if (!item) return null;
        Object.assign(item, patch);
        return item;
    }

    remove(id) {
        const before = this.items.length;
        this.items = this.items.filter(item => item.id !== id);
        return this.items.length !== before;
    }

    clear() {
        const count = this.items.length;
        this.items = [];
        this.cooldownUntil.clear();
        return count;
    }

    trimToMaximum() {
        if (this.items.length <= this.maxQueue) return;
        this.sort();
        this.items = this.items.slice(0, this.maxQueue);
    }

    get size() {
        return this.items.length;
    }

    snapshot() {
        return this.items.map(item => ({
            id: item.id,
            category: item.category,
            priority: item.priority,
            text: item.text,
            createdAt: item.createdAt,
            expiresAt: item.expiresAt
        }));
    }
}

function clampInt(value, minimum, maximum, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(maximum, Math.max(minimum, Math.round(number)));
}

module.exports = { VoiceQueue, clampInt };
