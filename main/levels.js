function normalizeLevel (value, levels, fallback) {
    if (value === null) return null;
    return levels.includes(Number(value)) ? Number(value) : fallback;
}

module.exports = { normalizeLevel };
