const test = require('node:test');
const assert = require('node:assert');
const { warningPlan, extendedEndTime, minutesLeft, extendLabel } = require('../main/timer-warning');

const MIN = 60 * 1000;
const plan = (overrides) => warningPlan({ enabled: true, endTime: 60 * MIN, armedAt: 0, now: 0, warnedForEndTime: null, ...overrides });

test('the warning is scheduled five minutes before the end', () => {
    assert.deepEqual(plan({ now: 0 }), { action: 'schedule', delayMs: 55 * MIN });
    assert.deepEqual(plan({ now: 50 * MIN }), { action: 'schedule', delayMs: 5 * MIN });
});

test('waking up inside the last five minutes shows a warning that was not shown yet', () => {
    assert.deepEqual(plan({ now: 57 * MIN }), { action: 'show-now' });
    assert.deepEqual(plan({ now: 57 * MIN, warnedForEndTime: 60 * MIN }), { action: 'none' });
});

test('no warning for a session of five minutes or less, when turned off, or after the end', () => {
    assert.deepEqual(plan({ endTime: 5 * MIN, now: 0 }), { action: 'none' });
    assert.deepEqual(plan({ enabled: false }), { action: 'none' });
    assert.deepEqual(plan({ now: 61 * MIN }), { action: 'none' });
});

test('an extension is warned about again', () => {
    assert.deepEqual(plan({ endTime: 90 * MIN, armedAt: 56 * MIN, now: 56 * MIN, warnedForEndTime: 60 * MIN }), { action: 'schedule', delayMs: 29 * MIN });
});

test('extending adds 30 minutes to the current end, or to now when the end has passed', () => {
    assert.equal(extendedEndTime({ endTime: 60 * MIN, now: 56 * MIN }), 90 * MIN);
    assert.equal(extendedEndTime({ endTime: 60 * MIN, now: 61 * MIN }), 91 * MIN);
});

test('minutesLeft rounds up like the menu, and never says zero', () => {
    assert.equal(minutesLeft({ endTime: 54.6 * MIN, now: 50 * MIN }), 5);
    assert.equal(minutesLeft({ endTime: 50 * MIN + 10 * 1000, now: 50 * MIN }), 1);
});

test('the menu label follows the extension length', () => {
    assert.equal(extendLabel(), 'Add 30 Minutes');
    assert.equal(extendLabel(15 * MIN), 'Add 15 Minutes');
});
