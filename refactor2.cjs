const fs = require('fs');

// 9. file/metadata.ts
let metadata = fs.readFileSync('src/file/metadata.ts', 'utf8');

// Remove character imports
metadata = metadata.replace(/import \{\n  type CharacterRecord,\n  exportCharacterPins,\n  exportCharacters,\n  readCharacter,\n  writeCharacter,\n\} from "\.\.\/db\/character\.js";\n/, '');

// Remove CHARACTER_KEY
metadata = metadata.replace(/const CHARACTER_KEY = "character";\n\n/, '');

// Remove isCharacterRecord and writeCharacterToSqlite (lines 50-108)
metadata = metadata.replace(/function isCharacterRecord\([\s\S]*?async function writeAssetMetadataToSqlite/m, 'async function writeAssetMetadataToSqlite');

// Replace the dispatch logic inside writeMetadata (lines 196-204)
let dispatchRegex = /    if \(key === CHARACTER_KEY && isCharacterRecord\(data\)\) \{\n      await writeCharacterToSqlite\(\n        projectDir,\n        assetId,\n        data,\n        filePath,\n        json,\n        gitPath,\n      \);\n    \} else \{\n      await writeAssetMetadataToSqlite\(\n        projectDir,\n        assetId,\n        key,\n        data,\n        filePath,\n        json,\n        gitPath,\n      \);\n    \}/;
metadata = metadata.replace(dispatchRegex, `    await writeAssetMetadataToSqlite(
      projectDir,
      assetId,
      key,
      data,
      filePath,
      json,
      gitPath,
    );`);

// Remove typed path from readMetadata (lines 245-257)
let readMetaRegex = /  \/\/ Character is the only key with SQL-native typed storage; for everything\n  \/\/ else the sidecar is still the source-of-truth signal \(its presence ==\n  \/\/ metadata exists; its deletion == metadata deleted\)\. asset_metadata is\n  \/\/ a passive mirror used only for the audit trail and the canonical export\.\n  if \(key === CHARACTER_KEY && \(await metadataDbExists\(projectDir\)\)\) \{\n    try \{\n      const db = getMetadataDb\(projectDir\);\n      const character = readCharacter\(db, assetId\);\n      if \(character\) return ok\(character as unknown as T\);\n    \} catch \{\n      \/\/ fall through to sidecar\n    \}\n  \}\n\n/;
metadata = metadata.replace(readMetaRegex, '');

// Remove metadataDbExists function and its unused imports
let dbExistsRegex = /async function metadataDbExists\(projectDir: string\): Promise<boolean> \{\n  try \{\n    const stat = await fs\.stat\(\n      path\.join\(projectDir, VIDEOCITY_DIR, "metadata\.sqlite"\),\n    \);\n    return stat\.isFile\(\);\n  \} catch \{\n    return false;\n  \}\n\}\n\n/;
metadata = metadata.replace(dbExistsRegex, '');
metadata = metadata.replace(/import \{ getMetadataDb \} from "\.\.\/db\/metadata-client\.js";\n/, '');
metadata = metadata.replace(/import \{ VIDEOCITY_DIR \} from "\.\.\/db\/client\.js";\n/, '');

fs.writeFileSync('src/file/metadata.ts', metadata);

// 10. db/recover.ts
let recover = fs.readFileSync('src/db/recover.ts', 'utf8');

// Remove character imports
recover = recover.replace(/import \{\n  exportCharacterPins,\n  exportCharacters,\n  readCharacter,\n\} from "\.\/character\.js";\n/, '');

// Remove from rebuildKnownExports
recover = recover.replace(/    \{ rel: "characters\.json", body: exportCharacters\(db\) \},\n    \{ rel: "character_pins\.json", body: exportCharacterPins\(db\) \},\n/, '');

// Remove from rebuildSidecarsForOperation
let rebuildRegex = /  if \(row\.intent === "write_character" && row\.target\) \{\n    const character = readCharacter\(metadataDb, row\.target\);\n    if \(character\) \{\n      const rel = await writeJsonSidecar\(\n        projectDir,\n        path\.join\(row\.target, "\.character\.json"\),\n        character,\n      \);\n      if \(rel\) written\.push\(rel\);\n    \}\n  \}\n/;
recover = recover.replace(rebuildRegex, '');

fs.writeFileSync('src/db/recover.ts', recover);
