import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

interface LockEntry {
  resolved?: string;
}

test('Open Border dependencies use only the anonymous public npm registry', async () => {
  const [manifestSource, lockSource] = await Promise.all([
    readFile(join(process.cwd(), 'package.json'), 'utf8'),
    readFile(join(process.cwd(), 'package-lock.json'), 'utf8'),
  ]);
  const manifest = JSON.parse(manifestSource) as { dependencies: Record<string, string> };
  const lock = JSON.parse(lockSource) as { packages: Record<string, LockEntry> };

  const openBorderDependencies = Object.keys(manifest.dependencies).filter((name) =>
    /^@open-?border\//.test(name),
  );
  assert.deepEqual(openBorderDependencies, ['@open-border/node']);

  for (const forbidden of [
    'npm.pkg.github.com',
    'NODE_AUTH_TOKEN',
    'NPM_TOKEN',
    'github.com/OpenBorder/payments',
    'node_modules/@openborder/',
  ]) {
    assert.equal(lockSource.includes(forbidden), false, `lockfile must not contain ${forbidden}`);
  }

  const publicPackages = Object.entries(lock.packages).filter(([path]) =>
    path.startsWith('node_modules/@open-border/'),
  );
  assert.ok(publicPackages.length > 0);
  for (const [path, entry] of publicPackages) {
    assert.match(
      entry.resolved ?? '',
      /^https:\/\/registry\.npmjs\.org\/@open-border\//,
      `${path} must resolve from the public npm registry`,
    );
  }
});
