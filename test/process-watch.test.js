const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { HOLD_CAP_SECONDS, ProcessWatcher, parseProcessList, candidateProcesses, displayName, labelFor, holdOutcome, orphanedWatchHolds } = require('../main/process-watch');

const PS = `
 9441 139.2 /System/Library/Frameworks/Virtualization.framework/Versions/A/XPCServices/com.apple.Virtualization.VirtualMachine
32466  10.0 /Users/a/.vscode/extensions/anthropic.claude-code/resources/native-binary/claude
58863   7.7 /Applications/ClipFlow.app/Contents/MacOS/ClipFlow
  588   3.6 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
  590   2.1 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper
  604   4.8 /usr/libexec/spotlightknowledged.updater
59131   3.2 docker
70000  25.0 /opt/homebrew/bin/ffmpeg
70001   0.4 /usr/bin/rsync
  700   9.0 -zsh
 4242  50.0 /Applications/Mac Insomnia.app/Contents/MacOS/Mac Insomnia
`;
const CAP_MS = HOLD_CAP_SECONDS * 1000;

test('displayName shows the app name for app bundles and the binary name otherwise', () => {
    assert.equal(displayName('/Applications/Docker.app/Contents/MacOS/com.docker.backend'), 'Docker');
    assert.equal(displayName('/opt/homebrew/bin/ffmpeg'), 'ffmpeg');
});

test('candidates are busy user apps and tools, busiest first, without system services, helpers, shells or Insomnia', () => {
    const list = candidateProcesses(parseProcessList(PS), { selfPid: 1, watchedPids: [32466] });
    assert.deepEqual(list.map((p) => p.name), ['ffmpeg', 'ClipFlow', 'Google Chrome', 'docker']);
});

test('two processes with the same name are labelled with their pid', () => {
    const all = [{ pid: 1, name: 'node' }, { pid: 2, name: 'node' }, { pid: 3, name: 'ffmpeg' }];
    assert.equal(labelFor(all[0], all), 'node (pid 1)');
    assert.equal(labelFor(all[2], all), 'ffmpeg');
});

test('a hold that exits normally means the process finished, unless it ran into its cap', () => {
    assert.equal(holdOutcome({ code: 0, signal: null, heldMs: 60 * 1000 }), 'finished');
    assert.equal(holdOutcome({ code: 0, signal: null, heldMs: CAP_MS }), 'renew');
    assert.equal(holdOutcome({ code: null, signal: 'SIGKILL', heldMs: 60 * 1000 }), 'unexpected');
    assert.equal(holdOutcome({ code: 1, signal: null, heldMs: 60 * 1000 }), 'unexpected');
});

test('orphaned holds are only our capped waits whose parent died', () => {
    const table = `
  10 1 /usr/bin/caffeinate -ims -t ${HOLD_CAP_SECONDS} -w 600
  11 1 /usr/bin/caffeinate -dimsu -t ${HOLD_CAP_SECONDS} -w 601
  12 4242 /usr/bin/caffeinate -ims -t ${HOLD_CAP_SECONDS} -w 602
  13 1 /usr/bin/caffeinate -w 603
  14 1 /usr/bin/caffeinate -dimsu -w 4242
`;
    assert.deepEqual(orphanedWatchHolds(table), [10, 11]);
});

function fakeWatcher (t, { names = {}, flag = '-ims' } = {}) {
    const holds = [];
    const events = [];
    let now = 0;
    const state = { flag };
    const watcher = new ProcessWatcher({
        keepAwakeFlag: () => state.flag,
        onFinished: ({ name }) => events.push(`finished:${name}`),
        onUnexpectedEnd: ({ name }) => events.push(`unexpected:${name}`),
        runner: {
            processName: async (pid) => names[pid] ?? null,
            holdWhileAlive: (pid, args) => {
                const child = Object.assign(new EventEmitter(), { killed: false, args });
                child.kill = () => { child.killed = true; };
                holds.push({ pid, child });
                return child;
            },
            now: () => now
        }
    });
    t.after(() => watcher.unwatchAll());
    return { watcher, holds, events, state, advance: (ms) => { now += ms; } };
}

test('waiting holds the Mac awake with a capped caffeinate until the process ends, then reports it finished', (t) => {
    const { watcher, holds, events, advance } = fakeWatcher(t);
    watcher.watch(70000, 'ffmpeg');
    assert.deepEqual(holds[0].child.args, ['-ims', '-t', String(HOLD_CAP_SECONDS)]);
    advance(60 * 1000);
    holds[0].child.emit('exit', 0, null);
    assert.equal(watcher.count, 0);
    assert.deepEqual(events, ['finished:ffmpeg']);
});

test('a hold killed from outside reports that the wait stopped, not that the process finished', (t) => {
    const { watcher, holds, events } = fakeWatcher(t);
    watcher.watch(70000, 'ffmpeg');
    holds[0].child.emit('exit', null, 'SIGTERM');
    assert.deepEqual(events, ['unexpected:ffmpeg']);
});

test('a hold that reaches its cap is renewed while the process still runs', (t) => {
    const { watcher, holds, events, advance } = fakeWatcher(t);
    watcher.watch(70000, 'ffmpeg');
    advance(CAP_MS);
    holds[0].child.emit('exit', 0, null);
    assert.equal(watcher.count, 1);
    assert.equal(holds.length, 2);
    assert.deepEqual(events, []);
});

test('stopping the wait reports nothing', (t) => {
    const { watcher, holds, events } = fakeWatcher(t);
    watcher.watch(70000, 'ffmpeg');
    watcher.unwatch(70000);
    holds[0].child.emit('exit', null, 'SIGTERM');
    assert.equal(holds[0].child.killed, true);
    assert.deepEqual(events, []);
});

test('changing Let the Display Sleep replaces running holds with the new flag', (t) => {
    const { watcher, holds, events, state } = fakeWatcher(t, { flag: '-dimsu' });
    watcher.watch(70000, 'ffmpeg');
    state.flag = '-ims';
    watcher.reapplyFlags();
    holds[0].child.emit('exit', null, 'SIGTERM');
    assert.equal(holds[1].child.args[0], '-ims');
    assert.equal(holds[0].child.killed, true);
    assert.equal(watcher.count, 1);
    assert.deepEqual(events, []);
});

test('a link or a stale menu entry waits only for a process that still runs under that name', async (t) => {
    const { watcher } = fakeWatcher(t, { names: { 70000: 'ffmpeg', 70002: 'node' } });
    assert.deepEqual(await watcher.watchPid(12345), { ok: false, reason: 'not-running' });
    assert.deepEqual(await watcher.watchChecked(70002, 'ffmpeg'), { ok: false, reason: 'not-running' });
    assert.deepEqual(await watcher.watchPid(70000), { ok: true, name: 'ffmpeg' });
    assert.deepEqual(await watcher.watchPid(70000), { ok: false, reason: 'already-waiting' });
});
