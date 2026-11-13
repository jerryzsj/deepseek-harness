import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validKey } from './relay.mjs';

const ALGORITHM = 'aes-256-gcm';

async function ordinaryDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('凭据目录需要普通文件夹。');
  await chmod(directory, 0o700);
}

async function ordinaryFile(filename) {
  const info = await lstat(filename).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('凭据文件需要普通文件。');
  return info;
}

async function atomicWrite(filename, bytes) {
  const temporary = `${filename}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, filename);
}

/**
 * AES-256-GCM record with a per-installation key file. The key protects the
 * record through file permissions only; it is not a system credential store.
 */
export function macKeyStore(stateRoot) {
  const directory = path.join(stateRoot, 'secrets');
  const record = path.join(directory, 'deepseek-key.bin');
  const keyFile = path.join(directory, 'credential-cache.key');

  async function readKey() {
    if (await ordinaryFile(keyFile)) {
      const key = await readFile(keyFile);
      if (key.length !== 32) throw new Error('本机凭据密钥长度不正确，请重新输入 Key。');
      return key;
    }
    const key = randomBytes(32);
    await atomicWrite(keyFile, key);
    return key;
  }

  return {
    async load() {
      const info = await ordinaryFile(record);
      if (!info) return null;
      if (info.size > 1024 * 1024) throw new Error('凭据记录过大，请重新输入 Key。');
      const payload = JSON.parse(await readFile(record, 'utf8'));
      if (payload?.version !== 1 || typeof payload.iv !== 'string' || typeof payload.tag !== 'string' || typeof payload.data !== 'string') {
        throw new Error('凭据记录格式不受支持，请重新输入 Key。');
      }
      const key = await readKey();
      let plain;
      try {
        const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(payload.iv, 'base64'));
        decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
        plain = Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]);
      } catch { throw new Error('凭据记录无法解密，请重新输入 Key。'); }
      return validKey(plain.toString('utf8'));
    },
    async save(key) {
      validKey(key);
      await ordinaryDirectory(directory);
      const encryptionKey = await readKey();
      const iv = randomBytes(12);
      const cipher = createCipheriv(ALGORITHM, encryptionKey, iv);
      const data = Buffer.concat([cipher.update(key, 'utf8'), cipher.final()]);
      await atomicWrite(record, JSON.stringify({
        version: 1,
        createdAt: new Date().toISOString(),
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        data: data.toString('base64'),
      }, null, 2));
    },
    async delete() {
      await ordinaryDirectory(directory);
      const { rm } = await import('node:fs/promises');
      await rm(record, { force: true });
    },
  };
}