'use strict';

/**
 * GIF → PNG animation pipeline.
 *
 * `assets/gifs/*.gif` are the source assets (kept untouched); every conversion
 * writes an ordinal PNG sequence plus an `animation.json` into
 * `UnityProject/Assets/Resources/Characters/<animationId>/` and refreshes the
 * `animations.json` manifest Unity reads at runtime, so a newly downloaded GIF
 * becomes a usable character animation without touching C# or copying files by
 * hand.
 */

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { decodeGif, isGif } = require('./gif-decoder');
const { encodePng } = require('./png');

const PROJECT_ROOT = path.join(__dirname, '..', '..', '..');
const DEFAULT_GIFS_DIR = path.join(__dirname, '..', '..', 'assets', 'gifs');
const DEFAULT_CHARACTERS_DIR = path.join(PROJECT_ROOT, 'UnityProject', 'Assets', 'Resources', 'Characters');
const DEFAULT_STATE_FILE = path.join(DEFAULT_GIFS_DIR, '.conversion-state.json');
const DEFAULT_LOG_DIR = path.join(__dirname, '..', '..', 'logs');
const MANIFEST_NAME = 'animations.json';
const METADATA_NAME = 'animation.json';
const STATE_VERSION = 1;

function sanitizeAnimationId(fileName) {
    const base = path.basename(String(fileName || '')).replace(/\.gif$/i, '');
    // Dotfiles carry no usable name, and an empty base would otherwise become a
    // folder called "gif".
    if (!base || base.startsWith('.')) throw new Error(`Cannot derive an animation id from "${fileName}".`);
    const id = base
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 64);
    if (!id) throw new Error(`Cannot derive an animation id from "${fileName}".`);
    return id;
}

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function resolveOptions(options = {}) {
    return {
        gifsDir: options.gifsDir || process.env.GIF_SOURCE_DIR || DEFAULT_GIFS_DIR,
        charactersDir: options.charactersDir || process.env.UNITY_CHARACTERS_DIR || DEFAULT_CHARACTERS_DIR,
        stateFile: options.stateFile || process.env.GIF_STATE_FILE || DEFAULT_STATE_FILE,
        logDir: options.logDir || process.env.GIF_LOG_DIR || DEFAULT_LOG_DIR,
        force: options.force === true,
        logger: options.logger || null
    };
}

async function readState(stateFile) {
    try {
        const parsed = JSON.parse(await fs.readFile(stateFile, 'utf8'));
        if (!parsed || parsed.version !== STATE_VERSION || typeof parsed.entries !== 'object') {
            return { version: STATE_VERSION, entries: {} };
        }
        return parsed;
    } catch {
        return { version: STATE_VERSION, entries: {} };
    }
}

