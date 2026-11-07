import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import type { MarkdownAsset, MarkdownDocument } from "../studio/model.ts";

// Execute the real component's mounted hooks/effects, not copied editor logic.
// DOM/layout claims are intentionally left to the real browser check.
function mount(Component: (props: any) => any) {
  const cells: any[] = [], cleanups: any[] = [];
  let cursor = 0, dirty = true, tree: any, props: any, effects: any[] = [];
  const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const same = (a: any, b: any) => a && b && a.length === b.length && a.every((v: any, i: number) => Object.is(v, b[i]));
  const dispatcher = {
    useState(initial: any) { const i = cursor++; if (!(i in cells)) cells[i] = typeof initial === "function" ? initial() : initial; return [cells[i], (next: any) => { const value = typeof next === "function" ? next(cells[i]) : next; if (!Object.is(value, cells[i])) { cells[i] = value; dirty = true; } }]; },
    useRef(initial: any) { return cells[cursor++] ??= { current: initial }; },
    useEffect(run: any, deps: any) { const i = cursor++; if (!same(cells[i], deps)) { cells[i] = deps; effects.push({ i, run }); } },
  };
  const render = (next = props) => {
    props = next; dirty = true;
    for (let n = 0; dirty; n++) {
      assert.ok(n < 30, "editor effects must settle"); cursor = 0; dirty = false; effects = [];
      const old = internals.H; internals.H = dispatcher;
      try { tree = Component(props); } finally { internals.H = old; }
      for (const { i, run } of effects) { cleanups[i]?.(); cleanups[i] = run(); }
    }
    return tree;
  };
  return { render, async settle() { for (let i = 0; i < 8; i++) { await new Promise(resolve => setImmediate(resolve)); if (dirty) render(); } return tree; }, unmount() { cleanups.forEach(fn => fn?.()); } };
}
function nodes(tree: any): any[] { return Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === "object" ? [tree, ...nodes(tree.props?.children)] : []; }
function content(tree: any): string { return Array.isArray(tree) ? tree.map(content).join("") : typeof tree === "string" ? tree : tree?.props ? content(tree.props.children) : ""; }
const button = (tree: any, text: string) => nodes(tree).find(node => node.type === "button" && content(node) === text);
const textarea = (tree: any) => nodes(tree).find(node => node.type === "textarea");
const asset: MarkdownAsset = { id: "00000000-0000-4000-8000-000000000001", type: "markdown", name: "设计.md", file: "Assets/文档/设计.md", folder: "文档", revision: "v1", contentHash: "hash", byteLength: 4, createdAt: "now", updatedAt: "now" };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
async function fixture() {
  const oldWindow = globalThis.window, oldFetch = globalThis.fetch;
  Object.assign(globalThis, { window: { addEventListener() {}, removeEventListener() {}, confirm: () => true } });
  const vite = await createServer({ configFile: false, root: fileURLToPath(new URL("../", import.meta.url)), server: { middlewareMode: true }, appType: "custom" });
  const { MarkdownEditor } = await vite.ssrLoadModule("/web/MarkdownEditor.tsx");
  const editor = mount(MarkdownEditor);
  const close = async () => { editor.unmount(); await vite.close(); Object.assign(globalThis, { window: oldWindow, fetch: oldFetch }); };
  return { editor, close };
}

test("actual Markdown editor follows clean updates but preserves dirty text and 409 conflicts", async () => {
  const f = await fixture(); let current: MarkdownDocument = { asset, text: "初始正文" }, dirty = false;
  const props = { projectId: "project", asset, onDirty: (value: boolean) => { dirty = value; }, onSaved: async () => {}, onReference() {} };
  try {
    globalThis.fetch = async (_url: any, options: any) => options?.method === "PUT" ? json({ error: "文档版本已变化" }, 409) : json(current);
    f.editor.render(props); let tree = await f.editor.settle();
    assert.equal(textarea(tree).props.value, "初始正文");
    current = { asset: { ...asset, revision: "v2" }, text: "助手最新正文" };
    f.editor.render({ ...props, asset: current.asset }); tree = await f.editor.settle();
    assert.equal(textarea(tree).props.value, "助手最新正文");
    textarea(tree).props.onChange({ target: { value: "我的未保存文字" } }); tree = f.editor.render();
    assert.equal(dirty, true);
    current = { asset: { ...asset, revision: "v3" }, text: "助手再次保存" };
    f.editor.render({ ...props, asset: current.asset }); tree = await f.editor.settle();
    assert.equal(textarea(tree).props.value, "我的未保存文字");
    await button(tree, "保存文档").props.onClick(); tree = await f.editor.settle();
    assert.equal(textarea(tree).props.value, "我的未保存文字");
    assert.ok(nodes(tree).some(node => node.props?.role === "alert"));
    assert.equal(button(tree, "引用到对话").props.disabled, true);
  } finally { await f.close(); }
});

