import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ProjectStore, sha256 } from "./store.ts";
import type { ClipAsset } from "./model.ts";

test("image operations preserve sources, frame identity and revision conflicts across reload", async () => {
  const root = mkdtempSync(join(tmpdir(), "sprite-studio-test-"));
  const fixture = join(root, "fixture.png");
  const generated = spawnSync(
    process.env.SPRITE_STUDIO_PYTHON || "python",
    [
      "-c",
      "from PIL import Image,ImageDraw; import sys; im=Image.new('RGBA',(129,33)); d=ImageDraw.Draw(im); [d.rectangle((i*32+8,8,i*32+23,23),fill=c) for i,c in enumerate(['red','green','blue','yellow'])]; im.save(sys.argv[1])",
      fixture,
    ],
    { windowsHide: true },
  );
  assert.equal(generated.status, 0, generated.stderr.toString());
  const store = new ProjectStore(join(root, "projects"));
  const project = store.createProject("验证工程");
  try {
    const original = readFileSync(fixture);
    const source = await store.importImage(project.id, "sheet.png", original);
    const clip = await store.slice(project.id, source.id, source.revision, {
      columns: 4,
      rows: 1,
      fps: 12,
    });
    assert.equal(clip.frames.length, 4);
    assert.equal(
      clip.frames.reduce((total, frame) => total + frame.durationUs, 0),
      333333,
    );
    assert.deepEqual(
      [
        ...new Set(
          clip.frames.map((frame) => {
            const image = store.image(project.id, frame.imageId);
            return `${image.width}x${image.height}`;
          }),
        ),
      ],
      ["33x33"],
    );
    const image = store.image(project.id, clip.frames[1]!.imageId);
    const variant = await store.transform(
      project.id,
      image.id,
      image.revision,
      { scale: 0.5, offsetX: 2 },
    );
    assert.equal(variant.kind, "image");
    assert.equal(variant.origin?.assetId, image.id);
    assert.notEqual(variant.contentHash, image.contentHash);
    assert.equal(
      sha256(readFileSync(store.imagePath(project.id, source.id))),
      sha256(original),
    );
    const changed = store.updateClip(project.id, clip.id, {
      revision: clip.revision,
      frames: clip.frames.map((frame, index) =>
        index === 1 ? { ...frame, imageId: variant.id } : frame,
      ),
      loop: true,
    });
    assert.deepEqual(
      changed.frames.map((frame) => frame.id),
      clip.frames.map((frame) => frame.id),
    );
    assert.throws(
      () =>
        store.updateClip(project.id, clip.id, {
          revision: clip.revision,
          frames: clip.frames,
          loop: true,
        }),
      /动画已被其他操作修改/,
    );
    const exported = await store.exportClip(project.id, clip.id);
    assert.ok(
      readFileSync(exported.path).subarray(0, 4).equals(Buffer.from("RIFF")),
    );
    const decoded = spawnSync(
      process.env.SPRITE_STUDIO_PYTHON || "python",
      [
        "-c",
        "from PIL import Image; import sys,json; im=Image.open(sys.argv[1]); print(json.dumps({'frames':im.n_frames,'size':im.size,'loop':im.info['loop']}))",
        exported.path,
      ],
      { windowsHide: true },
    );
    assert.equal(decoded.status, 0, decoded.stderr.toString());
    assert.deepEqual(JSON.parse(decoded.stdout.toString()), {
      frames: 4,
      size: [33, 33],
      loop: 0,
    });
    const session = store.createSession(project.id);
    session.status = "running";
    store.saveSession(session);
    const restored = new ProjectStore(store.root);
    try {
      assert.deepEqual(
        (restored.asset(project.id, clip.id) as ClipAsset).frames,
        changed.frames,
      );
      assert.equal(restored.session(session.id).status, "interrupted");
      assert.equal(
        restored.image(project.id, source.id).contentHash,
        source.contentHash,
      );
    } finally {
      restored.worker.close();
    }
    writeFileSync(
      store.imagePath(project.id, image.id),
      Buffer.from("external modification"),
    );
    assert.throws(
      () => store.imagePath(project.id, image.id),
      /图片已被外部修改/,
    );
  } finally {
    store.worker.close();
  }
});

test("worker rejects paths outside its data root and refuses accidental clipping", async () => {
  const root = mkdtempSync(join(tmpdir(), "sprite-studio-path-test-"));
  const store = new ProjectStore(join(root, "projects"));
  const outside = join(root, "outside.png");
  const result = spawnSync(
    process.env.SPRITE_STUDIO_PYTHON || "python",
    [
      "-c",
      "from PIL import Image; import sys; Image.new('RGBA',(8,8),'red').save(sys.argv[1])",
      outside,
    ],
    { windowsHide: true },
  );
  assert.equal(result.status, 0);
  try {
    await assert.rejects(
      store.worker.run("inspect", { path: outside }),
      /图像路径必须在工作台数据目录内/,
    );
    const project = store.createProject("路径验证");
    const source = await store.importImage(
      project.id,
      "red.png",
      readFileSync(outside),
    );
    await assert.rejects(
      store.transform(project.id, source.id, source.revision, { offsetX: 4 }),
      /可见内容超出画布/,
    );
    assert.equal(store.assets(project.id).length, 1);
    const clipped = await store.transform(
      project.id,
      source.id,
      source.revision,
      { offsetX: 4, clip: true },
    );
    assert.equal(clipped.kind, "image");
  } finally {
    store.worker.close();
  }
});
