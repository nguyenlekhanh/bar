'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const manager = require('../src/gifs/manager');
const { sanitizeGiftAnimations, resolveGiftTarget } = require('../src/gifts/animations');

const GIF_PATH = path.join(__dirname, '..', 'assets', 'gifs', 'a.gif');
const OTHER_GIF_PATH = path.join(__dirname, '..', 'assets', 'gifs', 'b.gif');

const SMALL_LIMITS = {
    maxBytes: 1024 * 1024,
    maxFrames: 600,
    maxDimension: 2048,
    maxDownloadBytes: 4096,
    downloadTimeoutMs: 5000,
    maxRedirects: 2
};

async function workspace() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gif-manager-'));
    const gifsDir = path.join(root, 'gifs');
    const charactersDir = path.join(root, 'Characters');
    const logDir = path.join(root, 'logs');
    await fs.mkdir(gifsDir, { recursive: true });
    return {
        root,
        gifsDir,
        charactersDir,
        logDir,
        options: { gifsDir, charactersDir, logDir, stateFile: path.join(gifsDir, '.conversion-state.json') }
    };
}

async function gifBuffer() {
    return fs.readFile(GIF_PATH);
}

test('inspectGifBuffer rejects empty, non-GIF, oversized and extreme input', async () => {
    const gif = await gifBuffer();
    assert.throws(() => manager.inspectGifBuffer(Buffer.alloc(0)), /empty/i);
    assert.throws(() => manager.inspectGifBuffer(Buffer.from('definitely not a gif')), /GIF87a/);
    assert.throws(
        () => manager.inspectGifBuffer(Buffer.concat([gif, Buffer.alloc(4096)]), {
            filename: 'a.gif',
            limits: { ...SMALL_LIMITS, maxBytes: 1024 }
        }),
        /limit/i
    );
    assert.throws(
        () => manager.inspectGifBuffer(gif, { limits: { ...SMALL_LIMITS, maxFrames: 2 } }),
        /frames/i
    );
    assert.throws(
        () => manager.inspectGifBuffer(gif, { limits: { ...SMALL_LIMITS, maxDimension: 16 } }),
        /resolution/i
    );
});

test('inspectGifBuffer reports the metadata the panel displays', async () => {
    const info = manager.inspectGifBuffer(await gifBuffer(), { filename: 'dragon_dance.gif' });
    assert.equal(info.filename, 'dragon_dance.gif');
    assert.equal(info.animationId, 'dragon_dance');
    assert.ok(info.width > 0 && info.height > 0);
    assert.ok(info.frameCount > 1);
    assert.ok(info.fps > 0 && info.fps < 100);
    assert.equal(info.frameDelaysMs.length, info.frameCount);
    assert.ok(info.durationMs > 0);
    assert.equal(info.transparent, true);
    assert.equal(typeof info.loop, 'boolean');
    assert.equal(info.sha256.length, 64);
    assert.ok(info.bytes > 0);
});

test('client filenames cannot escape the GIF folder', () => {
    assert.equal(manager.sanitizeFileName('../../etc/passwd.gif'), 'passwd.gif');
    assert.equal(manager.sanitizeFileName('C:\\Windows\\System32\\evil.gif'), 'evil.gif');
    assert.equal(manager.sanitizeFileName(''), 'animation.gif');
    assert.equal(manager.sanitizeFileName('..gif'), 'animation.gif');
    assert.equal(manager.sanitizeFileName('x'.repeat(300) + '.gif').length, 84);
    assert.ok(!manager.sanitizeFileName('a b?.gif').includes(' '));
});

test('import writes atomically, suffixes collisions and detects duplicates', async () => {
    const ws = await workspace();
    const gif = await gifBuffer();
    const other = await fs.readFile(OTHER_GIF_PATH);

    const first = await manager.importGifBuffer(gif, { ...ws.options, filename: 'dance.gif' });
    assert.equal(first.storedName, 'dance.gif');
    assert.equal(first.duplicate, false);

    const duplicate = await manager.importGifBuffer(gif, { ...ws.options, filename: 'dance.gif' });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.storedName, 'dance.gif');

    const collision = await manager.importGifBuffer(other, { ...ws.options, filename: 'dance.gif' });
    assert.equal(collision.storedName, 'dance-2.gif');
    assert.equal(collision.duplicate, false);

    const files = await fs.readdir(ws.gifsDir);
    assert.ok(files.includes('dance.gif') && files.includes('dance-2.gif'));
    assert.deepEqual(files.filter(name => name.endsWith('.tmp')), []);
});

