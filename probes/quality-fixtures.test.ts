import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { qualityFixtures, writeQualityFixtures } from "./quality-fixtures.ts";

test("fixture splits are disjoint, diverse and reproducible without model calls", () => {
  assert.ok(qualityFixtures.length >= 12 && qualityFixtures.length <= 16);
  const dev = qualityFixtures.filter(f => f.split === "development");
  const hold = qualityFixtures.filter(f => f.split === "holdout");
  assert.ok(dev.length && hold.length);
  assert.equal(new Set(qualityFixtures.map(f => f.id)).size, qualityFixtures.length);
  assert.ok(hold.every(f => !dev.some(d => JSON.stringify(d.frames) === JSON.stringify(f.frames))));
  for (const category of ["offset", "scale", "crop", "duration", "loop", "boundary", "normal-motion"]) assert.ok(qualityFixtures.some(f => f.category === category));
  const dir = mkdtempSync(join(tmpdir(), "quality-fixtures-test-"));
  try {
    const a = join(dir, "a"), b = join(dir, "b");
    writeQualityFixtures(a); writeQualityFixtures(b);
    assert.deepEqual(readFileSync(join(a, "manifest.json")), readFileSync(join(b, "manifest.json")));
    assert.deepEqual(readFileSync(join(a, "evaluation-template.json")), readFileSync(join(b, "evaluation-template.json")));
    const manifest = JSON.parse(readFileSync(join(a, "manifest.json"), "utf8"));
    assert.equal(manifest.fixtures.length, qualityFixtures.length);
    for (const f of manifest.fixtures) for (const frame of f.frames) assert.ok(existsSync(join(a, frame.file)));
    assert.throws(() => writeQualityFixtures(a));
    assert.throws(() => writeQualityFixtures("relative-output"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CLI refuses another project's .local and temp output does not depend on cwd .local", () => {
  const dir = mkdtempSync(join(tmpdir(), "quality-foreign-cwd-"));
  try {
    const project = join(dir, "project"), foreignLocal = join(project, ".local"), emptyCwd = join(dir, "empty");
    mkdirSync(foreignLocal, { recursive: true });
    mkdirSync(emptyCwd);
    const script = fileURLToPath(new URL("./quality-fixtures.ts", import.meta.url));
    const forbidden = join(foreignLocal, "output");
    const denied = spawnSync(process.execPath, [script, forbidden], { cwd: project, encoding: "utf8" });
    assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, /worktree/);
    assert.equal(existsSync(forbidden), false);
    const allowed = join(dir, "safe-output");
    const result = spawnSync(process.execPath, [script, allowed], { cwd: emptyCwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(allowed, "manifest.json")), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
