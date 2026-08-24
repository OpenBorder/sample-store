import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';

async function availableLoopbackPort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  assert(address && typeof address !== 'string');
  const port = address.port;
  probe.close();
  await once(probe, 'close');
  return port;
}

test('local server starts with only Test keys and stays on loopback', async (context) => {
  const port = await availableLoopbackPort();
  const child = spawn(path.resolve('node_modules/.bin/tsx'), ['server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      DEMO_TRANSACTION_CAP: '',
      OB_SECRET_KEY: 'sk_test_local_tutorial',
      OB_PUBLISHABLE_KEY: 'pk_test_local_tutorial',
      DATABASE_URL: '',
      OB_WEBHOOK_SECRET: '',
      ORDER_REFERENCE_HMAC_SECRET: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  context.after(() => child.kill('SIGTERM'));

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const started = await new Promise<string>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(
      () => reject(new Error(`Local tutorial server did not start. ${stderr}`.trim())),
      5_000,
    );
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.includes('Sample store on')) {
        clearTimeout(timeout);
        resolve(stdout);
      }
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Local tutorial server exited with code ${code}. ${stderr}`.trim()));
    });
  });

  assert.match(started, new RegExp(`Sample store on http://127\\.0\\.0\\.1:${port}`));
  const config = await fetch(`http://127.0.0.1:${port}/config.js`);
  assert.equal(config.status, 200);
  const body = await config.text();
  assert.match(body, /"transactionsEnabled":true/);
  assert.match(body, /pk_test_local_tutorial/);
  assert.doesNotMatch(body, /sk_test_local_tutorial/);
});
