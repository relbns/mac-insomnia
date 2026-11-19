const test = require('node:test');
const assert = require('node:assert');
const { WARNING_LEAD_MS, EXTEND_MS, warningDelayMs, extendedEndTime, minutesLeft } = require('../main/timer-warning');

const MIN = 60 * 1000;

test('the warning is due five minutes before the end', () => {
    assert.equal(warningDelayMs({ endTime: 60 * MIN, now: 0 }), 55 * MIN);
    assert.equal(warningDelayMs({ endTime: 60 * MIN, now: 50 * MIN }), 5 * MIN);
});

test('no warning without a timer, or when five minutes or less are left', () => {
    assert.equal(warningDelayMs({ endTime: null, now: 0 }), null);
    assert.equal(warningDelayMs({ endTime: 5 * MIN, now: 0 }), null);
    assert.equal(warningDelayMs({ endTime: 60 * MIN, now: 57 * MIN }), null);
});

test('extending adds to the current end, or to now when the end has passed', () => {
    assert.equal(extendedEndTime({ endTime: 60 * MIN, now: 56 * MIN }), 60 * MIN + EXTEND_MS);
    assert.equal(extendedEndTime({ endTime: 60 * MIN, now: 61 * MIN }), 61 * MIN + EXTEND_MS);
    assert.equal(WARNING_LEAD_MS, 5 * MIN);
});

test('minutesLeft rounds to whole minutes and never says zero', () => {
    assert.equal(minutesLeft({ endTime: 5 * MIN, now: 0 }), 5);
    assert.equal(minutesLeft({ endTime: 4.6 * MIN, now: 0 }), 5);
    assert.equal(minutesLeft({ endTime: 10 * 1000, now: 0 }), 1);
});
