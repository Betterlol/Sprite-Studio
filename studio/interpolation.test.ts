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
    const job = store.interpolations.create(pid, spec);
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
    const job = store.interpolations.create(pid, spec);
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
    const job = store.interpolations.create(pid, spec);
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
