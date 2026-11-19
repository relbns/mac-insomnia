const { spawn } = require('child_process');

const GUARD_LEVELS = [10, 20, 30, 50];
const DEFAULT_GUARD_PERCENT = 20;
const MAX_RESTART_DELAY_MS = 60 * 1000;

function parsePowerSource (text) {
    const value = String(text);
    const sources = [...value.matchAll(/Now drawing from '([^']+)'/g)];
    const levels = [...value.matchAll(/-InternalBattery-\d+[^\n]*?\t(\d+)%/g)];
    return {
        known: sources.length > 0,
        onBattery: sources.length > 0 && sources[sources.length - 1][1] === 'Battery Power',
        percent: levels.length > 0 ? Number(levels[levels.length - 1][1]) : null
    };
}

function normalizeGuardPercent (value) {
    if (value === null) return null;
    return GUARD_LEVELS.includes(Number(value)) ? Number(value) : DEFAULT_GUARD_PERCENT;
}

function shouldMonitor ({ guardPercent, onBattery, awake }) {
    return Boolean(guardPercent) && onBattery && awake;
}

function shouldStop ({ guardPercent, onBattery, percent, awake }) {
    return shouldMonitor({ guardPercent, onBattery, awake }) && percent !== null && percent <= guardPercent;
}

function shouldResumeSmartMode ({ guardPercent, onBattery, percent }) {
    return !shouldStop({ guardPercent, onBattery, percent, awake: true });
}

function lidModeAllowed ({ lidOffOnBattery, onBattery }) {
    return !(lidOffOnBattery && onBattery);
}

class BatteryMonitor {
    constructor ({ onUpdate, onError = () => {}, restartDelayMs = 5000, spawnLog = () => spawn('/usr/bin/pmset', ['-g', 'pslog'], { stdio: ['ignore', 'pipe', 'ignore'] }) }) {
        this.onUpdate = onUpdate;
        this.onError = onError;
        this.restartDelayMs = restartDelayMs;
        this.spawnLog = spawnLog;
        this.child = null;
        this.wanted = false;
        this.restartTimer = null;
        this.failures = 0;
    }

    get running () {
        return Boolean(this.child);
    }

    start () {
        this.wanted = true;
        if (this.child || this.restartTimer) return;
        this.spawnChild();
    }

    stop () {
        this.wanted = false;
        this.failures = 0;
        clearTimeout(this.restartTimer);
        this.restartTimer = null;
        const child = this.child;
        this.child = null;
        if (child) child.kill('SIGTERM');
    }

    spawnChild () {
        this.restartTimer = null;
        const child = this.spawnLog();
        this.child = child;
        let partial = '';
        let state = { known: false, onBattery: false, percent: null };
        child.stdout.setEncoding?.('utf8');
        child.stdout.on('data', (chunk) => {
            if (this.child !== child) return;
            const lines = (partial + chunk).split('\n');
            partial = lines.pop();
            let changed = false;
            for (const line of lines) {
                const next = parsePowerSource(line);
                if (next.known) state = { ...state, known: true, onBattery: next.onBattery };
                if (next.percent !== null) state = { ...state, percent: next.percent };
                changed = changed || next.known || next.percent !== null;
            }
            if (changed && state.known) {
                this.failures = 0;
                this.onUpdate({ ...state });
            }
        });
        child.once('error', (error) => {
            this.onError(error);
            this.handleExit(child, 'error');
        });
        child.once('exit', (code) => this.handleExit(child, code));
    }

    handleExit (child, code) {
        if (this.child !== child) return;
        this.child = null;
        if (!this.wanted) return;
        this.failures++;
        this.onError(new Error(`pmset -g pslog ended (${code}), restarting`));
        const delay = Math.min(this.restartDelayMs * 2 ** (this.failures - 1), MAX_RESTART_DELAY_MS);
        this.restartTimer = setTimeout(() => {
            if (this.wanted) this.spawnChild();
            else this.restartTimer = null;
        }, delay);
    }
}

module.exports = {
    GUARD_LEVELS,
    DEFAULT_GUARD_PERCENT,
    BatteryMonitor,
    parsePowerSource,
    normalizeGuardPercent,
    shouldMonitor,
    shouldStop,
    shouldResumeSmartMode,
    lidModeAllowed
};
