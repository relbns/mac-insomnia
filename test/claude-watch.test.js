const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const {
    ClaudeWatcher, hookCommand, parseClaudeUrl, parseProcessTable, findClaudeAncestor, hasHooks, addHooks, removeHooks, readClaudeSettings, writeClaudeSettings
} = require('../main/claude-watch');

const TABLE = parseProcessTable(`
  500     1 /Applications/Visual Studio Code.app/Contents/MacOS/Electron
  600   500 /Users/a/.vscode/extensions/anthropic.claude-code-2.1.326-darwin-arm64/resources/native-binary/claude
  601   600 /bin/sh
  602   601 /usr/bin/open
  700   500 /bin/zsh
  800     1 /opt/homebrew/bin/claude
`);

test('parseClaudeUrl accepts only busy/idle with a numeric pid', () => {
    assert.deepEqual(parseClaudeUrl('mac-insomnia://claude?state=busy&pid=600'), { state: 'busy', pid: 600 });
    assert.deepEqual(parseClaudeUrl('mac-insomnia://claude?state=idle&pid=600'), { state: 'idle', pid: 600 });
    for (const url of ['mac-insomnia://claude?state=busy&pid=1', 'mac-insomnia://claude?state=busy&pid=abc', 'mac-insomnia://claude?state=run&pid=600', 'mac-insomnia://other?state=busy&pid=600', 'https://claude?state=busy&pid=600', 'not a url']) {
        assert.equal(parseClaudeUrl(url), null, url);
    }
});

test('findClaudeAncestor walks up from the hook shell to the claude process', () => {
    assert.equal(findClaudeAncestor(601, TABLE), 600);
    assert.equal(findClaudeAncestor(600, TABLE), 600);
    assert.equal(findClaudeAncestor(700, TABLE), null);
    assert.equal(findClaudeAncestor(999, TABLE), null);
});

test('addHooks keeps other hooks and is idempotent; removeHooks removes only ours', () => {
    const original = { model: 'x', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } };
    const installed = addHooks(addHooks(original));
    assert.equal(hasHooks(installed), true);
    assert.deepEqual(installed.hooks.Stop.map((e) => e.hooks[0].command), ['say done', hookCommand('idle')]);
    assert.deepEqual(installed.hooks.UserPromptSubmit.map((e) => e.hooks[0].command), [hookCommand('busy')]);
    assert.deepEqual(installed.hooks.SessionEnd.map((e) => e.hooks[0].command), [hookCommand('idle')]);
    assert.deepEqual(removeHooks(installed), original);
    assert.equal(hasHooks(original), false);
    assert.deepEqual(original.hooks.Stop.length, 1);
});

test('the hook command backgrounds open, so a prompt never waits on it', () => {
    assert.equal(hookCommand('busy'), '/usr/bin/open -g "mac-insomnia://claude?state=busy&pid=$PPID" >/dev/null 2>&1 &');
});

test('writeClaudeSettings backs up the existing file and refuses nothing it cannot parse', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-settings-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'settings.json');
    assert.deepEqual(readClaudeSettings(file), {});
    fs.writeFileSync(file, '{"model":"x"}');
    const backup = writeClaudeSettings(addHooks(readClaudeSettings(file)), file, new Date('2026-11-19T12:00:00Z'));
    assert.equal(fs.readFileSync(backup, 'utf8'), '{"model":"x"}');
    assert.equal(hasHooks(readClaudeSettings(file)), true);
    fs.writeFileSync(file, '{ broken');
    assert.throws(() => readClaudeSettings(file));
});

function fakeWatcher (t) {
    const holds = [];
    const runner = {
        processTable: async () => TABLE,
        holdWhileAlive: (pid) => {
            const child = Object.assign(new EventEmitter(), { pid: 9000 + pid, killed: false });
            child.kill = () => { child.killed = true; child.emit('exit'); };
            holds.push({ pid, child });
            return child;
        }
    };
    const watcher = new ClaudeWatcher({ runner, scanIntervalMs: 60_000 });
    t.after(() => watcher.stop());
    return { watcher, holds };
}

test('hooks mode holds the session from busy until idle', async (t) => {
    const { watcher, holds } = fakeWatcher(t);
    watcher.start('hooks');
    assert.equal(await watcher.handleUrl('mac-insomnia://claude?state=busy&pid=601'), true);
    assert.equal(await watcher.handleUrl('mac-insomnia://claude?state=busy&pid=601'), true);
    assert.deepEqual([watcher.count, holds.map((h) => h.pid)], [1, [600]]);
    assert.equal(await watcher.handleUrl('mac-insomnia://claude?state=idle&pid=601'), true);
    assert.equal(watcher.count, 0);
    assert.equal(holds[0].child.killed, true);
});

test('a hold ends when the claude process exits without an idle event', async (t) => {
    const { watcher, holds } = fakeWatcher(t);
    watcher.start('hooks');
    await watcher.handleUrl('mac-insomnia://claude?state=busy&pid=600');
    holds[0].child.emit('exit');
    assert.equal(watcher.count, 0);
});

test('hook URLs are ignored when the mode is off or scanning, and for non-claude pids', async (t) => {
    const { watcher } = fakeWatcher(t);
    assert.equal(await watcher.handleUrl('mac-insomnia://claude?state=busy&pid=600'), false);
    watcher.start('scan');
    assert.equal(await watcher.handleUrl('mac-insomnia://claude?state=busy&pid=600'), false);
    watcher.start('hooks');
    assert.equal(await watcher.handleUrl('mac-insomnia://claude?state=busy&pid=700'), false);
    assert.equal(watcher.count, 0);
});

test('scan mode holds every claude process, and stop releases them all', async (t) => {
    const { watcher, holds } = fakeWatcher(t);
    watcher.start('scan');
    await watcher.scan();
    assert.deepEqual(holds.map((h) => h.pid).sort(), [600, 800]);
    watcher.stop();
    assert.equal(watcher.count, 0);
    assert.equal(holds.every((h) => h.child.killed), true);
});