test("actual editor Ctrl+S uses exact revision and keeps text typed during save", async () => {
  const f = await fixture(); let resolve!: (response: Response) => void, submitted: any;
  let current = { asset, text: "初始" };
  const props = { projectId: "project", asset, onDirty() {}, onSaved: async () => {}, onReference() {} };
  try {
    globalThis.fetch = async (_url: any, options: any) => {
      if (options?.method === "PUT") { submitted = JSON.parse(options.body); return new Promise<Response>(done => { resolve = done; }); }
      return json(current);
    };
    f.editor.render(props); let tree = await f.editor.settle();
    textarea(tree).props.onChange({ target: { value: "第一稿" } }); tree = f.editor.render();
    let prevented = false;
    tree.props.onKeyDown({ ctrlKey: true, key: "s", preventDefault() { prevented = true; } });
    assert.equal(prevented, true); assert.deepEqual(submitted, { text: "第一稿", expectedRevision: "v1" });
    textarea(tree).props.onChange({ target: { value: "保存期间继续写" } }); tree = f.editor.render();
    current = { asset: { ...asset, revision: "v2" }, text: "第一稿" };
    resolve(json(current)); tree = await f.editor.settle();
    assert.equal(textarea(tree).props.value, "保存期间继续写");
    assert.equal(button(tree, "保存文档").props.disabled, false);
  } finally { await f.close(); }
});

test("actual editor reload cannot overwrite new input typed while a latest-version request waits", async () => {
  const f = await fixture(); let resolve!: (response: Response) => void, reloadPending = false;
  const props = { projectId: "project", asset, onDirty() {}, onSaved: async () => {}, onReference() {} };
  try {
    globalThis.fetch = async (_url: any, options: any) => {
      if (options?.method === "PUT") return json({ error: "版本冲突" }, 409);
      if (reloadPending) return new Promise<Response>(done => { resolve = done; });
      return json({ asset, text: "初始" });
    };
    f.editor.render(props); let tree = await f.editor.settle();
    textarea(tree).props.onChange({ target: { value: "旧本地输入" } }); tree = f.editor.render();
    button(tree, "保存文档").props.onClick(); tree = await f.editor.settle();
    reloadPending = true;
    button(tree, "载入最新正文").props.onClick();
    textarea(tree).props.onChange({ target: { value: "载入期间的新输入" } }); tree = f.editor.render();
    resolve(json({ asset: { ...asset, revision: "v2" }, text: "另一编辑器正文" }));
    tree = await f.editor.settle();
    assert.equal(textarea(tree).props.value, "载入期间的新输入");
    assert.match(content(tree), /读取期间有新的输入/);
  } finally { await f.close(); }
});

test("actual Markdown preview renders tables but executes no raw HTML, unsafe links or image loads", async () => {
  const f = await fixture();
  const text = "# 文档\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n<script>alert(1)</script>\n\n![外链](https://example.invalid/track.png)\n\n[危险](javascript:alert(1))\n\n[安全](https://example.com/)";
  try {
    globalThis.fetch = async () => json({ asset, text });
    f.editor.render({ projectId: "project", asset, onDirty() {}, onSaved: async () => {}, onReference() {} });
    let tree = await f.editor.settle(); button(tree, "预览").props.onClick(); tree = f.editor.render();
    const article = nodes(tree).find(node => node.type === "article");
    const html = renderToStaticMarkup(article);
    assert.match(html, /<table>/); assert.match(html, /<h1>文档<\/h1>/);
    assert.ok(!html.includes("<script")); assert.ok(!html.includes("<img")); assert.ok(!html.includes("javascript:"));
    assert.match(html, /rel="noopener noreferrer"/);
  } finally { await f.close(); }
});
