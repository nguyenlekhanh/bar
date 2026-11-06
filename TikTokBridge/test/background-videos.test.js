'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
    videoPath,
    listBackgroundFiles,
    resolveBackgroundPath,
    kindForFile,
    validateBackground,
    WEBM_WARNING
} = require('./helpers/background-fixtures');

test('classifies every supported container', () => {
    for (const file of ['a.png', 'a.PNG', 'a.jpg', 'a.jpeg']) assert.equal(kindForFile(file), 'image');
    for (const file of ['a.mp4', 'a.M4V', 'a.mov', 'a.webm']) assert.equal(kindForFile(file), 'video');
    for (const file of ['a.gif', 'a.mkv', 'a.avi', 'a.txt', '']) assert.equal(kindForFile(file), null);
});

test('lists webm clips from DJ_VIDEO next to LiveAssets videos', async () => {
    const { root, extra } = await videoPath({
        videos: ['LiveClip.mp4'],
        extra: ['video1.webm', 'notes.txt', 'stage.mp4'],
        images: ['bg.png']
    });

    const listing = await listBackgroundFiles(root, { extraVideoDirs: [extra] });

    assert.deepEqual(listing.images.map(item => item.file), ['bg.png']);
    assert.deepEqual(listing.videos.map(item => item.file), ['LiveClip.mp4', 'stage.mp4', 'video1.webm']);
    assert.equal(listing.all.length, 4);

    const webm = listing.videos.find(item => item.file === 'video1.webm');
    assert.equal(webm.type, 'video');
    assert.equal(webm.folder, 'DJ_VIDEO');
    assert.equal(webm.warning, WEBM_WARNING);
    assert.ok(webm.bytes > 0);

    const mp4 = listing.videos.find(item => item.file === 'stage.mp4');
    assert.equal(mp4.folder, 'DJ_VIDEO');
    assert.equal(mp4.warning, undefined);
});

test('a clip present in both folders is offered once', async () => {
    const { root, extra } = await videoPath({
        videos: ['same.mp4'],
        extra: ['same.mp4']
    });

    const listing = await listBackgroundFiles(root, { extraVideoDirs: [extra] });
    assert.deepEqual(listing.videos.map(item => item.file), ['same.mp4']);
    assert.equal(listing.videos[0].folder, 'videos');
});

test('extra video folders are optional and deduplicated', async () => {
    const { root, extra } = await videoPath({ videos: ['a.mp4'], extra: ['b.webm'] });

    const withoutExtra = await listBackgroundFiles(root);
    assert.deepEqual(withoutExtra.videos.map(item => item.file), ['a.mp4']);

    const repeated = await listBackgroundFiles(root, { extraVideoDirs: [extra, extra] });
    assert.deepEqual(repeated.videos.map(item => item.file), ['a.mp4', 'b.webm']);
});

test('oversized and empty clips are skipped', async () => {
    const { root, extra } = await videoPath({ extra: [] });
    await fs.writeFile(path.join(extra, 'empty.mp4'), Buffer.alloc(0));
    await fs.writeFile(path.join(extra, 'locked.webm'), Buffer.alloc(4, 0));

    const listing = await listBackgroundFiles(root, { extraVideoDirs: [extra] });
    assert.deepEqual(listing.videos.map(item => item.file), ['locked.webm']);
});

test('resolveBackgroundPath finds the real file in DJ_VIDEO', async () => {
    const { root, extra } = await videoPath({ videos: [], extra: ['video1.webm'] });

    const resolved = resolveBackgroundPath(root, { type: 'video', file: 'video1.webm' }, { extraVideoDirs: [extra] });
    assert.equal(resolved.error, undefined);
    assert.equal(resolved.exists, true);
    assert.equal(resolved.folder, 'DJ_VIDEO');
    assert.equal(resolved.absolute, path.join(path.resolve(extra), 'video1.webm'));
});

test('resolveBackgroundPath still refuses anything outside the roots', async () => {
    const { root, extra } = await videoPath({ extra: ['video1.webm'] });

    for (const file of ['../video1.webm', '..\\video1.webm', 'C:/Windows/win.ini', '/etc/passwd', 'sub/video1.webm', 'a..b.webm']) {
        const resolved = resolveBackgroundPath(root, { type: 'video', file }, { extraVideoDirs: [extra] });
        assert.ok(resolved.error, `expected rejection for ${file}`);
    }

    const missing = resolveBackgroundPath(root, { type: 'video', file: 'nope.mp4' }, { extraVideoDirs: [extra] });
    assert.equal(missing.exists, false);
    assert.equal(missing.absolute, path.join(path.resolve(root, 'videos'), 'nope.mp4'));
});

test('an image name cannot be smuggled into the video roots', async () => {
    const { root, extra } = await videoPath({ extra: ['video1.webm'] });

    assert.ok(resolveBackgroundPath(root, { type: 'video', file: 'bg.png' }, { extraVideoDirs: [extra] }).error);
    assert.ok(validateBackground({ file: 'video1.webm', type: 'image' }).error);
});

test('the catalogue gate accepts a webm that really exists', async () => {
    const { root, extra } = await videoPath({ extra: ['video1.webm'] });
    const listing = await listBackgroundFiles(root, { extraVideoDirs: [extra] });

    const accepted = validateBackground({ file: 'video1.webm', type: 'video' }, { available: listing.all });
    assert.equal(accepted.error, undefined);
    assert.equal(accepted.value.type, 'video');

    const shadow = validateBackground({ file: 'ghost.webm', type: 'video' }, { available: listing.all });
    assert.ok(shadow.error);
});
