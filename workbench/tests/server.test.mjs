import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { startWorkbench } from '../server.mjs';

test('a fresh workbench starts without saved preferences', async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'dsh-workbench-state-'));
  let app;
  try {
    app = await startWorkbench({
      stateRoot,
      keyStore: { async load() { return null; } },
    });
    const response = await fetch(app.origin, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    await response.body.cancel();
    assert.equal(app.status().keyAvailable, false);
  } finally {
    await app?.close();
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test('corrupt preferences stop startup instead of selecting another workspace', async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'dsh-workbench-state-'));
  let app;
  try {
    await writeFile(path.join(stateRoot, 'preferences.json'), '{invalid');
    await assert.rejects(async () => {
      app = await startWorkbench({
        stateRoot,
        keyStore: { async load() { return null; } },
      });
    }, SyntaxError);
  } finally {
    await app?.close();
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test('corrupt launcher records fail without starting a second controller', async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'dsh-workbench-state-'));
  try {
    await writeFile(path.join(stateRoot, 'launcher.json'), '{invalid');
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL('../server.mjs', import.meta.url)), '--attach', '--no-open',
    ], {
      env: { ...process.env, HARNESS_STATE: stateRoot },
      encoding: 'utf8',
      timeout: 20000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Harness 启动失败/);
    assert.doesNotMatch(result.stdout, /服务已启动/);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});
