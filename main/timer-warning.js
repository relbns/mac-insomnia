const WARNING_LEAD_MS = 5 * 60 * 1000;
const EXTEND_MS = 30 * 60 * 1000;

function warningDelayMs ({ endTime, now, leadMs = WARNING_LEAD_MS }) {
    if (!endTime || endTime - now <= leadMs) return null;
    return endTime - leadMs - now;
}

function extendedEndTime ({ endTime, now, addMs = EXTEND_MS }) {
    return Math.max(endTime || now, now) + addMs;
}

function minutesLeft ({ endTime, now }) {
    return Math.max(1, Math.round((endTime - now) / 60000));
}

module.exports = { WARNING_LEAD_MS, EXTEND_MS, warningDelayMs, extendedEndTime, minutesLeft };