test('a traversal filename is stored inside the GIF folder only', async () => {
    const ws = await workspace();
    const imported = await manager.importGifBuffer(await gifBuffer(), { ...ws.options, filename: '../../evil.gif' });
    assert.equal(imported.storedName, 'evil.gif');
    const rootEntries = await fs.readdir(ws.root);
    assert.ok(!rootEntries.includes('evil.gif'));
    assert.ok((await fs.readdir(ws.gifsDir)).includes('evil.gif'));
});

test('URL downloads are refused for unsafe targets', async () => {
    await assert.rejects(manager.downloadGifFromUrl('file:///etc/passwd'), /http/i);
    await assert.rejects(manager.downloadGifFromUrl('http://127.0.0.1:8080/a.gif'), /private|loopback/i);
    await assert.rejects(manager.downloadGifFromUrl('http://localhost/a.gif'), /private|loopback/i);
    await assert.rejects(manager.downloadGifFromUrl('javascript:alert(1)'), /http/i);
    await assert.rejects(manager.downloadGifFromUrl('not a url'), /not valid/i);
    await assert.rejects(manager.downloadGifFromUrl('https://user:secret@8.8.8.8/a.gif'), /credentials/i);
    assert.equal(manager.isPrivateAddress('10.0.0.5'), true);
    assert.equal(manager.isPrivateAddress('192.168.1.20'), true);
    assert.equal(manager.isPrivateAddress('::1'), true);
    assert.equal(manager.isPrivateAddress('8.8.8.8'), false);
});

test('a downloaded GIF is stored, and bad responses are rejected', async () => {
    const ws = await workspace();
    const gif = await gifBuffer();
    const originalFetch = global.fetch;
    try {
        global.fetch = async () => new Response(gif, { status: 200, headers: { 'content-type': 'image/gif' } });
        const imported = await manager.downloadGifFromUrl('https://8.8.8.8/media/dance.gif', {
            ...ws.options,
            limits: { ...SMALL_LIMITS, maxDownloadBytes: 4 * 1024 * 1024 }
        });
        assert.equal(imported.storedName, 'dance.gif');
        assert.equal(imported.duplicate, false);

        global.fetch = async () => new Response(Buffer.alloc(6000), { status: 200 });
        await assert.rejects(
            manager.downloadGifFromUrl('https://8.8.8.8/big.gif', { ...ws.options, limits: SMALL_LIMITS }),
            /limit/i
        );

        global.fetch = async () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
        await assert.rejects(
            manager.downloadGifFromUrl('https://8.8.8.8/page', { ...ws.options, limits: SMALL_LIMITS }),
            /content type/i
        );

        global.fetch = async () => new Response('missing', { status: 404 });
        await assert.rejects(
            manager.downloadGifFromUrl('https://8.8.8.8/missing.gif', { ...ws.options, limits: SMALL_LIMITS }),
            /404/
        );

        global.fetch = async () => new Response('not a gif at all', { status: 200, headers: { 'content-type': 'image/gif' } });
        await assert.rejects(
            manager.downloadGifFromUrl('https://8.8.8.8/fake.gif', { ...ws.options, limits: SMALL_LIMITS }),
            /GIF87a/
        );
    } finally {
        global.fetch = originalFetch;
    }
});

