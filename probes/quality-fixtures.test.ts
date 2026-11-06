import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
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
