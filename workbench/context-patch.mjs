import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, realpath, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const CONTEXT_OFFLINE_PATCH = Object.freeze({
  id: 'dsh-context-0.82.2-offline-v1',
  packageName: 'dsh-context',
  version: '0.82.2',
  inputSha256: '45971cf7344cb48f761fa9973dc669940fd67d286871c55414020d191121d9b9',
  outputSha256: '8a5f10cfadfe76cbaebb3e907944696dd6efb6d47efa677ce68e68629abc0066',
});

// These are the two source hooks in the exact npm artifact above, not a general
// minifier rewrite. Refuse any other artifact rather than guessing new symbols.
const UPDATE_HOOK = 'function Au(){return(!Ou||Date.now()-Ou.at>=36e5)&&(Ou={at:Date.now(),promise:(async()=>{for(let e of Du){let t=await ku(e);if(t!==null)return t}return null})()}),Ou.promise}';
const UPDATE_OFFLINE = 'function Au(){return Promise.resolve(null)}';
const PRICE_HOOK = 'let Ys=()=>Ks().providers(),Xs=';
const PRICE_OFFLINE = 'let Ys=()=>Promise.resolve({}),Xs=';

const digest = value => createHash('sha256').update(value).digest('hex');

function ensure(condition, message) {
  if (!condition) throw new Error(`dsh-context offline patch: ${message}`);
}

