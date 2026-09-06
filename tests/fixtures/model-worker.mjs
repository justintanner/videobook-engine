import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

process.on("message", async ({ id, call, configuration }) => {
  if (call.sourcePath) writeFileSync(call.sourcePath, JSON.stringify({
    pid: process.pid, cwd: process.cwd(), hasProviderSecret: Boolean(process.env.VIDEOBOOK_PRIVATE_FIXTURE),
    hasModelToken: Boolean(process.env.HF_TOKEN),
  }));
  if (call.text === "loop") { while (true) Math.sqrt(Math.random()); }
  if (call.text === "cache-stage") {
    const stage = join(configuration.modelCacheDir, ".videobook-staging", basename(process.cwd()));
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, "incomplete-model"), "incomplete");
    writeFileSync(call.sourcePath, JSON.stringify({ pid: process.pid, cwd: process.cwd(), stage }));
    while (true) Math.sqrt(Math.random());
  }
  if (call.text === "oom") {
    const values = [];
    while (true) values.push(new Array(8192).fill(Math.random()));
  }
  if (call.text === "decoder") {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    writeFileSync(call.sourcePath, JSON.stringify({ pid: process.pid, childPid: child.pid, cwd: process.cwd() }));
    await new Promise(() => {});
  }
  if (call.text === "delay") await new Promise((resolve) => setTimeout(resolve, call.durationSeconds ?? 150));
  if (call.text === "invalid") { process.send({ id: id + 1, ok: true }); return; }
  const vector = new Float32Array(512);
  vector[0] = process.pid;
  vector[1] = 1;
  process.send({ id, ok: true, value: vector });
});
