const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const URL_SCHEME = 'mac-insomnia';
const HOOK_MARKER = `${URL_SCHEME}://claude`;
const APP_PROCESS_NAME = 'Mac Insomnia';
const CLAUDE_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const SCAN_INTERVAL_MS = 30 * 1000;
const MAX_HOLD_SECONDS = 3 * 60 * 60 - 7;
const HOOKS = [
    { event: 'UserPromptSubmit', state: 'busy' },
    { event: 'Stop', state: 'idle' },
    { event: 'StopFailure', state: 'idle' },
    { event: 'SessionEnd', state: 'idle' },
    { event: 'Notification', matcher: 'idle_prompt', state: 'idle' }
];

function hookCommand (state) {
    return `/usr/bin/pgrep -xq "${APP_PROCESS_NAME}" && /usr/bin/open -g "${HOOK_MARKER}?state=${state}&pid=$PPID" >/dev/null 2>&1 &`;
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

function isClaudeCommand (args) {
    const text = String(args).trim();
    const executable = text.split(/\s+/)[0] || '';
    return path.basename(executable) === 'claude' || /\/@anthropic-ai\/claude-code\/cli\.m?js(\s|$)/.test(text);
}

function parseProcessTable (output) {
    const table = new Map();
    for (const line of String(output).split('\n')) {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
        if (match) table.set(Number(match[1]), { ppid: Number(match[2]), args: match[3] });
    }
    return table;
}

function findClaudeAncestor (pid, table, maxDepth = 6) {
    let current = pid;
    for (let depth = 0; depth <= maxDepth && current > 1; depth++) {
        const row = table.get(current);
        if (!row) return null;
        if (isClaudeCommand(row.args)) return current;
        current = row.ppid;
    }
    return null;
}

function claudePids (table) {
    return [...table].filter(([, row]) => isClaudeCommand(row.args)).map(([pid]) => pid);
}

function holdArgs (pid) {
    return ['-i', '-s', '-t', String(MAX_HOLD_SECONDS), '-w', String(pid)];
}

function orphanedHoldPids (table) {
    const pattern = new RegExp(`^/usr/bin/caffeinate -i -s -t ${MAX_HOLD_SECONDS} -w \\d+$`);
    return [...table].filter(([, row]) => row.ppid === 1 && pattern.test(row.args)).map(([pid]) => pid);
}

function isOurCommand (hook) {
    return String(hook?.command || '').includes(HOOK_MARKER);
}

function hasHooks (settings) {
    return HOOKS.every(({ event }) => (settings?.hooks?.[event] || []).some((group) => (group.hooks || []).some(isOurCommand)));
}

function removeHooks (settings) {
    const next = structuredClone(settings || {});
    for (const event of new Set(HOOKS.map((h) => h.event))) {
        if (!next.hooks?.[event]) continue;
        next.hooks[event] = next.hooks[event]
            .map((group) => ({ ...group, hooks: (group.hooks || []).filter((hook) => !isOurCommand(hook)) }))
            .filter((group) => group.hooks.length > 0);
        if (next.hooks[event].length === 0) delete next.hooks[event];
    }
    if (next.hooks && Object.keys(next.hooks).length === 0) delete next.hooks;
    return next;
}

function addHooks (settings) {
    const next = removeHooks(settings);
    next.hooks ??= {};
    for (const { event, matcher, state } of HOOKS) {
        next.hooks[event] ??= [];
        next.hooks[event].push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: hookCommand(state) }] });
    }
    return next;
}

