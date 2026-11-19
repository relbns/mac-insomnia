const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const {
    ClaudeWatcher, MAX_HOLD_SECONDS, hookCommand, holdArgs, parseClaudeUrl, parseProcessTable, findClaudeAncestor, orphanedHoldPids,
    hasHooks, addHooks, removeHooks, readClaudeSettings, writeClaudeSettings
} = require('../main/claude-watch');

const TABLE = parseProcessTable(`
  500     1 /Applications/Visual Studio Code.app/Contents/MacOS/Electron
  600   500 /Users/a/.vscode/extensions/anthropic.claude-code-2.1.326-darwin-arm64/resources/native-binary/claude --output-format stream-json
  601   600 /bin/sh -c /usr/bin/pgrep -xq "Mac Insomnia" && /usr/bin/open -g ...
  700   500 /bin/zsh
  800     1 /Users/a/.local/bin/claude
  900     1 /usr/local/bin/node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js
  950     1 /usr/bin/vim claude
`);

function tempDir (t, prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

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

test('claude is recognised as the native binary or the npm cli, not by an argument', () => {
    assert.equal(findClaudeAncestor(800, TABLE), 800);
    assert.equal(findClaudeAncestor(900, TABLE), 900);
    assert.equal(findClaudeAncestor(950, TABLE), null);
});

test('addHooks keeps other hooks and is idempotent; removeHooks restores the original', () => {
    const original = { model: 'x', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } };
    const installed = addHooks(addHooks(original));
    assert.equal(hasHooks(installed), true);
    assert.equal(hasHooks(original), false);
    assert.deepEqual(installed.hooks.Stop.map((e) => e.hooks[0].command), ['say done', hookCommand('idle')]);
    assert.deepEqual(installed.hooks.UserPromptSubmit.map((e) => e.hooks[0].command), [hookCommand('busy')]);
    assert.deepEqual(installed.hooks.Notification, [{ matcher: 'idle_prompt', hooks: [{ type: 'command', command: hookCommand('idle') }] }]);
    assert.deepEqual(Object.keys(installed.hooks).sort(), ['Notification', 'SessionEnd', 'Stop', 'StopFailure', 'UserPromptSubmit']);
    assert.deepEqual(removeHooks(installed), original);
});

test('removeHooks keeps another tool\'s hook that shares a group with ours', () => {
    const shared = addHooks({});
    shared.hooks.UserPromptSubmit[0].hooks.push({ type: 'command', command: 'log-prompt' });
    assert.deepEqual(removeHooks(shared), { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'log-prompt' }] }] } });
});

test('the hook only notifies a running app and backgrounds open, so a prompt never waits', () => {
    assert.equal(hookCommand('busy'), '/usr/bin/pgrep -xq "Mac Insomnia" && /usr/bin/open -g "mac-insomnia://claude?state=busy&pid=$PPID" >/dev/null 2>&1 &');
});

test('readClaudeSettings treats a missing file as empty and throws on invalid JSON', (t) => {
    const file = path.join(tempDir(t, 'claude-settings-'), 'settings.json');
    assert.deepEqual(readClaudeSettings(file), {});
    fs.writeFileSync(file, '{ broken');
    assert.throws(() => readClaudeSettings(file));
});

test('writeClaudeSettings saves the previous file as a backup before writing', (t) => {
    const file = path.join(tempDir(t, 'claude-settings-'), 'settings.json');
    fs.writeFileSync(file, '{"model":"x"}');
    const backup = writeClaudeSettings(addHooks(readClaudeSettings(file)), file);
    assert.equal(fs.readFileSync(backup, 'utf8'), '{"model":"x"}');
    assert.equal(hasHooks(readClaudeSettings(file)), true);
});

test('writeClaudeSettings writes through a symlinked settings file and keeps the link', (t) => {
    const dir = tempDir(t, 'claude-settings-');
    const real = path.join(dir, 'real.json');
    const link = path.join(dir, 'settings.json');
    fs.writeFileSync(real, '{}');
    fs.symlinkSync(real, link);
    writeClaudeSettings(addHooks({}), link);
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.equal(hasHooks(readClaudeSettings(real)), true);
});

