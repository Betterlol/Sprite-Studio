import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ProjectStore, atomicJson } from "./store.ts";
import type { ClipAsset } from "./model.ts";
const pythonExecutable = process.env.SPRITE_STUDIO_PYTHON || "python";
const layout = { columns: 2, rows: 2, includesEndpoints: true, fps: 8 };
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sprite-interpolation-")),
    file = join(root, "grid.png");
  const generated = spawnSync(
    pythonExecutable,
    [
      "-c",
      "from PIL import Image,ImageDraw; import sys; im=Image.new('RGBA',(64,64)); d=ImageDraw.Draw(im); [d.rectangle((x*32+8,y*32+8,x*32+23,y*32+23),fill=c) for x,y,c in [(0,0,'red'),(1,0,'green'),(0,1,'blue'),(1,1,'yellow')]]; im.save(sys.argv[1])",
      file,
    ],
    { windowsHide: true },
  );
  assert.equal(generated.status, 0, generated.stderr.toString());
  const store = new ProjectStore(join(root, "projects")),
    project = store.createProject("补帧验证");
  const sheet = await store.importImage(
    project.id,
    "grid.png",
    readFileSync(file),
  );
  const clip = await store.slice(project.id, sheet.id, sheet.revision, {
    columns: 2,
    rows: 2,
    fps: 10,
  });
  const spec = {
    requestId: randomUUID(),
    clipId: clip.id,
    revision: clip.revision,
    startFrameId: clip.frames[0]!.id,
    endFrameId: clip.frames[3]!.id,
    count: 2,
    fps: 8,
    description: "测试两个中间帧",
  };
  return { root, store, pid: project.id, sheet, clip, spec };
}

test("one insertion directly updates the original animation, preserves endpoints and survives retries/restart", async () => {
  const { root, store, pid, sheet, clip, spec } = await fixture();
  let restored: ProjectStore | undefined;
  try {
    const job = store.interpolations.create(pid, { ...spec, timingPolicy: "fps", interiorPolicy: "replace" });
    store.interpolations.receive(pid, job.id, sheet.id, {
      id: "fixture",
      inputImages: [
        { sha256: job.start.contentHash },
        { sha256: job.end.contentHash },
      ],
    });
    assert.equal(job.status, "generated");
    assert.equal(job.referencesVerified, true);
    const assets = store.assets(pid).length;
    const [updated, repeated] = await Promise.all([
      store.interpolations.insert(pid, job.id, layout),
      store.interpolations.insert(pid, job.id, layout),
    ]);
    assert.equal(updated.id, clip.id);
    assert.deepEqual(updated.frames, repeated.frames);
    assert.equal(store.assets(pid).length, assets + 2);
    assert.equal(store.assets(pid).filter((a) => a.type === "clip").length, 1);
    assert.deepEqual(updated.frames[0], clip.frames[0]);
    assert.deepEqual(updated.frames.at(-1), clip.frames.at(-1));
    assert.deepEqual(
      updated.frames.slice(1, -1).map((f) => f.durationUs),
      [125000, 125000],
    );
    assert.equal(
      (await store.interpolations.insert(pid, job.id, layout)).revision,
      updated.revision,
    );
    assert.deepEqual(
      store.animation.snapshot(pid, job.beforeSnapshotId!).clip.frames,
      clip.frames,
    );
    assert.deepEqual(
      store.animation.snapshot(pid, job.afterSnapshotId!).clip.frames,
      updated.frames,
    );
    atomicJson(
      join(store.dir(pid), ".studio", "interpolations", `${job.id}.json`),
      { ...job, status: "generated" },
    );
    store.worker.close();
    restored = new ProjectStore(join(root, "projects"));
    assert.equal(restored.interpolations.get(pid, job.id).status, "applied");
    assert.deepEqual(
      (await restored.interpolations.insert(pid, job.id, layout)).frames,
      updated.frames,
    );
    assert.ok(
      readFileSync((await restored.exportClip(pid, clip.id)).path).length > 20,
    );
  } finally {
    store.worker.close();
    restored?.worker.close();
  }
});
test("layout, live image and animation version checks protect direct insertion", async () => {
  const { store, pid, sheet, clip, spec } = await fixture();
  try {
    const job = store.interpolations.create(pid, { ...spec, timingPolicy: "fps", interiorPolicy: "replace" });
    store.interpolations.receive(pid, job.id, sheet.id, {
      id: "fixture",
      inputImages: [],
    });
    assert.equal(job.referencesVerified, false);
    assert.ok(job.error?.includes("未确认") || job.error?.includes("没有确认"));
    assert.throws(
      () => store.interpolations.insert(pid, job.id, { ...layout, columns: 1 }),
      /网格数量/,
    );
    const path = store.imagePath(pid, sheet.id),
      bytes = readFileSync(path);
    writeFileSync(path, Buffer.from("external modification"));
    await assert.rejects(
      store.interpolations.insert(pid, job.id, layout),
      /外部修改/,
    );
    writeFileSync(path, bytes);
    const edited = store.updateClip(pid, clip.id, {
      revision: clip.revision,
      loop: clip.loop,
      frames: clip.frames.map((f, i) =>
        i === 0 ? { ...f, durationUs: 150000 } : f,
      ),
    });
    assert.throws(
      () => store.interpolations.insert(pid, job.id, layout),
      /原动画已修改/,
    );
    assert.equal(store.asset(pid, clip.id).revision, edited.revision);
  } finally {
    store.worker.close();
  }
});
test("a concurrent edit during image processing is retained and insertion refuses to overwrite it", async () => {
  const { store, pid, sheet, clip, spec } = await fixture();
  try {
    const job = store.interpolations.create(pid, { ...spec, timingPolicy: "fps", interiorPolicy: "replace" });
    store.interpolations.receive(pid, job.id, sheet.id, { id: "fixture" });
    const count = store.assets(pid).length,
      pending = store.interpolations.insert(pid, job.id, layout);
    assert.throws(
      () =>
        store.interpolations.insert(pid, job.id, {
          ...layout,
          columns: 4,
          rows: 1,
        }),
      /正在处理/,
    );
    const edited = store.updateClip(pid, clip.id, {
      revision: clip.revision,
      loop: false,
      frames: clip.frames,
    });
    await assert.rejects(pending, /原动画已修改/);
    assert.equal(store.asset(pid, clip.id).revision, edited.revision);
    assert.equal(store.assets(pid).length, count);
  } finally {
    store.worker.close();
  }
});

