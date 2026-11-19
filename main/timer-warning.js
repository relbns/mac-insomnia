const WARNING_LEAD_MS = 5 * 60 * 1000;
const EXTEND_MS = 30 * 60 * 1000;

function warningPlan ({ enabled, endTime, armedAt, now, warnedForEndTime, leadMs = WARNING_LEAD_MS }) {
    if (!enabled || !endTime || warnedForEndTime === endTime) return { action: 'none' };
    const remaining = endTime - now;
    if (remaining <= 0) return { action: 'none' };
    if (remaining > leadMs) return { action: 'schedule', delayMs: remaining - leadMs };
    if (endTime - armedAt > leadMs) return { action: 'show-now' };
    return { action: 'none' };
}

function extendedEndTime ({ endTime, now, addMs = EXTEND_MS }) {
    return Math.max(endTime, now) + addMs;
}

function minutesLeft ({ endTime, now }) {
    return Math.max(1, Math.ceil((endTime - now) / 60000));
}

function extendLabel (ms = EXTEND_MS) {
    return `Add ${Math.round(ms / 60000)} Minutes`;
}

module.exports = { EXTEND_MS, warningPlan, extendedEndTime, minutesLeft, extendLabel };
