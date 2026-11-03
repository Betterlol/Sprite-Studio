import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ProjectStore, atomicJson, sha256 } from "./store.ts";
import type { ClipAsset, LibrarySelection } from "./model.ts";

const assets = (...ids: string[]): LibrarySelection => ({
  assetIds: ids,
  folders: [],
});
const folders = (...paths: string[]): LibrarySelection => ({
  assetIds: [],
  folders: paths,
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sprite-library-")),
    file = join(root, "sheet.png");
  const result = spawnSync(
    process.env.SPRITE_STUDIO_PYTHON || "python",
    [
      "-c",
      "from PIL import Image,ImageDraw; import sys; im=Image.new('RGBA',(64,32)); d=ImageDraw.Draw(im); d.rectangle((8,8,23,23),fill='red'); d.rectangle((40,8,55,23),fill='blue'); im.save(sys.argv[1])",
      file,
    ],
    { windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr.toString());
  const store = new ProjectStore(join(root, "projects")),
    pid = store.createProject("目录验证").id;
  const sheet = await store.importImage(pid, "sheet.png", readFileSync(file));
  const clip = await store.slice(pid, sheet.id, sheet.revision, {
    columns: 2,
    rows: 1,
    fps: 8,
  });
  const rev = () => store.library.revision(pid);
  return { root, store, pid, sheet, clip, rev };
}

test("real directories preserve IDs, snapshot validity and frame adoption/revert after rename, move and restart", async () => {
  const { root, store, pid, sheet, clip, rev } = await fixture();
  let reloaded: ProjectStore | undefined;
  try {
    const before = store.animation.capture(pid, clip.id),
      review = await store.animation.inspect(pid, { snapshotId: before.id });
    const job = store.interpolations.create(pid, {
      requestId: randomUUID(),
      clipId: clip.id,
      revision: clip.revision,
      startFrameId: clip.frames[0]!.id,
      endFrameId: clip.frames[1]!.id,
      count: 1,
      fps: 8,
      description: "目录移动回归",
    });
    job.sheetId = sheet.id;
    job.status = "candidate";
    store.interpolations.save(job);
    store.library.createFolder(pid, "", "角色", rev());
    store.library.createFolder(pid, "角色", "空目录", rev());
    const oldRevision = rev();
    store.library.relocate(pid, folders(clip.folder!), "角色", rev());
    assert.throws(
      () => store.library.createFolder(pid, "", "旧列表", oldRevision),
      /列表已变化/,
    );
    store.library.relocate(pid, assets(sheet.id), "角色", rev(), "角色图.png");
    store.library.relocate(
      pid,
      assets(clip.id),
      store.asset(pid, clip.id).folder!,
      rev(),
      "待机",
    );
    assert.equal(store.asset(pid, clip.id).revision, clip.revision);
    assert.equal(store.image(pid, sheet.id).revision, sheet.revision);
    assert.equal(store.animation.review(pid, review.id).stale, false);
    const prepared = await store.interpolations.prepare(pid, job.id, {
      columns: 1,
      rows: 1,
      includesEndpoints: false,
      fps: 8,
    });
    assert.ok(prepared.prepared);
    // Moving a prepared candidate and both endpoint images does not expire the job.
    store.library.relocate(pid, folders("角色"), "", rev(), "主角");
    const appliedInterpolation = store.interpolations.apply(pid, job.id);
    assert.equal(appliedInterpolation.frames.length, 3);
    const change = await store.animation.propose(
      pid,
      {
        requestId: randomUUID(),
        clipId: clip.id,
        revision: appliedInterpolation.revision,
        frameId: appliedInterpolation.frames[1]!.id,
        durationUs: 75000,
      },
      "human",
    );
    store.library.relocate(pid, assets(change.candidateClipId), "主角", rev());
    const candidate = store.asset(pid, change.candidateClipId) as ClipAsset;
    store.animation.apply(pid, change.id, candidate.revision);
    store.worker.close();
    reloaded = new ProjectStore(join(root, "projects"));
    assert.ok(reloaded.library.folders(pid).includes("主角/空目录"));
    assert.equal(reloaded.asset(pid, clip.id).name, "待机");
    assert.deepEqual(
      (reloaded.asset(pid, clip.id) as ClipAsset).frames,
      candidate.frames,
    );
    const reverted = reloaded.animation.revert(
      pid,
      change.id,
      reloaded.asset(pid, clip.id).revision,
    );
    assert.deepEqual(reverted.frames, appliedInterpolation.frames);
    const exported = await reloaded.exportClip(pid, clip.id);
    assert.ok(existsSync(exported.path));
    assert.equal(
      sha256(readFileSync(reloaded.imagePath(pid, sheet.id))),
      sheet.contentHash,
    );
    assert.ok(
      existsSync(reloaded.safePath(pid, reloaded.metaPath(pid, sheet.id))),
    );
  } finally {
    store.worker.close();
    reloaded?.worker.close();
  }
});

test("batch deletion protects outside references and undo dependencies; trash restores real files and empty folders across restart", async () => {
  const { root, store, pid, clip, rev } = await fixture();
  let reloaded: ProjectStore | undefined;
  try {
    const frameIds = clip.frames.map((f) => f.imageId);
    assert.ok(
      store.library
        .planDelete(pid, assets(frameIds[0]!))
        .blockers.some((b) => b.name === clip.name),
    );
    const reused = store.createClip(
      pid,
      "复用动画",
      clip.frames,
      undefined,
      true,
      "",
    );
    assert.throws(
      () => store.library.delete(pid, folders(clip.folder!), rev()),
      /复用动画/,
    );
    store.library.delete(pid, assets(reused.id), rev());
    const change = await store.animation.propose(
      pid,
      {
        requestId: randomUUID(),
        clipId: clip.id,
        revision: clip.revision,
        frameId: clip.frames[0]!.id,
        transform: { scale: 0.5 },
      },
      "human",
    );
    const candidate = store.asset(pid, change.candidateClipId) as ClipAsset;
    store.animation.apply(pid, change.id, candidate.revision);
    assert.ok(
      store.library
        .planDelete(pid, assets(frameIds[0]!))
        .blockers.some((b) => b.reason.includes("撤回")),
    );
    store.animation.revert(pid, change.id, store.asset(pid, clip.id).revision);
    // The separate candidate also uses the remaining frame; delete it in the same batch.
    const selection = { assetIds: [candidate.id], folders: [clip.folder!] };
    store.library.createFolder(pid, clip.folder!, "空", rev());
    const snapshot = store.animation.capture(pid, clip.id);
    const trash = store.library.delete(pid, selection, rev());
    assert.ok(!store.indexes.get(pid)!.has(clip.id));
    assert.ok(!existsSync(join(store.dir(pid), "Assets", clip.folder!)));
    assert.ok(
      existsSync(
        store.animation.imagePath(pid, snapshot.id, clip.frames[0]!.id).path,
      ),
    );
    store.worker.close();
    reloaded = new ProjectStore(join(root, "projects"));
    assert.ok(reloaded.library.trash(pid).some((e) => e.id === trash.id));
    // Original directory conflict must not overwrite even an empty folder.
    reloaded.library.createFolder(
      pid,
      "",
      clip.folder!,
      reloaded.library.revision(pid),
    );
    assert.throws(
      () =>
        reloaded!.library.restore(
          pid,
          trash.id,
          reloaded!.library.revision(pid),
        ),
      /同名/,
    );
    reloaded.library.relocate(
      pid,
      folders(clip.folder!),
      "",
      reloaded.library.revision(pid),
      "保留目录",
    );
    reloaded.library.restore(pid, trash.id, reloaded.library.revision(pid));
    assert.deepEqual(
      (reloaded.asset(pid, clip.id) as ClipAsset).frames,
      clip.frames,
    );
    assert.ok(reloaded.library.folders(pid).includes(`${clip.folder}/空`));
    assert.ok(!reloaded.library.trash(pid).some((e) => e.id === trash.id));
    for (const id of frameIds)
      assert.ok(existsSync(reloaded.imagePath(pid, id)));
    const removedClips = reloaded.library.delete(
      pid,
      assets(clip.id, candidate.id),
      reloaded.library.revision(pid),
    );
    const removedImage = reloaded.library.delete(
      pid,
      assets(frameIds[0]!),
      reloaded.library.revision(pid),
    );
    assert.throws(
      () =>
        reloaded!.library.restore(
          pid,
          removedClips.id,
          reloaded!.library.revision(pid),
        ),
      /先恢复/,
    );
    reloaded.library.restore(
      pid,
      removedImage.id,
      reloaded.library.revision(pid),
    );
    reloaded.library.restore(
      pid,
      removedClips.id,
      reloaded.library.revision(pid),
    );
    assert.deepEqual(
      (reloaded.asset(pid, clip.id) as ClipAsset).frames,
      clip.frames,
    );
  } finally {
    store.worker.close();
    reloaded?.worker.close();
  }
});

test("legacy flat sidecars load without rewriting and organization rejects invalid names, descendants and active work", async () => {
  const { root, store, pid, sheet, rev } = await fixture();
  let reloaded: ProjectStore | undefined;
  try {
    const legacyFile = `Assets/${sheet.id}.png`,
      legacyMeta = `Assets/${sheet.id}.meta.json`,
      priorMeta = store.metaPath(pid, sheet.id);
    renameSync(store.imagePath(pid, sheet.id), store.safePath(pid, legacyFile));
    renameSync(store.safePath(pid, priorMeta), store.safePath(pid, legacyMeta));
    const { folder, ...legacy } = sheet;
    atomicJson(store.safePath(pid, legacyMeta), {
      ...legacy,
      file: legacyFile,
    });
    const bytes = readFileSync(store.safePath(pid, legacyMeta));
    store.worker.close();
    reloaded = new ProjectStore(join(root, "projects"));
    assert.deepEqual(readFileSync(reloaded.safePath(pid, legacyMeta)), bytes);
    assert.equal(reloaded.image(pid, sheet.id).revision, sheet.revision);
    const duplicate = await reloaded.importImage(
      pid,
      "sheet.png",
      readFileSync(reloaded.imagePath(pid, sheet.id)),
    );
    assert.equal(duplicate.name, "sheet (2).png");
    const longName = await reloaded.importImage(
      pid,
      "x".repeat(140) + ".png",
      readFileSync(reloaded.imagePath(pid, sheet.id)),
    );
    assert.ok(longName.name.endsWith(".png"));
    assert.ok(longName.file.endsWith(".png"));
    const lib = reloaded.library,
      current = () => lib.revision(pid);
    for (const name of ["..", "CON", "folder.", "a/b", "a\\b", " bad"])
      assert.throws(() => lib.createFolder(pid, "", name, current()));
    lib.createFolder(pid, "", "角色", current());
    lib.createFolder(pid, "角色", "动作", current());
    assert.throws(
      () => lib.relocate(pid, folders("角色"), "角色/动作", current()),
      /自身或子目录/,
    );
    assert.throws(
      () => lib.relocate(pid, assets(sheet.id), "../outside", current()),
      /目录/,
    );
    assert.throws(() => lib.delete(pid, folders(""), current()), /根目录/);
    const session = reloaded.createSession(pid);
    session.status = "running";
    assert.throws(
      () => lib.delete(pid, assets(sheet.id), current()),
      /正在处理/,
    );
    session.status = "idle";
    let release!: () => void;
    const reading = reloaded.reading(
      pid,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    assert.throws(
      () => lib.relocate(pid, assets(sheet.id), "角色", current()),
      /正在处理/,
    );
    release();
    await reading;
    lib.relocate(pid, assets(sheet.id), "角色", current());
    assert.equal(reloaded.image(pid, sheet.id).revision, sheet.revision);
    assert.ok(existsSync(reloaded.imagePath(pid, sheet.id)));
  } finally {
    store.worker.close();
    reloaded?.worker.close();
  }
});

test("unfinished directory moves roll back metadata and bytes on startup; committed records survive repeated recovery", async () => {
  const { root, store, pid, clip, rev } = await fixture();
  let reloaded: ProjectStore | undefined;
  try {
    const oldFolder = clip.folder!,
      newFolder = "中断移动",
      original = store.assets(pid).filter((a) => a.folder === oldFolder);
    const writes = original.map((a) => {
      const oldMeta = store.metaPath(pid, a.id),
        path = oldMeta.replace(`Assets/${oldFolder}/`, `Assets/${newFolder}/`),
        before = readFileSync(store.safePath(pid, oldMeta), "utf8");
      return {
        path,
        before,
        after: JSON.stringify({
          ...JSON.parse(before),
          folder: newFolder,
          file: a.file!.replace(`Assets/${oldFolder}/`, `Assets/${newFolder}/`),
        }),
      };
    });
    const journalDir = join(store.dir(pid), ".studio", "library-operations");
    mkdirSync(journalDir, { recursive: true });
    const journal = {
      id: randomUUID(),
      status: "prepared",
      moves: [{ from: `Assets/${oldFolder}`, to: `Assets/${newFolder}` }],
      writes,
      directories: [],
    };
    atomicJson(join(journalDir, `${journal.id}.json`), journal);
    renameSync(
      store.safePath(pid, `Assets/${oldFolder}`),
      store.safePath(pid, `Assets/${newFolder}`),
    );
    for (const write of writes)
      atomicJson(store.safePath(pid, write.path), JSON.parse(write.after));
    store.worker.close();
    reloaded = new ProjectStore(join(root, "projects"));
    assert.ok(existsSync(reloaded.safePath(pid, `Assets/${oldFolder}`)));
    assert.ok(!existsSync(reloaded.safePath(pid, `Assets/${newFolder}`)));
    for (const a of original) {
      assert.equal(reloaded.asset(pid, a.id).file, a.file);
      assert.equal(reloaded.asset(pid, a.id).revision, a.revision);
    }
    const restored = readFileSync(
      join(journalDir, `${journal.id}.json`),
      "utf8",
    );
    assert.equal(JSON.parse(restored).status, "rolledBack");
    reloaded.library.recover(pid);
    assert.equal(
      readFileSync(join(journalDir, `${journal.id}.json`), "utf8"),
      restored,
    );
    reloaded.library.relocate(
      pid,
      folders(oldFolder),
      "",
      reloaded.library.revision(pid),
      "已提交",
    );
    reloaded.library.recover(pid);
    reloaded.loadAssets(pid);
    assert.equal(reloaded.asset(pid, clip.id).folder, "已提交");
    // Simulate a write failure after the file move; synchronous rollback restores the source.
    const source = reloaded.asset(pid, clip.frames[0]!.imageId),
      destination = "Assets/回滚图片.png";
    const originalPath = reloaded.library.path.bind(reloaded.library);
    let failed = false;
    reloaded.library.path = (project, path) => {
      if (
        !failed &&
        path === destination + ".meta.json" &&
        existsSync(originalPath(project, destination)) &&
        existsSync(originalPath(project, destination + ".meta.json")) &&
        !existsSync(originalPath(project, source.file!))
      ) {
        failed = true;
        throw new Error("injected metadata write failure");
      }
      return originalPath(project, path);
    };
    assert.throws(
      () =>
        reloaded!.library.relocate(
          pid,
          assets(source.id),
          "",
          reloaded!.library.revision(pid),
          "回滚图片.png",
        ),
      /injected/,
    );
    assert.equal(failed, true);
    reloaded.library.path = originalPath;
    assert.ok(existsSync(reloaded.imagePath(pid, source.id)));
    assert.ok(!existsSync(reloaded.safePath(pid, destination)));
  } finally {
    store.worker.close();
    reloaded?.worker.close();
  }
});
