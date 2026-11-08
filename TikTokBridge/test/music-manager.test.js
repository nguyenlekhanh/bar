'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createMusicService } = require('../src/music/service');

function wavBuffer(seed = 1) {
    const buffer = Buffer.alloc(44);
    buffer.write('RIFF', 0, 'ascii');
    buffer.writeUInt32LE(36, 4);
    buffer.write('WAVEfmt ', 8, 'ascii');
    buffer.writeUInt16LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(2, 22);
    buffer.writeUInt32LE(44100, 24);
    buffer.writeUInt32LE(176400, 28);
    buffer.writeUInt16LE(4, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write('data', 36, 'ascii');
    buffer.writeUInt32LE(0, 40);
    buffer[43] = seed;
    return buffer;
}

function mp3Buffer() {
    return Buffer.from([0xff, 0xfb, 0x90, 0x64, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
}

function oggBuffer() {
    return Buffer.from('OggS000000000000', 'ascii');
}

async function makeFixture() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'music-manager-'));
    const musicDir = path.join(root, 'DJ_MUSIC');
    await fs.mkdir(musicDir);
    await fs.writeFile(path.join(musicDir, 'alpha.wav'), wavBuffer(1));
    await fs.writeFile(path.join(musicDir, 'beta.mp3'), mp3Buffer());
    await fs.writeFile(path.join(musicDir, 'gamma.ogg'), oggBuffer());
    await fs.writeFile(path.join(musicDir, 'broken.mp3'), Buffer.from('not audio'));
    return { root, musicDir, statePath: path.join(root, 'music.json') };
}

function makeService(fixture, overrides = {}) {
    const sent = [];
    const control = [];
    const service = createMusicService({
        musicDir: fixture.musicDir,
        statePath: fixture.statePath,
        broadcastToRole: (role, message) => {
            if (role === 'overlay') sent.push(message);
            if (role === 'control') control.push(message);
        },
        getOverlayCount: () => 1,
        scanIntervalMs: 60000,
        stableMs: 0,
        ...overrides
    });
    return { service, sent, control };
}

test('scans supported files, ignores corrupt entries, and restores a playlist', async () => {
    const fixture = await makeFixture();
    const { service, sent } = makeService(fixture);
    await service.start();
    const snapshot = service.getSnapshot();
    assert.deepEqual(snapshot.library.map(item => item.file), ['alpha.wav', 'beta.mp3', 'broken.mp3', 'gamma.ogg']);
    assert.equal(snapshot.library.find(item => item.file === 'broken.mp3').valid, false);
    assert.deepEqual(snapshot.playlist, ['alpha.wav', 'beta.mp3', 'gamma.ogg']);
    assert.ok(sent.some(message => message.type === 'music_config'));

    const result = await service.command('play', { track: 'beta.mp3' });
    assert.equal(result.ok, true);
    assert.equal(result.sent, true);
    assert.equal(service.getSnapshot().current, 'beta.mp3');
    assert.ok(sent.some(message => message.type === 'music_command' && message.action === 'play' && message.track === 'beta.mp3'));

    service.updateActual({ track: 'beta.mp3', playing: true, paused: false, position: 2, duration: 10, musicVolume: 0.3, shuffle: false, repeat: true });
    assert.equal(service.getSnapshot().actual.playing, true);
    assert.equal(service.getSnapshot().lastAck, null);
    service.acknowledge({ commandId: result.commandId, ok: true, track: 'beta.mp3', playing: true });
    assert.equal(service.getSnapshot().lastAck.ok, true);
    await service.stop();
});

test('next, previous, shuffle, repeat and volume commands update persisted intent', async () => {
    const fixture = await makeFixture();
    const { service } = makeService(fixture);
    await service.start();

    assert.equal((await service.command('next')).ok, true);
    assert.equal(service.getSnapshot().current, 'beta.mp3');
    assert.equal((await service.command('previous')).ok, true);
    assert.equal(service.getSnapshot().current, 'alpha.wav');

    await service.command('set_shuffle', { shuffle: true });
    assert.equal(service.getSnapshot().shuffle, true);
    await service.command('set_repeat', { repeat: false });
    assert.equal(service.getSnapshot().repeat, false);
    await service.command('set_volume', { masterVolume: 0.42 });
    assert.equal(service.getSnapshot().masterVolume, 0.42);
    assert.equal((await fs.readFile(path.join(fixture.musicDir, 'VOLUME.txt'), 'utf8')).trim(), '0.42');
    await service.command('set_track_volume', { track: 'alpha.wav', trackVolume: 0.5 });
    assert.equal(service.getSnapshot().trackVolumes['alpha.wav'], 0.5);
    await service.stop();
});

test('upload is atomic and rejects traversal, wrong type and corruption', async () => {
    const fixture = await makeFixture();
    const { service } = makeService(fixture);
    await service.start();

    const good = await service.upload('uploaded.wav', wavBuffer(4));
    assert.equal(good.ok, true);
    assert.ok(good.snapshot.playlist.includes('uploaded.wav'));
    assert.ok((await fs.stat(path.join(fixture.musicDir, 'uploaded.wav'))).isFile());

    for (const name of ['../escape.wav', 'C:\\escape.wav', 'nul.wav', 'bad.flac']) {
        assert.equal((await service.upload(name, wavBuffer())).ok, false, name);
    }
    assert.equal((await service.upload('bad.wav', Buffer.from('not a wav'))).ok, false);
    const duplicate = await service.upload('uploaded.wav', wavBuffer());
    assert.equal(duplicate.conflict, true);
    await service.stop();
});

test('removing the current track falls back gracefully and persists settings', async () => {
    const fixture = await makeFixture();
    const { service } = makeService(fixture);
    await service.start();
    await service.command('play', { track: 'alpha.wav' });
    service.updateActual({ track: 'alpha.wav', playing: true, paused: false });
    const removed = await service.remove('alpha.wav');
    assert.equal(removed.ok, true);
    assert.notEqual(service.getSnapshot().current, 'alpha.wav');
    assert.ok(!service.getSnapshot().playlist.includes('alpha.wav'));
    assert.equal((await service.remove('../outside.wav')).ok, false);

    await service.stop();
    const second = makeService(fixture);
    await second.service.start();
    assert.ok(second.service.getSnapshot().playlist.includes('beta.mp3'));
    await second.service.stop();
});

test('auto-detection adds a completed file and ignores pending copies until stable', async () => {
    const fixture = await makeFixture();
    const { service } = makeService(fixture);
    await service.start();
    await fs.writeFile(path.join(fixture.musicDir, 'new.wav'), wavBuffer(8));

    await service.applyScan(false, false);
    assert.equal(service.getSnapshot().library.some(item => item.file === 'new.wav'), false);
    await service.applyScan(false, true);
    assert.equal(service.getSnapshot().library.some(item => item.file === 'new.wav'), true);
    assert.ok(service.getSnapshot().playlist.includes('new.wav'));
    await service.stop();
});
