'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createVoiceService } = require('../src/voice/service');
const { defaultVoiceConfig } = require('../src/voice/defaults');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs, label) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (predicate()) return;
        await sleep(100);
    }
    throw new Error(`Timed out waiting for ${label} (${timeoutMs}ms).`);
}

(async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-disco-scheduler-'));
    const configPath = path.join(directory, 'voice.json');
    const announcements = [];
    const statuses = [];
    const base = defaultVoiceConfig();
    base.provider = 'windows';
    base.voice = 'Microsoft David Desktop';
    base.voiceGender = 'male';
    base.boostDb = 0;
    base.autonomous = {
        ...base.autonomous,
        enabled: true,
        idleDetection: true,
        idleSeconds: 10,
        allowZeroViewers: true,
        randomDialogue: true,
        maxPerHour: 180
    };
    await fs.writeFile(configPath, `${JSON.stringify(base, null, 2)}\n`, 'utf8');

    const service = createVoiceService({
        configPath,
        broadcast: () => {},
        broadcastToRole: (role, message) => {
            if (message?.type === 'voice_status') statuses.push(message);
            if (role === 'overlay' && message?.type === 'voice_announcement') announcements.push(message);
        },
        logger: {
            debug: () => {},
            info: () => {},
            warn: message => console.warn(message),
            error: message => console.error(message)
        }
    });

    try {
        await service.start();
        service.setLiveViewerCount(0);
        const liveStartedAt = Date.now();
        service.setLiveSessionActive(true, { state: 'connected' });

        await waitFor(() => announcements.length >= 1, 15_000, 'first autonomous announcement');
        const first = announcements[0];
        assert.equal(first.autonomous, true);
        assert.ok(first.url && first.durationMs > 0);
        const firstDelayMs = first.createdAt - liveStartedAt;
        assert(firstDelayMs >= 9_000, `first autonomous delay was only ${firstDelayMs}ms`);
        console.log('First autonomous announcement:', { durationMs: first.durationMs, firstDelayMs, text: first.text });

        await waitFor(
            () => announcements.length >= 2,
            25_000,
            'second autonomous announcement after the first finished plus idle time'
        );
        assert.notEqual(announcements[1].text, first.text);
        assert.ok(announcements[1].autonomous);

        const afterTwo = service.getStatus();
        assert.equal(afterTwo.autonomous.totalCount, 2);
        assert.equal(afterTwo.liveSession.active, true);

        await waitFor(() => !service.getStatus().current, 10_000, 'second speech to finish');
        service.onGameEvent({ type: 'chat', comment: 'hello', userId: 'activity-test', uniqueId: 'activity_test' });
        const afterActivity = service.getStatus();
        assert(afterActivity.autonomous.secondsUntilNext >= 8);
        assert(afterActivity.autonomous.secondsUntilNext <= 10);
        assert.equal(afterActivity.autonomous.lastActivityReason, 'chat');

        // Repeated LIVE-start calls must not create a second scheduler or reset
        // an already-running session.
        service.setLiveSessionActive(true, { state: 'connected' });
        service.setLiveSessionActive(true, { state: 'reconnecting' });
        const repeated = service.getStatus();
        assert.equal(repeated.liveSession.active, true);
        assert.equal(repeated.autonomous.schedulerActive, true);

        const beforeDisable = announcements.length;
        await service.updateConfig({
            ...base,
            autonomous: { ...base.autonomous, enabled: false }
        });
        await sleep(1500);
        assert.equal(announcements.length, beforeDisable);
        assert.equal(service.getStatus().autonomous.schedulerActive, false);

        await service.updateConfig(base);
        service.setLiveSessionActive(true, { state: 'connected' });
        service.setLiveSessionActive(false, { state: 'ended' });
        const ended = service.getStatus();
        assert.equal(ended.liveSession.active, false);
        assert.equal(ended.autonomous.schedulerActive, false);

        const result = {
            provider: 'windows',
            idleSeconds: 10,
            firstDelayMs,
            firstAutonomousMs: first.createdAt,
            secondAutonomous: announcements[1].text,
            totalAutonomous: afterTwo.autonomous.totalCount,
            activityCountdownSeconds: afterActivity.autonomous.secondsUntilNext,
            disabledStoppedNewSpeech: true,
            liveEndStoppedScheduler: true,
            repeatedLiveStartSingleScheduler: true
        };
        console.log('Voice scheduler test passed:', JSON.stringify(result, null, 2));
    } finally {
        service.dispose();
        await fs.rm(directory, { recursive: true, force: true });
    }
})().catch(error => {
    console.error('Voice scheduler test failed:', error.stack || error);
    process.exitCode = 1;
});
