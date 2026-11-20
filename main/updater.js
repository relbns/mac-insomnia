const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const FEED_URL = 'https://github.com/relbns/mac-insomnia/releases/latest/download/latest-mac.yml';
const BUNDLE_ID = 'com.nodomain.insomnia';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FEED_TIMEOUT_MS = 30 * 1000;
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;
const QUIT_WAIT_TICKS = 600;
const BIN = { kill: '/bin/kill', sleep: '/bin/sleep', rm: '/bin/rm', mv: '/bin/mv', ditto: '/usr/bin/ditto', hdiutil: '/usr/bin/hdiutil', open: '/usr/bin/open' };

function parseFeedFiles (text) {
    const block = String(text).match(/^files:\s*\n((?:[ \t]+.*\n?)*)/m)?.[1] ?? '';
    return block.split(/^\s*-\s+/m).slice(1).map((entry) => ({
        file: entry.match(/(?:^|\n)\s*url:\s*(\S+)/)?.[1],
        sha512: entry.match(/\n\s*sha512:\s*(\S+)/)?.[1],
        size: Number(entry.match(/\n\s*size:\s*(\d+)/)?.[1])
    })).filter((entry) => entry.file && entry.sha512 && entry.size > 0);
}

function pickDmg (files, arch) {
    const dmgs = files.filter((entry) => /\.dmg$/.test(entry.file));
    const namesArch = (entry, name) => new RegExp(`-${name}\\.dmg$`).test(entry.file);
    return dmgs.find((entry) => namesArch(entry, arch))
        ?? dmgs.find((entry) => namesArch(entry, 'universal'))
        ?? (arch === 'x64' ? dmgs.find((entry) => !/-(arm64|universal)\.dmg$/.test(entry.file)) : undefined)
        ?? null;
}

function parseLatestYml (text, arch = process.arch) {
    const version = String(text).match(/^version:\s*'?([^'\n]+?)'?\s*$/m)?.[1] ?? null;
    const dmg = pickDmg(parseFeedFiles(text), arch);
    if (!version || !dmg) return null;
    return { version, ...dmg };
}

function parseVersion (version) {
    const match = String(version).match(/^(\d+)\.(\d+)\.(\d+)$/);
    return match ? match.slice(1).map(Number) : null;
}

function isNewer (candidate, current) {
    const a = parseVersion(candidate);
    const b = parseVersion(current);
    if (!a || !b) return false;
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
    return false;
}

function bundlePathFromExec (execPath) {
    const match = String(execPath).match(/^(.*\.app)\/Contents\/MacOS\/[^/]+$/);
    return match ? match[1] : null;
}

function downloadUrl (feedUrl, update) {
    const pinned = feedUrl.replace('/releases/latest/download/', `/releases/download/v${update.version}/`);
    return new URL(update.file, pinned).href;
}

function shellQuote (value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function buildInstallScript ({ appPid, bundlePath, newAppPath, mountPoint, dmgPath, version, statusPath, relaunchUrls = [] }, bin = BIN) {
    const bundle = shellQuote(bundlePath);
    const backup = shellQuote(`${bundlePath}.previous`);
    const staged = shellQuote(`${bundlePath}.new`);
    return [
        `waited=0; while ${bin.kill} -0 ${Number(appPid)} 2>/dev/null && [ $waited -lt ${QUIT_WAIT_TICKS} ]; do ${bin.sleep} 0.2; waited=$((waited + 1)); done`,
        'outcome=failed',
        `${bin.rm} -rf ${backup} ${staged}`,
        `if ! ${bin.kill} -0 ${Number(appPid)} 2>/dev/null && ${bin.ditto} ${shellQuote(newAppPath)} ${staged} && ${bin.mv} ${bundle} ${backup}; then if ${bin.mv} ${staged} ${bundle}; then outcome=installed; ${bin.rm} -rf ${backup}; else ${bin.mv} ${backup} ${bundle}; fi; fi`,
        `${bin.rm} -rf ${staged}`,
        `${bin.hdiutil} detach ${shellQuote(mountPoint)} -quiet`,
        `${bin.rm} -rf ${shellQuote(path.dirname(dmgPath))}`,
        `printf '%s %s\\n' "$outcome" ${shellQuote(version)} > ${shellQuote(statusPath)}`,
        [`${bin.open} -a ${bundle}`, ...relaunchUrls.map(shellQuote)].join(' ')
    ].join('\n');
}

function parseInstallOutcome (text) {
    const match = String(text).match(/^(installed|failed) (\d+\.\d+\.\d+)\s*$/);
    return match ? { outcome: match[1], version: match[2] } : null;
}

function run (file, args) {
    return new Promise((resolve, reject) => {
        execFile(file, args, { timeout: 120000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve(stdout)));
    });
}

function defaultRunner () {
    return {
        fetchText: async (url) => {
            const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(FEED_TIMEOUT_MS) });
            if (!response.ok) throw new Error(`update feed returned ${response.status}`);
            return response.text();
        },
        download: async (url, filePath, maxSize) => {
            const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
            if (!response.ok || !response.body) throw new Error(`download returned ${response.status}`);
            const hash = crypto.createHash('sha512');
            let size = 0;
            const source = Readable.fromWeb(response.body);
            source.on('data', (chunk) => {
                hash.update(chunk);
                size += chunk.length;
                if (size > maxSize) source.destroy(new Error('the download is larger than the release says'));
            });
            await pipeline(source, fs.createWriteStream(filePath));
            return { sha512: hash.digest('base64'), size };
        },
        mount: async (dmgPath) => {
            const out = await run('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', dmgPath]);
            const fields = out.split('\n').map((line) => line.split('\t').map((field) => field.trim()));
            const mountPoint = fields.map((row) => row.at(-1)).find((field) => field.startsWith('/Volumes/'));
            if (mountPoint) return mountPoint;
            const device = fields.map((row) => row[0]).find((field) => field.startsWith('/dev/disk'));
            if (device) await run('/usr/bin/hdiutil', ['detach', device, '-quiet']).catch(() => {});
            throw new Error('could not mount the update');
        },
        detach: (mountPoint) => run('/usr/bin/hdiutil', ['detach', mountPoint, '-quiet']).catch((error) => console.error('Update: detach failed:', error.message)),
        readPlist: async (appPath, key) => (await run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', path.join(appPath, 'Contents', 'Info.plist')])).trim(),
        verifySignature: (appPath) => run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath]),
        canReplace: (bundlePath) => {
            try {
                fs.accessSync(path.dirname(bundlePath), fs.constants.W_OK);
                fs.accessSync(bundlePath, fs.constants.W_OK);
                return true;
            } catch {
                return false;
            }
        },
        startInstaller: (script) => {
            const child = spawn('/bin/bash', ['-c', script], { detached: true, stdio: 'ignore' });
            child.unref();
        },
        tempDir: () => fs.mkdtempSync(path.join(os.tmpdir(), 'mac-insomnia-update-')),
        removeDir: (dir) => fs.rmSync(dir, { recursive: true, force: true })
    };
}

