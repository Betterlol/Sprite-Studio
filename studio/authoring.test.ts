import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { ProjectStore } from "./store.ts";
import type { ClipAsset } from "./model.ts";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sprite-authoring-")),
    store = new ProjectStore(join(root, "projects")),
    pid = store.createProject("自由制作").id,
    session = store.createSession(pid),
    file = join(store.stage(pid), "generated.png");
  const made = spawnSync(
    process.env.SPRITE_STUDIO_PYTHON || "python",
    [
      "-c",
      "from PIL import Image; import sys; Image.new('RGBA',(32,32),'red').save(sys.argv[1])",
      file,
    ],
    { windowsHide: true },
  );
  assert.equal(made.status, 0, made.stderr.toString());
  const generated = await store.generated.capture(pid, session.id, {
    id: "generation-fixture",
    savedPath: file,
  });
  return { root, store, pid, session, file, generated };
}
test("generation is retained without registration; explicit save chooses exact category, name and folder, survives restart and retries", async () => {
  const { store, pid, generated, root, file } = await fixture();
  let restored: ProjectStore | undefined;
  try {
    assert.equal(store.assets(pid).length, 0);
    assert.equal(store.generated.list(pid).length, 1);
    const request = {
        generatedId: generated.id,
        type: "reference" as const,
        name: "设定图",
        folder: ".",
        requestId: randomUUID(),
      },
      reference = store.generated.save(pid, request);
    assert.equal(reference.name, "设定图.png");
    assert.equal(reference.file, "Assets/参考图/设定图.png");
    assert.equal(reference.kind, "reference");
    assert.equal(store.generated.save(pid, request).id, reference.id);
    assert.throws(
      () =>
        store.generated.save(pid, {
          ...request,
          name: "不同",
          requestId: request.requestId,
        }),
      /VERSION_CONFLICT/,
    );
    assert.throws(
      () => store.generated.save(pid, { ...request, requestId: randomUUID() }),
      /同名/,
    );
    const source = store.generated.save(pid, {
      ...request,
      type: "resource",
      name: "待机.png",
      folder: "骑士/待机",
      requestId: randomUUID(),
    });
    assert.equal(source.folder, "原图素材/骑士/待机");
    assert.deepEqual(
      readFileSync(store.imagePath(pid, source.id)),
      readFileSync(file),
    );
    assert.throws(() =>
      store.generated.save(pid, {
        ...request,
        folder: "../escape",
        requestId: randomUUID(),
      }),
    );
    const other = store.createProject("其他工程").id;
    assert.throws(() => store.generated.record(other, generated.id), /不存在/);
    store.worker.close();
    restored = new ProjectStore(join(root, "projects"));
    assert.equal(restored.generated.list(pid)[0]!.assetIds.length, 2);
    assert.deepEqual(
      readFileSync(restored.generated.imagePath(pid, generated.id)),
      readFileSync(file),
    );
  } finally {
    store.worker.close();
    restored?.worker.close();
  }
});
test("empty clip creation, free configuration, instance identity and browser edits share one config with stale-write protection", async () => {
  const { store, pid, generated, root } = await fixture();
  let restored: ProjectStore | undefined;
  try {
    const request = {
        name: "待机",
        fps: 8,
        folder: "骑士",
        requestId: randomUUID(),
      },
      clip = store.documents.createClip(pid, request);
    assert.equal(clip.frames.length, 0);
    assert.equal(clip.initialFps, 8);
    assert.equal(clip.folder, "动画/骑士");
    assert.equal(store.documents.createClip(pid, request).id, clip.id);
    await assert.rejects(store.exportClip(pid, clip.id), /没有帧/);
    await assert.rejects(
      store.animation.inspect(pid, { clipId: clip.id }),
      /没有帧/,
    );
    const source = store.generated.save(pid, {
      generatedId: generated.id,
      type: "resource",
      name: "帧",
      requestId: randomUUID(),
    });
    const old = store.documents.read(pid, clip.id),
      config = JSON.parse(old.text);
    config.frames = [
      { imageId: source.id, durationUs: 125000 },
      { imageId: source.id, durationUs: 250000 },
    ];
    const [saved] = store.documents.write(pid, [
      {
        documentId: clip.id,
        expectedDocumentRevision: old.documentRevision,
        text: JSON.stringify(config),
      },
    ]);
    const current = store.asset(pid, clip.id) as ClipAsset;
    assert.notEqual(current.frames[0]!.id, current.frames[1]!.id);
    assert.equal(current.frames.length, 2);
    const edited = store.updateClip(pid, clip.id, {
      revision: current.revision,
      frames: [...current.frames].reverse(),
      loop: false,
      initialFps: 10,
    });
    assert.deepEqual(
      JSON.parse(store.documents.read(pid, clip.id).text).frames,
      edited.frames,
    );
    assert.throws(
      () =>
        store.documents.write(pid, [
          {
            documentId: clip.id,
            expectedDocumentRevision: saved.documentRevision,
            text: saved.text,
          },
        ]),
      /VERSION_CONFLICT/,
    );
    store.library.relocate(
      pid,
      { assetIds: [clip.id], folders: [] },
      "动画",
      store.library.revision(pid),
      "新待机",
    );
    assert.equal(
      store.documents.read(pid, clip.id).path,
      "Assets/动画/新待机.clip.json.config.json",
    );
    const trash = store.library.delete(
      pid,
      { assetIds: [clip.id], folders: [] },
      store.library.revision(pid),
    );
    store.library.restore(pid, trash.id, store.library.revision(pid));
    store.worker.close();
    restored = new ProjectStore(join(root, "projects"));
    assert.equal(
      JSON.parse(restored.documents.read(pid, clip.id).text).initialFps,
      10,
    );
    const latest = restored.documents.read(pid, clip.id),
      blank = JSON.parse(latest.text);
    blank.frames = [];
    restored.documents.write(pid, [
      {
        documentId: clip.id,
        expectedDocumentRevision: latest.documentRevision,
        text: JSON.stringify(blank),
      },
    ]);
    assert.equal((restored.asset(pid, clip.id) as ClipAsset).frames.length, 0);
  } finally {
    store.worker.close();
    restored?.worker.close();
  }
});
test("mixed sheet and clip document batch validation prevents partial commits", async () => {
  const { store, pid, generated } = await fixture();
  try {
    const image = store.generated.save(pid, {
        generatedId: generated.id,
        type: "resource",
        name: "图集",
        requestId: randomUUID(),
      }),
      clip = store.documents.createClip(pid, {
        name: "动画",
        fps: 12,
        requestId: randomUUID(),
      });
    const sheet = store.documents.read(pid, image.id),
      animation = store.documents.read(pid, clip.id);
    assert.throws(
      () =>
        store.documents.write(pid, [
          {
            documentId: image.id,
            expectedDocumentRevision: sheet.documentRevision,
            text: sheet.text,
          },
          {
            documentId: clip.id,
            expectedDocumentRevision: animation.documentRevision,
            text: '{"schemaVersion":99}',
          },
        ]),
      /INVALID_DOCUMENT/,
    );
    assert.equal(store.sheets.read(pid, image.id).exists, false);
    assert.equal(
      store.documents.read(pid, clip.id).documentRevision,
      animation.documentRevision,
    );
  } finally {
    store.worker.close();
  }
});
