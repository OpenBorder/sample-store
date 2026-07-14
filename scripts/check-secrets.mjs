import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const tracked = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' });
if (tracked.status !== 0) throw new Error('Could not list repository files for secret scanning.');

const patterns = [
  /\b(?:sk|pk)_(?:test|live)_[A-Za-z0-9_-]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
];

const findings = [];
for (const file of tracked.stdout.split('\0').filter(Boolean)) {
  if (file === 'package-lock.json') continue;
  const content = readFileSync(file, 'utf8');
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    if (pattern.test(content)) findings.push(`${file}: ${pattern.source}`);
  }
}

if (findings.length) {
  console.error(`Potential committed secrets:\n${findings.join('\n')}`);
  process.exit(1);
}
console.log('Secret scan passed.');
