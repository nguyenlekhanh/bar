'use strict';

/**
 * Downloads public Giphy results into assets/gifsInternet.
 *
 * This folder is intentionally separate from assets/gifs, so these reference
 * GIFs are not auto-converted into Unity character animations.
 *
 * Run: node scripts/download-internet-gifs.js
 */

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const OUTPUT_DIR = path.join(__dirname, '..', 'assets', 'gifsInternet');
const DANCE_TARGET = 300;
const WING_TARGET = 100;
const MAX_BYTES = 8 * 1024 * 1024;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36';

const DANCE_QUERIES = [
    'hip-hop-dance', 'hip-hop-dance-meme', 'funny-dance', 'dancing-meme',
    'dance-meme', 'breakdance', 'bboy-dance', 'popping-dance',
    'locking-dance', 'fortnite-dance', 'tiktok-dance', 'disco-dance',
    'party-dance', 'awkward-dance', 'dance-fail', 'rap-meme',
    'rapper-meme', 'dj-meme', 'music-meme', 'swag-dance',
    'moonwalk', 'running-man-dance', 'floss-dance', 'dab-dance',
    'gangnam-style', 'harlem-shake', 'hip-hop', 'funny-hip-hop',
    'dance-off', 'dance-moves'
];

const WING_QUERIES = [
    'chicken-wing', 'chicken-wings', 'hot-wings', 'wings',
    'fried-chicken-wings', 'wing-meme', 'bird-wings', 'angel-wings',
    'chicken', 'food-wings'
];

function isGif(buffer) {
    const signature = buffer.subarray(0, 6).toString('ascii');
    return signature === 'GIF87a' || signature === 'GIF89a';
}

function skipSubBlocks(buffer, start) {
    let offset = start;
    while (offset < buffer.length) {
        const size = buffer[offset];
        offset += 1;
        if (size === 0) return offset;
        offset += size;
    }
    return buffer.length;
}

function countFrames(buffer) {
    if (!isGif(buffer) || buffer.length < 13) return 0;
    const globalTable = (buffer[10] & 0x80) !== 0;
    const globalSize = 3 * (2 ** ((buffer[10] & 0x07) + 1));
    let offset = 13 + (globalTable ? globalSize : 0);
    let frames = 0;
    while (offset < buffer.length) {
        const marker = buffer[offset];
        offset += 1;
        if (marker === 0x3b) break;
        if (marker === 0x21) {
            offset += 1;
            offset = skipSubBlocks(buffer, offset);
            continue;
        }
        if (marker !== 0x2c || offset + 9 > buffer.length) break;
        const localTable = (buffer[offset + 8] & 0x80) !== 0;
        const localSize = 3 * (2 ** ((buffer[offset + 8] & 0x07) + 1));
        offset += 9 + (localTable ? localSize : 0);
        if (offset >= buffer.length) break;
        offset += 1;
        offset = skipSubBlocks(buffer, offset);
        frames += 1;
    }
    return frames;
}

