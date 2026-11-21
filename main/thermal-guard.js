const HOT_STATES = ['serious', 'critical'];

function isHot (state) {
    return HOT_STATES.includes(state);
}

function thermalAction ({ enabled, state, lidOn, keepingAwake }) {
    if (!enabled) return 'none';
    if (state === 'critical' && keepingAwake) return 'stop-all';
    if (isHot(state) && lidOn) return 'lid-off';
    return 'none';
}

function lidModeAllowedWhenHot ({ enabled, state }) {
    return !(enabled && isHot(state));
}

function smartModeAllowedWhenHot ({ enabled, state }) {
    return !(enabled && state === 'critical');
}

module.exports = { thermalAction, lidModeAllowedWhenHot, smartModeAllowedWhenHot };
