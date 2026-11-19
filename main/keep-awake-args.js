function keepAwakeArgs ({ allowDisplaySleep, ownerPid }) {
    return [allowDisplaySleep ? '-ims' : '-dimsu', '-w', String(ownerPid)];
}

module.exports = { keepAwakeArgs };
