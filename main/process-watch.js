const path = require('path');
const { execFile, spawn } = require('child_process');

const SYSTEM_PREFIXES = ['/System/', '/usr/libexec/', '/usr/sbin/', '/sbin/', '/Library/Apple/'];
const SKIP_NAMES = new Set(['ps', 'caffeinate', 'pmset', 'Mac Insomnia', 'login', '-zsh', 'zsh', 'bash', 'sh', 'fish']);
const MIN_CPU = 1;

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

function defaultRunner () {
    return {
        listProcesses: () => new Promise((resolve, reject) => {
            execFile('/bin/ps', ['-x', '-o', 'pid=,pcpu=,comm='], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => (err ? reject(err) : resolve(parseProcessList(out))));
        }),
        processName: (pid) => new Promise((resolve) => {
            execFile('/bin/ps', ['-p', String(pid), '-o', 'comm='], { timeout: 5000 }, (err, out) => resolve(err || !out.trim() ? null : displayName(out.trim())));
        }),
        holdWhileAlive: (pid, args) => spawn('/usr/bin/caffeinate', [...args, '-w', String(pid)], { stdio: 'ignore' }),
        isAlive: (pid) => {
            try {
                process.kill(pid, 0);
                return true;
            } catch (error) {
                return error.code === 'EPERM';
            }
        }
    };
}

class ProcessWatcher {
    constructor ({ keepAwakeFlags, onChange = () => {}, onFinished = () => {}, runner = defaultRunner() }) {
        this.keepAwakeFlags = keepAwakeFlags;
        this.onChange = onChange;
        this.onFinished = onFinished;
        this.runner = runner;
        this.watched = new Map();
    }

    get count () {
        return this.watched.size;
    }

    list () {
        return [...this.watched].map(([pid, entry]) => ({ pid, name: entry.name }));
    }

    async watchPid (pid) {
        if (!Number.isInteger(pid) || pid <= 1 || this.watched.has(pid)) return false;
        const name = await this.runner.processName(pid);
        if (!name) return false;
        this.watch(pid, name);
        return true;
    }

    watch (pid, name) {
        if (this.watched.has(pid)) return;
        const child = this.runner.holdWhileAlive(pid, this.keepAwakeFlags());
        child.once('error', () => this.unwatch(pid));
        child.once('exit', () => {
            if (this.watched.get(pid)?.child !== child) return;
            this.watched.delete(pid);
            if (!this.runner.isAlive(pid)) this.onFinished({ pid, name });
            this.onChange();
        });
        this.watched.set(pid, { name, child });
        this.onChange();
    }

    unwatch (pid, { notify = true } = {}) {
        const entry = this.watched.get(pid);
        if (!entry) return;
        this.watched.delete(pid);
        entry.child.kill('SIGTERM');
        if (notify) this.onChange();
    }

    unwatchAll () {
        for (const pid of [...this.watched.keys()]) this.unwatch(pid, { notify: false });
        this.onChange();
    }

    async candidates () {
        try {
            return candidateProcesses(await this.runner.listProcesses(), { selfPid: process.pid, watchedPids: [...this.watched.keys()] });
        } catch {
            return [];
        }
    }
}

module.exports = { ProcessWatcher, parseProcessList, candidateProcesses, displayName };
