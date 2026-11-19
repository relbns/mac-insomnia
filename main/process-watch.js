const path = require('path');
const { execFile, spawn } = require('child_process');

const SYSTEM_PREFIXES = ['/System/', '/usr/libexec/', '/usr/sbin/', '/sbin/', '/Library/Apple/'];
const SKIP_NAMES = new Set(['ps', 'caffeinate', 'pmset', 'Mac Insomnia', 'login', '-zsh', 'zsh', 'bash', 'sh', 'fish']);
const MIN_CPU = 1;
const HOLD_CAP_SECONDS = 24 * 60 * 60 - 7;
const PS_ENV = { ...process.env, LC_ALL: 'C' };
const CAP_REACHED_MARGIN_MS = 5000;

function displayName (comm) {
    const app = String(comm).match(/\/([^/]+)\.app\/Contents\/MacOS\/[^/]+$/);
    if (app) return app[1];
    return path.basename(String(comm).trim());
}

function parseProcessList (output) {
    const rows = [];
    for (const line of String(output).split('\n')) {
        const match = line.trim().match(/^(\d+)\s+([\d.]+)\s+(.+)$/);
        if (match) rows.push({ pid: Number(match[1]), cpu: Number(match[2]), comm: match[3] });
    }
    return rows;
}

function candidateProcesses (rows, { selfPid, watchedPids = [], limit = 8 } = {}) {
    return rows
        .filter((row) => row.pid !== selfPid && !watchedPids.includes(row.pid) && row.cpu >= MIN_CPU)
        .filter((row) => !SYSTEM_PREFIXES.some((prefix) => row.comm.startsWith(prefix)))
        .filter((row) => !row.comm.includes('.app/Contents/Frameworks/'))
        .map((row) => ({ pid: row.pid, cpu: row.cpu, name: displayName(row.comm) }))
        .filter((row) => !SKIP_NAMES.has(row.name))
        .sort((a, b) => b.cpu - a.cpu)
        .slice(0, limit);
}

function labelFor ({ pid, name }, all) {
    return all.filter((other) => other.name === name).length > 1 ? `${name} (pid ${pid})` : name;
}

function holdArgs (flag) {
    return [flag, '-t', String(HOLD_CAP_SECONDS)];
}

function holdOutcome ({ code, signal, heldMs }) {
    if (signal || code !== 0) return 'unexpected';
    return heldMs >= HOLD_CAP_SECONDS * 1000 - CAP_REACHED_MARGIN_MS ? 'renew' : 'finished';
}

function orphanedWatchHolds (output) {
    const pattern = new RegExp(`^/usr/bin/caffeinate -(dimsu|ims) -t ${HOLD_CAP_SECONDS} -w \\d+$`);
    const orphans = [];
    for (const line of String(output).split('\n')) {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
        if (match && Number(match[2]) === 1 && pattern.test(match[3])) orphans.push(Number(match[1]));
    }
    return orphans;
}

function defaultRunner () {
    return {
        listProcesses: () => new Promise((resolve, reject) => {
            execFile('/bin/ps', ['-x', '-o', 'pid=,pcpu=,comm='], { timeout: 5000, maxBuffer: 8 * 1024 * 1024, env: PS_ENV }, (err, out) => (err ? reject(err) : resolve(parseProcessList(out))));
        }),
        processTable: () => new Promise((resolve, reject) => {
            execFile('/bin/ps', ['-axo', 'pid=,ppid=,args='], { timeout: 5000, maxBuffer: 16 * 1024 * 1024, env: PS_ENV }, (err, out) => (err ? reject(err) : resolve(out)));
        }),
        processName: (pid) => new Promise((resolve) => {
            execFile('/bin/ps', ['-p', String(pid), '-o', 'comm='], { timeout: 5000, env: PS_ENV }, (err, out) => resolve(err || !out.trim() ? null : displayName(out.trim())));
        }),
        holdWhileAlive: (pid, args) => spawn('/usr/bin/caffeinate', [...args, '-w', String(pid)], { stdio: 'ignore' }),
        kill: (pid) => process.kill(pid, 'SIGTERM'),
        now: () => Date.now()
    };
}

