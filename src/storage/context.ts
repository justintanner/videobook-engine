import * as path from "node:path";

import type { Catalog } from "./catalog.js";

interface CatalogEntry {
  catalog: Catalog;
  references: number;
}

const catalogs = new Map<string, CatalogEntry>();

export function acquireCatalog(
  projectsDir: string,
  create: () => Catalog,
): Catalog {
  const root = path.resolve(projectsDir);
  const current = catalogs.get(root);
  if (current) {
    current.references += 1;
    return current.catalog;
  }
  const catalog = create();
  catalogs.set(root, { catalog, references: 1 });
  return catalog;
}

export function releaseCatalog(
  projectsDir: string,
  catalog: Catalog,
): boolean {
  const root = path.resolve(projectsDir);
  const current = catalogs.get(root);
  if (!current || current.catalog !== catalog) return true;
  current.references -= 1;
  if (current.references > 0) return false;
  catalogs.delete(root);
  return true;
}

export function catalogForProjectDir(projectDir: string): Catalog | null {
  const projectPath = path.resolve(projectDir);
  let winner: { root: string; catalog: Catalog } | null = null;
  for (const [root, entry] of catalogs) {
    if (projectPath === root || projectPath.startsWith(`${root}${path.sep}`)) {
      if (!winner || root.length > winner.root.length) {
        winner = { root, catalog: entry.catalog };
      }
    }
  }
  return winner?.catalog ?? null;
}
