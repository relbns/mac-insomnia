import test from 'node:test';
import assert from 'node:assert';
import { parseCpuTime, parsePs, descendants, classify, slopePerHour } from '../scripts/measure-footprint.mjs';

test('parseCpuTime handles ps time formats', () => {
    assert.equal(parseCpuTime('0:01.50'), 1.5);
    assert.equal(parseCpuTime('12:03.00'), 723);
    assert.equal(parseCpuTime('1:00:00.00'), 3600);
    assert.equal(parseCpuTime('1-00:00:01.00'), 86401);
});

test('descendants walks the whole tree and classify names Electron helpers', () => {
    const rows = parsePs(`  10 1 1000 0:01.00 /A.app/Contents/MacOS/A
  11 10 500 0:00.10 /A.app/Contents/Frameworks/A Helper (GPU).app/Contents/MacOS/A Helper (GPU)
  12 10 400 0:00.10 /A.app/Contents/Frameworks/A Helper.app/Contents/MacOS/A Helper
  13 11 10 0:00.00 /usr/bin/caffeinate
  99 1 10 0:00.00 /bin/zsh`);
    assert.deepEqual(descendants(rows, 10).map((r) => r.pid), [10, 11, 12, 13]);
    assert.deepEqual(descendants(rows, 10).map((r) => classify(r.comm, 10, r.pid)), ['main', 'gpu', 'utility', 'caffeinate']);
});

test('slopePerHour is the least-squares growth rate', () => {
    assert.equal(slopePerHour([{ t: 0, v: 10 }, { t: 1800, v: 11 }, { t: 3600, v: 12 }]), 2);
    assert.equal(slopePerHour([{ t: 0, v: 10 }]), 0);
});
