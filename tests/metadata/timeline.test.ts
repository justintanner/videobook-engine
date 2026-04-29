import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { createFs, type ClipfirstFs } from "../../src/index.js";
import { closeAllStateDbs } from "../../src/db/client.js";
import { getMetadataDb } from "../../src/db/metadata-client.js";

interface SlotRow {
  position: number;
  asset_id: string;
  volume: number | null;
  audio_fade_in: number | null;
  audio_fade_out: number | null;
}

describe("timeline metadata.sqlite migration", () => {
  let projectsDir: string;
  let cfs: ClipfirstFs;
  let projectDir: string;

  beforeEach(async () => {
    projectsDir = await fs.mkdtemp(path.join(os.tmpdir(), "cfs-timeline-"));
    cfs = createFs({ projectsDir });
    const created = await cfs.createProject("p");
    expect(created.ok).toBe(true);
    projectDir = path.join(projectsDir, "p");
  });

  afterEach(async () => {
    closeAllStateDbs();
    await fs.rm(projectsDir, { recursive: true, force: true });
  });

  it("dual-writes timeline to SQLite and sidecar", async () => {
    const config = {
      slots: [
        { slug: "vid-a", volume: 0.8 },
        { slug: "vid-b", audioFadeIn: 0.2 },
      ],
      render: "landscape" as const,
    };
    const result = await cfs.writeProjectMeta("timeline", config, "p");
    expect(result.ok).toBe(true);

    const sidecarPath = path.join(projectDir, ".timeline.json");
    const sidecarRaw = await fs.readFile(sidecarPath, "utf-8");
    const sidecar = JSON.parse(sidecarRaw);
    expect(sidecar.slots.length).toBe(2);

    const db = getMetadataDb(projectDir);
    const slots = db
      .prepare(`SELECT position, asset_id, volume, audio_fade_in, audio_fade_out FROM timeline_slots ORDER BY position`)
      .all() as SlotRow[];
    expect(slots.length).toBe(2);
    expect(slots[0].asset_id).toBe("vid-a");
    expect(slots[0].volume).toBe(0.8);
    expect(slots[1].asset_id).toBe("vid-b");
    expect(slots[1].audio_fade_in).toBe(0.2);
  });

  it("readProjectMeta returns the same shape from SQLite", async () => {
    const config = {
      slots: [{ slug: "vid-x" }],
      render: "portrait" as const,
      currentOrientation: "original" as const,
    };
    await cfs.writeProjectMeta("timeline", config, "p");

    // Delete the sidecar to ensure SQLite is the source
    const sidecarPath = path.join(projectDir, ".timeline.json");
    await fs.rm(sidecarPath, { force: true });

    const read = await cfs.readProjectMeta<typeof config>("timeline", "p");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.render).toBe("portrait");
    expect(read.value.currentOrientation).toBe("original");
    expect(read.value.slots.length).toBe(1);
    expect(read.value.slots[0].slug).toBe("vid-x");
  });

  it("emits canonical export under .clipfirst/export/timeline.json", async () => {
    const config = {
      slots: [{ slug: "vid-z", volume: 1 }],
      render: "square" as const,
    };
    await cfs.writeProjectMeta("timeline", config, "p");

    const exportPath = path.join(
      projectDir,
      ".clipfirst",
      "export",
      "timeline.json",
    );
    const exported = await fs.readFile(exportPath, "utf-8");
    // Canonical: keys are sorted alphabetically (render before slots)
    expect(exported).toContain('"render": "square"');
    expect(exported.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(exported);
    expect(parsed.slots[0].slug).toBe("vid-z");
  });

  it("two concurrent timeline writes do not interleave", async () => {
    const writes = [
      cfs.writeProjectMeta(
        "timeline",
        { slots: [{ slug: "vid-1" }], render: "landscape" as const },
        "p",
      ),
      cfs.writeProjectMeta(
        "timeline",
        { slots: [{ slug: "vid-2" }], render: "portrait" as const },
        "p",
      ),
      cfs.writeProjectMeta(
        "timeline",
        { slots: [{ slug: "vid-3" }], render: "square" as const },
        "p",
      ),
    ];
    const results = await Promise.all(writes);
    for (const r of results) expect(r.ok).toBe(true);

    const db = getMetadataDb(projectDir);
    const row = db.prepare(`SELECT render FROM timeline WHERE id = 1`).get() as
      | { render: string }
      | undefined;
    expect(row).toBeDefined();
    // The final winner is one of the three — but the SQLite tx invariant
    // means render and slots are consistent (no interleaving).
    expect(["landscape", "portrait", "square"]).toContain(row!.render);

    const slots = db
      .prepare(`SELECT asset_id FROM timeline_slots ORDER BY position`)
      .all() as Array<{ asset_id: string }>;
    expect(slots.length).toBe(1);
    if (row!.render === "landscape") expect(slots[0].asset_id).toBe("vid-1");
    if (row!.render === "portrait") expect(slots[0].asset_id).toBe("vid-2");
    if (row!.render === "square") expect(slots[0].asset_id).toBe("vid-3");
  });
});
