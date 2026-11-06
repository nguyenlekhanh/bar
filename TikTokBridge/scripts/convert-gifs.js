#!/usr/bin/env node
'use strict';

/**
 * Converts assets/gifs/*.gif into Unity character animation folders.
 *
 *   node scripts/convert-gifs.js           # convert new/changed GIFs
 *   node scripts/convert-gifs.js --force   # reconvert everything
 *   node scripts/convert-gifs.js --watch   # keep watching the folder
 *
 * Logs:   logs/gif-conversion.log
 * Report: logs/gif-conversion-report.json
 */

const { convertAll, startAutoConversion } = require('../src/gifs/pipeline');

const argv = new Set(process.argv.slice(2));
const force = argv.has('--force');
const watch = argv.has('--watch');
const quiet = argv.has('--quiet');

async function main() {
    if (watch) {
        const runner = startAutoConversion({
            force,
            logger: message => console.log(message)
        });
        const shutdown = () => {
            runner.stop();
            process.exit(0);
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
        console.log('Watching for new GIFs… (Ctrl+C to stop)');
        return;
    }

    const result = await convertAll({ force });
    if (!quiet) {
        for (const item of result.converted) {
            console.log(`✓ ${item.gif} → ${item.animationId} (${item.frameCount} frames @ ${item.fps} fps)`);
        }
        for (const item of result.skipped) {
            console.log(`= ${item.gif} → ${item.animationId} (unchanged, ${item.frameCount} frames)`);
        }
        for (const item of result.failed) {
            console.error(`✗ ${item.gif}: ${item.error}`);
        }
        console.log(
            `\n${result.converted.length} converted, ${result.skipped.length} skipped, ` +
            `${result.failed.length} failed, ${result.animations.length} animation folders registered.`
        );
    }
    if (result.failed.length) process.exitCode = 1;
}

main().catch(error => {
    console.error('GIF conversion failed:', error);
    process.exitCode = 1;
});
