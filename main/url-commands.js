const URL_PROTOCOL = 'mac-insomnia:';
const MAX_MINUTES = 24 * 60;

function parseCommandUrl (url) {
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    if (parsed.protocol !== URL_PROTOCOL) return null;
    const action = parsed.hostname;
    if (action === 'stop' || action === 'toggle') return { action };
    if (action === 'until') {
        const pid = parsed.searchParams.get('pid');
        return /^\d+$/.test(pid || '') && Number(pid) > 1 ? { action, pid: Number(pid) } : null;
    }
    if (action !== 'start') return null;
    const minutes = parsed.searchParams.get('minutes');
    if (minutes === null) return { action };
    if (minutes === 'infinite') return { action, durationMs: null };
    if (!/^\d+$/.test(minutes) || Number(minutes) < 1 || Number(minutes) > MAX_MINUTES) return null;
    return { action, durationMs: Number(minutes) * 60 * 1000 };
}

module.exports = { parseCommandUrl, MAX_MINUTES };
