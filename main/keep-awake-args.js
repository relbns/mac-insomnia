function keepAwakeFlag ({ allowDisplaySleep }) {
    return allowDisplaySleep ? '-ims' : '-dimsu';
}

function keepAwakeArgs ({ allowDisplaySleep, ownerPid }) {
    return [keepAwakeFlag({ allowDisplaySleep }), '-w', String(ownerPid)];
}

module.exports = { keepAwakeFlag, keepAwakeArgs };
