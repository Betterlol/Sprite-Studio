import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { atomicJson, sha256, StudioError, type ProjectStore } from "./store.ts";
import { bytes } from "./documents.ts";
import { frameEditSchema, type FrameDraft, type FrameChange } from "./model.ts";

export const frameSavePolicySchema = z.enum(["ask", "allow", "deny"]);
export class FrameDrafts {
  store: ProjectStore;
  records = new Map<string, string>();
  saving = new Map<string, Promise<FrameChange>>();
  constructor(store: ProjectStore) {
    this.store = store;
    for (const pid of store.projects.keys()) {
      const folder = store.safePath(pid, ".studio/animation/drafts");
      if (!existsSync(folder)) continue;
      for (const file of readdirSync(folder).filter((f) =>
        f.endsWith(".json"),
      )) {
        const draft = JSON.parse(
          readFileSync(join(folder, file), "utf8"),
        ) as FrameDraft;
        if (draft.projectId !== pid || file !== draft.id + ".json") continue;
        this.records.set(draft.id, pid);
        const clip = store.indexes.get(pid)?.get(draft.clipId);
        if (
          clip?.type === "clip" &&
          clip.appliedFrameChangeIds?.includes(draft.id)
        ) {
          draft.status = "saved";
          draft.changeId = draft.id;
        } else if (draft.status === "pending") draft.status = "editing";
        this.persist(draft);
      }
    }
  }
  path(id: string) {
    return `.studio/animation/drafts/${id}.json`;
  }
  has(id: string) {
    return this.records.has(id);
  }
  get(pid: string, id: string): FrameDraft {
    if (this.records.get(id) !== pid)
      throw new StudioError("单帧草稿不存在", 404);
    return JSON.parse(
      readFileSync(this.store.safePath(pid, this.path(id)), "utf8"),
    );
  }
  list(pid: string) {
    return [...this.records]
      .filter(([, p]) => p === pid)
      .map(([id]) => this.get(pid, id))
      .filter((d) => d.status === "editing" || d.status === "pending")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  persist(draft: FrameDraft) {
    const file = this.store.safePath(draft.projectId, this.path(draft.id));
    mkdirSync(join(file, ".."), { recursive: true });
    atomicJson(file, draft);
    this.records.set(draft.id, draft.projectId);
    this.store.changed(draft.projectId);
    return draft;
  }
  create(
    pid: string,
    input: { clipId: string; revision: string; frameId: string },
    source: "agent" | "human",
    sessionId?: string,
  ) {
    const spec = z
      .object({
        clipId: z.string().uuid(),
        revision: z.string(),
        frameId: z.string().uuid(),
      })
      .strict()
      .parse(input);
    const base = this.store.animation.capture(pid, spec.clipId, spec.revision);
    const frame = base.clip.frames.find((f) => f.id === spec.frameId);
    if (!frame) throw new StudioError("帧不在目标动画中");
    const existing = this.list(pid).find(
      (d) =>
        d.clipId === spec.clipId &&
        d.frameId === spec.frameId &&
        d.source === source &&
        d.sessionId === sessionId &&
        d.baseSnapshotId === base.id,
    );
    if (existing) return this.read(pid, existing.id);
    const text = bytes({
      schemaVersion: 1,
      type: "frame-edit",
      transform: frame.transform || {
        scale: 1,
        offsetX: 0,
        offsetY: 0,
        clip: false,
      },
      durationUs: frame.durationUs,
    }).toString();
    const draft: FrameDraft = {
      id: randomUUID(),
      projectId: pid,
      clipId: spec.clipId,
      frameId: spec.frameId,
      baseSnapshotId: base.id,
      source,
      sessionId,
      status: "editing",
      createdAt: new Date().toISOString(),
      text,
      documentRevision: sha256(text),
    };
    this.persist(draft);
    return this.read(pid, draft.id);
  }
  read(pid: string, id: string) {
    const draft = this.get(pid, id);
    return {
      documentId: id,
      path: this.path(id),
      type: "frame-edit",
      text: draft.text,
      documentRevision: draft.documentRevision,
      definitionRevision: draft.documentRevision,
      exists: true,
      draft,
    };
  }
  parse(text: string) {
    if (Buffer.byteLength(text) > 256 * 1024)
      throw new StudioError("草稿配置超过256KB");
    try {
      return frameEditSchema.parse(JSON.parse(text));
    } catch (error) {
      throw new StudioError("无效单帧配置：" + String(error));
    }
  }
  prepare(
    pid: string,
    input: {
      documentId: string;
      expectedDocumentRevision: string;
      text: string;
    },
  ) {
    const draft = this.get(pid, input.documentId);
    if (draft.status !== "editing")
      throw new StudioError("草稿正在等待审批或已结束，不能修改", 409);
    if (draft.documentRevision !== input.expectedDocumentRevision)
      throw new StudioError("VERSION_CONFLICT：草稿已改变，请重新读取", 409);
    const text = bytes(this.parse(input.text)).toString();
    return {
      path: this.path(draft.id),
      bytes: bytes({
        ...draft,
        text,
        documentRevision: sha256(text),
        snapshotId: undefined,
      }),
    };
  }
  check(pid: string, id: string, revision: string) {
    const draft = this.get(pid, id);
    if (draft.documentRevision !== revision)
      throw new StudioError("VERSION_CONFLICT：草稿已改变，请重新预览", 409);
    const base = this.store.animation.snapshot(pid, draft.baseSnapshotId);
    const current = this.store.animation.capture(
      pid,
      draft.clipId,
      base.clip.revision,
    );
    if (JSON.stringify(current.images) !== JSON.stringify(base.images))
      throw new StudioError("底图已变化，请重新建立单帧草稿", 409);
    return draft;
  }
  async preview(pid: string, id: string, revision: string) {
    const draft = this.get(pid, id);
    if (draft.documentRevision !== revision)
      throw new StudioError("草稿已改变，请重新预览", 409);
    const base = this.store.animation.snapshot(pid, draft.baseSnapshotId),
      config = this.parse(draft.text);
    const original = base.clip.frames.find((f) => f.id === draft.frameId)!;
    const modified =
      JSON.stringify(config.transform) !==
        JSON.stringify(
          original.transform || {
            scale: 1,
            offsetX: 0,
            offsetY: 0,
            clip: false,
          },
        ) || config.durationUs !== original.durationUs;
    const snapshot = this.store.animation.captureClip(
      pid,
      {
        ...base.clip,
        revision: sha256(JSON.stringify([base.id, draft.frameId, revision])),
        frames: base.clip.frames.map((f) =>
          f.id === draft.frameId
            ? {
                ...f,
                transform: config.transform,
                durationUs: config.durationUs,
              }
            : f,
        ),
      },
      base.images,
    );
    // Render before returning a playable preview; invalid clipping never reaches save.
    await this.store.animation.renderFrame(pid, snapshot.id, draft.frameId);
    return { draft, before: base, preview: snapshot, modified };
  }
  async save(pid: string, id: string, revision: string) {
    const old = this.get(pid, id);
    if (old.documentRevision !== revision)
      throw new StudioError("草稿已改变，请重新提交保存", 409);
    if (old.status === "saved")
      return this.store.animation.change(pid, old.changeId!);
    if (old.status === "discarded") throw new StudioError("草稿已放弃", 409);
    const running = this.saving.get(id);
    if (running) return running;
    const promise = this.store
      .reading(pid, async () => {
        const draft = this.check(pid, id, revision),
          config = this.parse(draft.text);
        this.persist({ ...draft, status: "pending" });
        try {
          await this.preview(pid, id, revision);
          this.check(pid, id, revision);
          const base = this.store.animation.snapshot(pid, draft.baseSnapshotId);
          const change = await this.store.animation.adjust(
            pid,
            {
              requestId: id,
              clipId: draft.clipId,
              revision: base.clip.revision,
              frameId: draft.frameId,
              transform: config.transform,
              durationUs: config.durationUs,
            },
            draft.source,
          );
          this.persist({ ...draft, status: "saved", changeId: change.id });
          return change;
        } catch (error) {
          this.persist({ ...draft, status: "editing" });
          throw error;
        }
      })
      .finally(() => this.saving.delete(id));
    this.saving.set(id, promise);
    return promise;
  }
  discard(pid: string, id: string, revision: string) {
    const draft = this.get(pid, id);
    if (draft.status !== "editing" || draft.documentRevision !== revision)
      throw new StudioError("草稿状态已改变，请刷新", 409);
    return this.persist({ ...draft, status: "discarded" });
  }
  policy() {
    const path = join(this.store.root, "tool-permissions.json");
    return frameSavePolicySchema.parse(
      existsSync(path)
        ? JSON.parse(readFileSync(path, "utf8")).save_frame_draft
        : "ask",
    );
  }
  setPolicy(value: unknown) {
    const policy = frameSavePolicySchema.parse(value);
    const path = join(this.store.root, "tool-permissions.json");
    const existing = existsSync(path)
      ? JSON.parse(readFileSync(path, "utf8"))
      : {};
    atomicJson(path, { ...existing, save_frame_draft: policy });
    return policy;
  }
}
