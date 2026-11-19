const { normalizeLevel } = require('./levels');

const IDLE_LEVELS = [5, 10, 30];
const DEFAULT_IDLE_MINUTES = 10;
const DONE_REASONS = ['idle', 'exited'];

function normalizeIdleMinutes (value) {
    return normalizeLevel(value, IDLE_LEVELS, DEFAULT_IDLE_MINUTES);
}

function shouldArmIdleTimer ({ idleMinutes, smartMode, lidActive, claudeBusy, sawClaudeWork, lastReleaseReason }) {
    return Boolean(idleMinutes) && smartMode && lidActive && !claudeBusy && sawClaudeWork && DONE_REASONS.includes(lastReleaseReason);
}

function idleDelayMs ({ armedAt, minutes, now }) {
    return Math.max(0, armedAt + minutes * 60 * 1000 - now);
}

module.exports = { IDLE_LEVELS, DEFAULT_IDLE_MINUTES, normalizeIdleMinutes, shouldArmIdleTimer, idleDelayMs };
