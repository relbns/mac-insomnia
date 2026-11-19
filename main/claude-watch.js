const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const URL_SCHEME = 'mac-insomnia';
const HOOK_MARKER = `${URL_SCHEME}://claude`;
const HOOK_EVENTS = {
    UserPromptSubmit: 'busy',
    Stop: 'idle',
    SessionEnd: 'idle'
};
const SCAN_INTERVAL_MS = 30 * 1000;

function hookCommand (state) {
    return `/usr/bin/open -g "${HOOK_MARKER}?state=${state}&pid=$PPID" >/dev/null 2>&1 &`;
}

function parseClaudeUrl (url) {
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    if (parsed.protocol !== `${URL_SCHEME}:` || parsed.hostname !== 'claude') return null;
    const state = parsed.searchParams.get('state');
    const pid = Number(parsed.searchParams.get('pid'));
    if (!['busy', 'idle'].includes(state) || !Number.isInteger(pid) || pid <= 1) return null;
    return { state, pid };
}

function isClaudeCommand (comm) {
    return path.basename(String(comm).trim()) === 'claude';
}

function parseProcessTable (output) {
    const table = new Map();
    for (const line of String(output).split('\n')) {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
        if (match) table.set(Number(match[1]), { ppid: Number(match[2]), comm: match[3] });
    }
    return table;
}

function findClaudeAncestor (pid, table, maxDepth = 6) {
    let current = pid;
    for (let depth = 0; depth <= maxDepth && current > 1; depth++) {
        const row = table.get(current);
        if (!row) return null;
        if (isClaudeCommand(row.comm)) return current;
        current = row.ppid;
    }
    return null;
}

function claudePids (table) {
    return [...table].filter(([, row]) => isClaudeCommand(row.comm)).map(([pid]) => pid);
}

function isOurHook (entry) {
    return (entry?.hooks || []).some((hook) => String(hook.command || '').includes(HOOK_MARKER));
}

function hasHooks (settings) {
    return Object.keys(HOOK_EVENTS).every((event) => (settings?.hooks?.[event] || []).some(isOurHook));
}

function removeHooks (settings) {
    const next = structuredClone(settings || {});
    for (const event of Object.keys(HOOK_EVENTS)) {
        if (!next.hooks?.[event]) continue;
        next.hooks[event] = next.hooks[event].filter((entry) => !isOurHook(entry));
        if (next.hooks[event].length === 0) delete next.hooks[event];
    }
    if (next.hooks && Object.keys(next.hooks).length === 0) delete next.hooks;
    return next;
}

function addHooks (settings) {
    const next = removeHooks(settings);
    next.hooks ??= {};
    for (const [event, state] of Object.entries(HOOK_EVENTS)) {
        next.hooks[event] ??= [];
        next.hooks[event].push({ hooks: [{ type: 'command', command: hookCommand(state) }] });
    }
    return next;
}

function defaultRunner () {
    return {
        processTable: () => new Promise((resolve, reject) => {
            execFile('/bin/ps', ['-axo', 'pid=,ppid=,comm='], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => (err ? reject(err) : resolve(parseProcessTable(out))));
        }),
        holdWhileAlive: (pid) => spawn('/usr/bin/caffeinate', ['-i', '-s', '-w', String(pid)], { stdio: 'ignore' })
    };
}

const CLAUDE_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');

function readClaudeSettings (file = CLAUDE_SETTINGS) {
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeClaudeSettings (settings, file = CLAUDE_SETTINGS, now = new Date()) {
    let backup = null;
    if (fs.existsSync(file)) {
        backup = `${file}.bak-mac-insomnia-${now.toISOString().replace(/[:.]/g, '-')}`;
        fs.copyFileSync(file, backup);
    } else {
        fs.mkdirSync(path.dirname(file), { recursive: true });
    }
    fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
    return backup;
}

class ClaudeWatcher {
    constructor ({ onChange = () => {}, runner = defaultRunner(), scanIntervalMs = SCAN_INTERVAL_MS } = {}) {
        this.onChange = onChange;
        this.runner = runner;
        this.scanIntervalMs = scanIntervalMs;
        this.holds = new Map();
        this.mode = 'off';
        this.scanTimer = null;
    }

    get count () {
        return this.holds.size;
    }

    start (mode) {
        this.stop();
        this.mode = mode;
        if (mode === 'scan') {
            this.scan();
            this.scanTimer = setInterval(() => this.scan(), this.scanIntervalMs);
        }
        this.onChange();
    }

    stop () {
        clearInterval(this.scanTimer);
        this.scanTimer = null;
        this.mode = 'off';
        for (const pid of [...this.holds.keys()]) this.release(pid, { notify: false });
        this.onChange();
    }

    hold (pid) {
        if (this.holds.has(pid)) return;
        const child = this.runner.holdWhileAlive(pid);
        child.once('error', () => this.release(pid));
        child.once('exit', () => {
            if (this.holds.get(pid) !== child) return;
            this.holds.delete(pid);
            this.onChange();
        });
        this.holds.set(pid, child);
        this.onChange();
    }

    release (pid, { notify = true } = {}) {
        const child = this.holds.get(pid);
        if (!child) return;
        this.holds.delete(pid);
        child.kill('SIGTERM');
        if (notify) this.onChange();
    }

    async handleUrl (url) {
        const event = parseClaudeUrl(url);
        if (!event || this.mode !== 'hooks') return false;
        let pid = event.pid;
        try {
            pid = findClaudeAncestor(event.pid, await this.runner.processTable());
        } catch {
            if (event.state === 'busy') return false;
        }
        if (!pid) return false;
        if (event.state === 'idle') this.release(pid);
        else this.hold(pid);
        return true;
    }

    async scan () {
        if (this.mode !== 'scan') return;
        let table;
        try {
            table = await this.runner.processTable();
        } catch {
            return;
        }
        const alive = new Set(claudePids(table));
        for (const pid of alive) this.hold(pid);
    }
}

module.exports = {
    URL_SCHEME,
    HOOK_MARKER,
    ClaudeWatcher,
    CLAUDE_SETTINGS,
    readClaudeSettings,
    writeClaudeSettings,
    hookCommand,
    parseClaudeUrl,
    parseProcessTable,
    findClaudeAncestor,
    claudePids,
    hasHooks,
    addHooks,
    removeHooks
};
