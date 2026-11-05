import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { ProjectStore } from "./store.ts";
import { AgentHub } from "./agent.ts";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sprite-frame-config-")),
    path = join(root, "source.png");
  const result = spawnSync(
    process.env.SPRITE_STUDIO_PYTHON || "python",
    [
      "-c",
      "from PIL import Image,ImageDraw;import sys;im=Image.new('RGBA',(96,96));ImageDraw.Draw(im).rectangle((24,24,71,71),fill='red');im.save(sys.argv[1])",
      path,
    ],
    { windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr.toString());
  const store = new ProjectStore(join(root, "projects")),
    pid = store.createProject("单帧配置验证").id;
  const image = await store.importImage(pid, "source.png", readFileSync(path));
  const clip = store.createClip(
    pid,
    "动画",
    [0, 1, 2].map(() => ({
      id: crypto.randomUUID(),
      imageId: image.id,
      durationUs: 100000,
    })),
  );
  store.frameDrafts.setPolicy("ask");
  // Exercise the host tool handlers without starting a remote Codex process.
  const hub: AgentHub = Object.assign(Object.create(AgentHub.prototype), {
    store,
    frameSaves: new Map(),
    timers: new Map(),
    prompts: new Map(),
    clients: new Map(),
  });
  return { store, pid, image, clip, hub };
}
function edit(
  store: ProjectStore,
  pid: string,
  id: string,
  scale: number,
  offsetX = 0,
  frameId?: string,
) {
  const doc = store.documents.read(pid, id),
    config = JSON.parse(doc.text);
  const frame = config.frames.find(
    (f: any) => f.frameId === (frameId || doc.draft.frameId),
  );
  frame.transform.scale = scale;
  frame.transform.offsetX = offsetX;
  return store.documents.write(pid, [
    {
      documentId: id,
      expectedDocumentRevision: doc.documentRevision,
      text: JSON.stringify(config),
    },
  ])[0]!;
}
async function pending(session: any) {
  for (let i = 0; i < 100 && !session.frameSaveApproval; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(session.frameSaveApproval, "save must enter approval state");
  return session.frameSaveApproval;
}

test("one animation draft accumulates multiple frames, previews and saves them together without creating assets", async () => {
  const { store, pid, clip } = await fixture();
  try {
    const count = store.assets(pid).length,
      original = store.documents.read(pid, clip.id).text;
    let doc = store.frameDrafts.create(
      pid,
      { clipId: clip.id, revision: clip.revision, frameId: clip.frames[1]!.id },
      "human",
    );
    doc = edit(store, pid, doc.documentId, 0.5, 4);
    const first = await store.frameDrafts.preview(
      pid,
      doc.documentId,
      doc.documentRevision,
    );
    const another = store.frameDrafts.create(
      pid,
      { clipId: clip.id, revision: clip.revision, frameId: clip.frames[0]!.id },
      "human",
    );
    assert.equal(
      another.documentId,
      doc.documentId,
      "switching frames must reuse the same animation draft",
    );
    doc = edit(store, pid, another.documentId, 0.25, 0, clip.frames[0]!.id);
    const preview = await store.frameDrafts.preview(
      pid,
      doc.documentId,
      doc.documentRevision,
    );
    assert.notEqual(preview.preview.id, first.preview.id);
    assert.equal(preview.preview.clip.frames[1]!.transform!.scale, 0.5);
    assert.equal(preview.modifiedFrameIds.length, 2);
    assert.equal(preview.warnings.length, 0);
    assert.equal(store.documents.read(pid, clip.id).text, original);
    const inspection = await store.animation.inspect(pid, {
      snapshotId: preview.preview.id,
      draftId: doc.documentId,
      documentRevision: doc.documentRevision,
    });
    assert.equal(inspection.stale, false);
    assert.deepEqual(
      inspection.frames.map((f) => f.width),
      [14, 24, 48],
    );
    assert.ok(
      readFileSync(store.animation.evidence(pid, inspection.id, "onion"))
        .length > 100,
    );
    const rendered = await Promise.all(
      clip.frames.map((f) =>
        store.animation.renderFrame(pid, preview.preview.id, f.id),
      ),
    );
    const change = await store.frameDrafts.save(
        pid,
        doc.documentId,
        doc.documentRevision,
      ),
      saved = store.animation.clip(pid, clip.id);
    assert.equal(change.frameIds!.length, 2);
    assert.equal(store.animation.listChanges(pid).length, 1);
    assert.deepEqual(
      saved.frames.map((f) => f.imageId),
      clip.frames.map((f) => f.imageId),
    );
    assert.deepEqual(saved.frames[2], clip.frames[2]);
    assert.equal(store.assets(pid).length, count);
    const after = store.animation.capture(pid, clip.id);
    for (let i = 0; i < clip.frames.length; i++)
      assert.deepEqual(
        readFileSync(
          (await store.animation.renderFrame(pid, after.id, clip.frames[i]!.id))
            .path,
        ),
        readFileSync(rendered[i]!.path),
      );
    assert.equal(
      (await store.frameDrafts.save(pid, doc.documentId, doc.documentRevision))
        .id,
      change.id,
    );
    assert.ok(
      readFileSync((await store.exportClip(pid, clip.id)).path).length > 20,
    );
    let next = store.frameDrafts.create(
      pid,
      {
        clipId: clip.id,
        revision: saved.revision,
        frameId: clip.frames[1]!.id,
      },
      "human",
    );
    assert.equal(JSON.parse(next.text).frames[1].transform.scale, 0.5);
    next = edit(store, pid, next.documentId, 0.25);
    const p = await store.frameDrafts.preview(
        pid,
        next.documentId,
        next.documentRevision,
      ),
      r = await store.animation.inspect(pid, { snapshotId: p.preview.id });
    assert.equal(
      r.frames[1]!.width,
      14,
      "quarter scale starts from source pixels rather than resampling the previous result",
    );
    assert.equal(store.assets(pid).length, count);
    store.frameDrafts.discard(pid, next.documentId, next.documentRevision);
    assert.equal(store.asset(pid, clip.id).revision, saved.revision);
    assert.deepEqual(
      store.animation.revert(pid, change.id, saved.revision).frames,
      clip.frames,
      "one undo restores the whole batch",
    );
  } finally {
    store.worker.close();
  }
});

test("Agent edits config, previews, receives denial reason, and only exact Accept saves", async () => {
  const { store, pid, clip, hub } = await fixture();
  const session = store.createSession(pid);
  try {
    const created = await hub.tool(session.id, "create_frame_draft", {
      clipId: clip.id,
      revision: clip.revision,
      frameId: clip.frames[1]!.id,
    });
    let doc = JSON.parse((created.content[0] as { text: string }).text);
    const config = JSON.parse(doc.text);
    config.frames[1].transform.scale = 0.5;
    config.frames[2].transform.offsetX = 3;
    const written = await hub.tool(session.id, "write_documents", {
      documents: [
        {
          documentId: doc.documentId,
          expectedDocumentRevision: doc.documentRevision,
          text: JSON.stringify(config),
        },
      ],
    });
    doc = JSON.parse((written.content[0] as { text: string }).text)[0];
    const review = await hub.tool(session.id, "inspect_clip", {
      draftId: doc.documentId,
      documentRevision: doc.documentRevision,
    });
    assert.ok(review.content.some((c: any) => c.type === "image"));
    let saving = hub.tool(session.id, "save_frame_draft", {
      draftId: doc.documentId,
      documentRevision: doc.documentRevision,
    });
    let approval = await pending(session);
    assert.equal(store.asset(pid, clip.id).revision, clip.revision);
    assert.throws(() => edit(store, pid, doc.documentId, 0.7), /等待审批/);
    await hub.resolveFrameSave(
      session.id,
      approval.id,
      false,
      "缩小过头了，请改到75%",
    );
    const denied = JSON.parse(
      ((await saving).content[0] as { text: string }).text,
    );
    assert.equal(denied.saved, false);
    assert.match(denied.reason, /75%/);
    assert.equal(store.asset(pid, clip.id).revision, clip.revision);
    doc = edit(store, pid, doc.documentId, 0.75);
    saving = hub.tool(session.id, "save_frame_draft", {
      draftId: doc.documentId,
      documentRevision: doc.documentRevision,
    });
    approval = await pending(session);
    assert.equal(approval.after.transform.scale, 0.75);
    assert.equal(approval.frameChanges.length, 2);
    assert.equal(approval.frameChanges[1].after.transform.offsetX, 3);
    assert.equal(approval.before.transform, undefined);
    const accepted = await hub.resolveFrameSave(session.id, approval.id, true);
    assert.equal(accepted.saved, true);
    assert.equal(
      JSON.parse(((await saving).content[0] as { text: string }).text).saved,
      true,
    );
    assert.equal(
      store.animation.clip(pid, clip.id).frames[1]!.transform!.scale,
      0.75,
    );
    assert.equal(
      store.animation.clip(pid, clip.id).frames[2]!.transform!.offsetX,
      3,
    );
    assert.equal(store.animation.listChanges(pid).length, 1);
    assert.equal(session.frameSaveApproval, undefined);
    await assert.rejects(
      hub.resolveFrameSave(session.id, approval.id, true),
      /已结束/,
    );
  } finally {
    hub.cancelFrameSave(session, "测试结束");
    store.worker.close();
  }
});

test("stale animation, live pixels, clipping, drafts and cross-project documents cannot be saved silently", async () => {
  const { store, pid, clip, image, hub } = await fixture();
  const session = store.createSession(pid);
  try {
    let doc = store.frameDrafts.create(
      pid,
      { clipId: clip.id, revision: clip.revision, frameId: clip.frames[1]!.id },
      "agent",
      session.id,
    );
    const other = store.createProject("另一工程").id;
    assert.throws(() => store.documents.read(other, doc.documentId), /不存在/);
    doc = edit(store, pid, doc.documentId, 0.5);
    assert.throws(
      () =>
        store.documents.write(pid, [
          {
            documentId: doc.documentId,
            expectedDocumentRevision: "old",
            text: doc.text,
          },
        ]),
      /VERSION_CONFLICT/,
    );
    const waiting = hub.requestFrameSave(
        session,
        doc.documentId,
        doc.documentRevision,
      ),
      approval = await pending(session);
    const live = store.animation.clip(pid, clip.id);
    store.updateClip(pid, clip.id, {
      revision: live.revision,
      frames: live.frames,
      loop: false,
    });
    await assert.rejects(
      hub.resolveFrameSave(session.id, approval.id, true),
      /版本已经改变/,
    );
    assert.equal((await waiting).saved, false);
    assert.equal(store.animation.clip(pid, clip.id).loop, false);
    assert.equal(store.frameDrafts.get(pid, doc.documentId).status, "editing");
    const current = store.animation.clip(pid, clip.id);
    let next = store.frameDrafts.create(
      pid,
      {
        clipId: clip.id,
        revision: current.revision,
        frameId: clip.frames[1]!.id,
      },
      "human",
    );
    next = edit(store, pid, next.documentId, 1, 4096);
    const overflowing = await store.frameDrafts.preview(
      pid,
      next.documentId,
      next.documentRevision,
    );
    assert.equal(overflowing.warnings[0]!.blocking, true);
    assert.equal(overflowing.warnings[0]!.frameNumber, 2);
    await assert.rejects(
      store.frameDrafts.save(pid, next.documentId, next.documentRevision),
      /超出画布/,
    );
    next = edit(store, pid, next.documentId, 0.5);
    writeFileSync(store.imagePath(pid, image.id), "modified pixels");
    await assert.rejects(
      store.frameDrafts.save(pid, next.documentId, next.documentRevision),
      /改变|变化|修改/,
    );
  } finally {
    hub.cancelFrameSave(session, "测试结束");
    store.worker.close();
  }
});

test("permissions persist, cancellation never saves, and restart recovers pending drafts without accepting", async () => {
  const { store, pid, clip, hub } = await fixture();
  const session = store.createSession(pid);
  let restored: ProjectStore | undefined;
  try {
    let doc = store.frameDrafts.create(
      pid,
      { clipId: clip.id, revision: clip.revision, frameId: clip.frames[1]!.id },
      "agent",
      session.id,
    );
    doc = edit(store, pid, doc.documentId, 0.5);
    store.frameDrafts.setPolicy("deny");
    assert.equal(
      (
        await hub.requestFrameSave(
          session,
          doc.documentId,
          doc.documentRevision,
        )
      ).saved,
      false,
    );
    store.frameDrafts.setPolicy("ask");
    let waiting = hub.requestFrameSave(
      session,
      doc.documentId,
      doc.documentRevision,
    );
    await pending(session);
    hub.cancelFrameSave(session, "用户停止了任务");
    assert.match((await waiting).reason, /停止/);
    assert.equal(store.asset(pid, clip.id).revision, clip.revision);
    waiting = hub.requestFrameSave(
      session,
      doc.documentId,
      doc.documentRevision,
    );
    await pending(session);
    restored = new ProjectStore(store.root);
    assert.equal(restored.session(session.id).frameSaveApproval, undefined);
    assert.equal(
      restored.frameDrafts.get(pid, doc.documentId).status,
      "editing",
    );
    assert.equal(restored.asset(pid, clip.id).revision, clip.revision);
    hub.cancelFrameSave(session, "服务重启");
    await waiting;
    store.frameDrafts.setPolicy("allow");
    const result = await hub.requestFrameSave(
      session,
      doc.documentId,
      doc.documentRevision,
    );
    assert.equal(result.saved, true);
    const again = new ProjectStore(store.root);
    assert.equal(again.frameDrafts.policy(), "allow");
    assert.equal(again.frameDrafts.get(pid, doc.documentId).status, "saved");
    assert.equal(
      again.animation.clip(pid, clip.id).frames[1]!.transform!.scale,
      0.5,
    );
    again.worker.close();
  } finally {
    hub.cancelFrameSave(session, "测试结束");
    store.worker.close();
    restored?.worker.close();
  }
});

test("legacy single-frame drafts on one base merge without losing pending edits or backups", async () => {
  const { store, pid, clip } = await fixture();
  let restored: ProjectStore | undefined;
  try {
    const base = store.animation.capture(pid, clip.id),
      ids = [crypto.randomUUID(), crypto.randomUUID()];
    for (const [i, id] of ids.entries()) {
      const text = JSON.stringify({
        schemaVersion: 1,
        type: "frame-edit",
        transform: {
          scale: i === 0 ? 0.5 : 0.75,
          offsetX: 0,
          offsetY: 0,
          clip: false,
        },
        durationUs: 100000,
      });
      store.frameDrafts.persist({
        id,
        projectId: pid,
        clipId: clip.id,
        frameId: clip.frames[i]!.id,
        baseSnapshotId: base.id,
        source: "human",
        status: i === 1 ? "pending" : "editing",
        createdAt: `2026-11-05T00:00:0${i}Z`,
        text,
        documentRevision: "old-" + i,
      });
    }
    restored = new ProjectStore(store.root);
    const list = restored.frameDrafts.list(pid);
    assert.equal(list.length, 1);
    const config = JSON.parse(list[0]!.text);
    assert.equal(config.schemaVersion, 2);
    assert.equal(config.frames[0].transform.scale, 0.5);
    assert.equal(config.frames[1].transform.scale, 0.75);
    assert.ok(
      existsSync(
        store.safePath(pid, `.studio/animation/drafts/legacy/${ids[0]}.json`),
      ),
    );
    assert.equal(restored.frameDrafts.get(pid, ids[1]!).mergedInto, ids[0]);
    assert.equal(restored.frameDrafts.get(pid, ids[1]!).status, "discarded");
    assert.equal(restored.asset(pid, clip.id).revision, clip.revision);
    const preview = await restored.frameDrafts.preview(
      pid,
      list[0]!.id,
      list[0]!.documentRevision,
    );
    assert.equal(preview.modifiedFrameIds.length, 2);
    const again = new ProjectStore(store.root);
    assert.equal(again.frameDrafts.list(pid).length, 1);
    again.worker.close();
  } finally {
    store.worker.close();
    restored?.worker.close();
  }
});

test("invisible alpha fringes do not block transforms; genuine overflow remains visible in preview and blocked on save", async () => {
  const { store, pid } = await fixture();
  try {
    const file = join(store.root, "fringe.png");
    const made = spawnSync(
      process.env.SPRITE_STUDIO_PYTHON || "python",
      [
        "-c",
        "from PIL import Image,ImageDraw;import sys;im=Image.new('RGBA',(32,32));ImageDraw.Draw(im).rectangle((8,8,23,23),fill=(80,200,180,255));im.putpixel((31,16),(80,200,180,1));im.save(sys.argv[1])",
        file,
      ],
      { windowsHide: true },
    );
    assert.equal(made.status, 0, made.stderr.toString());
    const image = await store.importImage(
        pid,
        "fringe.png",
        readFileSync(file),
      ),
      count = store.assets(pid).length;
    const safe = await store.previewTransform(pid, image.id, image.revision, {
      offsetX: 1,
    });
    assert.equal(safe.blocking, false);
    assert.deepEqual(safe.bounds, [9, 8, 25, 24]);
    assert.equal(store.assets(pid).length, count);
    const saved = await store.transform(pid, image.id, image.revision, {
      offsetX: 1,
    });
    assert.deepEqual(
      readFileSync(store.imagePath(pid, saved.id)),
      readFileSync(store.transformPreviewPath(pid, safe.id)),
    );
    const blocked = await store.previewTransform(
      pid,
      image.id,
      image.revision,
      { offsetX: 12 },
    );
    assert.equal(blocked.blocking, true);
    assert.equal(blocked.overflow.right, 4);
    assert.ok(
      readFileSync(store.transformPreviewPath(pid, blocked.id)).length > 20,
      "overflowing draft still has a real image preview",
    );
    await assert.rejects(
      store.transform(pid, image.id, image.revision, { offsetX: 12 }),
      /right=4px/,
    );
    const allowed = await store.previewTransform(
      pid,
      image.id,
      image.revision,
      { offsetX: 12, clip: true },
    );
    assert.equal(allowed.blocking, false);
    const cropped = await store.transform(pid, image.id, image.revision, {
      offsetX: 12,
      clip: true,
    });
    assert.deepEqual(
      readFileSync(store.imagePath(pid, cropped.id)),
      readFileSync(store.transformPreviewPath(pid, allowed.id)),
    );
  } finally {
    store.worker.close();
  }
});
