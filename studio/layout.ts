import { randomUUID } from "node:crypto";
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
} from "node:fs";
import { dirname } from "node:path";
import { resourceCategories, resourceCategory } from "./model.ts";
import { atomicJson, StudioError, type ProjectStore } from "./store.ts";

type LayoutOperation = {
  staged: string;
  backup: string;
  status: "prepared" | "completed";
};
const operationPath = ".studio/resource-layout-operation.json";

// The original tree is retained as a backup. A prepared tree is swapped in only
// after every file and sidecar has been copied successfully.
export function recoverResourceLayout(store: ProjectStore, pid: string) {
  const path = (file: string) => store.safePath(pid, file);
  if (!existsSync(path(operationPath))) return;
  const operation: LayoutOperation = JSON.parse(
    readFileSync(path(operationPath), "utf8"),
  );
  if (operation.status === "completed") return;
  if (!existsSync(path(operation.backup))) {
    if (!existsSync(path(operation.staged)))
      throw new StudioError("资源分类整理文件缺失，请保留现场处理");
    mkdirSync(dirname(path(operation.backup)), { recursive: true });
    renameSync(path("Assets"), path(operation.backup));
  }
  if (!existsSync(path("Assets")))
    renameSync(path(operation.staged), path("Assets"));
  const marker = path("Assets/.resource-layout.json");
  if (
    !existsSync(marker) ||
    JSON.parse(readFileSync(marker, "utf8")).version !== 1
  )
    throw new StudioError("资源分类整理遇到目录冲突，请保留现场处理");
  const project = store.project(pid);
  project.resourceLayout = 1;
  atomicJson(path("project.json"), project);
  operation.status = "completed";
  atomicJson(path(operationPath), operation);
}

export function organizeResourceLayout(store: ProjectStore, pid: string) {
  if (store.project(pid).resourceLayout === 1) return;
  const id = randomUUID(),
    staged = `.studio/layout-staging/${id}/Assets`,
    backup = `.studio/layout-backups/${id}/Assets`;
  const path = (file: string) => store.safePath(pid, file);
  for (const root of resourceCategories)
    mkdirSync(path(`${staged}/${root}`), { recursive: true });
  const destinations = new Map<string, string>();
  const metadata = new Map<string, unknown>();
  for (const asset of store.assets(pid)) {
    const root = resourceCategory(asset),
      folder = root + (asset.folder ? "/" + asset.folder : ""),
      file = `Assets/${root}/${asset.file!.slice(7)}`,
      meta = store.metaPath(pid, asset.id),
      newMeta = `Assets/${root}/${meta.slice(7)}`;
    destinations.set(asset.file!, file);
    destinations.set(meta, newMeta);
    metadata.set(meta, {
      ...JSON.parse(readFileSync(path(meta), "utf8")),
      folder,
      file,
    });
  }
  const visit = (folder: string) => {
    const entries = readdirSync(path(`Assets${folder ? "/" + folder : ""}`), {
      withFileTypes: true,
    });
    if (!entries.length && folder)
      mkdirSync(path(`${staged}/原图素材/${folder}`), { recursive: true });
    for (const entry of entries) {
      const relative = folder ? `${folder}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new StudioError("资源目录不能包含链接");
      if (entry.isDirectory()) {
        visit(relative);
        continue;
      }
      const source = `Assets/${relative}`,
        destination = destinations.get(source) || `Assets/原图素材/${relative}`,
        output = path(staged + destination.slice(6));
      mkdirSync(dirname(output), { recursive: true });
      copyFileSync(path(source), output, constants.COPYFILE_EXCL);
      if (metadata.has(source)) atomicJson(output, metadata.get(source));
    }
  };
  visit("");
  atomicJson(path(`${staged}/.resource-layout.json`), { version: 1 });
  atomicJson(path(operationPath), {
    staged,
    backup,
    status: "prepared",
  } satisfies LayoutOperation);
  recoverResourceLayout(store, pid);
  store.loadAssets(pid);
}
