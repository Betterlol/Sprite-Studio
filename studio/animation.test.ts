import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { ProjectStore } from "./store.ts";
import type { ClipAsset } from "./model.ts";
const python = process.env.SPRITE_STUDIO_PYTHON || "python";
test("snapshot evidence and corrections work in deeply nested Windows data paths", async () => {
  const { store, pid, clip } = await fixture(true);
  try {
    const review = await store.animation.inspect(pid, {
      clipId: clip.id,
      revision: clip.revision,
    });
    assert.ok(
      readFileSync(store.animation.evidence(pid, review.id, "contact")).length >
        100,
    );
    const change = await store.animation.propose(pid, {
      requestId: randomUUID(),
      clipId: clip.id,
      revision: clip.revision,
      frameId: clip.frames[2]!.id,
      transform: { scale: 0.5 },
    });
    assert.equal(
      store.animation.clip(pid, change.candidateClipId).frames.length,
      4,
    );
    const exported = await store.exportClip(pid, change.candidateClipId);
    assert.ok(readFileSync(exported.path).length > 20);
  } finally {
    store.worker.close();
  }
});
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
test("animation evidence identifies the correct instance and correction adopts/reverts only that instance across restart", async () => {
  const { store, pid, clip } = await fixture();
  try {
    // Reusing an image is distinct from reusing a frame instance.
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
      review.frames.map((frame) => frame.width),
      [24, 24, 48, 24, 48],
    );
    assert.ok(
      review.pairs.some(
        (pair) => pair.loopBoundary && pair.from === 4 && pair.to === 0,
      ),
    );
    assert.ok(
      readFileSync(store.animation.evidence(pid, review.id, "contact")).length >
        100,
    );
    const requestId = randomUUID(),
      input = {
        requestId,
        clipId: shared.id,
        revision: shared.revision,
        frameId: shared.frames[2]!.id,
        transform: { scale: 0.5 },
        durationUs: 125000,
      };
    const [change, repeated] = await Promise.all([
      store.animation.propose(pid, input),
      store.animation.propose(pid, input),
    ]);
    assert.equal(change.id, repeated.id);
    const candidate = store.animation.clip(pid, change.candidateClipId);
    assert.equal(candidate.frames[4]!.imageId, shared.frames[4]!.imageId);
    assert.notEqual(candidate.frames[2]!.imageId, shared.frames[2]!.imageId);
    assert.equal(candidate.frames[2]!.durationUs, 125000);
    assert.deepEqual(
      candidate.frames.filter((_, i) => i !== 2),
      shared.frames.filter((_, i) => i !== 2),
    );
    assert.equal(
      store.animation.clip(pid, shared.id).revision,
      shared.revision,
    );
    assert.deepEqual(
      store.animation.compare(pid, change.id).before.clip.frames,
      shared.frames,
    );
    const metadataPath = store.safePath(pid, store.metaPath(pid, shared.id)),
      oldMetadata = readFileSync(metadataPath);
    const applied = store.animation.apply(pid, change.id, candidate.revision);
    assert.deepEqual(applied.frames, candidate.frames);
    assert.equal(
      store.animation.apply(pid, change.id, "old-request").revision,
      applied.revision,
    );
    assert.equal(store.animation.review(pid, review.id).stale, true);
    // The clip carries the receipt if the process exits before the final record write.
    const record = join(
      store.dir(pid),
      ".studio",
      "animation",
      "changes",
      `${change.id}.json`,
    );
    writeFileSync(record, JSON.stringify({ ...change, status: "draft" }));
    writeFileSync(metadataPath, oldMetadata);
    const restored = new ProjectStore(store.root);
    try {
      assert.equal(restored.animation.change(pid, change.id).status, "applied");
      assert.equal(
        restored.animation.clip(pid, shared.id).revision,
        applied.revision,
      );
      const reverted = restored.animation.revert(
        pid,
        change.id,
        applied.revision,
      );
      assert.deepEqual(reverted.frames, shared.frames);
      assert.equal(
        restored.animation.revert(pid, change.id, "duplicate").revision,
        reverted.revision,
      );
      assert.throws(
        () => restored.animation.apply(pid, change.id, candidate.revision),
        /已撤回/,
      );
      assert.deepEqual(
        restored.animation.compare(pid, change.id).after.clip.frames,
        candidate.frames,
      );
      const again = new ProjectStore(restored.root);
      assert.equal(again.animation.change(pid, change.id).status, "reverted");
      again.worker.close();
    } finally {
      restored.worker.close();
    }
  } finally {
    store.worker.close();
  }
});
test("stale original/candidate and later edits cannot be overwritten, and immutable evidence retains old pixels", async () => {
  const { store, pid, clip } = await fixture();
  try {
    const input = {
      requestId: randomUUID(),
      clipId: clip.id,
      revision: clip.revision,
      frameId: clip.frames[2]!.id,
      durationUs: 100000,
    };
    const change = await store.animation.propose(pid, input),
      candidate = store.animation.clip(pid, change.candidateClipId);
    store.updateClip(pid, candidate.id, {
      revision: candidate.revision,
      frames: candidate.frames,
      loop: false,
    });
    assert.throws(
      () => store.animation.apply(pid, change.id, candidate.revision),
      /版本已经改变/,
    );
    const edited = store.animation.clip(pid, candidate.id),
      applied = store.animation.apply(pid, change.id, edited.revision);
    const later = store.updateClip(pid, clip.id, {
      revision: applied.revision,
      frames: applied.frames,
      loop: true,
    });
    assert.throws(
      () => store.animation.revert(pid, change.id, later.revision),
      /有新修改/,
    );
    const stale = await store.animation.propose(pid, {
      ...input,
      requestId: randomUUID(),
      revision: later.revision,
    });
    store.updateClip(pid, clip.id, {
      revision: later.revision,
      frames: later.frames,
      loop: false,
    });
    assert.throws(
      () =>
        store.animation.apply(
          pid,
          stale.id,
          store.animation.clip(pid, stale.candidateClipId).revision,
        ),
      /原动画已修改/,
    );
    const snapshot = store.animation.snapshot(pid, change.baseSnapshotId),
      file = store.imagePath(pid, clip.frames[0]!.imageId);
    writeFileSync(file, Buffer.from("external modification"));
    assert.ok(
      readFileSync(
        store.animation.imagePath(pid, snapshot.id, clip.frames[0]!.id).path,
      ).length > 20,
    );
    assert.throws(() => store.animation.capture(pid, clip.id), /外部修改/);
  } finally {
    store.worker.close();
  }
});
