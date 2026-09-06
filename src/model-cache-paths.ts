import { basename, join } from "node:path";

export function modelCacheStagingRoot(cacheDir: string, workerRoot: string): string {
  return join(cacheDir, ".videobook-staging", basename(workerRoot));
}
