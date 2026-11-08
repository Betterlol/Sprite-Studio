import type { Project } from "../studio/model.ts";

export type ProjectStorage = Pick<Storage, "length" | "key" | "removeItem">;

/** Confirmation asks for the exact name, so the wrong project is never deleted by reflex. */
export function deletionConfirmed(project: Pick<Project, "name">, input: string) {
  return input.trim() === project.name;
}

export function projectsAfterDeletion<T extends { id: string }>(
  projects: T[],
  id: string,
) {
  return projects.filter((project) => project.id !== id);
}

// Per-project browser preferences only; shared view settings such as theme and
// panel sizes belong to this browser and are kept.
const projectScopedKeys = [
  "asset",
  "session",
  "folder",
  "draft",
  "clip-draft",
  "recipe",
  "interpolation",
  "message-recovery",
];

export function clearProjectStorage(storage: ProjectStorage, id: string) {
  const prefixes = projectScopedKeys.map((name) => `studio.${name}.${id}`);
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key) keys.push(key);
  }
  let cleared = 0;
  for (const key of keys)
    if (prefixes.some((prefix) => key.startsWith(prefix))) {
      storage.removeItem(key);
      cleared++;
    }
  return cleared;
}
