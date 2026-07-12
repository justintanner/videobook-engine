const fs = require('fs');

// 1. types.ts
let types = fs.readFileSync('src/types.ts', 'utf8');
types = types.replace(
  'export type AssetType = "video" | "image" | "script" | "final" | "audio" | "character" | "plan";',
  'export type AssetType = "video" | "image" | "script" | "final" | "audio" | "character" | "notebook";'
);
fs.writeFileSync('src/types.ts', types);

// 2. validation.ts
let validation = fs.readFileSync('src/validation.ts', 'utf8');
validation = validation.replace(
  'const VALID_PREFIXES = ["img-", "vid-", "aud-", "script-", "char-"] as const;',
  'const VALID_PREFIXES = ["img-", "vid-", "aud-", "script-", "char-", "nb-"] as const;'
);
validation = validation.replace(
  'const SINGLETON_ASSETS = ["final", "plan"] as const;',
  'const SINGLETON_ASSETS = ["final"] as const;'
);
fs.writeFileSync('src/validation.ts', validation);

// 3. asset/list.ts
let list = fs.readFileSync('src/asset/list.ts', 'utf8');
list = list.replace(
  '  if (name === "final") return "final";\n  if (name === "plan") return "plan";',
  '  if (name.startsWith("nb-")) return "notebook";\n  if (name === "final") return "final";'
);
fs.writeFileSync('src/asset/list.ts', list);

// 4. tests/helpers/arbitraries.ts
let arbs = fs.readFileSync('tests/helpers/arbitraries.ts', 'utf8');
arbs = arbs.replace("  fc.constant('plan'),\n", "");
arbs = arbs.replace(
  "export const validPrefixArb = fc.constantFrom('vid', 'img', 'aud', 'script');",
  "export const validPrefixArb = fc.constantFrom('vid', 'img', 'aud', 'script', 'char', 'nb');"
);
fs.writeFileSync('tests/helpers/arbitraries.ts', arbs);

// 5. tests/fuzz/path-traversal.test.ts
let fuzz = fs.readFileSync('tests/fuzz/path-traversal.test.ts', 'utf8');
fuzz = fuzz.replace(
  "dangerousAssetIdArb.filter((id) => id !== 'plan' && !isValidAssetId(id))",
  "dangerousAssetIdArb.filter((id) => !isValidAssetId(id))"
);
fs.writeFileSync('tests/fuzz/path-traversal.test.ts', fuzz);

// 6. asset/status.ts
let status = fs.readFileSync('src/asset/status.ts', 'utf8');
status = status.replace(
  '  // Plan singleton: no primary media file by design — only `index.md` and\n  // `.plan.json`. Treat as ready once the markdown has been written.\n  if (assetId === "plan" && fileNames.has("index.md")) return "ready";',
  '  // Notebook and character assets have no required primary media.\n  // Treat as ready.\n  if (assetId.startsWith("nb-") || assetId.startsWith("char-")) return "ready";'
);
fs.writeFileSync('src/asset/status.ts', status);

// 7. db/run-operation.ts
let ro = fs.readFileSync('src/db/run-operation.ts', 'utf8');
ro = ro.replace(
  '  subjectType: "asset" | "character" | "timeline" | "project" | "render";',
  '  subjectType: "asset" | "timeline" | "project" | "render";'
);
fs.writeFileSync('src/db/run-operation.ts', ro);

// 8. index.ts
let index = fs.readFileSync('src/index.ts', 'utf8');
index = index.replace(
  'const BUILD_METADATA_VERSION = 5;',
  'const BUILD_METADATA_VERSION = 6;'
);
fs.writeFileSync('src/index.ts', index);
