const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const {
    LidSleepController, parseSleepDisabled, buildEnableCommand, buildOsascript, decideStartupAction, isUserCancel
} = require('../main/lid-sleep');

const cancelError = () => Object.assign(new Error('x'), { stderr: 'User canceled. (-128)' });

test('parseSleepDisabled reads the SleepDisabled line of pmset -g', () => {
    assert.equal(parseSleepDisabled('System-wide power settings:\n SleepDisabled\t\t1\nCurrently in use:\n sleep 1'), true);
    assert.equal(parseSleepDisabled('System-wide power settings:\n SleepDisabled\t\t0\n'), false);
    assert.equal(parseSleepDisabled('System-wide power settings:\nCurrently in use:\n sleep 1 (sleep prevented by caffeinate)'), false);
});

test('decideStartupAction fails closed when the sleep state is unknown', () => {
    const cases = [
        [true, true, 'restore-left-over'],
        [null, true, 'restore-left-over'],
        [true, false, 'report-external'],
        [null, false, 'report-unknown'],
        [false, true, 'clear-marker'],
        [false, false, 'none']
    ];
    for (const [sleepDisabled, markerExists, expected] of cases) {
        assert.equal(decideStartupAction({ sleepDisabled, markerExists }), expected, `${sleepDisabled}/${markerExists}`);
    }
});

test('enable command sets disablesleep, then starts the watchdog and records its pid', () => {
    const cmd = buildEnableCommand({ tokenPid: 4242, watchdogPidFile: '/Users/a/Application Support/x.pid' });
    assert.equal(cmd, `'/usr/bin/pmset' -a disablesleep 1 && { /usr/bin/nohup /bin/sh -c ''\\''/usr/bin/caffeinate'\\'' -w 4242; '\\''/usr/bin/pmset'\\'' -a disablesleep 0' >/dev/null 2>&1 & echo $! > '/Users/a/Application Support/x.pid'; }`);
    assert.throws(() => buildEnableCommand({ tokenPid: 0, watchdogPidFile: '/x' }));
    assert.throws(() => buildEnableCommand({ tokenPid: '1; rm -rf /', watchdogPidFile: '/x' }));
});

test('osascript escapes quotes and asks for admin only when privileged', () => {
    assert.equal(buildOsascript({ command: `echo "a\\b"`, prompt: 'P "q"' }), `do shell script "echo \\"a\\\\b\\"" with prompt "P \\"q\\"" with administrator privileges`);
    assert.equal(buildOsascript({ command: 'true', prompt: 'x', privileged: false }), 'do shell script "true"');
});

test('isUserCancel recognises the osascript cancel error', () => {
    assert.equal(isUserCancel(cancelError()), true);
    assert.equal(isUserCancel({ stderr: 'execution error: The administrator user name or password was incorrect. (-60007)' }), false);
});

function fakeController ({ initial = 0, enableSets = 1, watchdogRestores = true, watchdogStarts = true, pmsetFails = false } = {}) {
    const markerPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lid-')), 'marker.json');
    const killed = [];
    const prompts = [];
    const state = { sleepDisabled: initial, onPrompt: null };
    let controller;
    const runner = {
        readPmset: async () => {
            if (pmsetFails) throw new Error('pmset timed out');
            return `SleepDisabled ${state.sleepDisabled}`;
        },
        osascript: async (script) => {
            prompts.push(script);
            if (state.onPrompt) await state.onPrompt(script);
            if (script.includes('disablesleep 1')) {
                state.sleepDisabled = enableSets;
                if (killed.length && watchdogRestores) state.sleepDisabled = 0;
                if (watchdogStarts) fs.writeFileSync(controller.watchdogPidFile, String(process.pid));
            } else state.sleepDisabled = 0;
        },
        spawnToken: () => {
            const token = new EventEmitter();
            token.pid = 777;
            token.kill = (sig) => {
                killed.push(sig);
                if (watchdogRestores) state.sleepDisabled = 0;
            };
            return token;
        }
    };
    controller = new LidSleepController({ markerPath, runner, restoreWaitMs: 50, restorePollMs: 10 });
    return { controller, killed, markerPath, prompts, state };
}

