'use strict';

const crypto = require('node:crypto');
const { measureWav } = require('./wav-gain');

function readWavInfo(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 44 ||
        buffer.toString('ascii', 0, 4) !== 'RIFF' ||
        buffer.toString('ascii', 8, 12) !== 'WAVE') {
        return { durationMs: 0, sampleRate: 0, channels: 0 };
    }
    let offset = 12;
    let byteRate = 0;
    let sampleRate = 0;
    let channels = 0;
    let bits = 0;
    let format = 0;
    let dataBytes = 0;
    while (offset + 8 <= buffer.length) {
        const id = buffer.toString('ascii', offset, offset + 4);
        const size = buffer.readUInt32LE(offset + 4);
        const start = offset + 8;
        if (id === 'fmt ' && start + 16 <= buffer.length) {
            const formatTag = buffer.readUInt16LE(start);
            channels = buffer.readUInt16LE(start + 2);
            sampleRate = buffer.readUInt32LE(start + 4);
            byteRate = buffer.readUInt32LE(start + 8);
            bits = buffer.readUInt16LE(start + 14);
            format = formatTag === 0xFFFE && start + 26 <= buffer.length
                ? buffer.readUInt16LE(start + 24)
                : formatTag;
        } else if (id === 'data') {
            dataBytes = Math.min(size, Math.max(0, buffer.length - start));
            break;
        }
        offset = start + size + (size % 2);
        if (size <= 0) break;
    }
    const durationMs = byteRate > 0 ? Math.round((dataBytes / byteRate) * 1000) : 0;
    const level = measureWav(buffer);
    return {
        durationMs,
        sampleRate,
        channels,
        bits: bits || level.bits,
        format: format || level.format,
        peak: level.peak,
        rms: level.rms,
        peakDb: level.peakDb,
        rmsDb: level.rmsDb,
        lufs: level.lufs,
        truePeak: level.truePeak,
        truePeakDb: level.truePeakDb
    };
}

class VoiceAudioCache {
    constructor(options = {}) {
        this.maxEntries = Math.max(4, Number(options.maxEntries) || 48);
        this.maxBytes = Math.max(4 * 1024 * 1024, Number(options.maxBytes) || 64 * 1024 * 1024);
        this.ttlMs = Math.max(30_000, Number(options.ttlMs) || 20 * 60 * 1000);
        this.records = new Map();
        this.byKey = new Map();
    }

    put(buffer, meta = {}) {
        if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('Empty audio buffer.');
        const cacheKey = String(meta.cacheKey || '');
        const now = Date.now();
        if (cacheKey) {
            const existingId = this.byKey.get(cacheKey);
            const existing = existingId ? this.records.get(existingId) : null;
            if (existing && existing.expiresAt > now) {
                existing.expiresAt = now + this.ttlMs;
                return existing;
            }
            if (existingId && !existing) this.byKey.delete(cacheKey);
        }

        const id = crypto.createHash('sha256')
            .update(cacheKey || `${now}-${Math.random()}`)
            .digest('hex')
            .slice(0, 32);
        const wav = readWavInfo(buffer);
        const record = {
            id,
            buffer,
            bytes: buffer.length,
            createdAt: now,
            expiresAt: now + this.ttlMs,
            cacheKey,
            ...wav,
            durationMs: Number(meta.durationMs) || wav.durationMs,
            sampleRate: Number(meta.sampleRate) || wav.sampleRate,
            provider: String(meta.provider || ''),
            voice: String(meta.voice || ''),
            boostDb: Number(meta.boostDb) || 0,
            normalizationGainDb: Number(meta.normalizationGainDb) || 0,
            outputLufs: Number(meta.outputLufs) || 0,
            targetLufs: Number(meta.targetLufs) || 0,
            url: `/api/voice/audio/${id}.wav`
        };
        this.records.set(id, record);
        if (cacheKey) this.byKey.set(cacheKey, id);
        this.evict();
        return record;
    }

    get(id) {
        const safeId = String(id || '').replace(/[^a-f0-9]/gi, '');
        const record = this.records.get(safeId);
        if (!record) return null;
        if (record.expiresAt <= Date.now()) {
            this.records.delete(safeId);
            if (record.cacheKey) this.byKey.delete(record.cacheKey);
            return null;
        }
        return record;
    }

    evict() {
        const now = Date.now();
        for (const [id, record] of this.records) {
            if (record.expiresAt <= now) {
                this.records.delete(id);
                if (record.cacheKey) this.byKey.delete(record.cacheKey);
            }
        }
        let total = [...this.records.values()].reduce((sum, record) => sum + record.bytes, 0);
        while (this.records.size > this.maxEntries || total > this.maxBytes) {
            const oldest = [...this.records.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
            if (!oldest) break;
            this.records.delete(oldest.id);
            if (oldest.cacheKey) this.byKey.delete(oldest.cacheKey);
            total -= oldest.bytes;
        }
    }

    snapshot() {
        return {
            entries: this.records.size,
            bytes: [...this.records.values()].reduce((sum, record) => sum + record.bytes, 0),
            maxEntries: this.maxEntries,
            maxBytes: this.maxBytes
        };
    }

    clear() {
        this.records.clear();
        this.byKey.clear();
    }
}

module.exports = { VoiceAudioCache, readWavInfo };