test('each hold is capped, so a missed idle event cannot keep the Mac awake for days', () => {
    assert.deepEqual(holdArgs(600), ['-i', '-s', '-t', String(MAX_HOLD_SECONDS), '-w', '600']);
});

test('orphanedHoldPids finds only our capped holds left behind by a crashed app', () => {
    const table = parseProcessTable(`
  10 1 /usr/bin/caffeinate -i -s -t ${MAX_HOLD_SECONDS} -w 600
  11 4242 /usr/bin/caffeinate -i -s -t ${MAX_HOLD_SECONDS} -w 600
  12 1 /usr/bin/caffeinate -i -s -w 600
  13 1 /usr/bin/caffeinate -dimsu -w 4242
`);
    assert.deepEqual(orphanedHoldPids(table), [10]);
});

function fakeWatcher (t, { psDelays = [] } = {}) {
    const holds = [];
    let calls = 0;
    const runner = {
        processTable: () => new Promise((resolve) => setTimeout(() => resolve(TABLE), psDelays[calls++] || 0)),
        holdWhileAlive: (pid) => {
            const child = Object.assign(new EventEmitter(), { killed: false });
            child.kill = () => { child.killed = true; child.emit('exit'); };
            holds.push({ pid, child });
            return child;
        },
        kill: () => {}
    };
    const watcher = new ClaudeWatcher({ runner, scanIntervalMs: 60_000 });
    t.after(() => watcher.stop());
    return { watcher, holds };
}

test('hooks mode holds the session from busy until idle', async (t) => {
    const { watcher, holds } = fakeWatcher(t);
    watcher.start('hooks');
    assert.equal(await watcher.handleUrl('mac-insomnia://claude?state=busy&pid=601'), true);
    assert.equal(watcher.count, 1);
    assert.deepEqual(holds.map((h) => h.pid), [600]);
    assert.equal(await watcher.handleUrl('mac-insomnia://claude?state=idle&pid=601'), true);
    assert.equal(watcher.count, 0);
    assert.equal(holds[0].child.killed, true);
});

test('a second busy renews the capped hold instead of adding one', async (t) => {
    const { watcher, holds } = fakeWatcher(t);
    watcher.start('hooks');
    await watcher.handleUrl('mac-insomnia://claude?state=busy&pid=600');
    await watcher.handleUrl('mac-insomnia://claude?state=busy&pid=600');
    assert.equal(watcher.count, 1);
    assert.deepEqual(holds.map((h) => h.child.killed), [true, false]);
});

test('an idle that arrives right after busy wins even when the busy lookup is slower', async (t) => {
    const { watcher } = fakeWatcher(t, { psDelays: [50, 1] });
    watcher.start('hooks');
    await Promise.all([
        watcher.handleUrl('mac-insomnia://claude?state=busy&pid=600'),
        watcher.handleUrl('mac-insomnia://claude?state=idle&pid=600')
    ]);
    assert.equal(watcher.count, 0);
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
});

test('scan mode holds every claude process, and stop releases them all', async (t) => {
    const { watcher, holds } = fakeWatcher(t);
    watcher.start('scan');
    await watcher.scan();
    assert.deepEqual(holds.map((h) => h.pid).sort(), [600, 800, 900]);
    watcher.stop();
    assert.equal(watcher.count, 0);
    assert.equal(holds.every((h) => h.child.killed), true);
});

test('turning Smart Mode off during a scan leaves nothing held', async (t) => {
    const { watcher } = fakeWatcher(t, { psDelays: [30] });
    watcher.start('scan');
    watcher.stop();
    await watcher.queue;
    assert.equal(watcher.count, 0);
});

test('installing hooks keeps the sessions that scan mode was already holding', async (t) => {
    const { watcher } = fakeWatcher(t);
    watcher.start('scan');
    await watcher.scan();
    watcher.start('hooks');
    assert.equal(watcher.count, 3);
});
