const test = require('node:test');
const assert = require('node:assert');
const { parseCommandUrl } = require('../main/url-commands');

test('start, stop and toggle commands', () => {
    assert.deepEqual(parseCommandUrl('mac-insomnia://start'), { action: 'start' });
    assert.deepEqual(parseCommandUrl('mac-insomnia://stop'), { action: 'stop' });
    assert.deepEqual(parseCommandUrl('mac-insomnia://toggle'), { action: 'toggle' });
});

test('start takes a duration in whole minutes up to a day, or infinite', () => {
    assert.deepEqual(parseCommandUrl('mac-insomnia://start?minutes=90'), { action: 'start', durationMs: 90 * 60 * 1000 });
    assert.deepEqual(parseCommandUrl('mac-insomnia://start?minutes=1440'), { action: 'start', durationMs: 1440 * 60 * 1000 });
    assert.deepEqual(parseCommandUrl('mac-insomnia://start?minutes=infinite'), { action: 'start', durationMs: null });
});

test('anything else is not a command', () => {
    for (const url of ['mac-insomnia://start?minutes=0', 'mac-insomnia://start?minutes=1441', 'mac-insomnia://start?minutes=1.5', 'mac-insomnia://start?minutes=-5',
        'mac-insomnia://lid', 'mac-insomnia://claude?state=busy&pid=600', 'https://start', 'not a url']) {
        assert.equal(parseCommandUrl(url), null, url);
    }
});
