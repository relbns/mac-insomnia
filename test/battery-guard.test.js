const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { BatteryMonitor, parsePowerSource, normalizeGuardPercent, shouldMonitor, shouldStop, shouldResumeSmartMode, lidModeAllowed } = require('../main/battery-guard');

const ON_BATTERY = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=6946915)\t33%; discharging; 4:35 remaining present: true\n";
const ON_AC = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=6946915)\t85%; charging; 0:40 remaining present: true\n";
const NOTIFICATION_LINE = '2026-11-19 20:30:15 +0200 com.apple.system.powersources\n';

test('parsePowerSource reads the source and the battery level', () => {
    assert.deepEqual(parsePowerSource(ON_BATTERY), { known: true, onBattery: true, percent: 33 });
    assert.deepEqual(parsePowerSource(ON_AC), { known: true, onBattery: false, percent: 85 });
    assert.deepEqual(parsePowerSource("Now drawing from 'AC Power'\n"), { known: true, onBattery: false, percent: null });
    assert.deepEqual(parsePowerSource('pmset is in logging mode now.'), { known: false, onBattery: false, percent: null });
});

test('the guard defaults to 20% and accepts only the offered levels or off', () => {
    assert.equal(normalizeGuardPercent(undefined), 20);
    assert.equal(normalizeGuardPercent(30), 30);
    assert.equal(normalizeGuardPercent(null), null);
    assert.equal(normalizeGuardPercent(37), 20);
});

test('monitoring runs only when the guard is on, the Mac is on battery and something keeps it awake', () => {
    assert.equal(shouldMonitor({ guardPercent: 20, onBattery: true, awake: true }), true);
    assert.equal(shouldMonitor({ guardPercent: null, onBattery: true, awake: true }), false);
    assert.equal(shouldMonitor({ guardPercent: 20, onBattery: false, awake: true }), false);
    assert.equal(shouldMonitor({ guardPercent: 20, onBattery: true, awake: false }), false);
});

test('a guard paused Smart Mode resumes on AC, with the guard off, or above the guard level', () => {
    assert.equal(shouldResumeSmartMode({ guardPercent: 20, onBattery: false, percent: 15 }), true);
    assert.equal(shouldResumeSmartMode({ guardPercent: null, onBattery: true, percent: 15 }), true);
    assert.equal(shouldResumeSmartMode({ guardPercent: 10, onBattery: true, percent: 15 }), true);
    assert.equal(shouldResumeSmartMode({ guardPercent: 20, onBattery: true, percent: 15 }), false);
});

test('lid closed mode is not allowed on battery while Turn Off Lid Closed Mode on Battery is on', () => {
    assert.equal(lidModeAllowed({ lidOffOnBattery: true, onBattery: true }), false);
    assert.equal(lidModeAllowed({ lidOffOnBattery: true, onBattery: false }), true);
    assert.equal(lidModeAllowed({ lidOffOnBattery: false, onBattery: true }), true);
});

test('the guard stops at or below its level, on battery only', () => {
    assert.equal(shouldStop({ guardPercent: 20, onBattery: true, percent: 20, awake: true }), true);
    assert.equal(shouldStop({ guardPercent: 20, onBattery: true, percent: 21, awake: true }), false);
    assert.equal(shouldStop({ guardPercent: 20, onBattery: false, percent: 5, awake: true }), false);
    assert.equal(shouldStop({ guardPercent: 20, onBattery: true, percent: null, awake: true }), false);
});

function fakeLog () {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => { child.killed = true; };
    return child;
}

test('BatteryMonitor reports each update from the pslog stream, even when a line is split across chunks', () => {
    const child = fakeLog();
    const updates = [];
    const monitor = new BatteryMonitor({ onUpdate: (s) => updates.push(s.percent), spawnLog: () => child });
    monitor.start();
    child.stdout.emit('data', 'pmset is in logging mode now.\n');
    child.stdout.emit('data', ON_BATTERY);
    const next = ' -InternalBattery-0 (id=6946915)\t32%; discharging; 4:25 remaining present: true\n';
    child.stdout.emit('data', next.slice(0, 30));
    child.stdout.emit('data', next.slice(30));
    assert.deepEqual(updates, [33, 32]);
});

test('BatteryMonitor keeps the power source from the first block, which pslog does not repeat', () => {
    const child = fakeLog();
    const updates = [];
    const monitor = new BatteryMonitor({ onUpdate: (s) => updates.push(s), spawnLog: () => child });
    monitor.start();
    child.stdout.emit('data', ON_BATTERY);
    child.stdout.emit('data', NOTIFICATION_LINE);
    child.stdout.emit('data', ' -InternalBattery-0 (id=6946915)\t19%; discharging; 1:05 remaining present: true\n');
    assert.deepEqual(updates.at(-1), { known: true, onBattery: true, percent: 19 });
});

test('BatteryMonitor runs one pmset at most and stops it', () => {
    let spawned = 0;
    const child = fakeLog();
    const monitor = new BatteryMonitor({ onUpdate: () => {}, spawnLog: () => { spawned++; return child; } });
    monitor.start();
    monitor.start();
    assert.equal(spawned, 1);
    monitor.stop();
    assert.equal(child.killed, true);
    assert.equal(monitor.running, false);
});

test('BatteryMonitor restarts pmset after it dies unexpectedly, and not after stop()', async () => {
    const children = [];
    const errors = [];
    const monitor = new BatteryMonitor({
        onUpdate: () => {},
        onError: (e) => errors.push(e.message),
        restartDelayMs: 1,
        spawnLog: () => { const c = fakeLog(); children.push(c); return c; }
    });
    monitor.start();
    children[0].emit('exit', 1);
    assert.equal(monitor.running, false);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(children.length, 2);
    assert.equal(monitor.running, true);
    assert.match(errors[0], /pmset -g pslog ended \(1\)/);
    monitor.stop();
    children[1].emit('exit', null);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(children.length, 2);
});
