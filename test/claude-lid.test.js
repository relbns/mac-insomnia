const test = require('node:test');
const assert = require('node:assert');
const { normalizeIdleMinutes, shouldArmIdleTimer } = require('../main/claude-lid');

const base = { idleMinutes: 10, smartMode: true, lidActive: true, claudeBusy: false };

test('the idle countdown runs only while lid closed mode is on, Smart Mode is on and Claude is not working', () => {
    assert.equal(shouldArmIdleTimer(base), true);
    assert.equal(shouldArmIdleTimer({ ...base, claudeBusy: true }), false);
    assert.equal(shouldArmIdleTimer({ ...base, lidActive: false }), false);
    assert.equal(shouldArmIdleTimer({ ...base, smartMode: false }), false);
    assert.equal(shouldArmIdleTimer({ ...base, idleMinutes: null }), false);
});

test('the idle limit defaults to 10 minutes and accepts only the offered values or off', () => {
    assert.equal(normalizeIdleMinutes(undefined), 10);
    assert.equal(normalizeIdleMinutes(30), 30);
    assert.equal(normalizeIdleMinutes(null), null);
    assert.equal(normalizeIdleMinutes(7), 10);
});
