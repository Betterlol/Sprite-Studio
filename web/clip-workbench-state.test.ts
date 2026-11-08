import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { createServer } from "vite";
import type { ClipAsset, ImageAsset } from "../studio/model.ts";
import type { ClipDraftDocument } from "../studio/workflow-model.ts";
import { clipEdit } from "./workflow-state.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const clip: ClipAsset = { id: id(1), type: "clip", name: "component state fixture", revision: "saved-1", createdAt: "now", loop: true, initialFps: 12, frames: [{ id: id(2), imageId: id(4), durationUs: 100000 }, { id: id(3), imageId: id(4), durationUs: 200000 }] };
const image: ImageAsset = { id: id(4), type: "image", kind: "image", name: "fixture", file: "synthetic.png", revision: "image-1", createdAt: "now", width: 64, height: 64, mime: "image/png", frameCount: 1, contentHash: "synthetic" };

/** Executes the actual component's React hooks/effects across mounted renders.
 * No copied reducer/effect implementation and no browser/DOM or visual claims.
 * React's dispatcher is scoped to a render and restored even on assertion errors.
 */
function mountedComponent(Component: (props: any) => any) {
  const cells: any[] = [], cleanups: (() => void)[] = [];
  let cursor = 0, dirty = true, tree: any, props: any, effects: { index: number; run: () => any }[] = [];
  const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const same = (a: any[] | undefined, b: any[] | undefined) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const dispatcher = {
    useState(initial: any) {
      const index = cursor++;
      if (!(index in cells)) cells[index] = typeof initial === "function" ? initial() : initial;
      return [cells[index], (next: any) => { const value = typeof next === "function" ? next(cells[index]) : next; if (!Object.is(value, cells[index])) { cells[index] = value; dirty = true; } }];
    },
    useRef(initial: any) { const index = cursor++; return cells[index] ??= { current: initial }; },
    useMemo(create: () => any, deps?: any[]) { const index = cursor++; if (!same(cells[index]?.deps, deps)) cells[index] = { deps, value: create() }; return cells[index].value; },
    useCallback(callback: (...args: any[]) => any, deps?: any[]) { const index = cursor++; if (!same(cells[index]?.deps, deps)) cells[index] = { deps, value: callback }; return cells[index].value; },
    useEffect(run: () => any, deps?: any[]) {
      const index = cursor++;
      if (!same(cells[index], deps)) { cells[index] = deps; effects.push({ index, run }); }
    },
  };
  function render(next = props) {
    props = next; dirty = true;
    for (let renders = 0; dirty; renders++) {
      assert.ok(renders < 30, "component effects must settle"); dirty = false; cursor = 0; effects = [];
      const previous = internals.H; internals.H = dispatcher;
      try { tree = Component(props); } finally { internals.H = previous; }
      for (const { index, run } of effects) { cleanups[index]?.(); cleanups[index] = run(); }
    }
    return tree;
  }
  return { render, async settle() { for (let i = 0; i < 8; i++) { await new Promise(resolve => setImmediate(resolve)); if (dirty) render(); } return tree; }, unmount() { cleanups.forEach(cleanup => cleanup?.()); } };
}
function descendants(tree: any): any[] {
  if (Array.isArray(tree)) return tree.flatMap(descendants);
  if (!tree || typeof tree !== "object") return [];
  return [tree, ...descendants(tree.props?.children ?? tree.children)];
}
const editor = (tree: any) => descendants(tree).find(node => node.type?.name === "AnimationEditor");
const canvas = (tree: any) => descendants(tree).find(node => node.type === "img" && node.props.alt?.includes("帧实例"));
const storage = new Map<string, string>();
const globals = () => {
  const originals = { window: globalThis.window, document: globalThis.document, EventSource: globalThis.EventSource, localStorage: globalThis.localStorage, fetch: globalThis.fetch };
  Object.assign(globalThis, { document: { documentElement: { dataset: {} } }, EventSource: class { close() {} }, window: { addEventListener() {}, removeEventListener() {}, confirm: () => true }, localStorage: { getItem: (key: string) => storage.get(key) || null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) } });
  return () => { Object.assign(globalThis, originals); storage.clear(); };
};

