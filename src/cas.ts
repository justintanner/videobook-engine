import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  constants,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import * as path from "node:path";

import { v7 as uuidv7 } from "uuid";

import type { ContentStore } from "./engine-types.js";

export interface StoredObject {
  hash: string;
  size: number;
  path: string;
}

/**
 * Local content-addressed store with an optional remote ContentStore.
 *
 * Objects are content-immutable (a hash always names the same bytes) but no
 * longer undeletable: `deleteLocal` and `unpublish` support the forgettable
 * data policy. Deleting an object that versioned rows still reference turns
 * those rows into tombstones — the `objects` table keeps hash + size and
 * reads surface OBJECT_UNAVAILABLE through `ensureLocal`.
 */
export class ObjectStore {
  readonly root: string;
  readonly prefix: string;

  constructor(
    root: string,
    private readonly remote?: ContentStore,
    prefix = "superlzy-media/videobook/sha256",
    private readonly isForgotten?: (hash: string) => boolean,
  ) {
    this.root = root;
    this.prefix = prefix.replace(/^\/+|\/+$/g, "");
  }

  async put(data: Buffer | string): Promise<StoredObject> {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const hash = createHash("sha256").update(buffer).digest("hex");
    const destination = this.pathFor(hash);
    await mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.${uuidv7()}.tmp`;
    try {
      await writeFile(temporary, buffer, { flag: "wx" });
      try {
        await rename(temporary, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
    return { hash, size: buffer.byteLength, path: destination };
  }

  async import(sourcePath: string): Promise<StoredObject> {
    const source = path.resolve(sourcePath);
    const [hash, sourceStat] = await Promise.all([
      hashFile(source),
      stat(source),
    ]);
    const destination = this.pathFor(hash);
    await mkdir(path.dirname(destination), { recursive: true });
    try {
      await copyFile(source, destination, constants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return { hash, size: sourceStat.size, path: destination };
  }

  async read(hash: string): Promise<Buffer> {
    await this.ensureLocal(hash);
    return readFile(this.pathFor(hash));
  }

  /**
   * Makes a content-addressed object available locally and returns its path
   * without copying it into an artifact workspace.
   */
  async ensureLocalPath(hash: string): Promise<string> {
    await this.ensureLocal(hash);
    return this.pathFor(hash);
  }

  async materialize(hash: string, destinationPath: string): Promise<void> {
    await this.ensureLocal(hash);
    await mkdir(path.dirname(destinationPath), { recursive: true });
    const temporary = `${destinationPath}.${uuidv7()}.materialize`;
    try {
      await copyFile(
        this.pathFor(hash),
        temporary,
        constants.COPYFILE_EXCL,
      );
      await rename(temporary, destinationPath);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async publish(hash: string, expectedSize: number): Promise<void> {
    if (!this.remote) return;
    const key = this.keyFor(hash);
    const current = await this.remote.head(key);
    if (!current.exists) {
      await this.remote.uploadFile(key, this.pathFor(hash));
    } else if (current.size !== undefined && current.size !== expectedSize) {
      throw new Error(`Remote object size mismatch: ${hash}`);
    }
    const verified = await this.remote.head(key);
    if (!verified.exists) {
      throw new Error(`Remote object verification failed: ${hash}`);
    }
    if (verified.size !== undefined && verified.size !== expectedSize) {
      throw new Error(`Remote object size mismatch: ${hash}`);
    }
  }

  pathFor(hash: string): string {
    validateHash(hash);
    return path.join(this.root, hash.slice(0, 2), hash);
  }

  /**
   * Removes the local copy of an object. Returns whether a local file was
   * actually removed; deleting an object that is not stored locally is not
   * an error.
   */
  async deleteLocal(hash: string): Promise<boolean> {
    const destination = this.pathFor(hash);
    try {
      await rm(destination);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  /**
   * Unpublishes an object from the remote content store. Returns whether a
   * remote object was deleted. Without a configured remote this is a no-op.
   */
  async unpublish(hash: string): Promise<boolean> {
    if (!this.remote) return false;
    const key = this.keyFor(hash);
    const current = await this.remote.head(key);
    if (!current.exists) return false;
    await this.remote.delete(key);
    return true;
  }

  /**
   * Lists every object hash stored locally, including stray files that have
   * no `objects` row (for example leftovers from an interrupted import).
   */
  async listLocal(): Promise<string[]> {
    const hashes: string[] = [];
    let fanout: string[];
    try {
      fanout = await readdir(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    for (const directory of fanout.sort()) {
      if (!/^[a-f0-9]{2}$/.test(directory)) continue;
      const entries = await readdir(path.join(this.root, directory));
      for (const entry of entries.sort()) {
        if (/^[a-f0-9]{64}$/.test(entry)) hashes.push(entry);
      }
    }
    return hashes;
  }

  keyFor(hash: string): string {
    validateHash(hash);
    return `${this.prefix}/${hash.slice(0, 2)}/${hash}`;
  }

  private async ensureLocal(hash: string): Promise<void> {
    // A forgotten object must stay forgotten: refuse the read before even
    // looking at local bytes, so neither a lingering local file nor a
    // configured remote can resurrect deleted content.
    if (this.isForgotten?.(hash)) {
      throw new Error(`Object unavailable: ${hash}`);
    }
    const destination = this.pathFor(hash);
    try {
      await stat(destination);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!this.remote) throw new Error(`Object unavailable: ${hash}`);
    await mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.${uuidv7()}.download`;
    try {
      await this.remote.downloadFile(this.keyFor(hash), temporary);
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const input = createReadStream(filePath);
    input.on("data", (chunk) => {
      hash.update(chunk);
    });
    input.on("error", reject);
    input.on("end", resolve);
  });
  return hash.digest("hex");
}

function validateHash(hash: string): void {
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error(`Invalid SHA-256 hash: ${hash}`);
  }
}