test("default insertion conserves interval duration and keeps interior instances despite a different layout fps", async () => {
  const { root, store, pid, sheet, clip, spec } = await fixture();
  let restored: ProjectStore | undefined;
  try {
    const job = store.interpolations.create(pid, spec);
    assert.equal(job.timingPolicy, "preserve-duration");
    assert.equal(job.interiorPolicy, "preserve");
    assert.equal(store.interpolations.create(pid, spec).id, job.id);
    assert.throws(() => store.interpolations.create(pid, { ...spec, timingPolicy: "fps" }), /requestId/);
    store.interpolations.receive(pid, job.id, sheet.id, { id: "fixture" });
    // The policies and original image dependency snapshot survive a service restart.
    store.worker.close();
    restored = new ProjectStore(join(root, "projects"));
    const updated = await restored.interpolations.insert(pid, job.id, { ...layout, fps: 60 });
    assert.equal(updated.frames.length, clip.frames.length + spec.count);
    assert.deepEqual(updated.frames.filter(f => clip.frames.some(old => old.id === f.id)).map(f => [f.id, f.imageId, f.transform]), clip.frames.map(f => [f.id, f.imageId, f.transform]));
    assert.deepEqual(updated.frames.at(-1), clip.frames.at(-1));
    assert.equal(updated.frames.reduce((n, f) => n + f.durationUs, 0), clip.frames.reduce((n, f) => n + f.durationUs, 0));
    assert.deepEqual(updated.frames.slice(0, -1).map(f => f.durationUs), [60000, 60000, 60000, 60000, 60000]);
    assert.deepEqual((await restored.interpolations.insert(pid, job.id, layout)).frames, updated.frames);
  } finally { store.worker.close(); restored?.worker.close(); }
});

test("explicit replacement can preserve total duration without changing endpoints or outside frames", async () => {
  const { store, pid, sheet, clip, spec } = await fixture();
  try {
    const job = store.interpolations.create(pid, { ...spec, interiorPolicy: "replace", endFrameId: clip.frames[2]!.id });
    store.interpolations.receive(pid, job.id, sheet.id, { id: "fixture" });
    const updated = await store.interpolations.insert(pid, job.id, layout);
    assert.equal(updated.frames.length, 5);
    assert.ok(!updated.frames.some(f => f.id === clip.frames[1]!.id));
    assert.deepEqual(updated.frames.slice(-2), clip.frames.slice(-2));
    assert.equal(updated.frames[0]!.id, clip.frames[0]!.id);
    assert.equal(updated.frames[0]!.imageId, clip.frames[0]!.imageId);
    assert.deepEqual(updated.frames.slice(0, 3).map(f => f.durationUs), [66667, 66666, 66667]);
    assert.equal(updated.frames.reduce((n, f) => n + f.durationUs, 0), 400000);
  } finally { store.worker.close(); }
});

test("default count limits and minimum duration fail before starting a session; explicit replace uses actual result count", async () => {
  const { store, pid, clip, spec } = await fixture();
  try {
    const full = store.createClip(pid, "full", Array.from({ length: 128 }, () => ({ id: randomUUID(), imageId: clip.frames[0]!.imageId, durationUs: 100000 })));
    const fullSpec = { ...spec, clipId: full.id, revision: full.revision, startFrameId: full.frames[0]!.id, endFrameId: full.frames[127]!.id };
    assert.throws(() => store.interpolations.create(pid, fullSpec), /128/);
    assert.equal(store.interpolations.list(pid).length, 0);
    const replaced = store.interpolations.create(pid, { ...fullSpec, interiorPolicy: "replace" });
    assert.equal(replaced.interiorPolicy, "replace");
    const tiny = store.createClip(pid, "tiny", clip.frames.slice(0, 2).map(f => ({ ...f, id: randomUUID(), durationUs: 1000 })));
    assert.throws(() => store.interpolations.create(pid, { ...spec, requestId: randomUUID(), clipId: tiny.id, revision: tiny.revision, startFrameId: tiny.frames[0]!.id, endFrameId: tiny.frames[1]!.id }), /1000us/);
  } finally { store.worker.close(); }
});

test("a changed interior original-image digest blocks insertion even when clip revision is unchanged", async () => {
  const { store, pid, sheet, clip, spec } = await fixture();
  try {
    const job = store.interpolations.create(pid, spec);
    store.interpolations.receive(pid, job.id, sheet.id, { id: "fixture" });
    const original = store.image(pid, clip.frames[1]!.imageId);
    const replacement = store.image(pid, clip.frames[2]!.imageId);
    // Simulate reloaded image metadata after a legitimate pixel replacement.
    store.indexes.get(pid)!.set(original.id, { ...original, file: replacement.file, contentHash: replacement.contentHash });
    assert.equal(store.asset(pid, clip.id).revision, clip.revision);
    assert.throws(() => store.interpolations.insert(pid, job.id, layout), /原动画图片已改变/);
    assert.deepEqual((store.asset(pid, clip.id) as ClipAsset).frames, clip.frames);
  } finally { store.worker.close(); }
});
