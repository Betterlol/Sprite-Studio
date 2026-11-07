import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { ProjectStore, atomicJson } from "./store.ts";
import type { SheetDocument } from "./sheets.ts";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sprite-recipes-")),
    path = join(root, "sheet.png");
  const result = spawnSync(
    process.env.SPRITE_STUDIO_PYTHON || "python",
    [
      "-c",
      "from PIL import Image,ImageDraw; import sys; im=Image.new('RGBA',(64,32)); d=ImageDraw.Draw(im); d.rectangle((4,4,27,27),fill='red'); d.rectangle((36,4,59,27),fill='blue'); im.save(sys.argv[1])",
      path,
    ],
    { windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr.toString());
  const store = new ProjectStore(join(root, "projects")),
    pid = store.createProject("配方验证").id;
  const image = await store.importImage(
    pid,
    "sheet.png",
    readFileSync(path),
    "image",
  );
  const draft = store.sheets.read(pid, image.id);
  assert.equal(draft.recipe.slicing.method, "grid");
  if (draft.recipe.slicing.method !== "grid") throw new Error("expected grid");
  draft.recipe.slicing.grid.columns = 2;
  draft.recipe.slicing.items = [
    { cell: [0, 0], name: "01", enabled: true },
    { cell: [1, 0], name: "02", enabled: true },
  ];
  const save = (doc: SheetDocument) =>
    store.sheets.write(pid, [
      {
        documentId: image.id,
        expectedDocumentRevision: doc.documentRevision,
        text: JSON.stringify(doc.recipe),
      },
    ])[0]!;
  return { root, store, pid, image, save, doc: save(draft) };
}

test("prepared config publication is rolled back on restart before assets load", async () => {
  const { root, store, pid, image, doc } = await fixture();
  let restored: ProjectStore | undefined;
  try {
    const prefix = `.studio/config-operations/${randomUUID()}`,
      file = store.safePath(pid, doc.path),
      original = readFileSync(file);
    mkdirSync(store.safePath(pid, prefix), { recursive: true });
    writeFileSync(store.safePath(pid, prefix + "/before"), original);
    writeFileSync(store.safePath(pid, prefix + "/after"), "incomplete json");
    atomicJson(store.safePath(pid, prefix + "/operation.json"), {
      status: "prepared",
      files: [
        {
          path: doc.path,
          before: prefix + "/before",
          after: prefix + "/after",
        },
      ],
      directories: [],
      result: {},
    });
    writeFileSync(file, "incomplete json");
    store.worker.close();
    restored = new ProjectStore(join(root, "projects"));
    assert.deepEqual(readFileSync(file), original);
    assert.equal(
      restored.sheets.read(pid, image.id).documentRevision,
      doc.documentRevision,
    );
    assert.equal(
      JSON.parse(
        readFileSync(
          restored.safePath(pid, prefix + "/operation.json"),
          "utf8",
        ),
      ).status,
      "rolledBack",
    );
  } finally {
    store.worker.close();
    restored?.worker.close();
  }
});

test("recipe text persists; repeat slicing preserves identities, pixels, references and directory sidecars", async () => {
  const { root, store, pid, image, save, doc } = await fixture();
  let restored: ProjectStore | undefined;
  try {
    const beforeCount = store.assets(pid).length,
      requestId = randomUUID();
    const first = await store.sheets.execute(
      pid,
      image.id,
      doc.definitionRevision,
      requestId,
    );
    assert.equal(store.assets(pid).length, beforeCount + 2);
    assert.equal(store.assets(pid).filter((a) => a.type === "clip").length, 0);
    assert.deepEqual(
      await store.sheets.execute(
        pid,
        image.id,
        doc.definitionRevision,
        requestId,
      ),
      first,
    );
    assert.equal(store.sheets.read(pid, image.id).status, "ready");
    const hashes = first.outputIds.map(
      (id) => store.image(pid, id).contentHash,
    );
    const clip = store.createClip(
      pid,
      "复用",
      first.outputIds.map((imageId) => ({
        id: randomUUID(),
        imageId,
        durationUs: 100000,
      })),
    );
    const snapshot = store.animation.capture(pid, clip.id);
    const next = store.sheets.read(pid, image.id);
    if (next.recipe.slicing.method !== "grid") throw new Error("expected grid");
    next.recipe.slicing.items.reverse();
    next.recipe.slicing.items[0]!.cell = [0, 0];
    next.recipe.slicing.items[1]!.cell = [1, 0];
    const saved = save(next);
    assert.equal(store.sheets.read(pid, image.id).status, "dirty");
    const second = await store.sheets.execute(
      pid,
      image.id,
      saved.definitionRevision,
      randomUUID(),
    );
    assert.deepEqual(second.outputIds, [...first.outputIds].reverse());
    assert.deepEqual(
      first.outputIds.map((id) => store.image(pid, id).contentHash),
      [...hashes].reverse(),
    );
    assert.deepEqual(
      (store.asset(pid, clip.id) as typeof clip).frames,
      clip.frames,
    );
    assert.ok(
      existsSync(
        store.animation.imagePath(pid, snapshot.id, clip.frames[0]!.id).path,
      ),
    );
    assert.equal(store.assets(pid).length, beforeCount + 3);
    assert.throws(() => {
      const changed = store.sheets.read(pid, image.id);
      changed.recipe.slicing.items[0]!.enabled = false;
      save(changed);
    }, /仍被使用/);
    assert.throws(
      () =>
        store.library.delete(
          pid,
          { assetIds: [image.id], folders: [] },
          store.library.revision(pid),
        ),
      /切片仍引用/,
    );
    const oldPath = store.sheets.read(pid, image.id).path;
    store.library.relocate(
      pid,
      { assetIds: [image.id], folders: [] },
      "原图素材",
      store.library.revision(pid),
      "renamed.png",
    );
    assert.equal(existsSync(store.safePath(pid, oldPath)), false);
    assert.equal(store.sheets.read(pid, image.id).status, "ready");
    store.worker.close();
    restored = new ProjectStore(join(root, "projects"));
    assert.deepEqual(
      restored.sheets.read(pid, image.id).outputIds,
      second.outputIds,
    );
    assert.equal(restored.sheets.read(pid, image.id).status, "ready");
  } finally {
    store.worker.close();
    restored?.worker.close();
  }
});

