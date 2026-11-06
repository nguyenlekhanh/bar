'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { readVideoMeta, clearVideoMetaCache } = require('../src/background/video-meta');
const { listBackgroundFiles } = require('../src/background/registry');

/* ── tiny MP4 writer ─────────────────────────────────────── */

function box(type, ...payloads) {
    const body = Buffer.concat(payloads);
    const header = Buffer.alloc(8);
    header.writeUInt32BE(body.length + 8, 0);
    header.write(type, 4, 'latin1');
    return Buffer.concat([header, body]);
}

function fullBox(type, version, ...payloads) {
    const flags = Buffer.alloc(4);
    flags[0] = version;
    return box(type, flags, ...payloads);
}

function fixed16(value) {
    const buffer = Buffer.alloc(4);
    buffer.writeInt32BE(Math.round(value * 65536), 0);
    return buffer;
}

const u32 = value => {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(value, 0);
    return buffer;
};

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const ROT_90 = [0, 1, 0, -1, 0, 0, 0, 0, 1];
const ROT_180 = [-1, 0, 0, 0, -1, 0, 0, 0, 1];
const ROT_270 = [0, -1, 0, 1, 0, 0, 0, 0, 1];

function tkhd(matrix, width, height) {
    const body = Buffer.concat([
        u32(0), u32(0), u32(1), u32(0), u32(0), // creation, modification, track, reserved, duration
        Buffer.alloc(8),                        // reserved
        Buffer.alloc(2),                        // layer
        Buffer.alloc(2),                        // alternate group
        Buffer.alloc(2),                        // volume
        Buffer.alloc(2),                        // reserved
        ...matrix.map(fixed16),
        fixed16(width),
        fixed16(height),
    ]);
    return fullBox('tkhd', 0, body);
}

function mvhd(timescale, duration) {
    return fullBox('mvhd', 0, u32(0), u32(0), u32(timescale), u32(duration));
}

function hdlr(type) {
    return fullBox('hdlr', 0, u32(0), Buffer.from(type, 'latin1'), Buffer.alloc(12), Buffer.from([0]));
}

function mp4({ matrix = IDENTITY, width = 1920, height = 1080, seconds = 12, timescale = 1000 } = {}) {
    const moov = box(
        'moov',
        mvhd(timescale, Math.round(seconds * timescale)),
        box('trak', tkhd(matrix, width, height), box('mdia', hdlr('vide')))
    );
    return Buffer.concat([box('ftyp', Buffer.from('isom', 'latin1'), u32(512)), moov]);
}

async function writeTemp(name, buffer) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bg-meta-'));
    const file = path.join(dir, name);
    await fs.writeFile(file, buffer);
    return { dir, file };
}

/* ── tests ───────────────────────────────────────────────── */

test('reads the rotation declared by the tkhd matrix', async () => {
    const cases = [
        [IDENTITY, 0],
        [ROT_90, 90],
        [ROT_180, 180],
        [ROT_270, 270],
    ];
    for (const [matrix, expected] of cases) {
        clearVideoMetaCache();
        const { file } = await writeTemp(`clip-${expected}.mp4`, mp4({ matrix }));
        const meta = await readVideoMeta(file);
        assert.ok(meta, `expected metadata for rotation ${expected}`);
        assert.equal(meta.rotation, expected, `matrix produced ${meta.rotation}, expected ${expected}`);
    }
});

test('reports display size, swapping it for quarter turns', async () => {
    clearVideoMetaCache();
    const upright = await writeTemp('upright.mp4', mp4({ width: 1920, height: 1080 }));
    assert.deepEqual(
        (({ width, height }) => ({ width, height }))(await readVideoMeta(upright.file)),
        { width: 1920, height: 1080 }
    );

    clearVideoMetaCache();
    const turned = await writeTemp('phone.mp4', mp4({ matrix: ROT_90, width: 1920, height: 1080 }));
    assert.deepEqual(
        (({ width, height }) => ({ width, height }))(await readVideoMeta(turned.file)),
        { width: 1080, height: 1920 }
    );
});

test('reads duration from mvhd', async () => {
    clearVideoMetaCache();
    const { file } = await writeTemp('len.mp4', mp4({ seconds: 4.5, timescale: 1000 }));
    const meta = await readVideoMeta(file);
    assert.equal(Math.round(meta.duration * 10) / 10, 4.5);
});

test('finds moov stored at the end of the file', async () => {
    clearVideoMetaCache();
    const payload = mp4({ matrix: ROT_180 });
    const body = payload.subarray(16); // drop ftyp, keep moov at the tail
    const padded = Buffer.concat([body, Buffer.alloc(0)]);
    const { file } = await writeTemp('tail.mp4', Buffer.concat([box('ftyp', Buffer.from('isom', 'latin1'), u32(512)), box('mdat', Buffer.alloc(2048, 3)), padded]));
    const meta = await readVideoMeta(file);
    assert.equal(meta.rotation, 180);
});

test('webm is never parsed and reports no rotation', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bg-meta-'));
    const file = path.join(dir, 'clip.webm');
    await fs.writeFile(file, Buffer.alloc(64, 9));
    assert.equal(await readVideoMeta(file), null);
});

test('junk, missing and empty files fall back to null', async () => {
    const junk = await writeTemp('junk.mp4', Buffer.alloc(40, 0x7f));
    assert.equal(await readVideoMeta(junk.file), null);
    assert.equal(await readVideoMeta(path.join(junk.dir, 'ghost.mp4')), null);

    const empty = await writeTemp('empty.mp4', Buffer.alloc(0));
    assert.equal(await readVideoMeta(empty.file), null);
});

test('a track without a video handler is ignored', async () => {
    clearVideoMetaCache();
    const audioOnly = Buffer.concat([
        box('ftyp', Buffer.from('isom', 'latin1'), u32(512)),
        box('moov', mvhd(1000, 5000), box('trak', tkhd(ROT_90, 1920, 1080), box('mdia', hdlr('soun'))))
    ]);
    const { file } = await writeTemp('audio.mp4', audioOnly);
    assert.equal(await readVideoMeta(file), null);
});

test('the catalogue carries rotation for folder listings', async () => {
    clearVideoMetaCache();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bg-meta-list-'));
    const videos = path.join(dir, 'videos');
    await fs.mkdir(videos, { recursive: true });
    await fs.writeFile(path.join(videos, 'sideways.mp4'), mp4({ matrix: ROT_270, width: 1280, height: 720 }));
    await fs.writeFile(path.join(videos, 'normal.mov'), mp4({ width: 640, height: 480 }));

    const listing = await listBackgroundFiles(dir);
    const sideways = listing.videos.find(item => item.file === 'sideways.mp4');
    const normal = listing.videos.find(item => item.file === 'normal.mov');

    assert.equal(sideways.rotation, 270);
    assert.equal(sideways.width, 720);
    assert.equal(sideways.height, 1280);
    assert.equal(normal.rotation, 0);
    assert.equal(normal.width, 640);
});
