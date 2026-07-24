import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  constants,
  copyFile,
  mkdir,
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

export class ObjectStore {
  readonly root: string;
  readonly prefix: string;

  constructor(
    root: string,
    private readonly remote?: ContentStore,
    prefix = "superlzy-media/videobook/sha256",
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
    await copyFile(this.pathFor(hash), destinationPath);
  }

  async publish(hash: string, expectedSize: number): Promise<void> {
    if (!this.remote) return;
    const key = this.keyFor(hash);
    const current = await this.remote.head(key);
    if (!current.exists) {
      await this.remote.uploadFile(key, this.pathFor(hash));
    } else if (
      current.size !== undefined &&
      current.size !== expectedSize
    ) {
      throw new Error(`Remote object size mismatch: ${hash}`);
    }
    const verified = await this.remote.head(key);
    if (!verified.exists) {
      throw new Error(`Remote object verification failed: ${hash}`);
    }
    if (
      verified.size !== undefined &&
      verified.size !== expectedSize
    ) {
      throw new Error(`Remote object size mismatch: ${hash}`);
    }
  }

  pathFor(hash: string): string {
    validateHash(hash);
    return path.join(this.root, hash.slice(0, 2), hash);
  }

  keyFor(hash: string): string {
    validateHash(hash);
    return `${this.prefix}/${hash.slice(0, 2)}/${hash}`;
  }

  private async ensureLocal(hash: string): Promise<void> {
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
