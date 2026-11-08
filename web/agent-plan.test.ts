import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import type { Session } from "../studio/model.ts";

test("native plan UI distinguishes current, incomplete-ended and previous progress without adding gates", async () => {
  const vite = await createServer({ configFile: false, root: fileURLToPath(new URL("../", import.meta.url)), server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom" });
  try {
    const { AgentPlan } = await vite.ssrLoadModule("/web/AgentPlan.tsx");
    const session: Session = { id: "session", projectId: "project", title: "goal", status: "running", threadId: "thread", turnId: "turn", messages: [], activities: [], createdAt: "now", updatedAt: "now", plan: { threadId: "thread", turnId: "turn", explanation: "维护已有方案", plan: [{ step: "读取方案", status: "completed" }, { step: "补充规格", status: "inProgress" }] } };
    const render = () => renderToStaticMarkup(createElement(AgentPlan, { session }));
    let html = render();
    assert.match(html, /执行计划/); assert.match(html, /1\/2 步已完成/); assert.match(html, /aria-current="step"/);
    assert.ok(!html.includes("<button"));
    session.status = "idle"; html = render();
    assert.match(html, /回合已结束/); assert.match(html, /步骤尚未全部完成/); assert.ok(!html.includes("aria-current"));
    session.status = "starting"; session.turnId = undefined; assert.match(render(), /上一轮计划/);
    session.status = "failed"; session.turnId = "turn"; assert.match(render(), /已停止/);
    session.plan!.plan = []; assert.equal(render(), "");
  } finally { await vite.close(); }
});
