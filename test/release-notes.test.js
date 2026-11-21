const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMergedPullRequests, formatReleaseNotes } = require('../scripts/release-notes');

const LOG = [
    'Merge pull request #31 from relbns/release/v1.0.16\tRelease 1.0.16',
    'Merge pull request #28 from relbns/release/v1.0.7\t1.0.7',
    'Merge pull request #30 from relbns/feature/thermal-guard\tThermal Guard: turn off Lid Closed Mode when the Mac runs hot',
    'Merge branch \'master\' into feature/x\t',
    'Merge pull request #29 from relbns/docs/updates-from-older\tDocs: versions before 1.0.14 need one manual install'
].join('\n');

test('release notes list the merged pull requests, oldest first, without the version bump', () => {
    assert.deepEqual(parseMergedPullRequests(LOG), [
        { number: 29, title: 'Docs: versions before 1.0.14 need one manual install' },
        { number: 30, title: 'Thermal Guard: turn off Lid Closed Mode when the Mac runs hot' }
    ]);
});

test('release notes link each pull request and the full comparison', () => {
    assert.equal(formatReleaseNotes({ tag: 'v1.0.16', previousTag: 'v1.0.15', pullRequests: [{ number: 30, title: 'Thermal Guard' }] }),
        "## What's changed\n\n- Thermal Guard ([#30](https://github.com/relbns/mac-insomnia/pull/30))\n\n**Full changelog:** https://github.com/relbns/mac-insomnia/compare/v1.0.15...v1.0.16\n");
});

test('a release with nothing but the version bump says so', () => {
    assert.equal(formatReleaseNotes({ tag: 'v1.0.1', previousTag: null, pullRequests: [] }), "## What's changed\n\n- Maintenance release.\n");
});
