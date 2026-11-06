'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { decodeGif, isGif } = require('../src/gifs/gif-decoder');
const { encodePng } = require('../src/gifs/png');
const { convertAll, discoverAnimations, sanitizeAnimationId } = require('../src/gifs/pipeline');

const GIF_PATH = path.join(__dirname, '..', 'assets', 'gifs', 'a.gif');

async function tempWorkspace() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gif-pipeline-'));
    const gifsDir = path.join(root, 'gifs');
    const charactersDir = path.join(root, 'Characters');
    const logDir = path.join(root, 'logs');
    await fs.mkdir(gifsDir, { recursive: true });
    return {
        root,
        gifsDir,
        charactersDir,
        logDir,
        stateFile: path.join(gifsDir, '.conversion-state.json'),
        options: {
            gifsDir,
            charactersDir,
            logDir,
            stateFile: path.join(gifsDir, '.conversion-state.json')
        }
    };
}

test('isGif accepts real GIFs and rejects other data', async () => {
    const gif = await fs.readFile(GIF_PATH);
    assert.equal(isGif(gif), true);
    assert.equal(isGif(Buffer.from([0x47, 0x49, 0x46])), false);
    assert.equal(isGif(Buffer.from('GIF89a')), false);
    assert.equal(isGif(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0])), false);
    assert.equal(isGif(null), false);
});

test('decodeGif rejects non-GIF and truncated input', () => {
    assert.throws(() => decodeGif(Buffer.from('not a gif at all, really not')), /not a GIF/);
    // Too short to even hold a screen descriptor.
    assert.throws(() => decodeGif(Buffer.concat([Buffer.from('GIF89a'), Buffer.from([1, 0, 1, 0])])), /not a GIF/);
    // Full header but a zero-sized canvas.
    const emptyCanvas = Buffer.concat([
        Buffer.from('GIF89a'),
        Buffer.from([0, 0, 0, 0, 0, 0, 0])
    ]);
    assert.equal(emptyCanvas.length, 13);
    assert.throws(() => decodeGif(emptyCanvas), /canvas size/);
});

test('decodeGif preserves frames, size, transparency and timing', async () => {
    const gif = await fs.readFile(GIF_PATH);
    const decoded = decodeGif(gif);

    assert.ok(decoded.width > 0 && decoded.height > 0);
    assert.ok(decoded.frames.length > 1, `expected an animated GIF, got ${decoded.frames.length} frame(s)`);
    assert.equal(decoded.declaredFrameCount, decoded.frames.length);
    assert.ok(decoded.fps > 0 && decoded.fps < 120, `fps ${decoded.fps}`);
    assert.equal(decoded.hasTransparency, true);

    const bytes = decoded.width * decoded.height * 4;
    for (const frame of decoded.frames) {
        assert.equal(frame.rgba.length, bytes);
        assert.ok(frame.delayMs > 0, `frame delay ${frame.delayMs}`);
    }

    // A transparent source must leave fully transparent pixels somewhere.
    const alphas = new Set();
    for (const frame of decoded.frames) {
        for (let index = 3; index < frame.rgba.length; index += 4 * 97) alphas.add(frame.rgba[index]);
        if (alphas.has(0) && alphas.has(255)) break;
    }
    assert.ok(alphas.has(0), 'expected transparent pixels to stay transparent');
    assert.ok(alphas.has(255), 'expected painted pixels to stay opaque');
});

test('encodePng writes a valid RGBA PNG header', () => {
    const width = 3;
    const height = 2;
    const rgba = Buffer.alloc(width * height * 4, 128);
    const png = encodePng(rgba, width, height);

    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(png.subarray(12, 16).toString('ascii'), 'IHDR');
    assert.equal(png.readUInt32BE(16), width);
    assert.equal(png.readUInt32BE(20), height);
    assert.equal(png[24], 8);
    assert.equal(png[25], 6);
    assert.equal(png.subarray(png.length - 8, png.length - 4).toString('ascii'), 'IEND');
    assert.throws(() => encodePng(Buffer.alloc(4), width, height), /expected/);
    assert.throws(() => encodePng(rgba, 0, 2), /positive integer/);
});

test('animation ids are safe, stable and derived from the file name', () => {
    assert.equal(sanitizeAnimationId('mushroom_dance_01.gif'), 'mushroom_dance_01');
    assert.equal(sanitizeAnimationId('Dragon Dance!!.GIF'), 'dragon_dance');
    assert.equal(sanitizeAnimationId('hän han.mov.gif'), 'han_han_mov');
    assert.throws(() => sanitizeAnimationId('.gif'), /Cannot derive/);
});

