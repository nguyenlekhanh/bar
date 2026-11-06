'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
    DEFAULT_BACKGROUND,
    DEFAULT_TRANSFORM,
    validateTransform,
    validateBackground,
    loadBackgroundConfig,
    saveBackgroundConfig
} = require('../src/background/registry');

test('accepts every rotation with any flip combination', () => {
    for (const rotation of [0, 90, 180, 270]) {
        for (const flipHorizontal of [false, true]) {
            for (const flipVertical of [false, true]) {
                const result = validateTransform({ rotation, flipHorizontal, flipVertical });
                assert.equal(result.error, undefined, `${rotation}/${flipHorizontal}/${flipVertical}`);
                assert.deepEqual(result.value, { rotation, flipHorizontal, flipVertical });
            }
        }
    }
});

test('rejects rotations outside 0/90/180/270', () => {
    for (const rotation of [45, -90, 360, 91, '90', null, 1.5]) {
        assert.ok(validateTransform({ rotation }).error, `expected rejection for ${JSON.stringify(rotation)}`);
    }
});

test('rejects non-boolean flips and unknown keys', () => {
    assert.ok(validateTransform({ rotation: 0, flipHorizontal: 'yes' }).error);
    assert.ok(validateTransform({ rotation: 0, flipVertical: 1 }).error);
    assert.ok(validateTransform({ rotation: 0, rotate: 90 }).error);
    assert.ok(validateTransform([90]).error);
    assert.ok(validateTransform('90').error);
});

test('an absent transform is not an error', () => {
    assert.equal(validateTransform(undefined).value, null);
    assert.equal(validateTransform(null).value, null);
    assert.deepEqual(DEFAULT_TRANSFORM, { rotation: 0, flipHorizontal: false, flipVertical: false });
});

test('the background carries the validated transform', () => {
    const result = validateBackground({
        file: 'clip.mp4',
        type: 'video',
        transform: { rotation: 270, flipHorizontal: true, flipVertical: false }
    });
    assert.equal(result.error, undefined);
    assert.deepEqual(result.value.transform, { rotation: 270, flipHorizontal: true, flipVertical: false });
    assert.equal(result.value.rotation, 270);
});

test('a bad transform fails the whole background', () => {
    assert.ok(validateBackground({ file: 'clip.mp4', type: 'video', transform: { rotation: 45 } }).error);
    assert.ok(validateBackground({ file: 'clip.mp4', type: 'video', transform: { flipHorizontal: 'no' } }).error);
});

test('images accept a neutral transform but reject a real one', () => {
    const neutral = validateBackground({
        file: 'stage.png',
        type: 'image',
        transform: { rotation: 0, flipHorizontal: false, flipVertical: false }
    });
    assert.equal(neutral.error, undefined);
    assert.deepEqual(neutral.value.transform, { rotation: 0, flipHorizontal: false, flipVertical: false });

    for (const transform of [
        { rotation: 180 },
        { rotation: 0, flipHorizontal: true },
        { rotation: 0, flipVertical: true },
    ]) {
        assert.ok(validateBackground({ file: 'stage.png', type: 'image', transform }).error);
    }
});

test('a Phase 1.2 config with only rotation still loads', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bg-transform-'));
    const configPath = path.join(dir, 'background.json');
    await fs.writeFile(configPath, JSON.stringify({ file: 'clip.mp4', type: 'video', rotation: 90 }), 'utf8');

    const loaded = await loadBackgroundConfig(configPath);
    assert.equal(loaded.file, 'clip.mp4');
    assert.equal(loaded.rotation, 90);
    assert.deepEqual(loaded.transform, { rotation: 90, flipHorizontal: false, flipVertical: false });
});

test('configs written before transforms existed still fall back cleanly', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bg-transform-'));
    const configPath = path.join(dir, 'background.json');
    await fs.writeFile(configPath, JSON.stringify({ file: 'gone.mp4', type: 'video', rotation: 90 }), 'utf8');

    const available = [{ file: 'present.png', type: 'image' }];
    assert.deepEqual(await loadBackgroundConfig(configPath, { available }), DEFAULT_BACKGROUND);
});

test('transform persists through the atomic save', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bg-transform-'));
    const configPath = path.join(dir, 'nested', 'background.json');

    const saved = await saveBackgroundConfig(configPath, {
        file: 'clip.webm',
        type: 'video',
        fitMode: 'fill',
        loop: true,
        id: 'bg_live',
        transform: { rotation: 180, flipHorizontal: true, flipVertical: true },
        generation: 12
    });
    assert.deepEqual(saved.transform, { rotation: 180, flipHorizontal: true, flipVertical: true });

    const loaded = await loadBackgroundConfig(configPath);
    assert.deepEqual(loaded, saved);
    assert.deepEqual(await fs.readdir(path.dirname(configPath)), ['background.json']);
});

test('a transform smuggled into an image name is still rejected', () => {
    assert.ok(validateBackground({ file: 'clip.mp4', type: 'image', transform: { rotation: 90 } }).error);
});