function idsFromSearchHtml(html) {
    const ids = [];
    for (const match of html.matchAll(/https:\/\/giphy\.com\/(?:gifs|stickers)\/([^"'\s<>]+)/g)) {
        const segment = match[1].split('/')[0];
        const id = segment.split('-').pop();
        if (/^[A-Za-z0-9]{8,}$/.test(id)) ids.push(id);
    }
    return [...new Set(ids)];
}

async function search(query) {
    const url = `https://giphy.com/search/${encodeURIComponent(query)}`;
    const response = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) throw new Error(`search HTTP ${response.status}`);
    return { ids: idsFromSearchHtml(await response.text()), url };
}

async function download(id) {
    const url = `https://media.giphy.com/media/${id}/200w.gif`;
    const response = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Referer: `https://giphy.com/gifs/${id}` },
        signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) throw new Error(`media HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!isGif(buffer)) throw new Error('not a GIF');
    if (buffer.length > MAX_BYTES) throw new Error(`too large (${buffer.length} bytes)`);
    const frames = countFrames(buffer);
    if (frames < 1) throw new Error('no readable frames');
    return { buffer, frames };
}

async function collectIds(queries, target, category) {
    const found = [];
    const seen = new Set();
    for (const query of queries) {
        if (found.length >= target) break;
        try {
            const result = await search(query);
            let added = 0;
            for (const id of result.ids) {
                if (seen.has(id)) continue;
                seen.add(id);
                found.push({ id, query, searchPage: result.url });
                added += 1;
                if (found.length >= target) break;
            }
            console.log(`[search] ${category} ${query}: +${added} (${found.length}/${target})`);
        } catch (error) {
            console.warn(`[search] ${category} ${query}: ${error.message}`);
        }
    }
    if (found.length < target) {
        throw new Error(`${category}: only found ${found.length}/${target} unique IDs`);
    }
    return found.slice(0, target);
}

async function downloadCategory(items, prefix, category) {
    const accepted = [];
    const hashes = new Set();
    let cursor = 0;
    let nextNumber = 1;
    async function worker() {
        while (cursor < items.length && accepted.length < items.length) {
            const item = items[cursor];
            cursor += 1;
            try {
                const { buffer, frames } = await download(item.id);
                const hash = crypto.createHash('sha256').update(buffer).digest('hex');
                if (hashes.has(hash)) {
                    console.warn(`[skip] duplicate ${category} ${item.id}`);
                    continue;
                }
                hashes.add(hash);
                // Reserve the filename before awaiting disk I/O; accepted.length is
                // not safe for this under concurrent workers.
                const number = String(nextNumber).padStart(3, '0');
                nextNumber += 1;
                const filename = `${prefix}_${number}.gif`;
                await fs.writeFile(path.join(OUTPUT_DIR, filename), buffer, { flag: 'wx' });
                accepted.push({
                    filename,
                    category,
                    giphyId: item.id,
                    frames,
                    bytes: buffer.length,
                    sha256: hash,
                    searchPage: item.searchPage,
                    pageUrl: `https://giphy.com/gifs/${item.id}`,
                    assetUrl: `https://media.giphy.com/media/${item.id}/200w.gif`
                });
                if (accepted.length % 25 === 0) {
                    console.log(`[download] ${category}: ${accepted.length}/${items.length}`);
                }
            } catch (error) {
                console.warn(`[skip] ${category} ${item.id}: ${error.message}`);
            }
        }
    }
    await Promise.all(Array.from({ length: 8 }, () => worker()));
    if (accepted.length < items.length) {
        throw new Error(`${category}: only downloaded ${accepted.length}/${items.length} valid GIFs`);
    }
    return accepted;
}

async function main() {
    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    const existing = (await fs.readdir(OUTPUT_DIR)).filter(name => /\.(gif|json|md)$/i.test(name));
    for (const name of existing) await fs.rm(path.join(OUTPUT_DIR, name), { force: true });

    const danceIds = await collectIds(DANCE_QUERIES, DANCE_TARGET, 'dance_funny');
    const wingIds = await collectIds(WING_QUERIES, WING_TARGET, 'wing');
    const dance = await downloadCategory(danceIds, 'dance_funny', 'dance_funny');
    const wing = await downloadCategory(wingIds, 'wing', 'wing');
    const manifest = [...dance, ...wing];

    await fs.writeFile(
        path.join(OUTPUT_DIR, 'sources.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
        'utf8'
    );
    await fs.writeFile(
        path.join(OUTPUT_DIR, 'README.md'),
        [
            '# Internet GIF references',
            '',
            `- ${dance.length} meme / hip-hop / funny dance GIFs`,
            `- ${wing.length} wing GIFs`,
            '',
            'Files were downloaded from public Giphy search results at 200px wide.',
            'Each file is an original GIF and its source is recorded in `sources.json`.',
            '',
            'Giphy content remains the property of its respective creators. Downloading',
            'for free does not grant a commercial broadcast licence. Check Giphy and',
            'TikTok rights for each clip before using it in a monetised livestream.',
            ''
        ].join('\n'),
        'utf8'
    );
    console.log(`Done: ${dance.length} dance/funny + ${wing.length} wing = ${manifest.length} GIFs`);
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
