const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeIdleMinutes, shouldArmIdleTimer, idleDelayMs } = require('../main/claude-lid');

const MIN = 60 * 1000;
const base = { idleMinutes: 10, smartMode: true, lidActive: true, claudeBusy: false, sawClaudeWork: true, lastReleaseReason: 'idle' };

test('the countdown runs once Claude has worked and finished during lid closed mode', () => {
    assert.equal(shouldArmIdleTimer(base), true);
    assert.equal(shouldArmIdleTimer({ ...base, lastReleaseReason: 'exited' }), true);
});

test('the countdown does not run while Claude works, or before Claude has worked at all', () => {
    assert.equal(shouldArmIdleTimer({ ...base, claudeBusy: true }), false);
    assert.equal(shouldArmIdleTimer({ ...base, sawClaudeWork: false }), false);
});

test('a hold that ran out, or was dropped by a restart, does not mean Claude finished', () => {
    assert.equal(shouldArmIdleTimer({ ...base, lastReleaseReason: 'expired' }), false);
    assert.equal(shouldArmIdleTimer({ ...base, lastReleaseReason: 'stopped' }), false);
    assert.equal(shouldArmIdleTimer({ ...base, lastReleaseReason: null }), false);
});

test('the countdown needs lid closed mode, Smart Mode and a limit', () => {
    assert.equal(shouldArmIdleTimer({ ...base, lidActive: false }), false);
    assert.equal(shouldArmIdleTimer({ ...base, smartMode: false }), false);
    assert.equal(shouldArmIdleTimer({ ...base, idleMinutes: null }), false);
});

test('changing the limit keeps the time already counted', () => {
    assert.equal(idleDelayMs({ armedAt: 0, minutes: 10, now: 4 * MIN }), 6 * MIN);
    assert.equal(idleDelayMs({ armedAt: 0, minutes: 5, now: 25 * MIN }), 0);
});

test('the idle limit defaults to 10 minutes and accepts only the offered values or off', () => {
    assert.equal(normalizeIdleMinutes(undefined), 10);
    assert.equal(normalizeIdleMinutes(30), 30);
    assert.equal(normalizeIdleMinutes('5'), 5);
    assert.equal(normalizeIdleMinutes(null), null);
    assert.equal(normalizeIdleMinutes(7), 10);
});
