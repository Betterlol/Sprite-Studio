import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { ProjectStore } from "./store.ts";

function source(root: string) {
  const path = join(root, "idle.png");
  const result = spawnSync(
    process.env.SPRITE_STUDIO_PYTHON || "python",
    [
      "-c",
      "from PIL import Image,ImageDraw;import sys;im=Image.new('RGBA',(32,32));ImageDraw.Draw(im).rectangle((8,8,23,23),fill='red');im.save(sys.argv[1])",
      path,
    ],
    { windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr.toString());
  return readFileSync(path);
}

test("IDLE baseline configuration is validated, persisted and cleared without touching frames", async () => {
  const root = mkdtempSync(join(tmpdir(), "sprite-idle-guide-"));
  let store = new ProjectStore(join(root, "projects"));
  const pid = store.createProject("IDLE 叠图验证").id;
  let clipId = "";
  try {
    const image = await store.importImage(pid, "idle.png", source(root));
    const clip = store.createClip(
      pid,
      "idle",
      [0, 1].map(() => ({
        id: crypto.randomUUID(),
        imageId: image.id,
        durationUs: 100000,
      })),
    );
    clipId = clip.id;
    assert.equal(store.project(pid).idle, undefined, "新工程没有 IDLE 基准图");
    const before = store.project(pid);

    store.setIdle(pid, { kind: "clip", assetId: clip.id, opacity: 0.35 });
    assert.deepEqual(store.state(pid).project.idle, {
      kind: "clip",
      assetId: clip.id,
      opacity: 0.35,
    });
    store.setIdle(pid, { kind: "image", assetId: image.id });
    assert.deepEqual(store.project(pid).idle, {
      kind: "image",
      assetId: image.id,
      opacity: 0.22,
    });
    assert.equal(store.project(pid).name, before.name, "只改叠图配置，不碰工程其它字段");
    assert.deepEqual(
      store.animation.clip(pid, clip.id).frames,
      clip.frames,
      "叠图配置不写入帧",
    );

    assert.throws(
      () => store.setIdle(pid, { kind: "image", assetId: crypto.randomUUID() }),
      /不存在|请选择/,
    );
    assert.throws(
      () => store.setIdle(pid, { kind: "clip", assetId: image.id }),
      /动画/,
      "图片不能被当作动画来源",
    );
    assert.throws(
      () => store.setIdle(pid, { kind: "image", assetId: image.id, opacity: 2 }),
      /Too big|小于|greater/i,
    );
    const empty = store.createClip(pid, "空动画", []);
    assert.throws(
      () => store.setIdle(pid, { kind: "clip", assetId: empty.id }),
      /还没有帧/,
    );
  } finally {
    store.worker.close();
  }
  // A restart must keep the configuration: it belongs to project.json.
  store = new ProjectStore(join(root, "projects"));
  try {
    assert.equal(store.project(pid).idle?.kind, "image");
    assert.equal(store.project(pid).idle?.opacity, 0.22);
    store.clearIdle(pid);
    assert.equal(store.project(pid).idle, undefined);
    assert.ok(store.animation.clip(pid, clipId).frames.length, "清除叠图配置不影响动画");
  } finally {
    store.worker.close();
  }
});