function within(root, target) {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function regularFile(file) {
  const stat = await lstat(file);
  ensure(stat.isFile() && !stat.isSymbolicLink(), `expected a regular file: ${file}`);
  return stat;
}

export function createOfflineContextClient(original) {
  const bytes = Buffer.from(original);
  ensure(digest(bytes) === CONTEXT_OFFLINE_PATCH.inputSha256, 'unknown original client digest; install the pinned npm artifact');
  let source = bytes.toString('utf8');
  for (const [before, after] of [[UPDATE_HOOK, UPDATE_OFFLINE], [PRICE_HOOK, PRICE_OFFLINE]]) {
    ensure(source.split(before).length === 2, 'the audited client hook must occur exactly once');
    source = source.replace(before, after);
  }
  const output = Buffer.from(source, 'utf8');
  ensure(digest(output) === CONTEXT_OFFLINE_PATCH.outputSha256, 'generated client digest mismatch');
  return output;
}

async function contextPaths({ packageDir, backupRoot } = {}) {
  ensure(typeof packageDir === 'string' && packageDir.length > 0, 'packageDir is required');
  ensure(typeof backupRoot === 'string' && backupRoot.length > 0, 'backupRoot is required');
  const root = await realpath(packageDir);
  ensure((await lstat(root)).isDirectory(), 'packageDir must be a directory');
  const client = path.join(root, 'lib', 'client.js');
  const packageFile = path.join(root, 'package.json');
  const license = path.join(root, 'LICENSE');
  for (const file of [client, packageFile, license]) {
    await regularFile(file);
    ensure(within(root, await realpath(file)), 'package file escapes the package directory');
  }
  const manifest = JSON.parse(await readFile(packageFile, 'utf8'));
  ensure(manifest.name === CONTEXT_OFFLINE_PATCH.packageName && manifest.version === CONTEXT_OFFLINE_PATCH.version,
    'only dsh-context@0.82.2 is supported');
  const requestedBackup = path.resolve(backupRoot);
  ensure(!within(root, requestedBackup), 'backupRoot must be outside the installed package');
  await mkdir(requestedBackup, { recursive: true });
  const backupBase = await realpath(requestedBackup);
  ensure(!within(root, backupBase), 'backupRoot resolves inside the installed package');
  const backupDir = path.join(backupBase, CONTEXT_OFFLINE_PATCH.id, CONTEXT_OFFLINE_PATCH.inputSha256);
  await mkdir(backupDir, { recursive: true });
  ensure((await realpath(backupDir)) === backupDir, 'backup directory must not contain links');
  return { root, client, packageFile, license, backupDir };
}

async function withLock(paths, action) {
  const lock = path.join(paths.backupDir, '.lock');
  try { await mkdir(lock); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('dsh-context offline patch: another operation holds the backup lock; inspect an interrupted deployment before retrying');
    throw error;
  }
  try { return await action(); }
  finally { await rmdir(lock); }
}

async function readClient(paths) {
  await regularFile(paths.client);
  ensure(within(paths.root, await realpath(paths.client)), 'client file escapes the package directory');
  const bytes = await readFile(paths.client);
  return { bytes, sha256: digest(bytes) };
}

async function preserve(source, destination) {
  const original = await readFile(source);
  try { await copyFile(source, destination, constants.COPYFILE_EXCL); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  await regularFile(destination);
  ensure(digest(await readFile(destination)) === digest(original), `backup differs from original: ${path.basename(destination)}`);
}

async function originalBackup(paths) {
  const file = path.join(paths.backupDir, 'client.js.original');
  await regularFile(file);
  const bytes = await readFile(file);
  ensure(digest(bytes) === CONTEXT_OFFLINE_PATCH.inputSha256, 'original backup is corrupt');
  return bytes;
}

async function validateReceipt(paths) {
  const file = path.join(paths.backupDir, 'patch.json');
  await regularFile(file);
  const receipt = JSON.parse(await readFile(file, 'utf8'));
  for (const [key, value] of Object.entries(CONTEXT_OFFLINE_PATCH)) {
    ensure(receipt[key] === value, 'backup receipt does not match this patch');
  }
}

async function replaceClient(paths, bytes, expectedBefore, expectedAfter) {
  const temporary = path.join(path.dirname(paths.client), `.mycodex-context-${randomUUID()}.tmp`);
  const stat = await regularFile(paths.client);
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: stat.mode & 0o777 });
    ensure((await readClient(paths)).sha256 === expectedBefore, 'client changed during deployment');
    // Replacing the directory entry avoids modifying a pnpm hard-linked store file.
    await rename(temporary, paths.client);
    ensure((await readClient(paths)).sha256 === expectedAfter, 'written client digest mismatch');
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

function outcome(paths, status) {
  return { status, ...CONTEXT_OFFLINE_PATCH, backupDir: paths.backupDir };
}

export async function applyContextOfflinePatch(options) {
  const paths = await contextPaths(options);
  return withLock(paths, async () => {
    const current = await readClient(paths);
    if (current.sha256 === CONTEXT_OFFLINE_PATCH.outputSha256) {
      await originalBackup(paths);
      await validateReceipt(paths);
      return outcome(paths, 'already-patched');
    }
    ensure(current.sha256 === CONTEXT_OFFLINE_PATCH.inputSha256, 'unknown installed client digest; refusing to overwrite it');
    const patched = createOfflineContextClient(current.bytes);
    await preserve(paths.client, path.join(paths.backupDir, 'client.js.original'));
    await originalBackup(paths);
    await preserve(paths.packageFile, path.join(paths.backupDir, 'package.json.original'));
    await preserve(paths.license, path.join(paths.backupDir, 'LICENSE.original'));
    const receiptFile = path.join(paths.backupDir, 'patch.json');
    const receipt = Buffer.from(`${JSON.stringify({
      ...CONTEXT_OFFLINE_PATCH,
      changes: ['Disable automatic registry version checks', 'Resolve an empty local price book; unknown prices remain unknown'],
      upstream: 'https://github.com/bowenliang123/dsh-context',
    }, null, 2)}\n`);
    try { await writeFile(receiptFile, receipt, { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    await validateReceipt(paths);
    await replaceClient(paths, patched, CONTEXT_OFFLINE_PATCH.inputSha256, CONTEXT_OFFLINE_PATCH.outputSha256);
    return outcome(paths, 'patched');
  });
}

export async function rollbackContextOfflinePatch(options) {
  const paths = await contextPaths(options);
  return withLock(paths, async () => {
    const current = await readClient(paths);
    if (current.sha256 === CONTEXT_OFFLINE_PATCH.inputSha256) return outcome(paths, 'already-original');
    ensure(current.sha256 === CONTEXT_OFFLINE_PATCH.outputSha256, 'unknown installed client digest; refusing rollback');
    await validateReceipt(paths);
    const original = await originalBackup(paths);
    await replaceClient(paths, original, CONTEXT_OFFLINE_PATCH.outputSha256, CONTEXT_OFFLINE_PATCH.inputSha256);
    return outcome(paths, 'restored');
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  const rollback = args[0] === '--rollback';
  if (rollback) args.shift();
  try {
    ensure(args.length === 2 && !args.some(arg => arg.startsWith('--')), 'usage: node harness/context-patch.mjs [--rollback] <packageDir> <backupRoot>');
    const result = await (rollback ? rollbackContextOfflinePatch : applyContextOfflinePatch)({ packageDir: args[0], backupRoot: args[1] });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
