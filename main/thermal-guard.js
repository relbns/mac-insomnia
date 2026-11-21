const HOT_STATES = ['serious', 'critical'];

function isHot ({ enabled, state }) {
    return Boolean(enabled) && HOT_STATES.includes(state);
}

function shouldTurnOffLidMode ({ enabled, state, lidOn, lidBusy }) {
    return isHot({ enabled, state }) && lidOn && !lidBusy;
}

function lidModeAllowedWhenHot ({ enabled, state }) {
    return !isHot({ enabled, state });
}

module.exports = { shouldTurnOffLidMode, lidModeAllowedWhenHot };
