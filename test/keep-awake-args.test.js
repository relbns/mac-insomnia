const test = require('node:test');
const assert = require('node:assert');
const { keepAwakeArgs } = require('../main/keep-awake-args');

test('the display stays on by default and may sleep when allowed, while the system stays awake', () => {
    assert.deepEqual(keepAwakeArgs({ allowDisplaySleep: false, ownerPid: 42 }), ['-dimsu', '-w', '42']);
    assert.deepEqual(keepAwakeArgs({ allowDisplaySleep: true, ownerPid: 42 }), ['-ims', '-w', '42']);
});