test('active is true only after pmset confirms, not while the password prompt is open', async () => {
    const { controller, state } = fakeController();
    const seen = [];
    state.onPrompt = () => seen.push([controller.pending, controller.active]);
    assert.equal((await controller.enable()).ok, true);
    assert.deepEqual(seen, [[true, false]]);
    assert.deepEqual([controller.pending, controller.active], [false, true]);
});

test('a cancelled password prompt leaves nothing behind', async () => {
    const { controller, killed, markerPath, state } = fakeController();
    state.onPrompt = () => { throw cancelError(); };
    const result = await controller.enable();
    assert.deepEqual([result.ok, result.canceled], [false, true]);
    assert.deepEqual(killed, ['SIGTERM']);
    assert.equal(controller.pending || controller.active, false);
    assert.equal(fs.existsSync(markerPath), false);
});

test('a stop during the password prompt ends the mode once pmset runs', async () => {
    const { controller, markerPath, state } = fakeController();
    state.onPrompt = () => controller.killToken();
    const result = await controller.enable();
    assert.deepEqual(result, { ok: false, reason: 'stopped', restored: true });
    assert.equal(controller.active, false);
    assert.equal(fs.existsSync(markerPath), false);
});

test('enable refuses to take over a disablesleep set by something else', async () => {
    const { controller, prompts } = fakeController({ initial: 1 });
    assert.deepEqual(await controller.enable(), { ok: false, reason: 'already-disabled' });
    assert.equal(prompts.length, 0);
});

test('an unreadable sleep state is unknown, never "restored"', async () => {
    const { controller, prompts } = fakeController({ pmsetFails: true });
    assert.equal(await controller.refresh(), null);
    assert.equal(await controller.waitForRestore(), false);
    assert.deepEqual(await controller.enable(), { ok: false, reason: 'state-unknown' });
    assert.equal(prompts.length, 0);
});

test('enable that pmset does not confirm is rolled back', async () => {
    const { controller, markerPath } = fakeController({ enableSets: 0 });
    const result = await controller.enable();
    assert.equal(result.ok, false);
    assert.equal(controller.active, false);
    assert.equal(fs.existsSync(markerPath), false);
});

test('a watchdog that did not start turns the mode off with the restore prompt', async () => {
    const { controller, prompts, markerPath } = fakeController({ watchdogStarts: false, watchdogRestores: false });
    const result = await controller.enable();
    assert.deepEqual([result.ok, result.restored], [false, true]);
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /disablesleep 0/);
    assert.equal(fs.existsSync(markerPath), false);
});

test('disable restores through the watchdog without a second prompt', async () => {
    const { controller, markerPath, prompts } = fakeController();
    assert.equal((await controller.enable()).ok, true);
    assert.equal(fs.existsSync(markerPath), true);
    assert.deepEqual(await controller.disable(), { restored: true, via: 'watchdog' });
    assert.equal(prompts.length, 1);
    assert.equal(fs.existsSync(markerPath), false);
});

test('disable falls back to the password prompt when the watchdog does not restore', async () => {
    const { controller, markerPath, prompts } = fakeController({ watchdogRestores: false });
    assert.equal((await controller.enable()).ok, true);
    assert.deepEqual(await controller.disable(), { restored: true, via: 'prompt' });
    assert.equal(prompts.length, 2);
    assert.equal(fs.existsSync(markerPath), false);
});

test('a cancelled restore prompt reports sleep as still disabled and keeps the marker', async () => {
    const { controller, markerPath, state } = fakeController({ watchdogRestores: false });
    assert.equal((await controller.enable()).ok, true);
    state.onPrompt = () => { throw cancelError(); };
    const result = await controller.disable();
    assert.deepEqual([result.restored, result.canceled, controller.systemSleepDisabled], [false, true, true]);
    assert.equal(fs.existsSync(markerPath), true);
});

test('a token that dies on its own waits for the watchdog before reporting', async () => {
    const { controller, markerPath, prompts, state } = fakeController({ watchdogRestores: false });
    const ended = [];
    controller.onUnexpectedEnd = (info) => ended.push(info);
    assert.equal((await controller.enable()).ok, true);
    const token = controller.token;
    setTimeout(() => { state.sleepDisabled = 0; }, 20);
    await controller.handleTokenExit(token);
    assert.deepEqual(ended, [{ restored: true }]);
    assert.equal(prompts.length, 1);
    assert.equal(fs.existsSync(markerPath), false);
});
