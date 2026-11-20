const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { Updater, parseLatestYml, parseInstallOutcome, isNewer, bundlePathFromExec, buildInstallScript } = require('../main/updater');

const SHA = 'AFnn1Vc1s4XH70GCOqziHg1jUnVlCfmG+cYDP9ICe27uUns8TLMHvIMJ71HS+weHG+GpQ1gVvgRE2gHVsDOm9A==';
const FEED = `version: 1.0.13
files:
  - url: Mac-Insomnia-1.0.13-arm64.dmg
    sha512: ${SHA}
    size: 105493073
path: Mac-Insomnia-1.0.13-arm64.dmg
sha512: ${SHA}
releaseDate: '2026-11-19T22:17:22.609Z'
`;
const LATEST = { version: '1.0.13', file: 'Mac-Insomnia-1.0.13-arm64.dmg', sha512: SHA, size: 105493073 };
const EXEC = '/Applications/Mac Insomnia.app/Contents/MacOS/Mac Insomnia';
const PINNED_DMG = 'https://github.com/relbns/mac-insomnia/releases/download/v1.0.13/Mac-Insomnia-1.0.13-arm64.dmg';

test('parseLatestYml reads the release feed electron-builder publishes', () => {
    assert.deepEqual(parseLatestYml(FEED, 'arm64'), LATEST);
    assert.equal(parseLatestYml('<html>Not Found</html>', 'arm64'), null);
});

test("parseLatestYml picks the dmg for this Mac's architecture, whatever order the feed lists files in", () => {
    const feed = `version: 2.0.0
files:
  - url: Mac-Insomnia-2.0.0-arm64-mac.zip
    sha512: zip
    size: 10
  - url: Mac-Insomnia-2.0.0.dmg
    sha512: intel
    size: 20
  - url: Mac-Insomnia-2.0.0-arm64.dmg
    sha512: arm
    size: 30
`;
    assert.equal(parseLatestYml(feed, 'arm64').sha512, 'arm');
    assert.equal(parseLatestYml(feed, 'x64').sha512, 'intel');
    assert.equal(parseLatestYml(FEED, 'x64'), null);
});

test('isNewer compares versions numerically', () => {
    assert.equal(isNewer('1.0.13', '1.0.12'), true);
    assert.equal(isNewer('1.0.10', '1.0.9'), true);
    assert.equal(isNewer('1.0.13', '1.0.13'), false);
    assert.equal(isNewer('1.0.12', '1.0.13'), false);
    assert.equal(isNewer('garbage', '1.0.0'), false);
});

test('bundlePathFromExec finds the app bundle of the running binary', () => {
    assert.equal(bundlePathFromExec(EXEC), '/Applications/Mac Insomnia.app');
    assert.equal(bundlePathFromExec('/usr/local/bin/electron'), null);
});

test('parseInstallOutcome reads only what the installer writes', () => {
    assert.deepEqual(parseInstallOutcome('installed 1.0.14\n'), { outcome: 'installed', version: '1.0.14' });
    assert.deepEqual(parseInstallOutcome('failed 1.0.14\n'), { outcome: 'failed', version: '1.0.14' });
    assert.equal(parseInstallOutcome('installed $(rm -rf ~)'), null);
});

function runInstaller ({ failDitto = false, refuseMoveOfBundle = false, folderName = 'Apps' } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'insomnia-installer-test-'));
    const apps = path.join(root, folderName);
    const bundlePath = path.join(apps, 'Mac Insomnia.app');
    const newAppPath = path.join(root, 'volume', 'Mac Insomnia.app');
    const download = path.join(root, 'download');
    for (const dir of [bundlePath, newAppPath, download]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(bundlePath, 'version'), 'old');
    fs.writeFileSync(path.join(newAppPath, 'version'), 'new');
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    const tool = (name, body) => {
        fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
        return path.join(bin, name);
    };
    const opened = path.join(root, 'opened');
    const fakes = {
        kill: '/bin/kill',
        sleep: '/bin/sleep',
        rm: '/bin/rm',
        mv: refuseMoveOfBundle ? tool('mv', `[ "$1" = ${JSON.stringify(bundlePath)} ] && exit 1\nexec /bin/mv "$@"`) : '/bin/mv',
        ditto: failDitto ? '/usr/bin/false' : '/usr/bin/ditto',
        hdiutil: '/usr/bin/true',
        open: tool('open', `printf '%s\\n' "$@" > ${JSON.stringify(opened)}`)
    };
    const deadPid = spawnSync('/usr/bin/true').pid;
    const statusPath = path.join(root, 'update-status.txt');
    const script = buildInstallScript({ appPid: deadPid, bundlePath, newAppPath, mountPoint: path.join(root, 'volume'), dmgPath: path.join(download, 'x.dmg'), version: '1.0.14', statusPath, relaunchUrls: ['mac-insomnia://start?minutes=infinite', 'mac-insomnia://until?pid=77'] }, fakes);
    spawnSync('/bin/bash', ['-c', script]);
    const result = {
        installed: fs.readFileSync(path.join(bundlePath, 'version'), 'utf8'),
        leftovers: fs.readdirSync(apps).filter((name) => name !== 'Mac Insomnia.app'),
        downloadRemoved: !fs.existsSync(download),
        status: fs.readFileSync(statusPath, 'utf8'),
        opened: fs.readFileSync(opened, 'utf8').trim().split('\n')
    };
    fs.rmSync(root, { recursive: true, force: true });
    return { ...result, bundlePath };
}