function readClaudeSettings (file = CLAUDE_SETTINGS) {
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeClaudeSettings (settings, file = CLAUDE_SETTINGS) {
    const target = fs.existsSync(file) ? fs.realpathSync(file) : file;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const backup = `${target}.bak-mac-insomnia`;
    if (fs.existsSync(target)) fs.copyFileSync(target, backup);
    const temp = `${target}.tmp-mac-insomnia-${process.pid}`;
    fs.writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`);
    fs.renameSync(temp, target);
    return fs.existsSync(backup) ? backup : null;
}

function defaultRunner () {
    return {
        processTable: () => new Promise((resolve, reject) => {
            execFile('/bin/ps', ['-axo', 'pid=,ppid=,args='], { timeout: 5000, maxBuffer: 16 * 1024 * 1024 }, (err, out) => (err ? reject(err) : resolve(parseProcessTable(out))));
        }),
        holdWhileAlive: (pid) => spawn('/usr/bin/caffeinate', holdArgs(pid), { stdio: 'ignore' }),
        kill: (pid) => process.kill(pid, 'SIGTERM')
    };
}

class ClaudeWatcher {
    constructor ({ onChange = () => {}, onError = () => {}, runner = defaultRunner(), scanIntervalMs = SCAN_INTERVAL_MS } = {}) {
        this.onChange = onChange;
        this.onError = onError;
        this.runner = runner;
        this.scanIntervalMs = scanIntervalMs;
        this.holds = new Map();
        this.mode = 'off';
        this.generation = 0;
        this.scanTimer = null;
        this.queue = Promise.resolve();
    }

    get count () {
        return this.holds.size;
    }

    enqueue (task) {
        const run = this.queue.then(task);
        this.queue = run.catch((error) => this.onError(error));
        return run.catch((error) => {
            this.onError(error);
            return false;
        });
    }

    start (mode) {
        const keepHolds = this.mode === 'scan' && mode === 'hooks';
        this.halt({ keepHolds });
        this.mode = mode;
        if (mode === 'scan') {
            this.scan();
            this.scanTimer = setInterval(() => this.scan(), this.scanIntervalMs);
        }
        this.onChange();
    }

    stop () {
        this.halt({ keepHolds: false });
        this.onChange();
    }

    halt ({ keepHolds }) {
        this.generation++;
        clearInterval(this.scanTimer);
        this.scanTimer = null;
        this.mode = 'off';
        if (!keepHolds) for (const pid of [...this.holds.keys()]) this.release(pid, { notify: false });
    }

    hold (pid) {
        const previous = this.holds.get(pid);
        const child = this.runner.holdWhileAlive(pid);
        child.once('error', (error) => {
            this.onError(error);
            this.release(pid);
        });
        child.once('exit', () => {
            if (this.holds.get(pid) !== child) return;
            this.holds.delete(pid);
            this.onChange();
        });
        this.holds.set(pid, child);
        if (previous) previous.kill('SIGTERM');
        this.onChange();
    }

    release (pid, { notify = true } = {}) {
        const child = this.holds.get(pid);
        if (!child) return;
        this.holds.delete(pid);
        child.kill('SIGTERM');
        if (notify) this.onChange();
    }

    handleUrl (url) {
        const event = parseClaudeUrl(url);
        if (!event) return Promise.resolve(false);
        return this.enqueue(async () => {
            if (this.mode !== 'hooks') return false;
            const generation = this.generation;
            const pid = findClaudeAncestor(event.pid, await this.runner.processTable());
            if (generation !== this.generation || this.mode !== 'hooks' || !pid) return false;
            if (event.state === 'idle') this.release(pid);
            else this.hold(pid);
            return true;
        });
    }

    scan () {
        return this.enqueue(async () => {
            if (this.mode !== 'scan') return;
            const generation = this.generation;
            const table = await this.runner.processTable();
            if (generation !== this.generation || this.mode !== 'scan') return;
            for (const pid of claudePids(table)) if (!this.holds.has(pid)) this.hold(pid);
        });
    }

    sweepOrphans () {
        return this.enqueue(async () => {
            for (const pid of orphanedHoldPids(await this.runner.processTable())) this.runner.kill(pid);
        });
    }
}

module.exports = {
    URL_SCHEME,
    CLAUDE_SETTINGS,
    MAX_HOLD_SECONDS,
    ClaudeWatcher,
    hookCommand,
    holdArgs,
    parseClaudeUrl,
    parseProcessTable,
    findClaudeAncestor,
    orphanedHoldPids,
    hasHooks,
    addHooks,
    removeHooks,
    readClaudeSettings,
    writeClaudeSettings
};
