import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { CONTEXT_OFFLINE_PATCH } from './context-patch.mjs';

export const PROFILE_NAME = 'mycodex-deepseek';
export const RUNTIME_VERSION = '0.2.2-rc.1';
export const CONTEXT_VERSION = '0.82.2';
export const TOKEN_REFERENCE = 'MYCODEX_HARNESS_RELAY_TOKEN';
const BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-context'];
const DISABLED = [
  'llm-deepseek', 'llm-deepseek-account', 'deepseek-account', 'account-controller', 'ui-settings-account',
  'plugin-package-inventory-deepseek', 'session-telemetry-otel', 'desktop-product-telemetry', 'product-analytics',
  'command-feedback', 'message-feedback', 'ui-message-feedback', 'web-search-deepseek',
];

function absoluteDirectory(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /\p{Cc}/u.test(value)) throw new Error(`${label} must be an absolute directory.`);
  const result = path.resolve(value);
  if (result === path.parse(result).root) throw new Error(`${label} cannot be a filesystem root.`);
  return result;
}

function directory(filename) {
  if (existsSync(filename)) {
    const info = lstatSync(filename);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Managed Harness directories must be ordinary directories.');
  } else mkdirSync(filename, { recursive: true, mode: 0o700 });
}

function writeManaged(filename, text) {
  if (existsSync(filename)) {
    const info = lstatSync(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Managed Harness files cannot be linked.');
    if (readFileSync(filename, 'utf8') === text) return;
  }
  const temporary = `${filename}.${randomUUID()}.tmp`;
  writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
  renameSync(temporary, filename);
}

function relayURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port ||
      url.username || url.password || url.search || url.hash || url.pathname.replace(/\/+$/, '') !== '/v1') {
    throw new Error('Harness models require the managed IPv4 loopback relay /v1 endpoint.');
  }
  return url.href.replace(/\/+$/, '');
}

function token(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{24,256}$/.test(value)) throw new Error('Harness requires a random short-lived relay token.');
  return value;
}

function physicalLocation(value) {
  const parts = [];
  let ancestor = value;
  while (!existsSync(ancestor)) {
    parts.unshift(path.basename(ancestor));
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error('Could not resolve managed Harness directory.');
    ancestor = parent;
  }
  return path.join(realpathSync.native(ancestor), ...parts);
}

function overlaps(left, right) {
  return left === right || left.startsWith(right + path.sep) || right.startsWith(left + path.sep);
}

