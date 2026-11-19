#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function parseCpuTime (value) {
    const [dayPart, rest] = value.includes('-') ? value.split('-') : ['0', value];
    const parts = rest.split(':').map(Number);
    while (parts.length < 3) parts.unshift(0);
    const [h, m, s] = parts;
    return Number(dayPart) * 86400 + h * 3600 + m * 60 + s;
}

export function classify (comm, rootPid, pid) {
    if (pid === rootPid) return 'main';
    const name = comm.split('/').pop();
    const helper = name.match(/Helper \((\w+)\)/);
    if (helper) return helper[1].toLowerCase();
    if (/Helper$/.test(name)) return 'utility';
    return name;
}

export function parsePs (output) {
    return output.trim().split('\n').map((line) => {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
        if (!m) return null;
        return { pid: Number(m[1]), ppid: Number(m[2]), rssKb: Number(m[3]), cpuSec: parseCpuTime(m[4]), comm: m[5] };
    }).filter(Boolean);
}

export function descendants (rows, rootPid) {
    const byParent = new Map();
    for (const r of rows) {
        if (!byParent.has(r.ppid)) byParent.set(r.ppid, []);
        byParent.get(r.ppid).push(r);
    }
    const root = rows.find((r) => r.pid === rootPid);
    if (!root) return [];
    const out = [root];
    for (let i = 0; i < out.length; i++) out.push(...(byParent.get(out[i].pid) || []));
    return out;
}

export function slopePerHour (points) {
    const n = points.length;
    if (n < 2) return 0;
    const mx = points.reduce((a, p) => a + p.t, 0) / n;
    const my = points.reduce((a, p) => a + p.v, 0) / n;
    const num = points.reduce((a, p) => a + (p.t - mx) * (p.v - my), 0);
    const den = points.reduce((a, p) => a + (p.t - mx) ** 2, 0);
    return den === 0 ? 0 : (num / den) * 3600;
}

export function summarize (samples) {
    const first = samples[0];
    const last = samples[samples.length - 1];
    const wall = last.t - first.t;
    const kinds = new Set(samples.flatMap((s) => Object.keys(s.byKind)));
    const perKind = {};
    for (const kind of kinds) {
        const rss = samples.map((s) => s.byKind[kind]?.rssMb).filter((v) => v !== undefined);
        const cpuStart = first.byKind[kind]?.cpuSec ?? 0;
        const cpuEnd = last.byKind[kind]?.cpuSec ?? 0;
        perKind[kind] = {
            rssMbFirst: rss[0],
            rssMbLast: rss[rss.length - 1],
            rssMbMax: Math.max(...rss),
            cpuSec: +(cpuEnd - cpuStart).toFixed(2),
            cpuPctAvg: wall > 0 ? +((100 * (cpuEnd - cpuStart)) / wall).toFixed(3) : 0
        };
    }
    const total = samples.map((s) => ({ t: s.t - first.t, v: s.totalRssMb }));
    return {
        wallMinutes: +(wall / 60).toFixed(1),
        processCountFirst: first.count,
        processCountLast: last.count,
        totalRssMbFirst: first.totalRssMb,
        totalRssMbLast: last.totalRssMb,
        totalRssMbMax: Math.max(...samples.map((s) => s.totalRssMb)),
        totalRssSlopeMbPerHour: +slopePerHour(total).toFixed(2),
        totalCpuSec: +(last.totalCpuSec - first.totalCpuSec).toFixed(2),
        totalCpuPctAvg: wall > 0 ? +((100 * (last.totalCpuSec - first.totalCpuSec)) / wall).toFixed(3) : 0,
        perKind
    };
}

function sample (rootPid) {
    const rows = parsePs(execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss=,time=,comm='], { encoding: 'utf8' }));
    const tree = descendants(rows, rootPid);
    if (!tree.length) return null;
    const byKind = {};
    for (const r of tree) {
        const kind = classify(r.comm, rootPid, r.pid);
        byKind[kind] ??= { rssMb: 0, cpuSec: 0, count: 0 };
        byKind[kind].rssMb = +(byKind[kind].rssMb + r.rssKb / 1024).toFixed(1);
        byKind[kind].cpuSec = +(byKind[kind].cpuSec + r.cpuSec).toFixed(2);
        byKind[kind].count++;
    }
    return {
        t: Date.now() / 1000,
        count: tree.length,
        pids: tree.map((r) => r.pid),
        totalRssMb: +(tree.reduce((a, r) => a + r.rssKb, 0) / 1024).toFixed(1),
        totalCpuSec: +tree.reduce((a, r) => a + r.cpuSec, 0).toFixed(2),
        byKind
    };
}

function energy (pids) {
    const args = ['-l', '2', '-s', '10', '-stats', 'pid,idlew,power'];
    for (const pid of pids) args.push('-pid', String(pid));
    const out = execFileSync('top', args, { encoding: 'utf8' });
    const lastBlock = out.split(/^PID\s+IDLEW\s+POWER\s*$/m).pop();
    let idleWakeups = 0;
    let power = 0;
    for (const line of lastBlock.trim().split('\n')) {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)/);
        if (m) { idleWakeups += Number(m[2]); power += Number(m[3]); }
    }
    return { idleWakeupsPer10s: idleWakeups, energyImpact: +power.toFixed(2) };
}

function parseArgs (argv) {
    const args = { minutes: 30, interval: 15 };
    for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1];
    return { pid: Number(args.pid), label: args.label || `pid-${args.pid}`, minutes: Number(args.minutes), interval: Number(args.interval), out: args.out };
}

async function main () {
    const { pid, label, minutes, interval, out } = parseArgs(process.argv.slice(2));
    if (!pid) {
        console.error('usage: measure-footprint.mjs --pid <electron main pid> [--label x] [--minutes 30] [--interval 15] [--out file.json]');
        process.exit(2);
    }
    const samples = [];
    const deadline = Date.now() + minutes * 60_000;
    while (Date.now() <= deadline) {
        const s = sample(pid);
        if (!s) { console.error(`${label}: process ${pid} is gone`); break; }
        samples.push(s);
        await new Promise((r) => setTimeout(r, interval * 1000));
    }
    if (samples.length < 2) process.exit(1);
    const last = samples[samples.length - 1];
    const result = { label, pid, summary: summarize(samples), energy: energy(last.pids), samples };
    if (out) writeFileSync(out, JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ label, summary: result.summary, energy: result.energy }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
