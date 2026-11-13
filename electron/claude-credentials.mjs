import { safeStorage } from 'electron';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { verifyClaudeKey } from './claude-api.mjs';
import { secureStorageAvailable } from './secure-storage.mjs';

const validKey = key => typeof key === 'string' && /^[!-~]{10,2048}$/u.test(key);

export class ClaudeCredentials {
  #operations = Promise.resolve();

  constructor(filename) {
    this.filename = filename;
  }

  async status() {
    const secureStorage = await secureStorageAvailable();
    const info = await lstat(this.filename).catch(() => null);
    return { configured: secureStorage && info?.isFile() === true, secureStorage };
  }

  #serialize(operation) {
    const result = this.#operations.then(operation);
    this.#operations = result.catch(() => {});
    return result;
  }

  save(input) {
    const key = typeof input === 'string' ? input.trim() : '';
    if (!validKey(key)) throw new Error('Enter a Claude API key.');
    return this.#serialize(async () => {
      if (!(await secureStorageAvailable()))
        throw new Error('Secure credential storage is unavailable.');
      await verifyClaudeKey(key);
      const temporary = `${this.filename}.${randomUUID()}.tmp`;
      try {
        const encrypted = await safeStorage.encryptStringAsync(key);
        if (encrypted.includes(key)) throw new Error();
        await mkdir(path.dirname(this.filename), { recursive: true });
        await writeFile(temporary, encrypted, { flag: 'wx', mode: 0o600 });
        await rename(temporary, this.filename);
      } catch {
        throw new Error('Could not save the key using secure credential storage.');
      } finally {
        await rm(temporary, { force: true }).catch(() => {});
      }
      return { configured: true, secureStorage: true };
    });
  }

  remove() {
    return this.#serialize(async () => {
      await rm(this.filename, { force: true }).catch(() => {
        throw new Error('Could not remove the saved Claude key.');
      });
      return this.status();
    });
  }

  async key() {
    if (!(await secureStorageAvailable()))
      throw new Error('Secure credential storage is unavailable.');
    let handle;
    try {
      handle = await open(
        this.filename,
        constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0),
      );
      const info = await handle.stat();
      if (!info.isFile() || info.size > 8192) throw new Error();
      const buffer = Buffer.alloc(8193);
      const { bytesRead } = await handle.read(buffer);
      if (bytesRead !== info.size) throw new Error();
      const encrypted = buffer.subarray(0, bytesRead);
      const { result } = await safeStorage.decryptStringAsync(encrypted);
      if (!validKey(result) || encrypted.includes(result)) throw new Error();
      return result;
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('Add an API key in Claude settings first.');
      throw new Error('Could not unlock the saved Claude key. Replace it in Claude settings.');
    } finally {
      await handle?.close().catch(() => {});
    }
  }
}