class ProcessWatcher {
    constructor ({ keepAwakeFlag, onChange = () => {}, onFinished = () => {}, onUnexpectedEnd = () => {}, onError = () => {}, runner = defaultRunner() }) {
        this.keepAwakeFlag = keepAwakeFlag;
        this.onChange = onChange;
        this.onFinished = onFinished;
        this.onUnexpectedEnd = onUnexpectedEnd;
        this.onError = onError;
        this.runner = runner;
        this.watched = new Map();
    }

    get count () {
        return this.watched.size;
    }

    list () {
        const all = [...this.watched].map(([pid, entry]) => ({ pid, name: entry.name }));
        return all.map((item) => ({ ...item, label: labelFor(item, all) }));
    }

    async watchPid (pid) {
        if (this.watched.has(pid)) return { ok: false, reason: 'already-waiting' };
        const name = await this.runner.processName(pid);
        if (!name) return { ok: false, reason: 'not-running' };
        this.watch(pid, name);
        return { ok: true, name };
    }

    async watchChecked (pid, name) {
        if (this.watched.has(pid)) return { ok: false, reason: 'already-waiting' };
        if (await this.runner.processName(pid) !== name) return { ok: false, reason: 'not-running' };
        this.watch(pid, name);
        return { ok: true, name };
    }

    watch (pid, name) {
        if (this.watched.has(pid)) return;
        const entry = { name };
        this.watched.set(pid, entry);
        this.spawnHold(pid, entry);
        this.onChange();
    }

    spawnHold (pid, entry) {
        const child = this.runner.holdWhileAlive(pid, holdArgs(this.keepAwakeFlag()));
        entry.child = child;
        entry.heldAt = this.runner.now();
        child.once('error', (error) => {
            this.onError(error);
            this.handleExit(pid, child, null, 'error');
        });
        child.once('exit', (code, signal) => this.handleExit(pid, child, code, signal));
    }

    handleExit (pid, child, code, signal) {
        const entry = this.watched.get(pid);
        if (entry?.child !== child) return;
        const outcome = holdOutcome({ code, signal, heldMs: this.runner.now() - entry.heldAt });
        if (outcome === 'renew') {
            this.spawnHold(pid, entry);
            return;
        }
        this.watched.delete(pid);
        if (outcome === 'finished') this.onFinished({ pid, name: entry.name });
        else this.onUnexpectedEnd({ pid, name: entry.name });
        this.onChange();
    }

    reapplyFlags () {
        for (const [pid, entry] of this.watched) {
            const previous = entry.child;
            this.spawnHold(pid, entry);
            previous.kill('SIGTERM');
        }
    }

    unwatch (pid, { silent = false } = {}) {
        const entry = this.watched.get(pid);
        if (!entry) return;
        this.watched.delete(pid);
        entry.child.kill('SIGTERM');
        if (!silent) this.onChange();
    }

    unwatchAll () {
        for (const pid of [...this.watched.keys()]) this.unwatch(pid, { silent: true });
        this.onChange();
    }

    async candidates () {
        try {
            const list = candidateProcesses(await this.runner.listProcesses(), { selfPid: process.pid, watchedPids: [...this.watched.keys()] });
            return { ok: true, list: list.map((item) => ({ ...item, label: labelFor(item, list) })) };
        } catch (error) {
            this.onError(error);
            return { ok: false, list: [] };
        }
    }

    async sweepOrphans () {
        try {
            for (const pid of orphanedWatchHolds(await this.runner.processTable())) this.runner.kill(pid);
        } catch (error) {
            this.onError(error);
        }
    }
}

module.exports = { HOLD_CAP_SECONDS, ProcessWatcher, parseProcessList, candidateProcesses, displayName, labelFor, holdOutcome, orphanedWatchHolds };
