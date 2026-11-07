'use strict';

const assert = require('node:assert/strict');
const { defaultVoiceConfig } = require('../src/voice/defaults');
const { normalizeUsername } = require('../src/voice/username-pronunciation');
const { sanitizeDialogues } = require('../src/voice/dialogue');
const { VoiceQueue } = require('../src/voice/queue');
const { sanitizeVoiceConfig } = require('../src/voice/config');

const config = defaultVoiceConfig();
assert.equal(config.language, 'en-US');
assert.equal(config.provider, 'kokoro');

const pronunciations = [
    ['cool_dj2025', 'Cool DJ Twenty Twenty-five'],
    ['@john.smith_88', 'John Smith Eighty-eight'],
    ['xX_darkwolf_Xx', 'Dark Wolf'],
    ['🎉party_king🎉', 'Party King']
];
for (const [raw, expected] of pronunciations) {
    const result = normalizeUsername(raw, config.username, config.pronunciations);
    assert.equal(result.spoken, expected, `${raw} should become ${expected}`);
}
const overridden = normalizeUsername('cool_dj2025', config.username, [
    { username: '@cool_dj2025', spoken: 'Cool Jay' }
]);
assert.equal(overridden.spoken, 'Cool Jay');
assert.equal(overridden.overridden, true);

for (const [category, lines] of Object.entries(config.dialogues)) {
    assert.ok(lines.length >= 10, `${category} needs at least 10 seed variations`);
    assert.ok(lines.every(line => /^[A-Za-z0-9 ,.!?'’\-:{}]+$/.test(line.text)),
        `${category} must contain only English dialogue and supported placeholders`);
}

const sanitized = sanitizeDialogues({
    welcome: [
        { id: 'one', text: 'Hello {name}' },
        { id: 'one', text: 'Duplicate id is ignored' },
        { id: 'two', text: 'Disabled line', enabled: false }
    ]
});
assert.equal(sanitized.welcome.length, 2);
assert.equal(sanitized.welcome[1].enabled, false);

const queue = new VoiceQueue({ maxQueue: 2, cooldownsMs: { gift: 10_000 } });
assert.equal(queue.enqueue({ category: 'random', priority: 1, text: 'random', userId: 'a', dedupeKey: 'a' }).accepted, true);
assert.equal(queue.enqueue({ category: 'vip', priority: 6, text: 'vip', userId: 'b', dedupeKey: 'b' }).accepted, true);
assert.equal(queue.enqueue({ category: 'gift', priority: 5, text: 'gift', userId: 'c', dedupeKey: 'c' }).accepted, true);
assert.equal(queue.dequeue().text, 'vip');
assert.equal(queue.dequeue().text, 'gift');

const cooldownQueue = new VoiceQueue({ maxQueue: 4, cooldownsMs: { gift: 10_000 } });
assert.equal(cooldownQueue.enqueue({ category: 'gift', text: 'first', userId: 'u', dedupeKey: 'first' }).accepted, true);
assert.equal(cooldownQueue.enqueue({ category: 'gift', text: 'second', userId: 'u', dedupeKey: 'second' }).reason, 'cooldown');
assert.equal(cooldownQueue.enqueue({ category: 'gift', text: 'first', userId: 'u', dedupeKey: 'first', bypassCooldown: true }).reason, 'duplicate');

const bounded = sanitizeVoiceConfig({
    provider: 'windows',
    voice: 'Microsoft David Desktop',
    speed: 99,
    volume: -5,
    maxQueue: 0,
    events: { welcome: false },
    dialogues: config.dialogues
});
assert.equal(bounded.provider, 'windows');
assert.equal(bounded.voice, 'Microsoft David Desktop');
assert.equal(bounded.speed, 1.35);
assert.equal(bounded.volume, 0);
assert.equal(bounded.maxQueue, 1);
assert.equal(bounded.events.welcome, false);

console.log('Voice self-test passed:', {
    pronunciationCases: pronunciations.length,
    dialogueCategories: Object.keys(config.dialogues).length,
    totalSeedLines: Object.values(config.dialogues).reduce((sum, lines) => sum + lines.length, 0),
    queuePriority: 'VIP > gift > random',
    providerFallbackConfig: bounded.provider
});
