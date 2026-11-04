import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { ProjectStore, atomicJson } from "./store.ts";
import type { ClipAsset } from "./model.ts";
const python = process.env.SPRITE_STUDIO_PYTHON || "python";
async function fixture(longPath = false) {
  const root = mkdtempSync(join(tmpdir(), "sprite-animation-")),
    file = join(root, "frames.png");
  const result = spawnSync(
    python,
    [
      "-c",
      "from PIL import Image,ImageDraw; import sys; im=Image.new('RGBA',(384,96));d=ImageDraw.Draw(im);[d.rectangle((i*96+48-size//2,48-size//2,i*96+48+size//2-1,48+size//2-1),fill='#207cda') for i,size in enumerate([24,24,48,24])];im.save(sys.argv[1])",
      file,
    ],
    { windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr.toString());
  const store = new ProjectStore(
      join(root, ...(longPath ? ["long-".repeat(30)] : []), "projects"),
    ),
    project = store.createProject("检查修正验证"),
    sheet = await store.importImage(
      project.id,
      "frames.png",
      readFileSync(file),
    ),
    clip = await store.slice(project.id, sheet.id, sheet.revision, {
      columns: 4,
      rows: 1,
      fps: 5,
    });
  return { store, pid: project.id, clip };
}

test("direct edits and immutable comparisons work in deep Windows paths without creating another animation", async () => {
  const { store, pid, clip } = await fixture(true);
  try {
    const beforeCount = store
      .assets(pid)
      .filter((a) => a.type === "clip").length;
    const change = await store.animation.adjust(pid, {
      requestId: randomUUID(),
      clipId: clip.id,
      revision: clip.revision,
      frameId: clip.frames[2]!.id,
      transform: { scale: 0.5 },
    });
    assert.equal(change.status, "applied");
    assert.equal(
      store.assets(pid).filter((a) => a.type === "clip").length,
      beforeCount,
    );
    const comparison = store.animation.compare(pid, change.id);
    assert.equal(comparison.before.clip.id, clip.id);
    assert.equal(comparison.after.clip.id, clip.id);
    assert.notEqual(
      comparison.before.clip.frames[2]!.imageId,
      comparison.after.clip.frames[2]!.imageId,
    );
    const review = await store.animation.inspect(pid, { clipId: clip.id });
    assert.deepEqual(
      review.frames.map((f) => f.width),
      [24, 24, 24, 24],
    );
    assert.ok(
      readFileSync(store.animation.evidence(pid, review.id, "contact")).length >
        100,
    );
    assert.ok(
      readFileSync((await store.exportClip(pid, clip.id)).path).length > 20,
    );
  } finally {
    store.worker.close();
  }
});
test("one instance changes directly, duplicate requests do not repeat it, and undo recovers after interrupted history write", async () => {
  const { store, pid, clip } = await fixture();
  let restored: ProjectStore | undefined;
  try {
    const shared = store.createClip(pid, "重复图片实例", [
      ...clip.frames,
      {
        id: randomUUID(),
        imageId: clip.frames[2]!.imageId,
        durationUs: 200000,
      },
    ]);
    const ref = store.animation.reference(pid, {
      clipId: shared.id,
      revision: shared.revision,
    });
    const review = await store.animation.inspect(pid, {
      snapshotId: ref.snapshotId,
    });
    assert.deepEqual(
      review.frames.map((f) => f.width),
      [24, 24, 48, 24, 48],
    );
    assert.ok(
      review.pairs.some((p) => p.loopBoundary && p.from === 4 && p.to === 0),
    );
    const metadataPath = store.safePath(pid, store.metaPath(pid, shared.id)),
      oldMetadata = readFileSync(metadataPath);
    const input = {
      requestId: randomUUID(),
      clipId: shared.id,
      revision: shared.revision,
      frameId: shared.frames[2]!.id,
      transform: { scale: 0.5 },
      durationUs: 125000,
    };
    const count = store.assets(pid).length;
    const [change, duplicate] = await Promise.all([
      store.animation.adjust(pid, input),
      store.animation.adjust(pid, input),
    ]);
    assert.equal(change.id, duplicate.id);
    assert.equal(store.assets(pid).length, count + 1);
    const changed = store.animation.clip(pid, shared.id);
    assert.equal(changed.frames[2]!.durationUs, 125000);
    assert.equal(changed.frames[4]!.imageId, shared.frames[4]!.imageId);
    assert.deepEqual(
      changed.frames.filter((_, i) => i !== 2),
      shared.frames.filter((_, i) => i !== 2),
    );
    assert.equal(store.animation.review(pid, review.id).stale, true);
    const record = join(
      store.dir(pid),
      ".studio",
      "animation",
      "changes",
      `${change.id}.json`,
    );
    atomicJson(record, {
      ...change,
      status: "pending",
      afterSnapshotId: undefined,
    });
    writeFileSync(metadataPath, oldMetadata);
    store.worker.close();
    restored = new ProjectStore(store.root);
    assert.equal(restored.animation.change(pid, change.id).status, "applied");
    assert.deepEqual(
      restored.animation.compare(pid, change.id).after.clip.frames,
      changed.frames,
    );
    assert.deepEqual(
      restored.animation.revert(
        pid,
        change.id,
        restored.asset(pid, shared.id).revision,
      ).frames,
      shared.frames,
    );
    assert.equal(
      (await restored.animation.adjust(pid, input)).status,
      "reverted",
    );
    assert.deepEqual(
      restored.animation.revert(pid, change.id, "repeated-request").frames,
      shared.frames,
    );
  } finally {
    store.worker.close();
    restored?.worker.close();
  }
});
test("stale edits and undo over later changes fail; old snapshot pixels remain available", async () => {
  const { store, pid, clip } = await fixture();
  try {
    const snapshot = store.animation.capture(pid, clip.id);
    const input = {
      requestId: randomUUID(),
      clipId: clip.id,
      revision: clip.revision,
      frameId: clip.frames[2]!.id,
      durationUs: 125000,
    };
    const change = await store.animation.adjust(pid, input);
    await assert.rejects(
      store.animation.adjust(pid, { ...input, requestId: randomUUID() }),
      /版本已经改变/,
    );
    const current = store.animation.clip(pid, clip.id);
    const edited = store.updateClip(pid, clip.id, {
      revision: current.revision,
      loop: current.loop,
      frames: current.frames.map((f, i) =>
        i === 0 ? { ...f, durationUs: 90000 } : f,
      ),
    });
    assert.throws(
      () => store.animation.revert(pid, change.id, edited.revision),
      /后续修改/,
    );
    const image = store.image(pid, clip.frames[2]!.imageId),
      path = store.imagePath(pid, image.id),
      bytes = readFileSync(path);
    writeFileSync(path, Buffer.from("external change"));
    assert.deepEqual(
      readFileSync(
        store.animation.imagePath(pid, snapshot.id, clip.frames[2]!.id).path,
      ),
      bytes,
    );
  } finally {
    store.worker.close();
  }
});
test("legacy image labels and unapplied records load as ordinary assets and archived history", async () => {
  const { store, pid, clip } = await fixture();
  let restored: ProjectStore | undefined;
  try {
    const image = store.image(pid, clip.frames[0]!.imageId),
      meta = store.safePath(pid, store.metaPath(pid, image.id));
    atomicJson(meta, { ...image, kind: undefined, role: "candidate" });
    const saved = readFileSync(meta);
    const before = store.animation.capture(pid, clip.id),
      id = randomUUID();
    const directory = join(store.dir(pid), ".studio", "animation", "changes");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(directory, { recursive: true });
    atomicJson(join(directory, `${id}.json`), {
      id,
      projectId: pid,
      clipId: clip.id,
      frameId: clip.frames[0]!.id,
      candidateClipId: clip.id,
      baseSnapshotId: before.id,
      status: "draft",
      source: "human",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    store.worker.close();
    restored = new ProjectStore(store.root);
    assert.equal(restored.image(pid, image.id).kind, "image");
    assert.equal("role" in restored.image(pid, image.id), false);
    assert.deepEqual(readFileSync(meta), saved);
    assert.equal(restored.asset(pid, clip.id).revision, clip.revision);
    assert.equal(restored.animation.change(pid, id).status, "archived");
    assert.throws(
      () => restored!.animation.revert(pid, id, clip.revision),
      /尚未完成/,
    );
  } finally {
    store.worker.close();
    restored?.worker.close();
  }
});
