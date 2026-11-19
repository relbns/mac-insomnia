const { spawn } = require('child_process');

const GUARD_LEVELS = [10, 20, 30, 50];
const DEFAULT_GUARD_PERCENT = 20;

function parsePowerSource (text) {
    const sources = [...String(text).matchAll(/Now drawing from '([^']+)'/g)];
    const levels = [...String(text).matchAll(/-InternalBattery-\d+[^\n]*?\t(\d+)%/g)];
    return {
        known: sources.length > 0,
        onBattery: sources.length > 0 && sources[sources.length - 1][1] === 'Battery Power',
        percent: levels.length > 0 ? Number(levels[levels.length - 1][1]) : null
    };
}

function normalizeGuardPercent (value) {
    if (value === null || value === 'off') return null;
    return GUARD_LEVELS.includes(Number(value)) ? Number(value) : DEFAULT_GUARD_PERCENT;
}

function shouldMonitor ({ guardPercent, onBattery, awake }) {
    return Boolean(guardPercent) && onBattery && awake;
}

function shouldStop ({ guardPercent, onBattery, percent, awake }) {
    return shouldMonitor({ guardPercent, onBattery, awake }) && percent !== null && percent <= guardPercent;
}

class BatteryMonitor {
    constructor ({ onUpdate, spawnLog = () => spawn('/usr/bin/pmset', ['-g', 'pslog'], { stdio: ['ignore', 'pipe', 'ignore'] }) }) {
        this.onUpdate = onUpdate;
        this.spawnLog = spawnLog;
        this.child = null;
        this.partial = '';
        this.state = { known: false, onBattery: false, percent: null };
    }

    get running () {
        return Boolean(this.child);
    }

    start () {
        if (this.child) return;
        const child = this.spawnLog();
        this.child = child;
        this.partial = '';
        this.state = { known: false, onBattery: false, percent: null };
        child.stdout.setEncoding?.('utf8');
        child.stdout.on('data', (chunk) => {
            if (this.child !== child) return;
            const lines = (this.partial + chunk).split('\n');
            this.partial = lines.pop();
            let changed = false;
            for (const line of lines) {
                const next = parsePowerSource(`${line}\n`);
                if (next.known) this.state = { ...this.state, known: true, onBattery: next.onBattery };
                if (next.percent !== null) this.state = { ...this.state, percent: next.percent };
                changed = changed || next.known || next.percent !== null;
            }
            if (changed && this.state.known) this.onUpdate({ ...this.state });
        });
        child.once('error', () => this.stop());
        child.once('exit', () => {
            if (this.child === child) this.child = null;
        });
    }

    stop () {
        const child = this.child;
        this.child = null;
        if (child) child.kill('SIGTERM');
    }
}

module.exports = { GUARD_LEVELS, DEFAULT_GUARD_PERCENT, BatteryMonitor, parsePowerSource, normalizeGuardPercent, shouldMonitor, shouldStop };
