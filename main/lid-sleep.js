const fs = require('fs');
const { execFile, spawn } = require('child_process');

const PMSET = '/usr/bin/pmset';
const CAFFEINATE = '/usr/bin/caffeinate';
const USER_CANCELED = -128;
const WATCHDOG_LABEL = 'com.relbns.mac-insomnia.lid-watchdog';

function parseSleepDisabled (pmsetOutput) {
    const match = String(pmsetOutput).match(/^\s*SleepDisabled\s+(\d+)/m);
    return Boolean(match && match[1] !== '0');
}

function shellQuote (value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function appleScriptString (value) {
    return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function xmlEscape (value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildWatchdogPlist ({ tokenPid, label, domain, plistPath, pmsetPath, caffeinatePath }) {
    const script = [
        `${shellQuote(caffeinatePath)} -w ${tokenPid}`,
        `${shellQuote(pmsetPath)} -a disablesleep 0`,
        `/bin/rm -f ${shellQuote(plistPath)}`,
        `/bin/launchctl bootout ${domain}/${label}`
    ].join('; ');
    const args = ['/bin/sh', '-c', script].map((a) => `<string>${xmlEscape(a)}</string>`).join('');
    return '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
        + `<plist version="1.0"><dict><key>Label</key><string>${xmlEscape(label)}</string><key>ProgramArguments</key><array>${args}</array>`
        + '<key>RunAtLoad</key><true/><key>KeepAlive</key><false/><key>AbandonProcessGroup</key><true/></dict></plist>';
}

function buildEnableCommand ({ tokenPid, label = WATCHDOG_LABEL, domain = 'system', plistPath = `/var/run/${WATCHDOG_LABEL}.plist`, pmsetPath = PMSET, caffeinatePath = CAFFEINATE }) {
    if (!Number.isInteger(tokenPid) || tokenPid <= 0) throw new Error(`invalid token pid: ${tokenPid}`);
    if (!/^[\w.-]+$/.test(label) || !/^(system|gui\/\d+)$/.test(domain)) throw new Error('invalid launchd label or domain');
    const plist = buildWatchdogPlist({ tokenPid, label, domain, plistPath, pmsetPath, caffeinatePath });
    return `/bin/launchctl bootout ${domain}/${label} >/dev/null 2>&1; `
        + `/usr/bin/printf '%s' ${shellQuote(plist)} > ${shellQuote(plistPath)} && /bin/chmod 644 ${shellQuote(plistPath)} && `
        + `${shellQuote(pmsetPath)} -a disablesleep 1 && `
        + `{ /bin/launchctl bootstrap ${domain} ${shellQuote(plistPath)} || { ${shellQuote(pmsetPath)} -a disablesleep 0; exit 1; }; }`;
}

function buildRestoreCommand ({ pmsetPath = PMSET } = {}) {
    return `${shellQuote(pmsetPath)} -a disablesleep 0`;
}

function buildOsascript ({ command, prompt, privileged = true }) {
    const parts = [`do shell script ${appleScriptString(command)}`];
    if (privileged) parts.push(`with prompt ${appleScriptString(prompt)}`, 'with administrator privileges');
    return parts.join(' ');
}

function decideStartupAction ({ sleepDisabled, markerExists }) {
    if (sleepDisabled !== false && markerExists) return 'restore-left-over';
    if (sleepDisabled === true) return 'report-external';
    if (sleepDisabled === null) return 'report-unknown';
    if (markerExists) return 'clear-marker';
    return 'none';
}

function parseLaunchdRunning (printOutput) {
    return /^\s*state = running\s*$/m.test(String(printOutput));
}

function isUserCancel (error) {
    return Boolean(error) && (error.code === USER_CANCELED || /\(-128\)|User cancel+ed/i.test(String(error.stderr || error.message)));
}

function defaultRunner () {
    return {
        readPmset: () => new Promise((resolve, reject) => {
            execFile(PMSET, ['-g'], { timeout: 5000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
        }),
        osascript: (script) => new Promise((resolve, reject) => {
            execFile('/usr/bin/osascript', ['-e', script], { timeout: 5 * 60 * 1000 }, (err, stdout, stderr) => {
                if (err) {
                    err.stderr = stderr;
                    reject(err);
                } else resolve(stdout);
            });
        }),
        spawnToken: (ownerPid) => spawn(CAFFEINATE, ['-s', '-w', String(ownerPid)], { stdio: 'ignore' }),
        launchdPrint: (target) => new Promise((resolve) => {
            execFile('/bin/launchctl', ['print', target], { timeout: 5000 }, (err, stdout) => resolve(err ? '' : stdout));
        })
    };
}

class LidSleepController {
    constructor ({ markerPath, ownerPid = process.pid, runner = defaultRunner(), commandOptions = {}, privileged = true, restoreWaitMs = 3000, restorePollMs = 250, onUnexpectedEnd = () => {} }) {
        this.markerPath = markerPath;
        this.ownerPid = ownerPid;
        this.runner = runner;
        this.commandOptions = commandOptions;
        this.privileged = privileged;
        this.restoreWaitMs = restoreWaitMs;
        this.restorePollMs = restorePollMs;
        this.onUnexpectedEnd = onUnexpectedEnd;
        this.token = null;
        this.enabled = false;
        this.systemSleepDisabled = false;
    }

    get active () {
        return Boolean(this.token) && this.enabled;
    }

    get pending () {
        return Boolean(this.token) && !this.enabled;
    }

    async refresh () {
        try {
            this.systemSleepDisabled = parseSleepDisabled(await this.runner.readPmset());
        } catch {
            this.systemSleepDisabled = null;
        }
        return this.systemSleepDisabled;
    }

    markerExists () {
        return fs.existsSync(this.markerPath);
    }

    readMarker () {
        try {
            return JSON.parse(fs.readFileSync(this.markerPath, 'utf8'));
        } catch {
            return null;
        }
    }

    writeMarker () {
        fs.writeFileSync(this.markerPath, JSON.stringify({ enabledAt: new Date().toISOString() }));
    }

    clearMarker () {
        fs.rmSync(this.markerPath, { force: true });
    }

    async watchdogRunning () {
        const { label = WATCHDOG_LABEL, domain = 'system' } = this.commandOptions;
        const deadline = Date.now() + this.restoreWaitMs;
        while (true) {
            if (parseLaunchdRunning(await this.runner.launchdPrint(`${domain}/${label}`))) return true;
            if (Date.now() >= deadline) return false;
            await new Promise((resolve) => setTimeout(resolve, this.restorePollMs));
        }
    }

    async startupAction () {
        const sleepDisabled = await this.refresh();
        const action = decideStartupAction({ sleepDisabled, markerExists: this.markerExists() });
        if (action === 'clear-marker') this.clearMarker();
        return action;
    }

    async enable () {
        if (this.token) return { ok: this.enabled, busy: !this.enabled };
        const before = await this.refresh();
        if (before !== false) return { ok: false, reason: before === null ? 'state-unknown' : 'already-disabled' };

        let token;
        try {
            token = this.runner.spawnToken(this.ownerPid);
            token.once('error', () => {});
            if (!Number.isInteger(token.pid)) throw new Error('could not start the helper process');
            this.token = token;
            this.enabled = false;
            token.once('exit', () => this.handleTokenExit(token));
            this.writeMarker();
            await this.runner.osascript(buildOsascript({
                command: buildEnableCommand({ tokenPid: token.pid, ...this.commandOptions }),
                prompt: 'Mac Insomnia needs your password to keep the Mac awake with the lid closed. Normal sleep is restored when the mode ends.',
                privileged: this.privileged
            }));
        } catch (error) {
            this.killToken();
            this.clearMarker();
            return { ok: false, canceled: isUserCancel(error), error };
        }

        if (this.token !== token) {
            const restored = await this.waitForRestore();
            if (restored) this.clearMarker();
            return { ok: false, reason: 'stopped', restored };
        }
        if (!(await this.watchdogRunning())) {
            this.killToken();
            const restore = await this.restoreWithPrompt();
            return { ok: false, restored: restore.restored, error: new Error('The restore watchdog did not start, so lid closed mode was turned off') };
        }
        if ((await this.refresh()) !== true) {
            const restore = await this.disable({ allowPrompt: true });
            return { ok: false, restored: restore.restored, error: new Error('pmset did not report SleepDisabled after enabling') };
        }
        this.enabled = true;
        return { ok: true };
    }

    async handleTokenExit (token) {
        if (this.token !== token) return;
        const wasEnabled = this.enabled;
        this.token = null;
        this.enabled = false;
        const restored = await this.waitForRestore();
        if (restored) this.clearMarker();
        if (wasEnabled) this.onUnexpectedEnd({ restored });
    }

    killToken () {
        const token = this.token;
        this.token = null;
        this.enabled = false;
        if (token) token.kill('SIGTERM');
    }

    async waitForRestore () {
        const deadline = Date.now() + this.restoreWaitMs;
        while (Date.now() < deadline) {
            if ((await this.refresh()) === false) return true;
            await new Promise((resolve) => setTimeout(resolve, this.restorePollMs));
        }
        return (await this.refresh()) === false;
    }

    async disable ({ allowPrompt = true } = {}) {
        this.killToken();
        if (await this.waitForRestore()) {
            this.clearMarker();
            return { restored: true, via: 'watchdog' };
        }
        if (!allowPrompt) return { restored: false };
        return this.restoreWithPrompt();
    }

    async restoreWithPrompt () {
        try {
            await this.runner.osascript(buildOsascript({
                command: buildRestoreCommand(this.commandOptions),
                prompt: 'Sleep is still disabled on this Mac. Mac Insomnia needs your password to restore normal sleep.',
                privileged: this.privileged
            }));
        } catch (error) {
            await this.refresh();
            return { restored: false, canceled: isUserCancel(error), error };
        }
        const restored = (await this.refresh()) === false;
        if (restored) this.clearMarker();
        return { restored, via: 'prompt' };
    }
}

module.exports = {
    LidSleepController,
    parseSleepDisabled,
    buildEnableCommand,
    buildOsascript,
    decideStartupAction,
    isUserCancel,
    parseLaunchdRunning,
    WATCHDOG_LABEL
};