test('the installer swaps in the new app, cleans up, records the outcome and relaunches with the session', () => {
    const result = runInstaller();
    assert.equal(result.installed, 'new');
    assert.deepEqual(result.leftovers, []);
    assert.equal(result.downloadRemoved, true);
    assert.equal(result.status, 'installed 1.0.14\n');
    assert.deepEqual(result.opened.slice(2), ['mac-insomnia://start?minutes=infinite', 'mac-insomnia://until?pid=77']);
});

test('the installer keeps the old app when the copy fails', () => {
    const result = runInstaller({ failDitto: true });
    assert.equal(result.installed, 'old');
    assert.deepEqual(result.leftovers, []);
    assert.equal(result.status, 'failed 1.0.14\n');
});

test('the installer keeps the old app when macOS refuses to move it', () => {
    const result = runInstaller({ refuseMoveOfBundle: true });
    assert.equal(result.installed, 'old');
    assert.deepEqual(result.leftovers, []);
    assert.equal(result.status, 'failed 1.0.14\n');
});

test('the installer handles a folder name with an apostrophe', () => {
    const result = runInstaller({ folderName: "Ariel's Apps" });
    assert.equal(result.installed, 'new');
    assert.equal(result.opened[1], result.bundlePath);
});

function fakeUpdater ({ feed = FEED, download = { sha512: SHA, size: LATEST.size }, downloadedBundleId = 'com.nodomain.insomnia', downloadedAppVersion = '1.0.13', signatureOk = true, canReplace = true, runningVersion = '1.0.12' } = {}) {
    const calls = [];
    const runner = {
        fetchText: async () => { if (feed instanceof Error) throw feed; return feed; },
        download: async (url) => { calls.push(`download ${url}`); return download; },
        mount: async () => '/Volumes/Mac Insomnia 1.0.13',
        detach: async () => { calls.push('detach'); },
        readPlist: async (_app, key) => (key === 'CFBundleIdentifier' ? downloadedBundleId : downloadedAppVersion),
        verifySignature: async () => { if (!signatureOk) throw new Error('codesign failed'); },
        canReplace: () => canReplace,
        tempDir: () => '/tmp/u',
        removeDir: (dir) => calls.push(`remove ${dir}`)
    };
    return { updater: new Updater({ currentVersion: runningVersion, execPath: EXEC, arch: 'arm64', runner }), calls };
}

test('check reports a newer release, stays quiet about the current one, and fails when the feed cannot be fetched', async () => {
    assert.deepEqual(await fakeUpdater().updater.check(), { ok: true, available: LATEST });
    assert.deepEqual(await fakeUpdater({ runningVersion: '1.0.13' }).updater.check(), { ok: true, available: null });
    assert.equal((await fakeUpdater({ feed: new Error('offline') }).updater.check()).ok, false);
});

test("a verified update downloads that version's release, not latest, and produces an install plan", async () => {
    const { updater, calls } = fakeUpdater();
    await updater.check();
    const result = await updater.prepare('1.0.13');
    assert.deepEqual(result.plan, { bundlePath: '/Applications/Mac Insomnia.app', newAppPath: '/Volumes/Mac Insomnia 1.0.13/Mac Insomnia.app', mountPoint: '/Volumes/Mac Insomnia 1.0.13', dmgPath: '/tmp/u/Mac-Insomnia-1.0.13-arm64.dmg', version: '1.0.13' });
    assert.deepEqual(calls, [`download ${PINNED_DMG}`]);
});

test('prepare refuses when the available version is no longer the one the user confirmed', async () => {
    const { updater, calls } = fakeUpdater();
    await updater.check();
    assert.equal((await updater.prepare('1.0.12')).ok, false);
    assert.deepEqual(calls, []);
});

test('a failed check stops the update and removes what it downloaded or mounted', async (t) => {
    const cases = [
        ['checksum mismatch', { download: { sha512: 'tampered', size: LATEST.size } }, /checksum/, ['remove /tmp/u']],
        ['size mismatch', { download: { sha512: SHA, size: 1 } }, /checksum/, ['remove /tmp/u']],
        ['wrong bundle id', { downloadedBundleId: 'com.evil.app' }, /not Mac Insomnia/, ['detach', 'remove /tmp/u']],
        ['wrong version inside the dmg', { downloadedAppVersion: '1.0.12' }, /unexpected version/, ['detach', 'remove /tmp/u']],
        ['invalid signature', { signatureOk: false }, /codesign failed/, ['detach', 'remove /tmp/u']],
        ['app folder not writable', { canReplace: false }, /cannot replace/, []]
    ];
    for (const [name, options, message, cleanup] of cases) {
        await t.test(name, async () => {
            const { updater, calls } = fakeUpdater(options);
            await updater.check();
            const result = await updater.prepare('1.0.13');
            assert.equal(result.ok, false);
            assert.match(result.error.message, message);
            assert.deepEqual(calls.filter((c) => !c.startsWith('download')), cleanup);
        });
    }
});

test('discard unmounts and removes a prepared update that will not be installed', async () => {
    const { updater, calls } = fakeUpdater();
    await updater.discard({ mountPoint: '/Volumes/Mac Insomnia 1.0.13', dmgPath: '/tmp/u/x.dmg' });
    assert.deepEqual(calls, ['detach', 'remove /tmp/u']);
});