async function writeState(stateFile, entries) {
    await fs.mkdir(path.dirname(stateFile), { recursive: true });
    const temporary = `${stateFile}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify({ version: STATE_VERSION, entries }, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, stateFile);
}

async function listGifs(gifsDir) {
    let names;
    try {
        names = await fs.readdir(gifsDir);
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
    return names.filter(name => name.toLowerCase().endsWith('.gif')).sort();
}

async function listPngs(folder) {
    try {
        const names = await fs.readdir(folder);
        return names.filter(name => /^\d+\.png$/.test(name)).sort();
    } catch {
        return [];
    }
}

async function readMetadata(folder) {
    try {
        return JSON.parse(await fs.readFile(path.join(folder, METADATA_NAME), 'utf8'));
    } catch {
        return null;
    }
}

function framePad(frameCount) {
    return Math.max(3, String(Math.max(0, frameCount - 1)).length);
}

async function pathExists(target) {
    try {
        await fs.access(target);
        return true;
    } catch {
        return false;
    }
}

/** Writes frames + metadata into a folder (staging or final). */
async function writeFrames(folder, animationId, gifName, hash, decoded, overrides) {
    await fs.mkdir(folder, { recursive: true });
    const pad = framePad(decoded.frames.length);
    for (const [index, frame] of decoded.frames.entries()) {
        const png = encodePng(frame.rgba, decoded.width, decoded.height);
        await fs.writeFile(path.join(folder, `${String(index).padStart(pad, '0')}.png`), png);
    }

    const durationMs = decoded.frames.reduce((sum, frame) => sum + frame.delayMs, 0);
    const metadata = {
        animationId,
        frameCount: decoded.frames.length,
        // Operator overrides survive a re-conversion; the GIF values stay as
        // `sourceFps` / `sourceLoop` so the original timing is never lost.
        fps: overrides && Number(overrides.fps) > 0 ? Number(overrides.fps) : decoded.fps,
        loop: overrides && typeof overrides.loop === 'boolean' ? overrides.loop : decoded.loopCount !== 1,
        playbackSpeed: overrides && Number(overrides.playbackSpeed) > 0 ? Number(overrides.playbackSpeed) : 1,
        defaultDurationMs: overrides && Number(overrides.defaultDurationMs) >= 0
            ? Number(overrides.defaultDurationMs)
            : durationMs,
        transparent: decoded.hasTransparency,
        width: decoded.width,
        height: decoded.height,
        durationMs,
        sourceFps: decoded.fps,
        sourceLoop: decoded.loopCount !== 1,
        frameDelaysMs: decoded.frames.map(frame => frame.delayMs),
        timing: 'average-fps',
        sourceGif: gifName,
        sourceSha256: hash,
        framePattern: `%0${pad}d.png`,
        convertedAt: new Date().toISOString(),
        overrides: overrides || null
    };
    await fs.writeFile(path.join(folder, METADATA_NAME), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
    return metadata;
}

async function writeAnimation(gifPath, gifName, buffer, options, stateEntries) {
    const animationId = sanitizeAnimationId(gifName);
    const hash = sha256(buffer);
    const folder = path.join(options.charactersDir, animationId);
    const existingMetadata = await readMetadata(folder);
    const existingPngs = await listPngs(folder);
    const previous = stateEntries[gifName];

    const unchanged = !options.force &&
        previous && previous.sha256 === hash &&
        existingMetadata && Number(existingMetadata.frameCount) === existingPngs.length &&
        existingPngs.length > 0;
    if (unchanged) {
        return { animationId, status: 'skipped', frameCount: existingPngs.length, hash, metadata: existingMetadata };
    }

    // Signature and structure are checked before anything is written, so a
    // corrupt download never destroys a working animation folder.
    if (!isGif(buffer)) throw new Error('not a GIF file (wrong signature)');

    const decoded = decodeGif(buffer);
    if (!decoded.frames.length) throw new Error('GIF contains no frames');

    const overrides = existingMetadata && existingMetadata.overrides ? existingMetadata.overrides : null;
    // Stage into a sibling folder and swap at the end: an interrupted
    // conversion can never leave a half-written animation behind.
    const staging = path.join(options.charactersDir, `.staging-${animationId}-${process.pid}-${Date.now()}`);
    let metadata;
    try {
        metadata = await writeFrames(staging, animationId, gifName, hash, decoded, overrides);
        const exists = await pathExists(folder);
        if (exists) {
            if (!options.allowOverwrite) {
                const error = new Error(`Animation "${animationId}" already exists.`);
                error.code = 'EEXIST';
                throw error;
            }
            const backup = path.join(options.charactersDir, `.old-${animationId}-${process.pid}-${Date.now()}`);
            await fs.rename(folder, backup);
            try {
                await fs.rename(staging, folder);
            } catch (error) {
                await fs.rename(backup, folder);
                throw error;
            }
            await fs.rm(backup, { recursive: true, force: true });
        } else {
            await fs.rename(staging, folder);
        }
    } finally {
        await fs.rm(staging, { recursive: true, force: true });
    }

    stateEntries[gifName] = {
        sha256: hash,
        animationId,
        frameCount: decoded.frames.length,
        fps: metadata.fps,
        convertedAt: metadata.convertedAt
    };

    return { animationId, status: 'converted', frameCount: decoded.frames.length, hash, metadata };
}

/** Lists every animation folder that currently holds at least one PNG frame. */
async function discoverAnimations(charactersDir) {
    let entries;
    try {
        entries = await fs.readdir(charactersDir, { withFileTypes: true });
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }

    const found = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const folder = path.join(charactersDir, entry.name);
        const pngs = await listPngs(folder);
        if (!pngs.length) continue;
        const metadata = await readMetadata(folder);
        found.push({
            animationId: entry.name,
            frameCount: pngs.length,
            fps: Number(metadata?.fps) > 0 ? Number(metadata.fps) : 12,
            loop: metadata ? metadata.loop !== false : true,
            playbackSpeed: Number(metadata?.playbackSpeed) > 0 ? Number(metadata.playbackSpeed) : 1,
            transparent: metadata ? metadata.transparent !== false : true,
            width: Number(metadata?.width) || 0,
            height: Number(metadata?.height) || 0,
            durationMs: Number(metadata?.durationMs) > 0
                ? Number(metadata.durationMs)
                : Math.round((pngs.length / 12) * 1000),
            defaultDurationMs: Number(metadata?.defaultDurationMs) >= 0
                ? Number(metadata.defaultDurationMs)
                : 0,
            sourceFps: Number(metadata?.sourceFps) > 0 ? Number(metadata.sourceFps) : 0,
            timing: metadata?.timing || 'average-fps',
            sourceGif: metadata?.sourceGif || '',
            convertedAt: metadata?.convertedAt || ''
        });
    }
    return found.sort((a, b) => a.animationId.localeCompare(b.animationId));
}

async function writeManifest(charactersDir, animations) {
    await fs.mkdir(charactersDir, { recursive: true });
    const payload = JSON.stringify({ animations }, null, 2);
    await fs.writeFile(path.join(charactersDir, MANIFEST_NAME), `${payload}\n`, 'utf8');
    return animations;
}

async function appendLog(logDir, lines) {
    await fs.mkdir(logDir, { recursive: true });
    const stamp = new Date().toISOString();
    const text = lines.map(line => `${stamp} ${line}`).join('\n');
    await fs.appendFile(path.join(logDir, 'gif-conversion.log'), `${text}\n`, 'utf8');
}

async function writeReport(logDir, report) {
    await fs.mkdir(logDir, { recursive: true });
    await fs.writeFile(
        path.join(logDir, 'gif-conversion-report.json'),
        `${JSON.stringify(report, null, 2)}\n`,
        'utf8'
    );
}

/**
 * Converts every GIF that changed since the last run.
 * @returns {Promise<{converted:Array,skipped:Array,failed:Array,animations:Array}>}
 */
async function convertAll(rawOptions = {}) {
    const options = resolveOptions(rawOptions);
    const state = await readState(options.stateFile);
    const stateEntries = state.entries || {};
    const gifs = await listGifs(options.gifsDir);

    const converted = [];
    const skipped = [];
    const failed = [];

    for (const gifName of gifs) {
        const gifPath = path.join(options.gifsDir, gifName);
        try {
            const buffer = await fs.readFile(gifPath);
            // The watcher owns the folders it produced, so a changed GIF refreshes
            // its folder. Panel-driven conversions ask for confirmation instead.
            const result = await writeAnimation(gifPath, gifName, buffer, { ...options, allowOverwrite: true }, stateEntries);
            if (result.status === 'converted') {
                converted.push({
                    gif: gifName,
                    animationId: result.animationId,
                    frameCount: result.frameCount,
                    fps: result.metadata.fps,
                    frameDelays: result.metadata.frameDelaysMs
                });
            } else {
                skipped.push({ gif: gifName, animationId: result.animationId, frameCount: result.frameCount });
            }
        } catch (error) {
            failed.push({ gif: gifName, error: error.message });
        }
    }

    await writeState(options.stateFile, stateEntries);
    const animations = await writeManifest(options.charactersDir, await discoverAnimations(options.charactersDir));

    const report = {
        generatedAt: new Date().toISOString(),
        source: options.gifsDir,
        characters: options.charactersDir,
        converted,
        skipped,
        failed,
        animations: animations.map(animation => ({
            animationId: animation.animationId,
            frameCount: animation.frameCount,
            fps: animation.fps,
            loop: animation.loop,
            transparent: animation.transparent
        }))
    };

    const lines = [
        `converted ${converted.length}, skipped ${skipped.length}, failed ${failed.length}, folders ${animations.length}`
    ];
    for (const item of converted) lines.push(`  + ${item.gif} -> ${item.animationId} (${item.frameCount} frames @ ${item.fps} fps)`);
    for (const item of failed) lines.push(`  ! ${item.gif}: ${item.error}`);

    try {
        await appendLog(options.logDir, lines);
        await writeReport(options.logDir, report);
    } catch (error) {
        if (options.logger) options.logger(`Could not write the conversion log: ${error.message}`);
    }

    if (options.logger) {
        for (const line of lines) options.logger(line);
    }

    return { converted, skipped, failed, animations };
}

/**
 * Watches the GIF folder and converts new or replaced files automatically.
 * Debounced and single-flight: a burst of downloads becomes one pass.
 */
function startAutoConversion(rawOptions = {}) {
    const options = resolveOptions(rawOptions);
    const log = options.logger || (message => console.log(`[gifs] ${message}`));
    let timer = null;
    let running = false;
    let queued = false;
    let watcher = null;

    const run = async () => {
        if (running) {
            queued = true;
            return;
        }
        running = true;
        try {
            const result = await convertAll({ ...options, logger: null });
            if (result.converted.length || result.failed.length) {
                log(`converted ${result.converted.length}, failed ${result.failed.length}`);
            }
        } catch (error) {
            log(`conversion pass failed: ${error.message}`);
        } finally {
            running = false;
            if (queued) {
                queued = false;
                run();
            }
        }
    };

    const schedule = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            run();
        }, 1500);
        if (timer.unref) timer.unref();
    };

    run();

    try {
        watcher = require('node:fs').watch(options.gifsDir, { persistent: false }, (eventType, fileName) => {
            if (!fileName || !String(fileName).toLowerCase().endsWith('.gif')) return;
            schedule();
        });
        watcher.on('error', error => log(`watcher stopped: ${error.message}`));
    } catch (error) {
        // A missing folder just means "no GIFs yet"; conversion still runs when
        // the script is invoked again.
        log(`watcher unavailable: ${error.message}`);
    }

    return {
        stop() {
            if (timer) clearTimeout(timer);
            if (watcher) watcher.close();
        },
        convertNow: run
    };
}

module.exports = {
    convertAll,
    startAutoConversion,
    discoverAnimations,
    sanitizeAnimationId,
    resolveOptions,
    readMetadata,
    listPngs,
    writeManifest,
    writeAnimation,
    readState,
    writeState,
    sha256,
    MANIFEST_NAME,
    METADATA_NAME
};
