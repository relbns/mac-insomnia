const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldTurnOffLidMode, lidModeAllowedWhenHot } = require('../main/thermal-guard');

const cases = [
    ['fair: Lid Closed Mode stays on', { state: 'fair', lidOn: true }, false],
    ['serious: Lid Closed Mode turns off', { state: 'serious', lidOn: true }, true],
    ['critical: Lid Closed Mode turns off', { state: 'critical', lidOn: true }, true],
    ['hot without Lid Closed Mode: nothing to do', { state: 'critical', lidOn: false }, false],
    ['hot while another lid task runs: wait for it', { state: 'serious', lidOn: true, lidBusy: true }, false],
    ['unknown state: nothing to do', { state: 'unknown', lidOn: true }, false],
    ['guard off: nothing to do', { enabled: false, state: 'critical', lidOn: true }, false]
];

for (const [name, input, expected] of cases) {
    test(name, () => assert.equal(shouldTurnOffLidMode({ enabled: true, lidBusy: false, ...input }), expected));
}

test('Lid Closed Mode cannot be turned on while the Mac is hot, unless Thermal Guard is off', () => {
    assert.equal(lidModeAllowedWhenHot({ enabled: true, state: 'fair' }), true);
    assert.equal(lidModeAllowedWhenHot({ enabled: true, state: 'serious' }), false);
    assert.equal(lidModeAllowedWhenHot({ enabled: false, state: 'critical' }), true);
});