test("invalid or stale document batches never partially save; changing a config during slicing rejects publication", async () => {
  const { store, pid, image, save, doc } = await fixture();
  try {
    const other = await store.importImage(
      pid,
      "other.png",
      readFileSync(store.imagePath(pid, image.id)),
      "image",
    );
    const otherDoc = store.sheets.read(pid, other.id);
    const changed = structuredClone(doc);
    changed.recipe.slicing.items[0]!.name = "edited";
    assert.throws(
      () =>
        store.sheets.write(pid, [
          {
            documentId: other.id,
            expectedDocumentRevision: otherDoc.documentRevision,
            text: otherDoc.text,
          },
          {
            documentId: image.id,
            expectedDocumentRevision: "stale",
            text: doc.text,
          },
        ]),
      /VERSION_CONFLICT/,
    );
    assert.equal(store.sheets.read(pid, other.id).exists, false);
    assert.throws(
      () =>
        store.sheets.write(pid, [
          {
            documentId: image.id,
            expectedDocumentRevision: doc.documentRevision,
            text: '{"schemaVersion":99}',
          },
        ]),
      /INVALID_DOCUMENT/,
    );
    assert.equal(
      store.sheets.read(pid, image.id).documentRevision,
      doc.documentRevision,
    );
    const original = store.worker.run.bind(store.worker);
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    store.worker.run = async (method, params) => {
      if (method === "recipe_slice") {
        entered();
        await gate;
      }
      return original(method, params);
    };
    const pending = store.sheets.execute(
      pid,
      image.id,
      doc.definitionRevision,
      randomUUID(),
    );
    await started;
    save(changed);
    release();
    await assert.rejects(pending, /切割期间/);
    assert.equal(
      store.assets(pid).filter((a) => a.type === "image" && a.producer).length,
      0,
    );
    assert.throws(() => save(doc), /VERSION_CONFLICT/);
  } finally {
    store.worker.close();
  }
});

test("multi-file publication failure rolls back new slice images and IDs, then retry succeeds", async () => {
  const { store, pid, image, doc } = await fixture();
  try {
    const folder = doc.recipe.slicing.outputFolder,
      item = doc.recipe.slicing.items[0]!,
      output = `Assets/${folder}/${item.name}-${item.id!.slice(0, 8)}.png`;
    const original = store.safePath.bind(store);
    let failed = false;
    store.safePath = (project, path) => {
      if (
        !failed &&
        path === output + ".meta.json" &&
        existsSync(original(project, output))
      ) {
        failed = true;
        throw new Error("injected publication failure");
      }
      return original(project, path);
    };
    const requestId = randomUUID();
    await assert.rejects(
      store.sheets.execute(pid, image.id, doc.definitionRevision, requestId),
      /injected/,
    );
    store.safePath = original;
    assert.equal(failed, true);
    assert.equal(existsSync(store.safePath(pid, output)), false);
    assert.equal(store.assets(pid).length, 1);
    const receipt = await store.sheets.execute(
      pid,
      image.id,
      doc.definitionRevision,
      requestId,
    );
    assert.equal(receipt.outputIds.length, 2);
    const trash = store.library.delete(
      pid,
      { assetIds: [image.id, ...receipt.outputIds], folders: [] },
      store.library.revision(pid),
    );
    assert.equal(store.assets(pid).length, 0);
    store.library.restore(pid, trash.id, store.library.revision(pid));
    assert.equal(store.sheets.read(pid, image.id).status, "ready");
  } finally {
    store.worker.close();
  }
});
