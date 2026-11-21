const test = require('node:test');
const assert = require('node:assert/strict');
const { thermalAction, lidModeAllowedWhenHot, smartModeAllowedWhenHot } = require('../main/thermal-guard');

test('Thermal Guard turns off Lid Closed Mode when the Mac runs hot and stops everything when it is critical', () => {
    const cases = [
        ['nominal, lid on', { state: 'nominal', lidOn: true, keepingAwake: true }, 'none'],
        ['fair, lid on', { state: 'fair', lidOn: true, keepingAwake: true }, 'none'],
        ['serious, lid on', { state: 'serious', lidOn: true, keepingAwake: true }, 'lid-off'],
        ['serious, session only', { state: 'serious', lidOn: false, keepingAwake: true }, 'none'],
        ['critical, session only', { state: 'critical', lidOn: false, keepingAwake: true }, 'stop-all'],
        ['critical, lid on', { state: 'critical', lidOn: true, keepingAwake: true }, 'stop-all'],
        ['critical, nothing awake', { state: 'critical', lidOn: false, keepingAwake: false }, 'none'],
        ['unknown state', { state: 'unknown', lidOn: true, keepingAwake: true }, 'none']
    ];
    for (const [name, input, expected] of cases) assert.equal(thermalAction({ enabled: true, ...input }), expected, name);
});

test('Thermal Guard does nothing when it is turned off', () => {
    assert.equal(thermalAction({ enabled: false, state: 'critical', lidOn: true, keepingAwake: true }), 'none');
    assert.equal(lidModeAllowedWhenHot({ enabled: false, state: 'critical' }), true);
    assert.equal(smartModeAllowedWhenHot({ enabled: false, state: 'critical' }), true);
});

test('Lid Closed Mode cannot start while the Mac is hot, and Smart Mode waits only while it is critical', () => {
    assert.equal(lidModeAllowedWhenHot({ enabled: true, state: 'fair' }), true);
    assert.equal(lidModeAllowedWhenHot({ enabled: true, state: 'serious' }), false);
    assert.equal(smartModeAllowedWhenHot({ enabled: true, state: 'serious' }), true);
    assert.equal(smartModeAllowedWhenHot({ enabled: true, state: 'critical' }), false);
});