test("R6 actual App preview playback preserves saved/legacy/draft editing identity rather than forging saved permission", async () => {
  const restore = globals();
  const vite = await createServer({ configFile: false, root: fileURLToPath(new URL("../", import.meta.url)), server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom" });
  const { App } = await vite.ssrLoadModule("/web/App.tsx"), component = mountedComponent(App);
  const project = { id: id(5), name: "preview context fixture" };
  const snapshot = { id: id(11), projectId: project.id, renderMode: "preview", createdAt: "now", clip: { ...clip, revision: "draft-preview", frames: clip.frames.map(frame => ({ ...frame, durationUs: 170000 })) }, images: {} };
  const state = { tasksEnabled: true, project, assets: [clip, image], tasks: [], sessions: [], frameDrafts: [], clipDrafts: [], reviews: [], frameChanges: [], interpolations: [], generatedImages: [], reviewSequences: [], folders: ["参考图"], libraryRevision: "one", trash: [] };
  try {
    globalThis.fetch = async (url: any) => new Response(JSON.stringify(String(url) === "/api/projects" ? [project] : String(url) === "/api/status" ? { connected: false } : String(url).includes("/snapshots/") ? snapshot : state), { status: 200, headers: { "Content-Type": "application/json" } });
    component.render({}); let tree = await component.settle();
    let workbench = descendants(tree).find(node => node.type?.name === "ClipWorkbench"); assert.ok(workbench);
    const taskCenter = () => descendants(tree).find(node => node.type?.name === "TaskCenter");
    // Legacy readonly playback is not a new editing selection: keep the original
    // saved object (and never send the legacy preview as saved context).
    const saved = taskCenter().props.context;
    workbench.props.onLegacyPreview(snapshot.id); tree = await component.settle();
    assert.equal(descendants(tree).find(node => node.type?.name === "SnapshotPlayer").props.snapshot.renderMode, "preview");
    assert.deepEqual(taskCenter().props.context, saved);
    assert.deepEqual(await taskCenter().props.stabilize(), saved);
    descendants(tree).find(node => node.type?.name === "SnapshotPlayer").props.onClose(); tree = component.render();
    workbench = descendants(tree).find(node => node.type?.name === "ClipWorkbench");
    const draftContext = { clipId: clip.id, revision: clip.revision, mode: "draft", draftId: id(12), documentRevision: "exact-body", frameId: clip.frames[1]!.id };
    workbench.props.onContext(draftContext); tree = component.render();
    taskCenter().props.onPlay(snapshot.id); tree = await component.settle();
    assert.deepEqual(taskCenter().props.context, draftContext, "task rough-animation playback must preserve draft source identity");
    assert.notEqual(taskCenter().props.context.mode, "saved");
  } finally { component.unmount(); await vite.close(); restore(); }
});

test("disabled task UI ignores historical bindings and keeps ordinary approvals visible", async () => {
  const restore = globals();
  const vite = await createServer({ configFile: false, root: fileURLToPath(new URL("../", import.meta.url)), server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom" });
  const { App } = await vite.ssrLoadModule("/web/App.tsx"), component = mountedComponent(App);
  const project = { id: id(5), name: "disabled task fixture" };
  const session = { id: id(40), projectId: project.id, taskId: id(41), title: "old session", status: "idle", messages: [], activities: [], toolApproval: { id: id(42), tool: "save_image" } };
  const task = { id: id(41), sessionId: session.id, phase: "direction", status: "waiting", target: { clipId: clip.id } };
  const state = { tasksEnabled: false, project, assets: [clip, image], tasks: [task], sessions: [session], frameDrafts: [], clipDrafts: [], reviews: [], frameChanges: [], interpolations: [], generatedImages: [], reviewSequences: [], folders: ["参考图"], libraryRevision: "one", trash: [] };
  try {
    globalThis.fetch = async (url: any) => new Response(JSON.stringify(String(url) === "/api/projects" ? [project] : String(url) === "/api/status" ? { connected: false } : state), { status: 200, headers: { "Content-Type": "application/json" } });
    component.render({}); const tree = await component.settle(), nodes = descendants(tree);
    assert.ok(!nodes.some(node => node.type?.name === "TaskCenter"));
    assert.equal(nodes.find(node => node.type?.name === "ToolApprovals").props.sessions.length, 1);
    assert.deepEqual(nodes.find(node => node.type?.name === "ResourceLibrary").props.blockedAssetIds, []);
  } finally { component.unmount(); await vite.close(); restore(); }
});

test("R9 actual TaskCenter creates an explicitly selected mandatory Review contract, never inferring one", async () => {
  const restore = globals();
  const vite = await createServer({ configFile: false, root: fileURLToPath(new URL("../", import.meta.url)), server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom" });
  const { TaskCenter } = await vite.ssrLoadModule("/web/TaskCenter.tsx"), component = mountedComponent(TaskCenter);
  const definition = { id: id(20), projectId: id(5), revision: "review-1", name: "explicit A to B", loop: true, segments: [{ id: id(21), clipId: clip.id, repeat: 1, speed: 1 }] };
  let submitted: any;
  try {
    globalThis.fetch = async (_url: any, options: any) => { submitted = JSON.parse(options.body); return new Response(JSON.stringify({ id: id(30) }), { status: 200 }); };
    component.render({ projectId: id(5), tasks: [], sessions: [], assets: [clip, image], clipDrafts: [], reviewSequences: [definition, { ...definition, id: id(22), archived: true }], referenceIds: [], context: { mode: "saved", clipId: clip.id }, selectedTaskId: "", onSelect() {}, onCreated() {}, onRefresh: async () => {}, onHandoff() {}, stabilize: async () => ({ mode: "saved", clipId: clip.id }), onPlay() {}, onBrowse() {} });
    let tree = await component.settle();
    const select = () => descendants(tree).find(node => node.props?.["aria-label"] === "任务必查Review");
    assert.equal(select().props.value, "");
    assert.equal(descendants(select()).find(node => node.type === "option" && node.props.value === id(22)).props.disabled, true);
    select().props.onChange({ target: { value: definition.id } });
    descendants(tree).find(node => node.props?.["aria-label"] === "新任务描述").props.onChange({ target: { value: "check explicit transition" } }); tree = component.render();
    descendants(tree).find(node => node.type === "button" && node.props.children === "按此明确范围创建任务").props.onClick(); await component.settle();
    assert.deepEqual(submitted.contract, { reviewSequenceId: definition.id }); assert.equal(submitted.target.clipId, clip.id);
  } finally { component.unmount(); await vite.close(); restore(); }
});

for (const legacySource of [false, true]) test(`R10 actual ClipWorkbench ${legacySource ? "legacy-to-unified" : "human"} preview/adopt callback uses exact dual-CAS without formal save`, async () => {
  const restore = globals();
  const vite = await createServer({ configFile: false, root: fileURLToPath(new URL("../", import.meta.url)), server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom" });
  const { ClipWorkbench } = await vite.ssrLoadModule("/web/ClipWorkbench.tsx"), component = mountedComponent(ClipWorkbench);
  const humanBody = { ...clipEdit(clip), frames: [{ ...clip.frames[0]!, durationUs: legacySource ? 100000 : 170000 }, clip.frames[1]!] };
  const resultBody = { ...humanBody, frames: [{ ...clip.frames[0]!, durationUs: 190000 }, clip.frames[1]!] };
  const human: ClipDraftDocument = { documentId: id(9), documentRevision: "human-v1", text: JSON.stringify(humanBody), draft: { id: id(9), projectId: id(5), clipId: clip.id, source: "human", status: "editing", baseSnapshotId: id(10), createdAt: "now" } };
  const delivery = { draftId: id(30), documentRevision: "result-v2", snapshotId: id(31), target: legacySource ? { draftId: id(40), documentRevision: "legacy-v1", kind: "frame" } : { draftId: human.documentId, documentRevision: human.documentRevision } };
  const proposal = { ...human.draft, id: delivery.draftId, source: "agent", readOnly: true, deliveryTarget: delivery.target, delivery };
  let adoptedPayload: any, plays: string[] = [], refreshes = 0, saves = 0;
  try {
    globalThis.fetch = async (url: any, options: any) => {
      if (String(url).endsWith("/save")) saves++;
      if (String(url).endsWith("/adopt")) {
        adoptedPayload = JSON.parse(options.body);
        return new Response(JSON.stringify({ ...human, documentId: legacySource ? id(41) : human.documentId, documentRevision: delivery.documentRevision, text: JSON.stringify(resultBody), draft: { ...human.draft, id: legacySource ? id(41) : human.documentId, adoptedResult: { draftId: proposal.id, documentRevision: delivery.documentRevision } } }), { status: 200 });
      }
      if (String(url).endsWith("/preview")) return new Response(JSON.stringify({ draft: human.draft, before: { id: id(10), clip }, preview: { id: id(11), clip: { ...clip, ...humanBody } }, modified: true, modifiedFrameIds: [clip.frames[0]!.id], warnings: [] }), { status: 200 });
      return new Response(JSON.stringify(human), { status: 200 });
    };
    component.render({ projectId: id(5), clip, assets: [image], frameIndex: 0, onFrame() {}, playing: false, onPlaying() {}, propertiesHost: { nodeType: 1 }, onContext() {}, onBridge() {}, onSaved: async () => { refreshes++; }, onTool() {}, legacyDrafts: legacySource ? [{ ...human.draft, id: id(40), documentRevision: "legacy-v1", frameId: clip.frames[0]!.id, text: "preserved legacy source" }] : [], clipDrafts: [proposal], onLegacyPreview: (id: string) => plays.push(id) });
    let tree = await component.settle();
    // Real createPortal produces its element tree; no DOM painting is claimed.
    assert.equal(editor(tree).props.clip.frames[0].durationUs, legacySource ? 100000 : 170000);
    const button = (text: string) => descendants(tree).find(node => node.type === "button" && node.props.children === text);
    button("播放此助手结果").props.onClick(); assert.deepEqual(plays, [delivery.snapshotId]);
    const adoptionLabel = legacySource ? "从旧稿助手结果建立统一人工稿" : "采用助手结果到我的草稿";
    assert.equal(button(adoptionLabel).props.disabled, false);
    button(adoptionLabel).props.onClick(); tree = await component.settle();
    assert.deepEqual(adoptedPayload, { expectedDocumentRevision: delivery.target.documentRevision, resultDraftId: proposal.id, expectedResultDocumentRevision: delivery.documentRevision });
    assert.equal(editor(tree).props.clip.frames[0].durationUs, 190000);
    assert.equal(clip.frames[0]!.durationUs, 100000); assert.equal(saves, 0); assert.equal(refreshes, 1);
  } finally { component.unmount(); await vite.close(); restore(); }
});

test("R8 actual ReviewSequences component uses semantic server stale and shows pending dependency reconciliation", async () => {
  const restore = globals();
  const vite = await createServer({ configFile: false, root: fileURLToPath(new URL("../", import.meta.url)), server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom" });
  const { ReviewSequences } = await vite.ssrLoadModule("/web/ReviewSequences.tsx"), component = mountedComponent(ReviewSequences);
  const definition = { id: id(20), projectId: id(5), revision: "definition-1", name: "Review", loop: true, segments: [{ id: id(21), clipId: clip.id, repeat: 1, speed: 1 }] };
  const snapshot = { id: id(22), projectId: id(5), definitionId: definition.id, definitionRevision: definition.revision, snapshotId: id(23), createdAt: new Date().toISOString(), dependencies: [{ clipId: clip.id, revision: clip.revision, snapshotId: id(24) }], segments: [], stale: false };
  const props = { projectId: id(5), clips: [clip], definitions: [definition], onDefinition() {}, onRefresh: async () => {}, onPlay() {} };
  let serverStale = false;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify([{ ...snapshot, stale: serverStale }]), { status: 200, headers: { "Content-Type": "application/json" } });
    let tree = component.render(props);
    descendants(tree).find(node => node.type === "select").props.onChange({ target: { value: definition.id } }); tree = await component.settle();
    const optionText = () => descendants(tree).filter(node => node.type === "option").map(node => JSON.stringify(node.props.children)).join(" ");
    assert.match(optionText(), /依赖当前/);
    const renamed = { ...props, clips: [{ ...clip, name: "only renamed", revision: "name-rev" }], definitions: [{ ...definition, name: "archived name", archived: true, revision: "metadata-rev" }] };
    tree = component.render(renamed); assert.match(optionText(), /依赖待核对/);
    tree = await component.settle(); assert.match(optionText(), /依赖当前/); assert.doesNotMatch(optionText(), /依赖已过期/);
    serverStale = true;
    tree = component.render({ ...renamed, dependencyRevision: "image-pixels-changed-without-clip-revision" });
    assert.match(optionText(), /依赖待核对/); tree = await component.settle(); assert.match(optionText(), /依赖已过期/);
  } finally { component.unmount(); await vite.close(); restore(); }
});

test("R7 actual ClipWorkbench mounted hook/effect path follows new saved props while Agent holds it, and preserves a human dirty document", async () => {
  const restore = globals();
  const vite = await createServer({ configFile: false, root: fileURLToPath(new URL("../", import.meta.url)), server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom" });
  const { ClipWorkbench } = await vite.ssrLoadModule("/web/ClipWorkbench.tsx");
  const component = mountedComponent(ClipWorkbench);
  const contexts: any[] = [];
  let bridge: any;
  const props = { projectId: id(5), clip, assets: [image], frameIndex: 0, onFrame() {}, playing: false, onPlaying() {}, propertiesHost: null, locked: "Agent持有", onContext: (value: any) => contexts.push(value), onBridge: (value: any) => { bridge = value; }, onSaved: async () => {}, onTool() {}, legacyDrafts: [], clipDrafts: [], onLegacyPreview() {} };
  try {
    globalThis.fetch = async () => { throw new Error("a locked read-only component must not create a human draft"); };
    let tree = component.render(props);
    assert.deepEqual(editor(tree).props.clip.frames, clip.frames);
    const next: ClipAsset = { ...clip, revision: "saved-2", loop: false, initialFps: 24, frames: [{ ...clip.frames[0]!, durationUs: 310000, transform: { scale: 0.7, offsetX: 9, offsetY: -3, clip: false } }, ...clip.frames.slice(1), { id: id(8), imageId: image.id, durationUs: 450000 }] };
    tree = component.render({ ...props, clip: next });
    assert.deepEqual(editor(tree).props.clip.frames, next.frames);
    assert.equal(editor(tree).props.clip.loop, false); assert.equal(editor(tree).props.clip.initialFps, 24);
    assert.match(canvas(tree).props.style.transform, /translate\(.+\) scale\(0.7\)/);
    assert.equal(contexts.at(-1).revision, "saved-2");
    assert.equal((await bridge.stabilize()).revision, "saved-2", "read-only bridge must not retain a stale saved revision");
    component.unmount();

    const human: ClipDraftDocument = { documentId: id(9), documentRevision: "human-v1", text: JSON.stringify(clipEdit(clip)), draft: { id: id(9), projectId: id(5), clipId: clip.id, source: "human", status: "editing", baseSnapshotId: id(10), createdAt: "now" } };
    globalThis.fetch = async (url: any) => new Response(JSON.stringify(String(url).endsWith("/preview") ? { draft: human.draft, before: { id: id(10), clip }, preview: { id: id(11), clip }, modified: false, modifiedFrameIds: [], warnings: [] } : human), { status: 200, headers: { "Content-Type": "application/json" } });
    const editable = mountedComponent(ClipWorkbench);
    try {
      editable.render({ ...props, locked: undefined }); tree = await editable.settle();
      const mine = { ...clip, frames: clip.frames.map((frame, index) => index ? frame : { ...frame, durationUs: 170000 }) };
      editor(tree).props.onChange(mine); tree = editable.render();
      assert.equal(editor(tree).props.clip.frames[0].durationUs, 170000);
      tree = editable.render({ ...props, clip: next, locked: "Agent持有" });
      assert.equal(editor(tree).props.clip.frames[0].durationUs, 170000, "external props cannot overwrite human dirty fields");
      assert.equal(editor(tree).props.clip.frames.length, 2);
      assert.ok(descendants(tree).some(node => typeof node.props?.title === "string" && /动画保存版本发生变化/.test(node.props.title)));
      await assert.rejects(bridge.stabilize(), /冲突/);
    } finally { editable.unmount(); }
  } finally { component.unmount(); await vite.close(); restore(); }
});
