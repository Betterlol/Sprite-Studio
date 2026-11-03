import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ProjectStore } from "./store.ts";
import type { ClipAsset } from "./model.ts";
const pythonExecutable = process.env.SPRITE_STUDIO_PYTHON || "python";

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

test("endpoint interpolation previews retain original endpoints and apply exactly once across recovery", async () => {
  const { store, pid, sheet, clip: sourceClip, spec } = await fixture();
  const clip = store.createClip(pid, "带区间外帧的动画", [
    {
      id: randomUUID(),
      imageId: sourceClip.frames[0]!.imageId,
      durationUs: 300000,
    },
    ...sourceClip.frames,
    {
      id: randomUUID(),
      imageId: sourceClip.frames[3]!.imageId,
      durationUs: 400000,
    },
  ]);
  spec.clipId = clip.id;
  spec.revision = clip.revision;
  try {
    const job = store.interpolations.create(pid, spec);
    assert.equal(store.interpolations.create(pid, spec).id, job.id);
    assert.equal(store.sessions.size, 1);
    store.interpolations.receive(pid, job.id, sheet.id, {
      id: "actual-event",
      inputImages: [
        { sha256: job.start.contentHash },
        { sha256: job.end.contentHash },
      ],
    });
    assert.equal(job.referencesVerified, true);
    await assert.rejects(
      async () =>
        store.interpolations.prepare(pid, job.id, {
          columns: 3,
          rows: 1,
          includesEndpoints: true,
          fps: 8,
        }),
      /网格数量/,
    );
    const layout = { columns: 2, rows: 2, includesEndpoints: true, fps: 8 };
    const [prepared, duplicate] = await Promise.all([
      store.interpolations.prepare(pid, job.id, layout),
      store.interpolations.prepare(pid, job.id, layout),
    ]);
    assert.equal(prepared.prepared!.clipId, duplicate.prepared!.clipId);
    assert.equal(store.asset(pid, clip.id).revision, clip.revision);
    const preview = store.asset(pid, prepared.prepared!.clipId) as ClipAsset;
    assert.deepEqual(preview.frames[0], clip.frames[0]);
    assert.deepEqual(preview.frames[1], clip.frames[1]);
    assert.deepEqual(preview.frames[4], clip.frames[4]);
    assert.deepEqual(preview.frames[5], clip.frames[5]);
    assert.equal(preview.frames[2]!.durationUs, 125000);
    assert.notEqual(preview.frames[2]!.imageId, clip.frames[2]!.imageId);
    const pixels = spawnSync(
      pythonExecutable,
      [
        "-c",
        "from PIL import Image; import sys,json; print(json.dumps([Image.open(p).getpixel((16,16)) for p in sys.argv[1:]]))",
        ...preview.frames.map((f) => store.imagePath(pid, f.imageId)),
      ],
      { windowsHide: true },
    );
    assert.deepEqual(JSON.parse(pixels.stdout.toString()), [
      [255, 0, 0, 255],
      [255, 0, 0, 255],
      [0, 128, 0, 255],
      [0, 0, 255, 255],
      [255, 255, 0, 255],
      [255, 255, 0, 255],
    ]);
    const applied = store.interpolations.apply(pid, job.id);
    assert.deepEqual(applied.frames, preview.frames);
    assert.equal(
      store.interpolations.apply(pid, job.id).revision,
      applied.revision,
    );
    // Simulate a process loss after the clip commit but before the job status write.
    writeFileSync(
      join(store.dir(pid), ".studio", "interpolations", `${job.id}.json`),
      JSON.stringify({ ...job, status: "preview" }),
    );
    const restored = new ProjectStore(store.root);
    try {
      assert.equal(restored.interpolations.get(pid, job.id).status, "applied");
      assert.deepEqual(
        restored.interpolations.apply(pid, job.id).frames,
        applied.frames,
      );
      assert.equal(
        restored.assets(pid).filter((a) => a.type === "image").length,
        7,
      );
    } finally {
      restored.worker.close();
    }
  } finally {
    store.worker.close();
  }
});

test("changed animation and edited previews cannot be silently applied; missing reference evidence stays explicit", async () => {
  const { store, pid, sheet, clip, spec } = await fixture();
  try {
    assert.throws(
      () =>
        store.interpolations.create(pid, {
          ...spec,
          startFrameId: spec.endFrameId,
          endFrameId: spec.startFrameId,
        }),
      /尾帧必须/,
    );
    const job = store.interpolations.create(pid, spec);
    store.interpolations.receive(pid, job.id, sheet.id, {
      id: "incomplete-event",
      inputImages: [{ sha256: job.start.contentHash }],
    });
    assert.equal(job.referencesVerified, false);
    assert.match(job.error!, /没有确认/);
    const layout = { columns: 2, rows: 2, includesEndpoints: true, fps: 8 };
    await store.interpolations.prepare(pid, job.id, layout);
    const preview = store.asset(pid, job.prepared!.clipId) as ClipAsset;
    const candidatePath = store.imagePath(pid, preview.frames[1]!.imageId),
      candidateBytes = readFileSync(candidatePath);
    writeFileSync(candidatePath, Buffer.from("externally modified candidate"));
    assert.throws(
      () => store.interpolations.apply(pid, job.id),
      /图片已被外部修改/,
    );
    writeFileSync(candidatePath, candidateBytes);
    store.updateClip(pid, preview.id, {
      revision: preview.revision,
      frames: preview.frames,
      loop: false,
    });
    assert.throws(
      () => store.interpolations.apply(pid, job.id),
      /预览动画已修改/,
    );
    await store.interpolations.prepare(pid, job.id, layout);
    store.updateClip(pid, clip.id, {
      revision: clip.revision,
      frames: clip.frames,
      loop: false,
    });
    assert.throws(
      () => store.interpolations.apply(pid, job.id),
      /原动画已修改/,
    );
    await assert.rejects(
      async () => store.interpolations.prepare(pid, job.id, layout),
      /原动画已修改/,
    );
  } finally {
    store.worker.close();
  }
});
