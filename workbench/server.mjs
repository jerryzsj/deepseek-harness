import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { macKeyStore } from './key-store.mjs';
import { DEEPSEEK_API, startRelay, validateKey, validKey } from './relay.mjs';
import { prepareProfile, readDefaultWorkspace } from './profile.mjs';
import { CONTEXT_OFFLINE_PATCH } from './context-patch.mjs';

export const PROJECT = fileURLToPath(new URL('..', import.meta.url));
export const DEFAULT_STATE = process.env.HARNESS_STATE ?? path.join(PROJECT, 'workbench/.state');
export const DEFAULT_RUNTIME = process.env.HARNESS_RUNTIME ?? path.join(PROJECT, 'workbench/runtime');
const assets = new Map([['/', ['setup.html', 'text/html; charset=utf-8']], ['/setup.js', ['setup.js', 'text/javascript; charset=utf-8']], ['/setup.css', ['setup.css', 'text/css; charset=utf-8']]]);

function sameToken(actual, expected) {
  return typeof actual === 'string' && /^[a-f0-9]{64}$/.test(actual) && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

async function readJSON(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) throw new Error('需要 JSON 请求。');
  const parts = []; let length = 0;
  for await (const part of request) { length += part.length; if (length > 16384) throw new Error('请求内容过长。'); parts.push(part); }
  let value; try { value = JSON.parse(Buffer.concat(parts)); } catch { throw new Error('请求需要有效 JSON。'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求格式无效。');
  return value;
}

async function atomicJSON(filename, value) {
  const temporary = `${filename}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
  await rename(temporary, filename);
}

export function defaultWorkspace() {
  return process.env.HARNESS_WORKSPACE ?? path.join(os.homedir(), 'HarnessWorkspace');
}

async function openWindow(url) {
  const application = process.env.HARNESS_APP ?? path.join(PROJECT, 'workbench/native-mac/build/Harness.app');
  if (await access(application).then(() => true, () => false)) {
    const child = spawn('/usr/bin/open', ['-a', application, '--args', '--attach', url], { detached: true, stdio: 'ignore' });
    await once(child, 'spawn'); child.unref(); return;
  }
  const child = spawn('/usr/bin/open', [url], { detached: true, stdio: 'ignore' });
  await once(child, 'spawn'); child.unref();
}

function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  child.kill('SIGTERM');
  return Promise.race([once(child, 'exit'), delay(5000).then(() => { if (child.exitCode === null) child.kill('SIGKILL'); })]);
}

async function runHarness({ key, workspace, stateRoot, runtime, upstream, onExit, signal }) {
  if (signal?.aborted) throw new Error('工作台启动已取消。');
  const packageDir = path.join(runtime, 'node_modules/dsh-context');
  const context = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'));
  const clientHash = createHash('sha256').update(await readFile(path.join(packageDir, 'lib/client.js'))).digest('hex');
  if (context.version !== CONTEXT_OFFLINE_PATCH.version || clientHash !== CONTEXT_OFFLINE_PATCH.outputSha256) {
    throw new Error('上下文插件离线补丁缺失或已改变，请重新运行安装脚本。');
  }
  const version = JSON.parse(await readFile(path.join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version;
  if (version !== '0.2.2-rc.1') throw new Error('Harness 版本不匹配，请重新运行安装脚本。');
  const relay = await startRelay({ key, upstream, upstreamAllowlist: process.env.HARNESS_UPSTREAM_ALLOWLIST });
  let child; let output = '';
  try {
    const profile = await prepareProfile({ home: path.join(stateRoot, 'home'), runtime, relayBaseURL: relay.baseURL, relayToken: relay.token, workspace });
    child = spawn(process.execPath, [path.join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), ...profile.args],
      { cwd: profile.cwd, env: profile.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let launchError;
    const append = data => { output = (output + stripVTControlCharacters(data.toString())).slice(-512 * 1024); };
    child.stdout.on('data', append); child.stderr.on('data', append); child.once('error', error => { launchError = error; });
    const deadline = Date.now() + 60000; let url;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('工作台启动已取消。');
      if (launchError || child.exitCode !== null) throw new Error('Harness 启动失败，请检查依赖和本机日志。');
      if (/dsh-context[\s\S]{0,240}(?:failed to import|ERR_MODULE_NOT_FOUND)|(?:failed to import|ERR_MODULE_NOT_FOUND)[^\n]{0,240}dsh-context/i.test(output)) {
        throw new Error('上下文插件加载失败，请重新运行安装脚本。');
      }
      url = /http:\/\/127\.0\.0\.1:\d+\/?\?token=[^\s]+/.exec(output)?.[0];
      if (url) break;
      await delay(100);
    }
    if (!url) throw new Error('Harness 启动超时，请检查安装及工作区设置。');
    let closed = false;
    const saveLog = () => writeFile(path.join(stateRoot, 'host.log'), output.replace(/([?&]token=)[^\s]+/g, '$1[REDACTED]').replaceAll(key, '[REDACTED]')).catch(() => {});
    child.once('exit', () => { if (!closed) { closed = true; void relay.close(); void saveLog(); onExit?.(); } });
    return { url, async close() { if (closed) return; closed = true; await terminate(child); await relay.close(); await saveLog(); } };
  } catch (error) {
    if (child) await terminate(child); await relay.close();
    await writeFile(path.join(stateRoot, 'host.log'), output.replace(/([?&]token=)[^\s]+/g, '$1[REDACTED]').replaceAll(key, '[REDACTED]')).catch(() => {});
    throw error;
  }
}

async function checkedWorkspace(requested) {
  if (typeof requested !== 'string' || !path.isAbsolute(requested) || /\p{Cc}/u.test(requested)) throw new Error('请填写项目文件夹的完整路径。');
  const absolute = path.resolve(requested);
  const within = (root, target) => { const relative = path.relative(root, target); return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)); };
  if (absolute === path.parse(absolute).root) throw new Error('请选择独立项目文件夹，避免使用磁盘根目录。');
  if (within(await realpath(PROJECT), absolute) || within(absolute, await realpath(PROJECT))) throw new Error('请选择应用目录之外的独立项目文件夹。');
  const info = await lstat(absolute).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error('项目工作区需要普通文件夹，不能使用目录链接。');
  await mkdir(absolute, { recursive: true });
  const physical = await realpath(absolute);
  const application = await realpath(PROJECT);
  if (within(application, physical) || within(physical, application)) throw new Error('请选择应用目录之外的独立项目文件夹。');
  return physical;
}

export async function startWorkbench({ stateRoot = DEFAULT_STATE, runtime = DEFAULT_RUNTIME, keyStore, upstream = process.env.HARNESS_UPSTREAM ?? DEEPSEEK_API, hostFactory = runHarness } = {}) {
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  keyStore ??= macKeyStore(stateRoot);
  const token = randomBytes(32).toString('hex');
  const preferences = path.join(stateRoot, 'preferences.json');
  let saved = {};
  try { saved = JSON.parse(await readFile(preferences, 'utf8')); }
  catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
  let workspace = typeof saved.workspace === 'string' ? saved.workspace : defaultWorkspace();
  let key = null; let remembered = false; let host = null; let error = ''; let busy = false; let closing = false; let origin; let workspaceLocked = false; let pendingLaunch = null; let launchAbort = null; let closePromise = null;
  async function refreshWorkspace() {
    try { await access(path.join(stateRoot, 'home/storages/workspace.json')); workspaceLocked = true; const actual = readDefaultWorkspace(path.join(stateRoot, 'home')); if (actual) workspace = actual; } catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
  }
  await refreshWorkspace();
  try { key = await keyStore.load(); remembered = Boolean(key); } catch { error = '读取已保存 Key 失败，请重新输入。'; }
  const status = () => ({ app: 'mycodex-harness-workbench', ready: Boolean(host), busy, keySaved: remembered, keyAvailable: Boolean(key), workspace, workspaceLocked, error, url: host?.url ?? null, model: 'deepseek-flash', gateway: upstream });
  async function stop() { const previous = host; host = null; await previous?.close(); }
  async function launch(nextKey, nextWorkspace) {
    if (closing) throw new Error('本机工作台正在关闭。');
    const abort = new AbortController(); launchAbort = abort;
    const operation = (async () => {
      const absolute = await checkedWorkspace(nextWorkspace);
      await stop();
      if (closing || abort.signal.aborted) throw new Error('工作台启动已取消。');
      const next = await hostFactory({ key: nextKey, workspace: absolute, stateRoot, runtime, upstream, signal: abort.signal, onExit: () => { host = null; error = 'Harness 已退出，可在此重新启动。'; } });
      if (closing || abort.signal.aborted) { await next.close(); throw new Error('工作台启动已取消。'); }
      host = next; key = nextKey; workspace = absolute; error = '';
      await refreshWorkspace();
      await atomicJSON(preferences, { workspace });
    })();
    pendingLaunch = operation;
    try { await operation; } finally { if (pendingLaunch === operation) pendingLaunch = null; if (launchAbort === abort) launchAbort = null; }
  }
  const server = createServer(async (request, response) => {
    const json = (code, value) => { if (response.destroyed || response.writableEnded) return; response.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); };
    if (request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin) || request.headers['sec-fetch-site'] === 'cross-site') return json(403, { error: '本机设置入口来源无效。' });
    const asset = assets.get(request.url);
    if (request.method === 'GET' && asset) {
      let content; try { content = await readFile(new URL(`./${asset[0]}`, import.meta.url)); } catch { return json(500, { error: '本机设置页面资源不完整，请重新安装。' }); }
      response.writeHead(200, { 'content-type': asset[1], 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" });
      return response.end(content);
    }
    if (!sameToken(request.headers['x-mycodex-setup'], token)) return json(401, { error: '请从本机启动器重新打开设置。' });
    if (closing) return json(503, { error: '本机工作台正在关闭。' });
    if (request.method === 'GET' && request.url === '/api/status') return json(200, status());
    if (request.method !== 'POST') return json(404, { error: '未知设置接口。' });
    if (busy) return json(409, { error: '另一项设置操作尚未完成，请稍候。' });
    busy = true;
    try {
      const body = await readJSON(request);
      if (request.url === '/api/connect') {
        const supplied = typeof body.key === 'string' && body.key.trim() ? validKey(body.key.trim()) : key;
        if (!supplied) throw new Error('请先输入 DeepSeek API Key。');
        if (typeof body.workspace !== 'string' || !body.workspace.trim() || typeof body.remember !== 'boolean') throw new Error('工作区和保存选项无效。');
        const nextWorkspace = await checkedWorkspace(body.workspace.trim());
        if (workspaceLocked && path.relative(workspace, nextWorkspace) !== '') throw new Error('初始项目已建立。其它项目请在 Harness 工作台的侧栏中选择或添加。');
        if (body.key?.trim()) await validateKey(supplied, { upstream, upstreamAllowlist: process.env.HARNESS_UPSTREAM_ALLOWLIST });
        if (closing) throw new Error('本机工作台正在关闭。');
        if (body.remember) { await keyStore.save(supplied); remembered = true; }
        else { await keyStore.delete(); remembered = false; }
        key = supplied;
        await launch(supplied, nextWorkspace);
        return json(200, status());
      }
      if (request.url === '/api/forget') { await stop(); await keyStore.delete(); key = null; remembered = false; error = ''; return json(200, status()); }
      if (request.url === '/api/stop') { await stop(); return json(200, status()); }
      return json(404, { error: '未知设置接口。' });
    } catch (failure) { error = failure instanceof Error ? failure.message : '本机操作失败。'; return json(400, { error }); }
    finally { busy = false; }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  const url = `${origin}/#${token}`;
  const signalClose = () => void close();
  async function close() {
    if (closePromise) return closePromise;
    closing = true; launchAbort?.abort();
    process.removeListener('SIGINT', signalClose); process.removeListener('SIGTERM', signalClose);
    closePromise = (async () => {
      const stoppedServer = new Promise(resolve => server.close(resolve)); server.closeAllConnections();
      try { await pendingLaunch; } catch (_launchFailed) {
        // The launch caller reports its failure; shutdown still owns host cleanup.
      }
      await stop(); await stoppedServer;
    })();
    return closePromise;
  }
  process.once('SIGINT', signalClose); process.once('SIGTERM', signalClose);
  if (key) { busy = true; try { await launch(key, workspace); } catch (failure) { error = failure.message; } finally { busy = false; } }
  if (closing) { await close(); throw new Error('工作台启动已取消。'); }
  return { url, origin, status, close, async saveLauncher() { await atomicJSON(path.join(stateRoot, 'launcher.json'), { pid: process.pid, url }); } };
}

async function existingController() {
  let record;
  try { record = await readFile(path.join(DEFAULT_STATE, 'launcher.json'), 'utf8'); }
  catch (failure) { if (failure.code === 'ENOENT') return null; throw failure; }
  const old = JSON.parse(record);
  const parsed = new URL(old.url);
  if (parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' && parsed.hash) {
    let response;
    try {
      response = await fetch(`${parsed.origin}/api/status`, { headers: { 'x-mycodex-setup': parsed.hash.slice(1) }, redirect: 'error', signal: AbortSignal.timeout(1500) });
    } catch (failure) {
      if (failure.cause?.code === 'ECONNREFUSED') return null;
      throw failure;
    }
    const previous = await response.json();
    if (response.ok && previous.app === 'mycodex-harness-workbench' && previous.ready) return previous.url;
    if (response.ok && previous.app === 'mycodex-harness-workbench') return old.url;
  }
  return null;
}

async function main() {
  const attachOnly = process.argv.includes('--attach');
  const noOpen = process.argv.includes('--no-open');
  if (attachOnly) {
    const running = await existingController();
    if (running) { if (!noOpen) await openWindow(running); return; }
    console.log('没有正在运行的工作台，正在启动新的工作台。');
  }
  const app = await startWorkbench();
  try {
    await app.saveLauncher();
    if (!noOpen) await openWindow(app.status().ready ? app.status().url : app.url);
  } catch (error) { await app.close(); throw error; }
  console.log('Harness 本机工作台服务已启动。');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Harness 启动失败：${error.message}`); process.exitCode = 1; });
}