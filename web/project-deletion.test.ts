import test from "node:test";
import assert from "node:assert/strict";
import {
  clearProjectStorage,
  deletionConfirmed,
  projectsAfterDeletion,
  type ProjectStorage,
} from "./project-deletion.ts";

function storage(initial: Record<string, string>) {
  const data = new Map(Object.entries(initial));
  const store: ProjectStorage & { keys: () => string[] } = {
    get length() {
      return data.size;
    },
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => void data.delete(key),
    keys: () => [...data.keys()],
  };
  return store;
}

const project = { id: "11111111-1111-4111-8111-111111111111", name: "森林骑士" };

test("confirmation needs the exact project name, not a prefix or another project", () => {
  assert.equal(deletionConfirmed(project, "森林骑士"), true);
  assert.equal(deletionConfirmed(project, "  森林骑士  "), true);
  assert.equal(deletionConfirmed(project, "森林"), false);
  assert.equal(deletionConfirmed(project, "森林骑士2"), false);
  assert.equal(deletionConfirmed(project, ""), false);
  assert.equal(deletionConfirmed({ name: "a b" }, "a  b"), false);
});

test("the remaining list keeps order and drops only the deleted project", () => {
  const projects = [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
    { id: "c", name: "C" },
  ];
  assert.deepEqual(
    projectsAfterDeletion(projects, "b").map((item) => item.id),
    ["a", "c"],
  );
  assert.deepEqual(
    projectsAfterDeletion(projects, "missing").map((item) => item.id),
    ["a", "b", "c"],
  );
  assert.deepEqual(projects.map((item) => item.id), ["a", "b", "c"]);
  assert.deepEqual(projectsAfterDeletion([], "a"), []);
});

test("only the deleted project's browser records are cleared", () => {
  const id = project.id;
  const other = "22222222-2222-4222-8222-222222222222";
  const store = storage({
    [`studio.asset.${id}`]: id,
    [`studio.session.${id}`]: "session",
    [`studio.folder.${id}`]: "参考图",
    [`studio.draft.${id}.session`]: "unsent",
    [`studio.clip-draft.${id}.clip`]: "{}",
    [`studio.recipe.${id}.image`]: "{}",
    [`studio.interpolation.${id}.clip`]: "{}",
    [`studio.message-recovery.${id}.session.request`]: "{}",
    [`studio.asset.${other}`]: other,
    [`studio.draft.${other}.session`]: "unsent",
    "studio.project": other,
    "studio.theme": "light",
    "studio.model": "sol",
    "studio.layout.rail": "300",
  });

  assert.equal(clearProjectStorage(store, id), 8);
  assert.deepEqual(store.keys(), [
    `studio.asset.${other}`,
    `studio.draft.${other}.session`,
    "studio.project",
    "studio.theme",
    "studio.model",
    "studio.layout.rail",
  ]);
  assert.equal(clearProjectStorage(store, id), 0);
});
