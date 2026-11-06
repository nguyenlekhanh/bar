'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
    DEFAULT_BACKGROUND,
    validateBackground,
    listBackgroundFiles,
    resolveBackgroundPath,
    loadBackgroundConfig,
    saveBackgroundConfig
} = require('../src/background/registry');

async function tempRoot() {
    return fs.mkdtemp(path.join(os.tmpdir(), 'bg-registry-'));
}

test('accepts a PNG background with fit mode and loop flag', () => {
    const result = validateBackground({ file: 'stage_01.png', type: 'image', fitMode: 'fill', loop: false });
    assert.equal(result.error, undefined);
    assert.deepEqual(
        { file: result.value.file, type: result.value.type, fitMode: result.value.fitMode, loop: result.value.loop },
        { file: 'stage_01.png', type: 'image', fitMode: 'fill', loop: false }
    );
});

test('accepts an MP4 background', () => {
    const result = validateBackground({ file: 'loop_01.mp4', type: 'video' });
    assert.equal(result.value.type, 'video');
    assert.equal(result.value.fitMode, 'native');
});

test('rejects path traversal and absolute paths', () => {
    for (const file of ['../secret.png', '..\\secret.png', 'C:/Windows/x.png', '/etc/passwd', 'foo/bar.png', 'a..b.png']) {
        assert.ok(validateBackground({ file }).error, `expected rejection for ${file}`);
    }
});

test('rejects unsupported extensions and mismatched types', () => {
    assert.ok(validateBackground({ file: 'clip.gif' }).error);
    assert.ok(validateBackground({ file: 'clip.mkv' }).error);
    assert.ok(validateBackground({ file: 'clip.mp4', type: 'image' }).error);
});

test('accepts every video container Unity can open on Windows', () => {
    for (const file of ['clip.mp4', 'clip.m4v', 'clip.mov', 'clip.webm']) {
        const result = validateBackground({ file, type: 'video' });
        assert.equal(result.error, undefined, `expected ${file} to be accepted`);
        assert.equal(result.value.type, 'video');
    }
});

test('falls back to native fit mode for unknown values', () => {
    assert.equal(validateBackground({ file: 'a.png', fitMode: 'stretch' }).value.fitMode, 'native');
});

test('rejects files that are not in the catalogue', () => {
    const available = [{ file: 'known.png', type: 'image' }];
    assert.ok(validateBackground({ file: 'other.png' }, { available }).error);
    assert.equal(validateBackground({ file: 'known.png' }, { available }).error, undefined);
});

test('lists only supported files inside images/ and videos/', async () => {
    const root = await tempRoot();
    await fs.mkdir(path.join(root, 'images'), { recursive: true });
    await fs.mkdir(path.join(root, 'videos'), { recursive: true });
    await fs.writeFile(path.join(root, 'images', 'a.png'), Buffer.alloc(8, 1));
    await fs.writeFile(path.join(root, 'images', 'b.JPG'), Buffer.alloc(8, 1));
    await fs.writeFile(path.join(root, 'images', 'skip.gif'), Buffer.alloc(8, 1));
    await fs.writeFile(path.join(root, 'images', 'skip.mp4'), Buffer.alloc(8, 1));
    await fs.writeFile(path.join(root, 'images', '.hidden.png'), Buffer.alloc(8, 1));
    await fs.writeFile(path.join(root, 'videos', 'loop.mp4'), Buffer.alloc(8, 1));

    const listing = await listBackgroundFiles(root);
    assert.deepEqual(listing.images.map(item => item.file), ['a.png', 'b.JPG']);
    assert.deepEqual(listing.videos.map(item => item.file), ['loop.mp4']);
    assert.equal(listing.all.length, 3);
});

test('missing folders list as empty', async () => {
    const listing = await listBackgroundFiles(path.join(await tempRoot(), 'nope'));
    assert.deepEqual(listing, { images: [], videos: [], all: [] });
});

test('resolveBackgroundPath stays inside the allowed folder', async () => {
    const root = await tempRoot();
    const resolved = resolveBackgroundPath(root, { type: 'image', file: 'ok.png' });
    assert.equal(resolved.absolute, path.join(path.resolve(root, 'images'), 'ok.png'));

    const rejected = resolveBackgroundPath(root, { type: 'image', file: '../ok.png' });
    assert.ok(rejected.error);
});

test('loadBackgroundConfig falls back to default on missing, invalid or stale config', async () => {
    const root = await tempRoot();
    const configPath = path.join(root, 'background.json');

    assert.deepEqual(await loadBackgroundConfig(configPath), DEFAULT_BACKGROUND);

    await fs.writeFile(configPath, '{ not json', 'utf8');
    assert.deepEqual(await loadBackgroundConfig(configPath), DEFAULT_BACKGROUND);

    await fs.writeFile(configPath, JSON.stringify({ file: '../escape.png', type: 'image' }), 'utf8');
    assert.deepEqual(await loadBackgroundConfig(configPath), DEFAULT_BACKGROUND);

    await fs.writeFile(configPath, JSON.stringify({ file: 'gone.png', type: 'image', fitMode: 'fit' }), 'utf8');
    const available = [{ file: 'present.png', type: 'image' }];
    assert.deepEqual(await loadBackgroundConfig(configPath, { available }), DEFAULT_BACKGROUND);
});

test('saveBackgroundConfig round trips through an atomic replace', async () => {
    const root = await tempRoot();
    const configPath = path.join(root, 'nested', 'background.json');
    const saved = await saveBackgroundConfig(configPath, {
        file: 'stage_02.jpg',
        type: 'image',
        fitMode: 'fit',
        id: 'bg_test',
        generation: 7
    });

    const loaded = await loadBackgroundConfig(configPath);
    assert.deepEqual(loaded, saved);
    assert.equal(loaded.fitMode, 'fit');
    assert.equal(loaded.generation, 7);

    const leftovers = await fs.readdir(path.dirname(configPath));
    assert.deepEqual(leftovers, ['background.json']);
});