class Updater {
    constructor ({ currentVersion, execPath, statusPath, arch = process.arch, appPid = process.pid, feedUrl = FEED_URL, runner = defaultRunner() }) {
        this.currentVersion = currentVersion;
        this.execPath = execPath;
        this.statusPath = statusPath;
        this.arch = arch;
        this.appPid = appPid;
        this.feedUrl = feedUrl;
        this.runner = runner;
        this.available = null;
    }

    async check () {
        try {
            const latest = parseLatestYml(await this.runner.fetchText(this.feedUrl), this.arch);
            if (!latest) throw new Error('the update feed could not be read');
            this.available = isNewer(latest.version, this.currentVersion) ? latest : null;
            return { ok: true, available: this.available };
        } catch (error) {
            return { ok: false, error };
        }
    }

    async prepare (version) {
        const update = this.available;
        if (!update || update.version !== version) return { ok: false, error: new Error(`version ${version} is no longer the available update`) };
        const bundlePath = bundlePathFromExec(this.execPath);
        if (!bundlePath) return { ok: false, error: new Error('Mac Insomnia is not running from an app bundle') };
        if (!this.runner.canReplace(bundlePath)) return { ok: false, error: new Error(`Mac Insomnia cannot replace ${bundlePath}; install the update from the release page`) };
        let dir = null;
        let mountPoint = null;
        try {
            dir = this.runner.tempDir();
            const dmgPath = path.join(dir, path.basename(update.file));
            const downloaded = await this.runner.download(downloadUrl(this.feedUrl, update), dmgPath, update.size);
            if (downloaded.sha512 !== update.sha512 || downloaded.size !== update.size) throw new Error('the download does not match the release checksum');
            mountPoint = await this.runner.mount(dmgPath);
            const newAppPath = path.join(mountPoint, 'Mac Insomnia.app');
            if (await this.runner.readPlist(newAppPath, 'CFBundleIdentifier') !== BUNDLE_ID) throw new Error('the update is not Mac Insomnia');
            if (await this.runner.readPlist(newAppPath, 'CFBundleShortVersionString') !== update.version) throw new Error('the update has an unexpected version');
            await this.runner.verifySignature(newAppPath);
            return { ok: true, plan: { bundlePath, newAppPath, mountPoint, dmgPath, version: update.version } };
        } catch (error) {
            if (mountPoint) await this.runner.detach(mountPoint);
            if (dir) this.runner.removeDir(dir);
            return { ok: false, error };
        }
    }

    async discard (plan) {
        await this.runner.detach(plan.mountPoint);
        this.runner.removeDir(path.dirname(plan.dmgPath));
    }

    install (plan, { relaunchUrls = [] } = {}) {
        this.runner.startInstaller(buildInstallScript({ appPid: this.appPid, ...plan, statusPath: this.statusPath, relaunchUrls }));
    }
}

module.exports = { FEED_URL, BUNDLE_ID, CHECK_INTERVAL_MS, Updater, parseLatestYml, parseInstallOutcome, isNewer, bundlePathFromExec, buildInstallScript, downloadUrl };
