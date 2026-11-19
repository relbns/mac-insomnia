const IDLE_LEVELS = [5, 10, 30];
const DEFAULT_IDLE_MINUTES = 10;

function normalizeIdleMinutes (value) {
    if (value === null) return null;
    return IDLE_LEVELS.includes(Number(value)) ? Number(value) : DEFAULT_IDLE_MINUTES;
}

function shouldArmIdleTimer ({ idleMinutes, smartMode, lidActive, claudeBusy }) {
    return Boolean(idleMinutes) && smartMode && lidActive && !claudeBusy;
}

module.exports = { IDLE_LEVELS, DEFAULT_IDLE_MINUTES, normalizeIdleMinutes, shouldArmIdleTimer };
