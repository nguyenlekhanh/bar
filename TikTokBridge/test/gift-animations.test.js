'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
    ANIMATIONS,
    catalogMessage,
    resolveGiftAnimation,
    sanitizeGiftAnimations,
    loadGiftAnimations,
    saveGiftAnimations
} = require('../src/gifts/animations');

async function tempFile(name = 'gift-animations.json') {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gift-anim-'));
    return path.join(directory, name);
}

test('the catalog is allow-listed and self-consistent', () => {
    assert.ok(ANIMATIONS.length >= 5);
    const ids = ANIMATIONS.map(animation => animation.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const animation of ANIMATIONS) {
        assert.match(animation.id, /^[a-z0-9_]+$/);
        assert.ok(animation.effect, `${animation.id} needs an effect`);
        assert.ok(animation.durationMs > 0, `${animation.id} needs a duration`);
    }
    assert.deepEqual(catalogMessage(), ANIMATIONS.map(animation => ({ ...animation })));
    // Mutating the copy must not corrupt the catalog.
    catalogMessage()[0].effect = 'hacked';
    assert.notEqual(ANIMATIONS[0].effect, 'hacked');
});

test('accepts the documented example mapping', () => {
    const result = sanitizeGiftAnimations({
        giftAnimations: [
            { giftId: '5655', animationId: 'dragon_dance' },
            { giftId: '8913', animationId: 'fireworks' },
            { giftId: '5269', animationId: 'heart_effect' }
        ]
    });
    assert.equal(result.error, undefined);
    assert.deepEqual(result.value, [
        { giftId: '5269', animationId: 'heart_effect' },
        { giftId: '5655', animationId: 'dragon_dance' },
        { giftId: '8913', animationId: 'fireworks' }
    ]);
});

test('several gift IDs may share one animation', () => {
    const result = sanitizeGiftAnimations([
        { giftId: '5655', animationId: 'dragon_dance' },
        { giftId: '5487', animationId: 'dragon_dance' },
        { giftId: '7934', animationId: 'dragon_dance' }
    ]);
    assert.equal(result.error, undefined);
    assert.equal(result.value.length, 3);
    assert.deepEqual(
        result.value.map(item => item.animationId),
        ['dragon_dance', 'dragon_dance', 'dragon_dance']
    );
});

test('an unknown animation ID is rejected', () => {
    for (const animationId of ['rm -rf', '../../Assets/evil.prefab', 'Dragon_Dance', '', 'dragon dance']) {
        const result = sanitizeGiftAnimations([{ giftId: '5655', animationId }]);
        assert.ok(result.error, `expected rejection for ${JSON.stringify(animationId)}`);
        assert.match(result.error, /unknown animation/i);
    }
});

test('gift IDs must be safe identifiers', () => {
    for (const giftId of ['', 'a/b', '../5655', 'has space', 'x'.repeat(41)]) {
        assert.ok(sanitizeGiftAnimations([{ giftId, animationId: 'dance' }]).error, `expected rejection for ${JSON.stringify(giftId)}`);
    }
    assert.equal(sanitizeGiftAnimations([{ giftId: 'gift_5655-a', animationId: 'dance' }]).error, undefined);
});

test('unknown fields and duplicate gift IDs are rejected', () => {
    assert.match(
        sanitizeGiftAnimations([{ giftId: '1', animationId: 'dance', file: '/etc/passwd' }]).error,
        /unknown field/i
    );
    assert.match(
        sanitizeGiftAnimations([
            { giftId: '1', animationId: 'dance' },
            { giftId: '1', animationId: 'jump' }
        ]).error,
        /more than once/i
    );
    assert.ok(sanitizeGiftAnimations('nope').error);
    assert.ok(sanitizeGiftAnimations({ giftAnimations: 'nope' }).error);
});

test('an empty mapping is valid', () => {
    assert.deepEqual(sanitizeGiftAnimations({ giftAnimations: [] }).value, []);
    assert.deepEqual(sanitizeGiftAnimations({}).value, []);
});

test('resolution maps gift IDs to animations and falls back to null', () => {
    const mappings = [
        { giftId: '5655', animationId: 'dragon_dance' },
        { giftId: '8913', animationId: 'fireworks' }
    ];
    const dragon = resolveGiftAnimation(mappings, '5655');
    assert.equal(dragon.id, 'dragon_dance');
    assert.equal(dragon.effect, 'dance');
    assert.equal(dragon.durationMs, 8000);
    assert.equal(resolveGiftAnimation(mappings, 8913).id, 'fireworks');
    assert.equal(resolveGiftAnimation(mappings, '0000'), null);
    assert.equal(resolveGiftAnimation(mappings, ''), null);
    assert.equal(resolveGiftAnimation([], '5655'), null);
    assert.equal(resolveGiftAnimation(mappings, undefined), null);
});

test('a stale animation ID in a hand-edited file does not resolve', () => {
    assert.equal(resolveGiftAnimation([{ giftId: '5655', animationId: 'gone' }], '5655'), null);
});

test('mapping round-trips through the atomic save', async () => {
    const file = await tempFile();
    const mappings = [
        { giftId: '5655', animationId: 'dragon_dance' },
        { giftId: '8913', animationId: 'fireworks' }
    ];
    await saveGiftAnimations(file, mappings);

    const loaded = await loadGiftAnimations(file);
    assert.deepEqual(loaded, { mappings });
    assert.deepEqual(await fs.readdir(path.dirname(file)), ['gift-animations.json']);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { giftAnimations: mappings });
});

test('a missing file means no mappings, and a broken file means no mappings', async () => {
    const missing = await tempFile('does-not-exist.json');
    assert.deepEqual(await loadGiftAnimations(missing), { mappings: [] });

    const broken = await tempFile();
    await fs.writeFile(broken, '{ not json', 'utf8');
    const result = await loadGiftAnimations(broken);
    assert.deepEqual(result.mappings, []);
    assert.ok(result.error);

    const invalid = await tempFile();
    await fs.writeFile(invalid, JSON.stringify({ giftAnimations: [{ giftId: '1', animationId: 'nope' }] }), 'utf8');
    const rejected = await loadGiftAnimations(invalid);
    assert.deepEqual(rejected.mappings, []);
    assert.match(rejected.error, /unknown animation/i);
});
