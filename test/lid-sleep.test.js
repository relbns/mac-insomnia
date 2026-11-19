const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const {
    LidSleepController, parseSleepDisabled, buildEnableCommand, buildOsascript, decideStartupAction, isUserCancel
} = require('../main/lid-sleep');

test('parseSleepDisabled reads the SleepDisabled line of pmset -g', () => {
    assert.equal(parseSleepDisabled('System-wide power settings:\n SleepDisabled\t\t1\nCurrently in use:\n sleep 1'), true);
    assert.equal(parseSleepDisabled('System-wide power settings:\n SleepDisabled\t\t0\n'), false);
    assert.equal(parseSleepDisabled('System-wide power settings:\nCurrently in use:\n sleep 1 (sleep prevented by caffeinate)'), false);
});

test('decideStartupAction', () => {
    assert.equal(decideStartupAction({ sleepDisabled: true, markerExists: true }), 'restore-left-over');
    assert.equal(decideStartupAction({ sleepDisabled: true, markerExists: false }), 'report-external');
    assert.equal(decideStartupAction({ sleepDisabled: false, markerExists: true }), 'clear-marker');
    assert.equal(decideStartupAction({ sleepDisabled: false, markerExists: false }), 'none');
});

test('enable command sets disablesleep before starting the watchdog on the token pid', () => {
    const cmd = buildEnableCommand({ tokenPid: 4242 });
    assert.equal(cmd, `'/usr/bin/pmset' -a disablesleep 1 && { /usr/bin/nohup /bin/sh -c ''\\''/usr/bin/caffeinate'\\'' -w 4242; '\\''/usr/bin/pmset'\\'' -a disablesleep 0' >/dev/null 2>&1 & }`);
    assert.throws(() => buildEnableCommand({ tokenPid: 0 }));
    assert.throws(() => buildEnableCommand({ tokenPid: '1; rm -rf /' }));
});

test('osascript escapes quotes and asks for admin only when privileged', () => {
    assert.equal(buildOsascript({ command: `echo "a\\b"`, prompt: 'P "q"' }), `do shell script "echo \\"a\\\\b\\"" with prompt "P \\"q\\"" with administrator privileges`);
    assert.equal(buildOsascript({ command: 'true', prompt: 'x', privileged: false }), 'do shell script "true"');
});

test('isUserCancel recognises the osascript cancel error', () => {
    assert.equal(isUserCancel({ stderr: '0:120: execution error: User canceled. (-128)' }), true);
    assert.equal(isUserCancel({ stderr: 'execution error: The administrator user name or password was incorrect. (-60007)' }), false);
});

function fakeController ({ osascriptError, enableSets = 1, watchdogRestores = true } = {}) {
    const markerPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lid-')), 'marker.json');
    const killed = [];
    const prompts = [];
    let sleepDisabled = 0;
    const runner = {
        readPmset: async () => `SleepDisabled ${sleepDisabled}`,
        osascript: async (script) => {
            prompts.push(script);
            if (osascriptError) throw osascriptError;
            sleepDisabled = script.includes('disablesleep 1') ? enableSets : 0;
        },
        spawnToken: () => Object.assign(new EventEmitter(), {
            pid: 777,
            kill: (sig) => { killed.push(sig); if (watchdogRestores) sleepDisabled = 0; }
        })
    };
    return { controller: new LidSleepController({ markerPath, runner, restoreWaitMs: 50, restorePollMs: 10 }), killed, markerPath, prompts };
}

test('a cancelled password prompt leaves nothing behind', async () => {
    const { controller, killed, markerPath } = fakeController({ osascriptError: Object.assign(new Error('x'), { stderr: 'User canceled. (-128)' }) });
    const result = await controller.enable();
    assert.deepEqual([result.ok, result.canceled], [false, true]);
    assert.deepEqual(killed, ['SIGTERM']);
    assert.equal(controller.active, false);
    assert.equal(fs.existsSync(markerPath), false);
});

test('enable that pmset does not confirm is rolled back', async () => {
    const { controller, killed, markerPath } = fakeController({ enableSets: 0 });
    const result = await controller.enable();
    assert.equal(result.ok, false);
    assert.deepEqual(killed, ['SIGTERM']);
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
    const { controller, markerPath } = fakeController({ watchdogRestores: false });
    assert.equal((await controller.enable()).ok, true);
    controller.runner.osascript = async () => { throw Object.assign(new Error('x'), { stderr: 'User canceled. (-128)' }); };
    const result = await controller.disable();
    assert.deepEqual([result.restored, result.canceled, controller.systemSleepDisabled], [false, true, true]);
    assert.equal(fs.existsSync(markerPath), true);
});

test('a token that dies on its own reports the end of the mode once', async () => {
    const { controller } = fakeController();
    let ended = 0;
    controller.onUnexpectedEnd = () => ended++;
    assert.equal((await controller.enable()).ok, true);
    controller.token.emit('exit');
    assert.deepEqual([ended, controller.active], [1, false]);
    assert.equal((await controller.enable()).ok, true);
    await controller.disable();
    assert.equal(ended, 1);
});
