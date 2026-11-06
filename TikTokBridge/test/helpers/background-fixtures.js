'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
    listBackgroundFiles,
    resolveBackgroundPath,
    kindForFile,
    validateBackground,
    WEBM_WARNING
} = require('../../src/background/registry');

/**
 * Builds a throw-away media layout:
 *   <root>/images/*, <root>/videos/*  and a separate DJ_VIDEO folder.
 * File contents are irrelevant here — only names, sizes and locations matter.
 */
async function videoPath({ images = [], videos = [], extra = [] } = {}) {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'bg-video-'));
    const root = path.join(base, 'Backgrounds');
    const extraDir = path.join(base, 'DJ_VIDEO');

    await fs.mkdir(path.join(root, 'images'), { recursive: true });
    await fs.mkdir(path.join(root, 'videos'), { recursive: true });
    await fs.mkdir(extraDir, { recursive: true });

    for (const file of images) await fs.writeFile(path.join(root, 'images', file), Buffer.alloc(16, 1));
    for (const file of videos) await fs.writeFile(path.join(root, 'videos', file), Buffer.alloc(32, 2));
    for (const file of extra) await fs.writeFile(path.join(extraDir, file), Buffer.alloc(48, 3));

    return { base, root, extra: extraDir };
}

module.exports = {
    videoPath,
    listBackgroundFiles,
    resolveBackgroundPath,
    kindForFile,
    validateBackground,
    WEBM_WARNING
};