test('convertAll writes frames, metadata and the Unity manifest', async () => {
    const workspace = await tempWorkspace();
    await fs.copyFile(GIF_PATH, path.join(workspace.gifsDir, 'a.gif'));

    const first = await convertAll(workspace.options);
    assert.equal(first.converted.length, 1);
    assert.equal(first.failed.length, 0);
    assert.equal(first.converted[0].animationId, 'a');

    const folder = path.join(workspace.charactersDir, 'a');
    const pngs = (await fs.readdir(folder)).filter(name => name.endsWith('.png')).sort();
    const metadata = JSON.parse(await fs.readFile(path.join(folder, 'animation.json'), 'utf8'));

    assert.equal(pngs.length, metadata.frameCount);
    assert.equal(pngs[0], '000.png');
    assert.match(pngs[pngs.length - 1], /^\d{3}\.png$/);
    assert.equal(metadata.animationId, 'a');
    assert.equal(metadata.sourceGif, 'a.gif');
    assert.ok(metadata.width > 0 && metadata.height > 0);
    assert.ok(metadata.fps > 0);
    assert.equal(typeof metadata.loop, 'boolean');
    assert.equal(metadata.transparent, true);
    assert.ok(metadata.durationMs > 0);
    assert.equal(metadata.frameDelaysMs.length, metadata.frameCount);

    const manifest = JSON.parse(await fs.readFile(path.join(workspace.charactersDir, 'animations.json'), 'utf8'));
    assert.equal(manifest.animations.length, 1);
    assert.equal(manifest.animations[0].animationId, 'a');
    assert.equal(manifest.animations[0].frameCount, metadata.frameCount);
    assert.equal(manifest.animations[0].fps, metadata.fps);

    const report = JSON.parse(await fs.readFile(path.join(workspace.logDir, 'gif-conversion-report.json'), 'utf8'));
    assert.equal(report.converted.length, 1);
    const log = await fs.readFile(path.join(workspace.logDir, 'gif-conversion.log'), 'utf8');
    assert.match(log, /converted 1/);

    // Original GIF is never touched.
    assert.deepEqual(await fs.readFile(path.join(workspace.gifsDir, 'a.gif')), await fs.readFile(GIF_PATH));
});

test('an unchanged GIF is not converted twice', async () => {
    const workspace = await tempWorkspace();
    await fs.copyFile(GIF_PATH, path.join(workspace.gifsDir, 'a.gif'));

    await convertAll(workspace.options);
    const folder = path.join(workspace.charactersDir, 'a');
    const firstFrame = path.join(folder, '000.png');
    const before = await fs.stat(firstFrame);

    const second = await convertAll(workspace.options);
    assert.equal(second.converted.length, 0);
    assert.equal(second.skipped.length, 1);
    assert.equal(second.skipped[0].animationId, 'a');
    const after = await fs.stat(firstFrame);
    assert.equal(after.mtimeMs, before.mtimeMs, 'frame files must not be rewritten');

    const forced = await convertAll({ ...workspace.options, force: true });
    assert.equal(forced.converted.length, 1);
});

test('a corrupt GIF is reported and leaves the previous animation intact', async () => {
    const workspace = await tempWorkspace();
    await fs.copyFile(GIF_PATH, path.join(workspace.gifsDir, 'a.gif'));
    await convertAll(workspace.options);

    const folder = path.join(workspace.charactersDir, 'a');
    const goodFrames = (await fs.readdir(folder)).filter(name => name.endsWith('.png')).length;

    // Truncated GIF keeps its signature but has no decodable frame data.
    const real = await fs.readFile(GIF_PATH);
    await fs.writeFile(path.join(workspace.gifsDir, 'a.gif'), real.subarray(0, 40));
    await fs.writeFile(path.join(workspace.gifsDir, 'broken.gif'), Buffer.from('GIF89a totally not a gif'));

    const result = await convertAll(workspace.options);
    assert.ok(result.failed.length >= 1, 'expected a failure entry');
    const failedNames = result.failed.map(item => item.gif);
    assert.ok(failedNames.includes('broken.gif'));
    assert.ok(result.failed.every(item => typeof item.error === 'string' && item.error.length > 0));

    const remaining = (await fs.readdir(folder)).filter(name => name.endsWith('.png')).length;
    assert.equal(remaining, goodFrames, 'a failed conversion must not delete working frames');
    assert.ok(!(await fs.readdir(workspace.charactersDir)).includes('broken'));

    const report = JSON.parse(await fs.readFile(path.join(workspace.logDir, 'gif-conversion-report.json'), 'utf8'));
    assert.ok(report.failed.length >= 1);
});

test('changing the frame count replaces stale frames', async () => {
    const workspace = await tempWorkspace();
    await fs.copyFile(GIF_PATH, path.join(workspace.gifsDir, 'a.gif'));
    const first = await convertAll(workspace.options);
    const folder = path.join(workspace.charactersDir, 'a');
    const staleCount = first.converted[0].frameCount;

    // Drop a leftover frame from a previous, longer conversion.
    await fs.writeFile(path.join(folder, '999.png'), Buffer.from('stale'));
    const second = await convertAll({ ...workspace.options, force: true });

    const names = await fs.readdir(folder);
    assert.ok(!names.includes('999.png'), 'stale frames must be removed');
    assert.equal(names.filter(name => name.endsWith('.png')).length, staleCount);
    assert.equal(second.converted[0].frameCount, staleCount);
});

test('discovery lists every folder with frames, with or without metadata', async () => {
    const workspace = await tempWorkspace();
    await fs.mkdir(path.join(workspace.charactersDir, 'a'), { recursive: true });
    await fs.mkdir(path.join(workspace.charactersDir, 'manual'), { recursive: true });
    await fs.writeFile(path.join(workspace.charactersDir, 'a', '000.png'), Buffer.from('x'));
    await fs.writeFile(path.join(workspace.charactersDir, 'manual', '000.png'), Buffer.from('x'));
    await fs.writeFile(path.join(workspace.charactersDir, 'manual', '001.png'), Buffer.from('x'));
    await fs.writeFile(
        path.join(workspace.charactersDir, 'a', 'animation.json'),
        JSON.stringify({ animationId: 'a', frameCount: 1, fps: 18, loop: false, transparent: false })
    );

    const found = await discoverAnimations(workspace.charactersDir);
    assert.deepEqual(found.map(item => item.animationId), ['a', 'manual']);
    const a = found.find(item => item.animationId === 'a');
    const manual = found.find(item => item.animationId === 'manual');
    assert.equal(a.fps, 18);
    assert.equal(a.loop, false);
    assert.equal(a.transparent, false);
    assert.equal(manual.frameCount, 2);
    assert.equal(manual.fps, 12);
    assert.equal(manual.loop, true);
});
