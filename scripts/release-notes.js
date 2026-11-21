const { execFileSync } = require('child_process');

const REPO_URL = 'https://github.com/relbns/mac-insomnia';

function parseMergedPullRequests (log) {
    return String(log).split('\n')
        .map((line) => line.match(/^Merge pull request #(\d+) from \S+\t(.+)$/))
        .filter(Boolean)
        .map(([, number, title]) => ({ number: Number(number), title: title.trim() }))
        .filter(({ title }) => !/^(Release )?v?\d+\.\d+\.\d+$/.test(title))
        .sort((a, b) => a.number - b.number);
}

function formatReleaseNotes ({ tag, previousTag, pullRequests }) {
    const changes = pullRequests.length
        ? pullRequests.map(({ number, title }) => `- ${title} ([#${number}](${REPO_URL}/pull/${number}))`).join('\n')
        : '- Maintenance release.';
    const compare = previousTag ? `\n\n**Full changelog:** ${REPO_URL}/compare/${previousTag}...${tag}` : '';
    return `## What's changed\n\n${changes}${compare}\n`;
}

function git (args) {
    return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function releaseNotesFor (tag) {
    let previousTag = null;
    try {
        previousTag = git(['describe', '--tags', '--abbrev=0', '--match', 'v*.*.*', `${tag}^`]);
    } catch {}
    const range = previousTag ? `${previousTag}..${tag}` : tag;
    const pullRequests = parseMergedPullRequests(git(['log', '--merges', '--format=%s%x09%b', range]));
    return formatReleaseNotes({ tag, previousTag, pullRequests });
}

if (require.main === module) {
    const tag = process.argv[2];
    if (!tag) {
        console.error('usage: node scripts/release-notes.js <tag>');
        process.exit(2);
    }
    process.stdout.write(releaseNotesFor(tag));
}

module.exports = { parseMergedPullRequests, formatReleaseNotes };
