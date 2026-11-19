const test = require('node:test');
const assert = require('node:assert/strict');
const { FEED_URL, Updater, parseLatestYml, isNewer, bundlePathFromExec, buildInstallScript, downloadUrl } = require('../main/updater');

const FEED = `version: 1.0.13
files:
  - url: Mac-Insomnia-1.0.13-arm64.dmg
    sha512: AFnn1Vc1s4XH70GCOqziHg1jUnVlCfmG+cYDP9ICe27uUns8TLMHvIMJ71HS+weHG+GpQ1gVvgRE2gHVsDOm9A==
    size: 105493073
path: Mac-Insomnia-1.0.13-arm64.dmg
sha512: AFnn1Vc1s4XH70GCOqziHg1jUnVlCfmG+cYDP9ICe27uUns8TLMHvIMJ71HS+weHG+GpQ1gVvgRE2gHVsDOm9A==
releaseDate: '2026-11-19T22:17:22.609Z'
`;
const LATEST = { version: '1.0.13', file: 'Mac-Insomnia-1.0.13-arm64.dmg', sha512: 'AFnn1Vc1s4XH70GCOqziHg1jUnVlCfmG+cYDP9ICe27uUns8TLMHvIMJ71HS+weHG+GpQ1gVvgRE2gHVsDOm9A==', size: 105493073 };
const EXEC = '/Applications/Mac Insomnia.app/Contents/MacOS/Mac Insomnia';

test('parseLatestYml reads the release feed electron-builder publishes', () => {
    assert.deepEqual(parseLatestYml(FEED), LATEST);
    assert.equal(parseLatestYml('<html>Not Found</html>'), null);
});

test('isNewer compares versions numerically', () => {
    assert.equal(isNewer('1.0.13', '1.0.12'), true);
    assert.equal(isNewer('1.0.10', '1.0.9'), true);
    assert.equal(isNewer('1.0.13', '1.0.13'), false);
    assert.equal(isNewer('1.0.12', '1.0.13'), false);
    assert.equal(isNewer('garbage', '1.0.0'), false);
});

test("the download is pinned to that version's release, not to latest", () => {
    assert.equal(downloadUrl(FEED_URL, LATEST), 'https://github.com/relbns/mac-insomnia/releases/download/v1.0.13/Mac-Insomnia-1.0.13-arm64.dmg');
});

test('bundlePathFromExec finds the app bundle of the running binary', () => {
    assert.equal(bundlePathFromExec(EXEC), '/Applications/Mac Insomnia.app');
    assert.equal(bundlePathFromExec('/usr/local/bin/electron'), null);
});

test('the installer waits for the app, keeps the old copy until the new one is in place, and restores it on failure', () => {
    const script = buildInstallScript({ appPid: 4242, bundlePath: "/Applications/Mac Insomnia.app", newAppPath: '/Volumes/Mac Insomnia 1.0.13/Mac Insomnia.app', mountPoint: '/Volumes/Mac Insomnia 1.0.13', dmgPath: '/tmp/u/x.dmg', relaunchUrl: 'mac-insomnia://start?minutes=infinite' });
    const lines = script.split('\n');
    assert.equal(lines[0], 'while /bin/kill -0 4242 2>/dev/null; do /bin/sleep 0.2; done');
    assert.equal(lines[2], "if /bin/mv '/Applications/Mac Insomnia.app' '/Applications/Mac Insomnia.app.previous' && /usr/bin/ditto '/Volumes/Mac Insomnia 1.0.13/Mac Insomnia.app' '/Applications/Mac Insomnia.app'; then /bin/rm -rf '/Applications/Mac Insomnia.app.previous'; else /bin/rm -rf '/Applications/Mac Insomnia.app'; /bin/mv '/Applications/Mac Insomnia.app.previous' '/Applications/Mac Insomnia.app'; fi");
    assert.equal(lines.at(-2), "/bin/rm -rf '/tmp/u'");
    assert.equal(lines.at(-1), "/usr/bin/open -a '/Applications/Mac Insomnia.app' 'mac-insomnia://start?minutes=infinite'");
    assert.equal(buildInstallScript({ appPid: 1, bundlePath: "/A/it's.app", newAppPath: '/V/n.app', mountPoint: '/V', dmgPath: '/t.dmg' }).split('\n').at(-1), "/usr/bin/open -a '/A/it'\\''s.app'");
});

function fakeUpdater ({ feed = FEED, download = { sha512: LATEST.sha512, size: LATEST.size }, bundleId = 'com.nodomain.insomnia', version = '1.0.13', signatureOk = true, canReplace = true, current = '1.0.12' } = {}) {
    const calls = [];
    const runner = {
        fetchText: async () => { if (feed instanceof Error) throw feed; return feed; },
        download: async (url) => { calls.push(`download ${url}`); return download; },
        mount: async () => { calls.push('mount'); return '/Volumes/Mac Insomnia 1.0.13'; },
        detach: async () => { calls.push('detach'); },
        readPlist: async (_app, key) => (key === 'CFBundleIdentifier' ? bundleId : version),
        verifySignature: async () => { if (!signatureOk) throw new Error('codesign failed'); },
        canReplace: () => canReplace,
        startInstaller: (script) => calls.push(`install ${script.split('\n')[0]}`),
        tempDir: () => '/tmp/u',
        removeDir: (dir) => calls.push(`remove ${dir}`)
    };
    return { updater: new Updater({ currentVersion: current, execPath: EXEC, appPid: 4242, runner }), calls };
}

test('check reports a newer release and stays quiet about the current one', async () => {
    assert.deepEqual((await fakeUpdater().updater.check()), { ok: true, available: LATEST });
    assert.deepEqual((await fakeUpdater({ current: '1.0.13' }).updater.check()), { ok: true, available: null });
    assert.equal((await fakeUpdater({ feed: new Error('offline') }).updater.check()).ok, false);
});

test('a verified update produces an install plan', async () => {
    const { updater, calls } = fakeUpdater();
    await updater.check();
    const result = await updater.prepare();
    assert.equal(result.ok, true);
    assert.deepEqual(result.plan, { bundlePath: '/Applications/Mac Insomnia.app', newAppPath: '/Volumes/Mac Insomnia 1.0.13/Mac Insomnia.app', mountPoint: '/Volumes/Mac Insomnia 1.0.13', dmgPath: '/tmp/u/Mac-Insomnia-1.0.13-arm64.dmg', version: '1.0.13' });
    assert.deepEqual(calls, ['download https://github.com/relbns/mac-insomnia/releases/download/v1.0.13/Mac-Insomnia-1.0.13-arm64.dmg', 'mount']);
});

test('any failed check stops the update before anything is replaced', async () => {
    const cases = [
        [{ download: { sha512: 'tampered', size: LATEST.size } }, /checksum/],
        [{ download: { sha512: LATEST.sha512, size: 1 } }, /checksum/],
        [{ bundleId: 'com.evil.app' }, /not Mac Insomnia/],
        [{ version: '1.0.12' }, /unexpected version/],
        [{ signatureOk: false }, /codesign failed/],
        [{ canReplace: false }, /cannot replace/]
    ];
    for (const [options, message] of cases) {
        const { updater, calls } = fakeUpdater(options);
        await updater.check();
        const result = await updater.prepare();
        assert.equal(result.ok, false, String(message));
        assert.match(result.error.message, message);
        assert.equal(calls.some((c) => c.startsWith('install')), false);
        if (calls.some((c) => c.startsWith('download'))) assert.equal(calls.at(-1), 'remove /tmp/u');
        if (calls.includes('mount')) assert.equal(calls.at(-2), 'detach');
    }
});