test('conversion reuses the pipeline and never overwrites without confirmation', async () => {
    const ws = await workspace();
    await manager.importGifBuffer(await gifBuffer(), { ...ws.options, filename: 'a.gif' });

    const first = await manager.convertAnimation('a', ws.options);
    assert.equal(first.status, 'converted');
    assert.ok(first.frameCount > 1);

    const frame = path.join(ws.charactersDir, 'a', '000.png');
    const before = await fs.stat(frame);
    await new Promise(resolve => setTimeout(resolve, 15));

    await assert.rejects(manager.convertAnimation('a', ws.options), /already exists/i);
    assert.equal((await fs.stat(frame)).mtimeMs, before.mtimeMs, 'existing frames must stay untouched');

    const forced = await manager.convertAnimation('a', { ...ws.options, confirm: true });
    assert.equal(forced.frameCount, first.frameCount);

    const manifest = JSON.parse(await fs.readFile(path.join(ws.charactersDir, 'animations.json'), 'utf8'));
    assert.equal(manifest.animations.length, 1);
    const leftovers = (await fs.readdir(ws.charactersDir))
        .filter(name => name.startsWith('.staging') || name.startsWith('.old'));
    assert.deepEqual(leftovers, [], 'staging folders must be cleaned up');
});

test('playback metadata persists, survives re-conversion and can reset', async () => {
    const ws = await workspace();
    await manager.importGifBuffer(await gifBuffer(), { ...ws.options, filename: 'a.gif' });
    await manager.convertAnimation('a', ws.options);

    const saved = await manager.updateAnimationMetadata('a', {
        fps: 18,
        loop: false,
        playbackSpeed: 1.5,
        defaultDurationMs: 2500
    }, ws.options);
    assert.equal(saved.metadata.fps, 18);
    assert.equal(saved.metadata.loop, false);
    assert.equal(saved.metadata.playbackSpeed, 1.5);
    assert.equal(saved.metadata.defaultDurationMs, 2500);
    assert.ok(saved.metadata.sourceFps > 0);

    const manifest = JSON.parse(await fs.readFile(path.join(ws.charactersDir, 'animations.json'), 'utf8'));
    assert.equal(manifest.animations[0].fps, 18);
    assert.equal(manifest.animations[0].loop, false);
    assert.equal(manifest.animations[0].playbackSpeed, 1.5);

    await manager.convertAnimation('a', { ...ws.options, confirm: true });
    let metadata = JSON.parse(await fs.readFile(path.join(ws.charactersDir, 'a', 'animation.json'), 'utf8'));
    assert.equal(metadata.fps, 18, 'operator FPS must survive a re-conversion');
    assert.equal(metadata.loop, false);

    await manager.updateAnimationMetadata('a', { reset: true }, ws.options);
    metadata = JSON.parse(await fs.readFile(path.join(ws.charactersDir, 'a', 'animation.json'), 'utf8'));
    assert.equal(metadata.fps, metadata.sourceFps);
    assert.equal(metadata.loop, metadata.sourceLoop);
    assert.equal(metadata.playbackSpeed, 1);

    for (const patch of [{ fps: 0 }, { fps: 121 }, { playbackSpeed: 9 }, { loop: 'yes' }, { defaultDurationMs: -1 }]) {
        await assert.rejects(manager.updateAnimationMetadata('a', patch, ws.options), /must be|true or false/i);
    }
    await assert.rejects(manager.updateAnimationMetadata('missing', { fps: 12 }, ws.options), /does not exist|no metadata/i);
});

test('rename moves frames, metadata and the manifest', async () => {
    const ws = await workspace();
    await manager.importGifBuffer(await gifBuffer(), { ...ws.options, filename: 'a.gif' });
    await manager.importGifBuffer(await fs.readFile(OTHER_GIF_PATH), { ...ws.options, filename: 'b.gif' });
    await manager.convertAnimation('a', ws.options);
    await manager.convertAnimation('b', ws.options);

    const result = await manager.renameAnimation('a', 'dragon_dance', ws.options);
    assert.equal(result.changed, true);
    assert.equal(result.animationId, 'dragon_dance');

    const entries = await fs.readdir(ws.charactersDir);
    assert.ok(!entries.includes('a'));
    assert.ok(entries.includes('dragon_dance'));
    const metadata = JSON.parse(await fs.readFile(path.join(ws.charactersDir, 'dragon_dance', 'animation.json'), 'utf8'));
    assert.equal(metadata.animationId, 'dragon_dance');

    const manifest = JSON.parse(await fs.readFile(path.join(ws.charactersDir, 'animations.json'), 'utf8'));
    assert.deepEqual(manifest.animations.map(entry => entry.animationId).sort(), ['b', 'dragon_dance']);

    await assert.rejects(manager.renameAnimation('b', 'dragon_dance', ws.options), /already exists/i);
    await assert.rejects(manager.renameAnimation('missing', 'x', ws.options), /does not exist/i);
    assert.equal((await manager.renameAnimation('b', 'b', ws.options)).changed, false);
});

