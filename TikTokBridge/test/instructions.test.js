const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
    MAX_LINES,
    defaultInstructionConfig,
    sanitizeInstructionConfig
} = require('../src/instructions/config');
const {
    inspectPng,
    saveInstructionIcon
} = require('../src/instructions/icons');

function pngHeader(width, height) {
    const buffer = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
    buffer.writeUInt32BE(13, 8);
    buffer.write('IHDR', 12, 'ascii');
    buffer.writeUInt32BE(width, 16);
    buffer.writeUInt32BE(height, 20);
    return buffer;
}

test('instruction config keeps 20 lines and rejects more than the bridge limit', () => {
    const lines = Array.from({ length: 20 }, (_, index) => ({
        id: `line-${index}`,
        title: `Instruction ${index + 1}`,
        subtitle: 'Subtitle',
        icon: 'star',
        enabled: index % 3 !== 0
    }));
    const result = sanitizeInstructionConfig({ lines });
    assert.equal(result.error, undefined);
    assert.equal(result.value.lines.length, 20);
    assert.equal(result.value.lines[0].enabled, false);
    assert.equal(result.value.lines[1].enabled, true);

    const tooMany = Array.from({ length: MAX_LINES + 1 }, () => ({ title: 'Line' }));
    assert.match(sanitizeInstructionConfig({ lines: tooMany }).error, /maximum/i);
});

test('instruction text and colors are sanitized, long text is clipped', () => {
    const result = sanitizeInstructionConfig({
        position: 'not-a-corner',
        fontSize: 999,
        opacity: 2,
        lines: [{
            id: 'same',
            title: `  <b>${'A'.repeat(100)}</b>  `,
            subtitle: 'Read the\nrules',
            icon: '../../evil.png',
            iconFile: '../icon.png',
            textColor: 'red',
            iconColor: '#12abef',
            enabled: false,
            highlight: true
        }, {
            id: 'same',
            title: 'Second',
            icon: 'custom',
            iconFile: 'icon-abc_123.png'
        }]
    });
    assert.equal(result.error, undefined);
    assert.equal(result.value.position, 'top-right');
    assert.equal(result.value.fontSize, 60);
    assert.equal(result.value.opacity, 0.9);
    assert.equal(result.value.lines[0].title.length, 60);
    assert.equal(result.value.lines[0].subtitle, 'Read the rules');
    assert.equal(result.value.lines[0].icon, 'image');
    assert.equal(result.value.lines[0].iconFile, '');
    assert.equal(result.value.lines[0].textColor, '#FFFFFF');
    assert.equal(result.value.lines[0].iconColor, '#12ABEF');
    assert.equal(result.value.lines[0].enabled, false);
    assert.equal(result.value.lines[0].highlight, true);
    assert.equal(result.value.lines[1].id, 'same-2');
    assert.equal(result.value.lines[1].icon, 'image');
    assert.equal(result.value.lines[1].iconFile, 'icon-abc_123.png');
});

test('default instruction config is configurable seed content', () => {
    const config = defaultInstructionConfig();
    assert.equal(config.position, 'top-right');
    assert.ok(config.lines.length >= 5);
    assert.ok(config.lines.every(line => line.title.length > 0));
    config.lines[0].title = 'CHANGED';
    assert.equal(defaultInstructionConfig().lines[0].title, 'ZOOM CAMERA');
});

test('PNG validation rejects wrong signatures, oversized files and non-square icons', () => {
    assert.equal(inspectPng(pngHeader(64, 64)).width, 64);
    assert.match(inspectPng(Buffer.from('not a png')).error, /PNG/);
    assert.match(inspectPng(pngHeader(513, 513)).error, /512/);
    assert.match(inspectPng(pngHeader(64, 32)).error, /square/);
    assert.match(inspectPng(pngHeader(64, 64).subarray(0, 20)).error, /PNG/);
});

test('uploaded icons are content-addressed and written only under the icon folder', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'instruction-icons-'));
    try {
        const buffer = pngHeader(32, 32);
        const first = await saveInstructionIcon(buffer, directory);
        const second = await saveInstructionIcon(buffer, directory);
        assert.equal(first.error, undefined);
        assert.match(first.file, /^icon-[a-f0-9]{16}\.png$/);
        assert.equal(first.file, second.file);
        assert.equal(first.url, `/assets/instruction-icons/${first.file}`);
        assert.equal((await fs.stat(path.join(directory, first.file))).size, buffer.length);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});
