const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { ProcessWatcher, parseProcessList, candidateProcesses, displayName } = require('../main/process-watch');

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

test('displayName shows the app name for app bundles and the binary name otherwise', () => {
    assert.equal(displayName('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'), 'Google Chrome');
    assert.equal(displayName('/opt/homebrew/bin/ffmpeg'), 'ffmpeg');
    assert.equal(displayName('docker'), 'docker');
});

test('candidates are busy user apps and tools, busiest first, without system services, helpers, shells or Insomnia', () => {
    const list = candidateProcesses(parseProcessList(PS), { selfPid: 1 });
    assert.deepEqual(list.map((p) => p.name), ['ffmpeg', 'claude', 'ClipFlow', 'Google Chrome', 'docker']);
});

test('candidates leave out processes that are already watched', () => {
    const list = candidateProcesses(parseProcessList(PS), { selfPid: 1, watchedPids: [70000] });
    assert.equal(list.some((p) => p.pid === 70000), false);
});

function fakeWatcher (t, { alive = new Set(), names = {} } = {}) {
    const holds = [];
    const finished = [];
    const watcher = new ProcessWatcher({
        keepAwakeFlags: () => ['-ims'],
        onFinished: (info) => finished.push(info),
        runner: {
            processName: async (pid) => names[pid] || null,
            holdWhileAlive: (pid, args) => {
                const child = Object.assign(new EventEmitter(), { killed: false, args });
                child.kill = () => { child.killed = true; };
                holds.push({ pid, child });
                return child;
            },
            isAlive: (pid) => alive.has(pid),
            listProcesses: async () => parseProcessList(PS)
        }
    });
    t.after(() => watcher.unwatchAll());
    return { watcher, holds, finished };
}

test('watching holds the Mac awake until the process ends, then reports it finished', (t) => {
    const { watcher, holds, finished } = fakeWatcher(t);
    watcher.watch(70000, 'ffmpeg');
    assert.deepEqual(holds[0].child.args, ['-ims']);
    assert.equal(watcher.count, 1);
    holds[0].child.emit('exit');
    assert.equal(watcher.count, 0);
    assert.deepEqual(finished, [{ pid: 70000, name: 'ffmpeg' }]);
});

test('stopping the wait does not report the process as finished', (t) => {
    const { watcher, holds, finished } = fakeWatcher(t, { alive: new Set([70000]) });
    watcher.watch(70000, 'ffmpeg');
    watcher.unwatch(70000);
    holds[0].child.emit('exit');
    assert.equal(holds[0].child.killed, true);
    assert.deepEqual(finished, []);
});

test('watchPid resolves the name and refuses unknown or invalid pids', async (t) => {
    const { watcher } = fakeWatcher(t, { names: { 70000: 'ffmpeg' } });
    assert.equal(await watcher.watchPid(70000), true);
    assert.deepEqual(watcher.list(), [{ pid: 70000, name: 'ffmpeg' }]);
    assert.equal(await watcher.watchPid(70000), false);
    assert.equal(await watcher.watchPid(12345), false);
    assert.equal(await watcher.watchPid(1), false);
});
