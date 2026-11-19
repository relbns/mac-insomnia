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

function parseLatestYml (text) {
    const value = (key) => String(text).match(new RegExp(`^${key}:\\s*'?([^'\\n]+)'?\\s*$`, 'm'))?.[1]?.trim() ?? null;
    const file = String(text).match(/^files:\s*\n\s*-\s*url:\s*(\S+)\s*\n\s*sha512:\s*(\S+)\s*\n\s*size:\s*(\d+)/m);
    const version = value('version');
    if (!version || !file || !/\.dmg$/.test(file[1])) return null;
    return { version, file: file[1], sha512: file[2], size: Number(file[3]) };
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

function buildInstallScript ({ appPid, bundlePath, newAppPath, mountPoint, dmgPath, relaunchUrl }) {
    const bundle = shellQuote(bundlePath);
    const backup = shellQuote(`${bundlePath}.previous`);
    const open = relaunchUrl ? `/usr/bin/open -a ${bundle} ${shellQuote(relaunchUrl)}` : `/usr/bin/open -a ${bundle}`;
    return [
        `while /bin/kill -0 ${Number(appPid)} 2>/dev/null; do /bin/sleep 0.2; done`,
        `/bin/rm -rf ${backup}`,
        `if /bin/mv ${bundle} ${backup} && /usr/bin/ditto ${shellQuote(newAppPath)} ${bundle}; then /bin/rm -rf ${backup}; else /bin/rm -rf ${bundle}; /bin/mv ${backup} ${bundle}; fi`,
        `/usr/bin/hdiutil detach ${shellQuote(mountPoint)} -quiet`,
        `/bin/rm -rf ${shellQuote(path.dirname(dmgPath))}`,
        open
    ].join('\n');
}

function run (file, args) {
    return new Promise((resolve, reject) => {
        execFile(file, args, { timeout: 120000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve(stdout)));
    });
}

function defaultRunner () {
    return {
        fetchText: async (url) => {
            const response = await fetch(url, { redirect: 'follow' });
            if (!response.ok) throw new Error(`update feed returned ${response.status}`);
            return response.text();
        },
        download: async (url, filePath) => {
            const response = await fetch(url, { redirect: 'follow' });
            if (!response.ok || !response.body) throw new Error(`download returned ${response.status}`);
            const hash = crypto.createHash('sha512');
            let size = 0;
            const source = Readable.fromWeb(response.body);
            source.on('data', (chunk) => {
                hash.update(chunk);
                size += chunk.length;
            });
            await pipeline(source, fs.createWriteStream(filePath));
            return { sha512: hash.digest('base64'), size };
        },
        mount: async (dmgPath) => {
            const out = await run('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', dmgPath]);
            const mountPoint = out.split('\n').map((line) => line.split('\t').pop().trim()).find((field) => field.startsWith('/Volumes/'));
            if (!mountPoint) throw new Error('could not mount the update');
            return mountPoint;
        },
        detach: (mountPoint) => run('/usr/bin/hdiutil', ['detach', mountPoint, '-quiet']).catch(() => {}),
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
    constructor ({ currentVersion, execPath, appPid = process.pid, feedUrl = FEED_URL, runner = defaultRunner() }) {
        this.currentVersion = currentVersion;
        this.execPath = execPath;
        this.appPid = appPid;
        this.feedUrl = feedUrl;
        this.runner = runner;
        this.available = null;
        this.state = 'idle';
    }

    async check () {
        this.state = 'checking';
        try {
            const latest = parseLatestYml(await this.runner.fetchText(this.feedUrl));
            if (!latest) throw new Error('the update feed could not be read');
            this.available = isNewer(latest.version, this.currentVersion) ? latest : null;
            this.state = 'idle';
            return { ok: true, available: this.available };
        } catch (error) {
            this.state = 'idle';
            return { ok: false, error };
        }
    }

    async prepare () {
        const update = this.available;
        if (!update) return { ok: false, error: new Error('no update is available') };
        const bundlePath = bundlePathFromExec(this.execPath);
        if (!bundlePath) return { ok: false, error: new Error('Mac Insomnia is not running from an app bundle') };
        if (!this.runner.canReplace(bundlePath)) return { ok: false, error: new Error(`Mac Insomnia cannot replace ${bundlePath}; install the update from the release page`) };
        this.state = 'downloading';
        const dir = this.runner.tempDir();
        const dmgPath = path.join(dir, path.basename(update.file));
        let mountPoint = null;
        try {
            const downloaded = await this.runner.download(downloadUrl(this.feedUrl, update), dmgPath);
            if (downloaded.sha512 !== update.sha512 || downloaded.size !== update.size) throw new Error('the download does not match the release checksum');
            mountPoint = await this.runner.mount(dmgPath);
            const newAppPath = path.join(mountPoint, 'Mac Insomnia.app');
            if (await this.runner.readPlist(newAppPath, 'CFBundleIdentifier') !== BUNDLE_ID) throw new Error('the update is not Mac Insomnia');
            if (await this.runner.readPlist(newAppPath, 'CFBundleShortVersionString') !== update.version) throw new Error('the update has an unexpected version');
            await this.runner.verifySignature(newAppPath);
            this.state = 'ready';
            return { ok: true, plan: { bundlePath, newAppPath, mountPoint, dmgPath, version: update.version } };
        } catch (error) {
            if (mountPoint) await this.runner.detach(mountPoint);
            this.runner.removeDir(dir);
            this.state = 'idle';
            return { ok: false, error };
        }
    }

    install (plan, { relaunchUrl } = {}) {
        this.runner.startInstaller(buildInstallScript({ appPid: this.appPid, ...plan, relaunchUrl }));
    }
}

module.exports = { FEED_URL, BUNDLE_ID, CHECK_INTERVAL_MS, Updater, parseLatestYml, isNewer, bundlePathFromExec, buildInstallScript, downloadUrl };