function within(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveCorePackage(profile, home, runtime, name, version) {
  const installed = path.join(runtime, 'node_modules', ...name.split('/'));
  const filename = path.join(profile, 'node_modules', ...name.split('/'));
  directory(path.join(profile, 'node_modules'));
  if (name.startsWith('@')) directory(path.dirname(filename));
  if (!lstatSync(filename, { throwIfNoEntry: false })) symlinkSync(installed, filename, 'dir');
  const actual = physicalLocation(filename);
  const expected = physicalLocation(installed);
  if (actual !== expected && !within(physicalLocation(profile), actual)) {
    throw new Error(`Required Harness package ${name} links outside its managed installation.`);
  }
  const manifest = JSON.parse(readFileSync(path.join(filename, 'package.json'), 'utf8'));
  if (manifest.name !== name || manifest.version !== version) throw new Error(`Required Harness package ${name}@${version} changed; restore its pinned version.`);
  if (actual === expected) return;
  const upstream = JSON.parse(readFileSync(path.join(installed, 'package.json'), 'utf8'));
  const patches = upstream.dsh?.bundle?.patch;
  for (const patch of typeof patches === 'string' ? [patches] : patches || []) {
    if (typeof patch !== 'string' || path.isAbsolute(patch) || patch.split(/[\\/]/).includes('..') ||
        !readFileSync(path.join(filename, patch)).equals(readFileSync(path.join(installed, patch)))) {
      throw new Error(`Required Harness package ${name} differs from its pinned bundle.`);
    }
  }
  if (name === 'dsh-context') {
    const client = path.join(filename, 'lib', 'client.js');
    const digest = value => createHash('sha256').update(value).digest('hex');
    const expectedDigest = digest(readFileSync(path.join(installed, 'lib', 'client.js')));
    if (digest(readFileSync(client)) !== expectedDigest) throw new Error('The profile Context client differs from the audited offline runtime.');
  }
}

function profileManifest(profile) {
  const filename = path.join(profile, 'package.json');
  if (!existsSync(filename)) return {};
  const info = lstatSync(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('The profile manifest must be an ordinary file.');
  const saved = JSON.parse(readFileSync(filename, 'utf8'));
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  if (!object(saved) || (saved.dependencies !== undefined && !object(saved.dependencies)) ||
      (saved.dsh !== undefined && !object(saved.dsh)) || (saved.dsh?.profile !== undefined && !object(saved.dsh.profile)) ||
      (saved.dsh?.profile?.bundles !== undefined && (!Array.isArray(saved.dsh.profile.bundles) || !saved.dsh.profile.bundles.every(name => typeof name === 'string' && name)))) {
    throw new Error('The profile manifest has an unsupported shape.');
  }
  return saved;
}

/** Read only the native Workspace v2 registry; never import Session or credential stores. */
export function readDefaultWorkspace(home) {
  home = absoluteDirectory(home, 'home');
  const filename = path.join(home, 'storages', 'workspace.json');
  if (!existsSync(filename)) return null;
  const info = lstatSync(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 8 * 1024 * 1024) {
    throw new Error('The Harness workspace registry must be an ordinary bounded JSON file.');
  }
  const record = JSON.parse(readFileSync(filename, 'utf8'));
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!object(record) || record.unit?.name !== 'workspace' || record.unit?.version !== 2 ||
      !object(record.global) || !Array.isArray(record.global.workspaceIds) ||
      !record.global.workspaceIds.every(id => typeof id === 'string') || !object(record.tables?.workspaces)) {
    throw new Error('The Harness workspace registry has an unsupported schema.');
  }
  const id = record.global.defaultWorkspaceId;
  if (id === undefined) return null;
  if (typeof id !== 'string' || !id) throw new Error('The Harness default workspace identity is invalid.');
  if (!Object.hasOwn(record.tables.workspaces, id)) return null;
  const workspace = record.tables.workspaces[id];
  if (!object(workspace) || !record.global.workspaceIds.includes(id)) throw new Error('The Harness default workspace record is invalid.');
  return absoluteDirectory(workspace.path, 'default workspace');
}

/** Keep application/provider credentials, preload hooks and proxy settings out of the host. */
export function childEnvironment({ home, runtime, relayToken, source = process.env }) {
  home = absoluteDirectory(home, 'home');
  const allowed = new Set(['LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM', 'SHELL', 'USER', 'LOGNAME']);
  const env = {};
  for (const [name, value] of Object.entries(source)) {
    if (allowed.has(name.toUpperCase()) && typeof value === 'string') env[name] = value;
  }
  const inheritedPath = Object.entries(source).find(([name]) => name.toUpperCase() === 'PATH')?.[1] || '';
  const paths = [path.dirname(process.execPath), ...inheritedPath.split(path.delimiter)]
    .filter(candidate => candidate && path.isAbsolute(candidate));
  env.PATH = [...new Map(paths.map(candidate => [candidate, candidate])).values()].join(path.delimiter);
  const user = path.join(home, 'user');
  Object.assign(env, {
    HOME: user,
    XDG_CONFIG_HOME: path.join(user, 'config'), XDG_DATA_HOME: path.join(user, 'data'),
    XDG_CACHE_HOME: path.join(user, 'cache'), XDG_STATE_HOME: path.join(user, 'state'),
    TMPDIR: path.join(home, 'tmp'),
    DSH_HOME: home, DSH_AGENTS_HOME: path.join(home, 'agents'), DSH_PERMISSION_MODE: 'workspace-write',
    [TOKEN_REFERENCE]: token(relayToken), NO_PROXY: '127.0.0.1,localhost,::1', NODE_ENV: 'production',
    DO_NOT_TRACK: '1', npm_config_ignore_scripts: 'true',
    DSH_RUNTIME_ROOT: absoluteDirectory(runtime, 'runtime'),
  });
  return env;
}

/** Prepare the dedicated persistent profile. Never point this at an existing user Harness home. */
export async function prepareProfile({ home, runtime, relayBaseURL, relayToken, workspace }) {
  home = absoluteDirectory(home, 'home');
  runtime = absoluteDirectory(runtime, 'runtime');
  workspace = absoluteDirectory(workspace, 'workspace');
  const baseURL = relayURL(relayBaseURL);
  token(relayToken);
  const workspaceLocation = physicalLocation(workspace);
  if (overlaps(workspaceLocation, physicalLocation(home)) || overlaps(workspaceLocation, physicalLocation(runtime))) {
    throw new Error('Workspace must be separate from the Harness profile and runtime.');
  }
  for (const [name, version] of [['@deepseek-ai/dsh', RUNTIME_VERSION], ...BUNDLES.map(name => [name, name === 'dsh-context' ? CONTEXT_VERSION : RUNTIME_VERSION])]) {
    const manifest = JSON.parse(readFileSync(path.join(runtime, 'node_modules', ...name.split('/'), 'package.json'), 'utf8'));
    if (manifest.name !== name || manifest.version !== version) throw new Error(`Install the pinned ${name}@${version} runtime first.`);
  }
  directory(home);
  const marker = path.join(home, '.mycodex-managed-home.json');
  if (existsSync(marker)) {
    const saved = JSON.parse(readFileSync(marker, 'utf8'));
    if (saved.profile !== PROFILE_NAME || saved.version !== 1) throw new Error('This Harness home belongs to a different installation.');
  } else if (readdirSync(home).length) {
    throw new Error('Refusing to import an existing unmanaged Harness home. Choose a new dedicated home.');
  }
  writeManaged(marker, JSON.stringify({ version: 1, profile: PROFILE_NAME }) + '\n');
  const cwd = path.join(home, 'boot');
  const profile = path.join(home, 'profiles', PROFILE_NAME);
  for (const folder of [cwd, path.join(home, 'profiles'), profile, path.join(home, 'tmp'), path.join(home, 'agents'), path.join(home, 'user')]) directory(folder);
  for (const filename of [path.join(home, '.env'), path.join(cwd, '.env'), path.join(home, 'user', '.env'), path.join(home, 'cordis.patch.yml')]) {
    if (existsSync(filename)) throw new Error('The managed Harness home must not import dotenv or home-level plugin overlays.');
  }
  directory(workspace);
  workspace = realpathSync.native(workspace);
  const saved = profileManifest(profile);
  const manifest = { ...saved, name: PROFILE_NAME, private: true,
    dsh: { ...saved.dsh, profile: { ...saved.dsh?.profile, bundles: [...new Set([...BUNDLES, ...(saved.dsh?.profile?.bundles || [])])] } },
    dependencies: { ...saved.dependencies, ...Object.fromEntries(BUNDLES.map(name => [name, name === 'dsh-context' ? CONTEXT_VERSION : RUNTIME_VERSION])) },
  };
  writeManaged(path.join(profile, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  for (const name of BUNDLES) resolveCorePackage(profile, home, runtime, name, name === 'dsh-context' ? CONTEXT_VERSION : RUNTIME_VERSION);
  writeManaged(path.join(profile, 'cordis.yml'), '[]\n');
  if (!existsSync(path.join(profile, 'cordis.patch.yml'))) writeManaged(path.join(profile, 'cordis.patch.yml'), '[]\n');
  const bootstrap = path.join(profile, 'workspace-bootstrap.mjs');
  writeManaged(bootstrap, `export const name = 'mycodex-workspace-bootstrap';\nexport const inject = ['workspaceRegistry'];\nexport async function apply(ctx) {\n  await ctx.workspaceRegistry.initializeDefault(async () => ${JSON.stringify(workspace)});\n  await ctx.workspaceRegistry.create(${JSON.stringify(workspace)});\n}\n`);
  // Official DeepSeek Responses supports none/low/high/max. Off must explicitly send none.
  // https://api-docs.deepseek.com/guides/thinking_mode/
  const reasoningEfforts = { off: 'none', low: 'low', high: 'high', max: 'max' };
  const models = [
    { id: 'deepseek-flash', name: 'DeepSeek Flash', input: ['text', 'image'] },
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', input: ['text'] },
  ].map(model => ({ ...model, contextWindow: 1000000, maxTokens: 32768, reasoningEfforts }));
  const rows = [
    { id: 'agent-default-model', config: { provider: 'mycodex-deepseek', model: 'deepseek-flash', reasoningEffort: 'high' } },
    { id: 'llm-pi-ai', config: { providers: { 'mycodex-deepseek': {
      api: 'openai-responses', apiKeyEnv: TOKEN_REFERENCE, baseURL, displayName: 'DeepSeek via local relay',
      defaultContextWindow: 1000000, defaultMaxTokens: 32768, models, reasoning: 'high', transport: 'sse',
      compat: { supportsDeveloperRole: false, supportsMaxOutputTokens: true },
    } } } },
    ...DISABLED.map(id => ({ id, disabled: true })),
    { insert: [{ id: 'mycodex-workspace-bootstrap', name: pathToFileURL(bootstrap).href }] },
  ];
  const patchPath = path.join(profile, 'deployment.patch.yml');
  writeManaged(patchPath, JSON.stringify(rows, null, 2) + '\n');
  return { profileName: PROFILE_NAME, patchPath, cwd, workspace,
    args: ['--profile', PROFILE_NAME, '--patch', patchPath, '--host', '127.0.0.1', '--port', '0', '--no-open'],
    env: childEnvironment({ home, runtime, relayToken }),
  };
}