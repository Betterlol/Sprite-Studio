import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { posix } from "node:path";
import { atomicJson, type ProjectStore } from "./store.ts";

type Record = {
  status: "prepared" | "committed" | "rolledBack";
  files: { path: string; before: string | null; after: string }[];
  directories: string[];
  result: unknown;
};
function replace(path: string, bytes: Buffer) {
  const temporary = path + "." + randomUUID() + ".tmp";
  writeFileSync(temporary, bytes, { flag: "wx" });
  renameSync(temporary, path);
}
function rollback(store: ProjectStore, pid: string, record: Record) {
  for (const file of [...record.files].reverse()) {
    const target = store.safePath(pid, file.path);
    if (file.before)
      replace(target, readFileSync(store.safePath(pid, file.before)));
    else if (existsSync(target)) unlinkSync(target);
  }
  for (const directory of [...record.directories].reverse()) {
    const path = store.safePath(pid, directory);
    if (existsSync(path) && !readdirSync(path).length) rmdirSync(path);
  }
  record.status = "rolledBack";
}
export function recoverFileOperations(store: ProjectStore, pid: string) {
  const root = store.safePath(pid, ".studio/config-operations");
  if (!existsSync(root)) return;
  for (const id of readdirSync(root)) {
    const file = store.safePath(
      pid,
      `.studio/config-operations/${id}/operation.json`,
    );
    if (!existsSync(file)) continue;
    const record: Record = JSON.parse(readFileSync(file, "utf8"));
    if (record.status === "prepared") {
      rollback(store, pid, record);
      atomicJson(file, record);
    }
  }
}
// Synchronous publication: computation runs outside this operation; all prior bytes
// are captured before any project file changes, including binary image outputs.
export function publishFiles(
  store: ProjectStore,
  pid: string,
  writes: { path: string; bytes: Buffer }[],
  result: unknown,
  beforePublish?: () => void,
) {
  store.assertWriteAllowed();
  beforePublish?.();
  const prefix = `.studio/config-operations/${randomUUID()}`;
  mkdirSync(store.safePath(pid, prefix), { recursive: true });
  const directories = new Set<string>();
  const record: Record = {
    status: "prepared",
    files: [],
    directories: [],
    result,
  };
  const paths = new Set<string>();
  for (const [index, write] of writes.entries()) {
    if (paths.has(write.path)) throw new Error("Duplicate publication path");
    paths.add(write.path);
    const path = store.safePath(pid, write.path),
      before = existsSync(path) ? `${prefix}/${index}.before` : null,
      after = `${prefix}/${index}.after`;
    if (before) writeFileSync(store.safePath(pid, before), readFileSync(path));
    writeFileSync(store.safePath(pid, after), write.bytes);
    record.files.push({ path: write.path, before, after });
    let folder = posix.dirname(write.path);
    while (folder !== "." && !existsSync(store.safePath(pid, folder))) {
      directories.add(folder);
      folder = posix.dirname(folder);
    }
  }
  record.directories = [...directories].sort(
    (a, b) => a.split("/").length - b.split("/").length,
  );
  const journal = store.safePath(pid, prefix + "/operation.json");
  // Recheck before a prepared journal exists: a rejected baseline must not be
  // rolled back over somebody else's changes at recovery.
  beforePublish?.();
  atomicJson(journal, record);
  try {
    for (const folder of record.directories)
      mkdirSync(store.safePath(pid, folder), { recursive: true });
    for (const file of record.files)
      replace(
        store.safePath(pid, file.path),
        readFileSync(store.safePath(pid, file.after)),
      );
    record.status = "committed";
    atomicJson(journal, record);
  } catch (error) {
    rollback(store, pid, record);
    atomicJson(journal, record);
    throw error;
  }
  store.loadAssets(pid);
  store.changed(pid);
}