test('deleting an animation that gifts use requires confirmation', async () => {
    const ws = await workspace();
    await manager.importGifBuffer(await gifBuffer(), { ...ws.options, filename: 'a.gif' });
    await manager.convertAnimation('a', ws.options);

    await assert.rejects(
        manager.deleteAnimation('a', { ...ws.options, giftIds: ['5655', '8913'] }),
        error => {
            assert.equal(error.code, 'EMAPPED');
            assert.deepEqual(error.giftIds, ['5655', '8913']);
            return true;
        }
    );
    assert.ok((await fs.readdir(ws.charactersDir)).includes('a'), 'a refused delete must keep the folder');

    const deleted = await manager.deleteAnimation('a', { ...ws.options, giftIds: ['5655'], confirm: true });
    assert.equal(deleted.removed, true);
    assert.ok(!(await fs.readdir(ws.charactersDir)).includes('a'));
    const manifest = JSON.parse(await fs.readFile(path.join(ws.charactersDir, 'animations.json'), 'utf8'));
    assert.deepEqual(manifest.animations, []);
    await assert.rejects(manager.deleteAnimation('a', ws.options), /does not exist/i);
});

test('gift mappings may target converted animations only', () => {
    // `dragon_dance` exists in the catalog too, where the catalog wins; a
    // converted-only id resolves to the character animation.
    const allowed = new Set(['mushroom_dance_42']);
    const accepted = sanitizeGiftAnimations([{ giftId: '5655', animationId: 'mushroom_dance_42' }], { allowedIds: allowed });
    assert.equal(accepted.error, undefined);
    assert.deepEqual(resolveGiftTarget(accepted.value, '5655', allowed), {
        animationId: 'mushroom_dance_42',
        character: 'mushroom_dance_42'
    });
    assert.deepEqual(resolveGiftTarget([{ giftId: '2', animationId: 'dragon_dance' }], '2', allowed), {
        animationId: 'dragon_dance',
        effect: 'dance',
        durationMs: 8000
    });

    const catalog = resolveGiftTarget([{ giftId: '1', animationId: 'fireworks' }], '1', new Set());
    assert.equal(catalog.effect, 'fireworks');

    assert.ok(sanitizeGiftAnimations([{ giftId: '5655', animationId: 'mushroom_dance_42' }]).error);
    assert.ok(sanitizeGiftAnimations([{ giftId: '5655', animationId: '../evil' }], { allowedIds: allowed }).error);
    assert.equal(resolveGiftTarget([{ giftId: '1', animationId: 'gone' }], '1', allowed), null);
});

test('librarySnapshot reports counts, statuses and frames', async () => {
    const ws = await workspace();
    await manager.importGifBuffer(await gifBuffer(), { ...ws.options, filename: 'a.gif' });
    await manager.importGifBuffer(await fs.readFile(OTHER_GIF_PATH), { ...ws.options, filename: 'b.gif' });
    await fs.writeFile(path.join(ws.gifsDir, 'broken.gif'), Buffer.from('GIF89a not really'));
    await manager.convertAnimation('a', ws.options);

    const snapshot = await manager.librarySnapshot(ws.options);
    assert.equal(snapshot.stats.totalGifs, 3);
    assert.equal(snapshot.stats.convertedAnimations, 1);
    assert.ok(snapshot.stats.totalFrames > 0);
    assert.ok(snapshot.stats.failedConversions >= 1);

    const byName = new Map(snapshot.gifs.map(entry => [entry.file, entry]));
    assert.equal(byName.get('a.gif').status, 'converted');
    assert.equal(byName.get('b.gif').status, 'pending');
    assert.equal(byName.get('broken.gif').status, 'invalid');
    assert.equal(snapshot.animations[0].animationId, 'a');
    assert.ok(snapshot.pipeline.limits.maxBytes > 0);
});
