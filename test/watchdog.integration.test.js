const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile, spawn, execFileSync } = require('child_process');
const { LidSleepController } = require('../main/lid-sleep');

const darwin = process.platform === 'darwin';

function setup (t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lid-watchdog-'));
    const state = path.join(dir, 'state');
    const fakePmset = path.join(dir, 'fake pmset');
    fs.writeFileSync(fakePmset, `#!/bin/sh\necho "$@" >> '${dir}/calls'\nif [ "$1" = "-a" ] && [ "$2" = "disablesleep" ]; then echo "$3" > '${state}'; fi\nif [ "$1" = "-g" ]; then echo "System-wide power settings:"; echo " SleepDisabled $(cat '${state}' 2>/dev/null || echo 0)"; fi\n`, { mode: 0o755 });
    const owner = spawn('/bin/sleep', ['120'], { stdio: 'ignore' });
    t.after(() => {
        owner.kill('SIGKILL');
        controller.killToken();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    const runner = {
        readPmset: () => new Promise((resolve, reject) => execFile(fakePmset, ['-g'], (e, out) => (e ? reject(e) : resolve(out)))),
        osascript: (script) => new Promise((resolve, reject) => execFile('/usr/bin/osascript', ['-e', script], (e, out, err) => (e ? reject(Object.assign(e, { stderr: err })) : resolve(out)))),
        spawnToken: (pid) => spawn('/usr/bin/caffeinate', ['-s', '-w', String(pid)], { stdio: 'ignore' })
    };
    const controller = new LidSleepController({
        markerPath: path.join(dir, 'marker.json'),
        ownerPid: owner.pid,
        runner,
        privileged: false,
        commandOptions: { pmsetPath: fakePmset }
    });
    const read = () => (fs.existsSync(state) ? fs.readFileSync(state, 'utf8').trim() : 'unset');
    const watchdogs = () => {
        try {
            return execFileSync('pgrep', ['-f', `${dir}/fake pmset' -a disablesleep 0`], { encoding: 'utf8' }).trim();
        } catch {
            return '';
        }
    };
    return { dir, owner, controller, read, watchdogs };
}

const waitFor = async (fn, ms = 4000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (fn()) return true;
        await new Promise((r) => setTimeout(r, 50));
    }
    return fn();
};

test('turning the mode off restores sleep through the real watchdog and leaves no watchdog process behind', { skip: !darwin }, async (t) => {
    const { owner, controller, read, watchdogs } = setup(t);
    assert.equal((await controller.enable()).ok, true);
    assert.equal(read(), '1');
    assert.notEqual(watchdogs(), '', 'watchdog survives osascript exit');
    assert.equal(controller.watchdogAlive(), true, 'watchdog pid file points at a live process');
    const result = await controller.disable({ allowPrompt: false });
    assert.deepEqual(result, { restored: true, via: 'watchdog' });
    assert.equal(read(), '0');
    assert.equal(await waitFor(() => watchdogs() === ''), true);
});

test('a SIGKILLed app restores sleep and leaves no process behind', { skip: !darwin }, async (t) => {
    const { owner, controller, read, watchdogs } = setup(t);
    assert.equal((await controller.enable()).ok, true);
    const tokenPid = controller.token.pid;
    assert.equal(read(), '1');
    owner.kill('SIGKILL');
    assert.equal(await waitFor(() => read() === '0'), true, 'watchdog restored disablesleep 0');
    assert.equal(await waitFor(() => watchdogs() === ''), true);
    assert.throws(() => process.kill(tokenPid, 0), 'token caffeinate exited with its owner');
});
