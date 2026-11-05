import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { dirname, extname, posix } from "node:path";
import { atomicJson, sha256, StudioError, type ProjectStore } from "./store.ts";
import type {
  Asset,
  DeletePlan,
  LibrarySelection,
  TrashEntry,
} from "./model.ts";
import {
  categoryFolder,
  folderCategory,
  resourceCategory,
  type ResourceCategory,
} from "./model.ts";

type Move = { from: string; to: string };
type Journal = {
  id: string;
  status: "prepared" | "committed" | "rolledBack";
  moves: Move[];
  writes: { path: string; before: string | null; after: string }[];
  directories: string[];
};
const within = (path: string, folder: string) =>
  path === folder || path.startsWith(folder + "/");
export const assetFolder = (asset: Asset) => asset.folder || "";
export function entryName(name: string) {
  if (
    !name ||
    name.length > 100 ||
    /[\\/:*?"<>|\x00-\x1f]/.test(name) ||
    /[. ]$/.test(name) ||
    name !== name.trim() ||
    /^(\.|\.\.|con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(name)
  )
    throw new StudioError("名称不能包含路径、特殊字符、结尾空格或系统保留名称");
  return name;
}

export class ResourceLibrary {
  store: ProjectStore;
  constructor(store: ProjectStore) {
    this.store = store;
  }
  path(pid: string, path: string) {
    return this.store.safePath(pid, path);
  }
  folder(pid: string, folder: string) {
    if (
      typeof folder !== "string" ||
      folder.includes("\\") ||
      folder.split("/").some((part) => part === "." || part === "..") ||
      folder.startsWith("/") ||
      folder.endsWith("/")
    )
      throw new StudioError("无效目录");
    if (folder) folder.split("/").forEach(entryName);
    const path = this.path(pid, `Assets${folder ? "/" + folder : ""}`);
    if (!existsSync(path) || !lstatSync(path).isDirectory())
      throw new StudioError("目录不存在，请刷新后重试", 409);
    return folder;
  }
  folders(pid: string) {
    const folders = [""];
    const visit = (folder: string) => {
      for (const entry of readdirSync(
        this.path(pid, `Assets${folder ? "/" + folder : ""}`),
        { withFileTypes: true },
      )) {
        if (entry.isSymbolicLink())
          throw new StudioError("资源目录包含链接，请移除链接后重新打开");
        if (entry.isDirectory()) {
          const child = folder ? `${folder}/${entry.name}` : entry.name;
          folders.push(child);
          visit(child);
        }
      }
    };
    visit("");
    return folders.sort((a, b) => a.localeCompare(b, "zh-CN"));
  }
  destination(pid: string, category: ResourceCategory, source = "") {
    this.folder(pid, source);
    const folder = categoryFolder(category, source);
    mkdirSync(this.path(pid, `Assets/${folder}`), { recursive: true });
    return this.folder(pid, folder);
  }
  private managedFolder(pid: string, folder: string) {
    this.folder(pid, folder);
    if (!folderCategory(folder))
      throw new StudioError("请在参考图、原图素材或动画分类内管理目录");
  }
  revision(pid: string) {
    return sha256(
      JSON.stringify({
        folders: this.folders(pid),
        assets: this.store
          .assets(pid)
          .map((a) => [a.id, a.revision, a.name, assetFolder(a)])
          .sort(),
      }),
    );
  }
  assertIdle(pid: string, expected: string) {
    if (
      this.store.resourceReaders.get(pid) ||
      [...this.store.sessions.values()].some(
        (s) =>
          s.projectId === pid && ["running", "starting"].includes(s.status),
      )
    )
      throw new StudioError(
        "当前工程正在处理图片或运行助手，请完成或停止后再整理资源",
        409,
      );
    if (expected !== this.revision(pid))
      throw new StudioError("资源列表已变化，请刷新后重试", 409);
  }
  private journalDir(pid: string) {
    const dir = this.path(pid, ".studio/library-operations");
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  recover(pid: string) {
    const dir = this.journalDir(pid);
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      const journal: Journal = JSON.parse(
        readFileSync(`${dir}/${file}`, "utf8"),
      );
      if (journal.status === "prepared") {
        this.rollback(pid, journal);
        atomicJson(`${dir}/${file}`, journal);
      }
    }
  }
  private rollback(pid: string, journal: Journal) {
    for (const write of [...journal.writes].reverse()) {
      const path = this.path(pid, write.path);
      if (write.before === null) {
        if (existsSync(path)) unlinkSync(path);
      } else if (existsSync(path)) {
        // atomicJson serializes the already captured JSON without changing its fields.
        atomicJson(path, JSON.parse(write.before));
      }
    }
    for (const move of [...journal.moves].reverse()) {
      const from = this.path(pid, move.from),
        to = this.path(pid, move.to);
      if (existsSync(to)) {
        if (existsSync(from))
          throw new StudioError(
            "资源操作恢复遇到路径冲突，请保留现场处理",
            409,
          );
        mkdirSync(dirname(from), { recursive: true });
        renameSync(to, from);
      }
    }
    for (const directory of [...journal.directories].reverse()) {
      const path = this.path(pid, directory);
      if (existsSync(path) && readdirSync(path).length === 0) rmdirSync(path);
    }
    journal.status = "rolledBack";
  }
  private transaction(
    pid: string,
    moves: Move[],
    values: { path: string; value: unknown; beforePath?: string }[] = [],
    directories: string[] = [],
  ) {
    const required = new Set(directories);
    for (const path of [
      ...moves.map((move) => move.to),
      ...values.map((value) => value.path),
      ...directories.map((dir) => `${dir}/_`),
    ]) {
      let parent = posix.dirname(path);
      while (parent !== "." && !existsSync(this.path(pid, parent))) {
        required.add(parent);
        parent = posix.dirname(parent);
      }
    }
    const directoryMoves = moves.filter(
      (move) =>
        existsSync(this.path(pid, move.from)) &&
        lstatSync(this.path(pid, move.from)).isDirectory(),
    );
    const journal: Journal = {
      id: randomUUID(),
      status: "prepared",
      moves,
      directories: [...required]
        .filter((dir) => !directoryMoves.some((move) => within(dir, move.to)))
        .sort((a, b) => a.split("/").length - b.split("/").length),
      writes: values.map((v) => {
        const beforePath = this.path(pid, v.beforePath || v.path);
        return {
          path: v.path,
          before: existsSync(beforePath)
            ? readFileSync(beforePath, "utf8")
            : null,
          after: JSON.stringify(v.value),
        };
      }),
    };
    for (const move of moves) {
      if (!existsSync(this.path(pid, move.from)))
        throw new StudioError("资源文件缺失，请刷新后重试", 409);
      if (existsSync(this.path(pid, move.to)))
        throw new StudioError("目标位置已有同名文件或文件夹", 409);
    }
    const journalPath = `${this.journalDir(pid)}/${journal.id}.json`;
    atomicJson(journalPath, journal);
    try {
      for (const directory of journal.directories)
        mkdirSync(this.path(pid, directory), { recursive: true });
      for (const move of moves) {
        mkdirSync(dirname(this.path(pid, move.to)), { recursive: true });
        renameSync(this.path(pid, move.from), this.path(pid, move.to));
      }
      for (const write of journal.writes)
        atomicJson(this.path(pid, write.path), JSON.parse(write.after));
      journal.status = "committed";
      atomicJson(journalPath, journal);
    } catch (error) {
      journal.status = "prepared";
      this.rollback(pid, journal);
      atomicJson(journalPath, journal);
      throw error;
    }
    this.store.loadAssets(pid);
    this.store.changed(pid);
  }
  private collision(
    pid: string,
    folder: string,
    name: string,
    except = new Set<string>(),
  ) {
    const key = name.toLocaleLowerCase();
    if (
      this.store
        .assets(pid)
        .some(
          (a) =>
            !except.has(a.id) &&
            assetFolder(a) === folder &&
            a.name.toLocaleLowerCase() === key,
        ) ||
      readdirSync(this.path(pid, `Assets${folder ? "/" + folder : ""}`)).some(
        (file) => file.toLocaleLowerCase() === key,
      )
    )
      throw new StudioError(`目标目录已存在“${name}”`, 409);
  }
  uniqueName(pid: string, folder: string, requested: string, image: boolean) {
    this.folder(pid, folder);
    const ext = image ? extname(requested) : "",
      stem = ext ? requested.slice(0, -ext.length) : requested;
    for (let index = 1; ; index++) {
      const name = `${stem.slice(0, 80)}${index > 1 ? ` (${index})` : ""}${ext}`;
      try {
        entryName(name);
        this.collision(pid, folder, name);
        const file = `Assets/${folder ? folder + "/" : ""}${name}${image ? "" : ".clip.json"}`;
        if (
          existsSync(this.path(pid, file)) ||
          existsSync(this.path(pid, file + ".meta.json"))
        )
          continue;
        return { name, file };
      } catch (error) {
        if (!(error instanceof StudioError) || error.statusCode !== 409)
          throw error;
      }
    }
  }
  createFolder(pid: string, parent: string, name: string, expected: string) {
    this.assertIdle(pid, expected);
    this.managedFolder(pid, parent);
    entryName(name);
    this.collision(pid, parent, name);
    const folder = parent ? `${parent}/${name}` : name;
    this.transaction(pid, [], [], [`Assets/${folder}`]);
    return folder;
  }
  outputFolder(pid: string, parent: string, requested: string) {
    this.folder(pid, parent);
    let name = requested.slice(0, 70) || "切片";
    for (let i = 1; ; i++) {
      const value = i === 1 ? name : `${name} (${i})`,
        folder = parent ? `${parent}/${value}` : value;
      try {
        this.collision(pid, parent, value);
        mkdirSync(this.path(pid, `Assets/${folder}`));
        return folder;
      } catch (error: any) {
        if (
          error.code !== "EEXIST" &&
          !(error instanceof StudioError && error.statusCode === 409)
        )
          throw error;
      }
    }
  }
  private selected(pid: string, selection: LibrarySelection) {
    const roots = [...new Set(selection.folders)]
      .map((f) => this.folder(pid, f))
      .sort((a, b) => a.length - b.length);
    if (roots.some((root) => !root || folderCategory(root) === root))
      throw new StudioError("不能移动、重命名或删除资源根目录及固定分类");
    const folders = roots.filter(
      (f, index) => !roots.slice(0, index).some((root) => within(f, root)),
    );
    const explicit = [...new Set(selection.assetIds)].map((id) =>
      this.store.asset(pid, id),
    );
    const assets = this.store
      .assets(pid)
      .filter(
        (a) =>
          explicit.some((v) => v.id === a.id) ||
          folders.some((f) => within(assetFolder(a), f)),
      );
    if (!assets.length && !folders.length)
      throw new StudioError("请先选择资源或文件夹");
    return {
      folders,
      assets,
      direct: explicit.filter(
        (a) => !folders.some((f) => within(assetFolder(a), f)),
      ),
    };
  }
  relocate(
    pid: string,
    selection: LibrarySelection,
    target: string,
    expected: string,
    newName?: string,
  ) {
    this.assertIdle(pid, expected);
    this.managedFolder(pid, target);
    const chosen = this.selected(pid, selection);
    if (
      chosen.folders.some(
        (folder) => folderCategory(folder) !== folderCategory(target),
      ) ||
      chosen.direct.some(
        (asset) => resourceCategory(asset) !== folderCategory(target),
      )
    )
      throw new StudioError("请在同一资源分类内移动，图片与动画通过引用关联");
    if (newName && chosen.folders.length + chosen.direct.length !== 1)
      throw new StudioError("每次只能重命名一个项目");
    const moves: Move[] = [],
      values: { path: string; value: unknown; beforePath: string }[] = [],
      targets = new Set<string>();
    const reserve = (name: string) => {
      const key = name.toLowerCase();
      if (targets.has(key))
        throw new StudioError(`所选项目存在重名“${name}”`, 409);
      targets.add(key);
    };
    for (const folder of chosen.folders) {
      const name = entryName(newName || posix.basename(folder)),
        destination = target ? `${target}/${name}` : name;
      if (destination === folder) continue;
      if (within(target, folder))
        throw new StudioError("不能把文件夹移到自身或子目录");
      this.collision(pid, target, name);
      reserve(name);
      moves.push({ from: `Assets/${folder}`, to: `Assets/${destination}` });
      for (const asset of chosen.assets.filter((a) =>
        within(assetFolder(a), folder),
      )) {
        const oldMeta = this.store.metaPath(pid, asset.id),
          meta = oldMeta.replace(`Assets/${folder}/`, `Assets/${destination}/`);
        values.push({
          path: meta,
          beforePath: oldMeta,
          value: {
            ...JSON.parse(readFileSync(this.path(pid, oldMeta), "utf8")),
            folder: assetFolder(asset).replace(folder, destination),
            file: asset.file!.replace(
              `Assets/${folder}/`,
              `Assets/${destination}/`,
            ),
          },
        });
      }
    }
    for (const asset of chosen.direct) {
      let name = entryName(newName || asset.name);
      if (
        asset.type === "image" &&
        extname(name).toLowerCase() !== extname(asset.file).toLowerCase()
      )
        throw new StudioError("重命名图片时请保留原扩展名");
      if (target === assetFolder(asset) && name === asset.name) continue;
      this.collision(pid, target, name, new Set([asset.id]));
      reserve(name);
      const file = `Assets/${target ? target + "/" : ""}${name}${asset.type === "clip" ? ".clip.json" : ""}`,
        meta = file + ".meta.json",
        oldMeta = this.store.metaPath(pid, asset.id);
      if (asset.file !== file) moves.push({ from: asset.file!, to: file });
      if (oldMeta !== meta) moves.push({ from: oldMeta, to: meta });
      if (
        asset.type === "image" &&
        existsSync(this.path(pid, asset.file + ".recipe.json"))
      )
        moves.push({
          from: asset.file + ".recipe.json",
          to: file + ".recipe.json",
        });
      if (
        asset.type === "clip" &&
        existsSync(this.path(pid, asset.file + ".config.json"))
      )
        moves.push({
          from: asset.file + ".config.json",
          to: file + ".config.json",
        });
      values.push({
        path: meta,
        beforePath: oldMeta,
        value: {
          ...JSON.parse(readFileSync(this.path(pid, oldMeta), "utf8")),
          name,
          folder: target,
          file,
        },
      });
    }
    if (moves.length) this.transaction(pid, moves, values);
    return this.store.state(pid);
  }
  planDelete(pid: string, selection: LibrarySelection): DeletePlan {
    const chosen = this.selected(pid, selection),
      ids = new Set(chosen.assets.map((a) => a.id)),
      blockers: DeletePlan["blockers"] = [];
    for (const asset of this.store.assets(pid)) {
      if (
        asset.type === "image" &&
        asset.producer &&
        ids.has(asset.producer.sheetId) &&
        !ids.has(asset.id)
      )
        blockers.push({
          name: asset.name,
          reason: "切片仍引用所选原图；请一起选择相关切片",
        });
      if (
        asset.type === "clip" &&
        !ids.has(asset.id) &&
        asset.frames.some((f) => ids.has(f.imageId))
      )
        blockers.push({ name: asset.name, reason: "动画仍在使用所选图片" });
    }
    for (const change of this.store.animation.changes.values()) {
      if (
        change.projectId !== pid ||
        change.status !== "applied" ||
        ids.has(change.clipId) ||
        !this.store.indexes.get(pid)?.has(change.clipId)
      )
        continue;
      if (
        this.store.animation
          .snapshot(pid, change.baseSnapshotId)
          .clip.frames.some((f) => ids.has(f.imageId))
      )
        blockers.push({
          name: this.store.asset(pid, change.clipId).name,
          reason: "修改历史的撤回仍需要所选图片",
        });
    }
    for (const job of this.store.interpolations.list(pid)) {
      if (
        !this.store.indexes.get(pid)?.has(job.clipId) ||
        ids.has(job.clipId) ||
        ["applied", "failed", "interrupted"].includes(job.status)
      )
        continue;
      if (
        [job.sheetId, job.start.imageId, job.end.imageId].some(
          (id) => id && ids.has(id),
        )
      )
        blockers.push({
          name:
            this.store.indexes.get(pid)?.get(job.clipId)?.name || "补帧任务",
          reason: "未完成的补帧任务仍需要所选资源",
        });
    }
    return { selection, assetIds: [...ids], folders: chosen.folders, blockers };
  }
  trash(pid: string) {
    const path = this.path(pid, ".studio/trash");
    if (!existsSync(path)) return [];
    return readdirSync(path)
      .flatMap((id) => {
        const file = this.path(pid, `.studio/trash/${id}/entry.json`);
        if (!existsSync(file)) return [];
        const item: TrashEntry = JSON.parse(readFileSync(file, "utf8"));
        return item.status === "trashed" ? [item] : [];
      })
      .sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  }
  delete(pid: string, selection: LibrarySelection, expected: string) {
    this.assertIdle(pid, expected);
    const plan = this.planDelete(pid, selection);
    if (plan.blockers.length)
      throw new StudioError(
        plan.blockers.map((b) => `${b.name}：${b.reason}`).join("；"),
        409,
      );
    const chosen = this.selected(pid, selection),
      id = randomUUID(),
      prefix = `.studio/trash/${id}/files/`;
    const roots: Move[] = chosen.folders.map((folder) => ({
      from: `Assets/${folder}`,
      to: prefix + folder,
    }));
    for (const asset of chosen.direct)
      for (const path of [
        asset.file!,
        this.store.metaPath(pid, asset.id),
        ...(asset.type === "clip" &&
        existsSync(this.path(pid, asset.file + ".config.json"))
          ? [asset.file + ".config.json"]
          : []),
        ...(asset.type === "image" &&
        existsSync(this.path(pid, asset.file + ".recipe.json"))
          ? [asset.file + ".recipe.json"]
          : []),
      ])
        roots.push({ from: path, to: prefix + path.slice(7) });
    const entry: TrashEntry = {
      resourceLayout: 1,
      id,
      label:
        chosen.folders.length === 1 && !chosen.direct.length
          ? posix.basename(chosen.folders[0]!)
          : chosen.assets.length === 1
            ? chosen.assets[0]!.name
            : `${chosen.assets.length} 项资源`,
      deletedAt: new Date().toISOString(),
      status: "trashed",
      assets: chosen.assets,
      folders: chosen.folders,
      roots,
    };
    this.transaction(pid, roots, [
      { path: `.studio/trash/${id}/entry.json`, value: entry },
    ]);
    return entry;
  }
  restore(pid: string, id: string, expected: string) {
    this.assertIdle(pid, expected);
    const entry = this.trash(pid).find((e) => e.id === id);
    if (!entry) throw new StudioError("回收站记录不存在或已恢复", 404);
    if (!entry.resourceLayout) return this.restoreLegacy(pid, entry);
    const ids = new Set(entry.assets.map((a) => a.id));
    for (const asset of entry.assets) {
      if (
        asset.type === "image" &&
        asset.producer &&
        !ids.has(asset.producer.sheetId) &&
        !this.store.indexes.get(pid)?.has(asset.producer.sheetId)
      )
        throw new StudioError("请先恢复切片的来源原图", 409);
      if (this.store.indexes.get(pid)?.has(asset.id))
        throw new StudioError("资源身份已存在，无法恢复覆盖", 409);
      if (this.folders(pid).includes(assetFolder(asset)))
        this.collision(pid, assetFolder(asset), asset.name);
      if (
        asset.type === "clip" &&
        asset.frames.some(
          (f) =>
            !ids.has(f.imageId) && !this.store.indexes.get(pid)?.has(f.imageId),
        )
      )
        throw new StudioError("请先恢复此动画使用的图片，再恢复动画", 409);
    }
    this.transaction(
      pid,
      entry.roots.map((move) => ({ from: move.to, to: move.from })),
      [
        {
          path: `.studio/trash/${id}/entry.json`,
          value: { ...entry, status: "restored" },
        },
      ],
    );
    return entry.assets.map((a) => a.id);
  }
  private restoreLegacy(pid: string, entry: TrashEntry) {
    const restored = entry.assets.map((asset) => {
      const root = resourceCategory(
        asset.type === "image"
          ? {
              ...asset,
              kind:
                asset.kind ||
                ((asset as any).role === "reference" ? "reference" : "image"),
            }
          : asset,
      );
      return {
        ...asset,
        ...(asset.type === "image"
          ? {
              kind:
                root === "参考图" ? ("reference" as const) : ("image" as const),
            }
          : {}),
        folder: root + (asset.folder ? "/" + asset.folder : ""),
        file: `Assets/${root}/${asset.file!.slice(7)}`,
      };
    });
    const ids = new Set(restored.map((asset) => asset.id));
    for (const asset of restored) {
      if (this.store.indexes.get(pid)?.has(asset.id))
        throw new StudioError("资源身份已存在，无法恢复覆盖", 409);
      if (
        asset.type === "clip" &&
        asset.frames.some(
          (frame) =>
            !ids.has(frame.imageId) &&
            !this.store.indexes.get(pid)?.has(frame.imageId),
        )
      )
        throw new StudioError("请先恢复此动画使用的图片，再恢复动画", 409);
      if (existsSync(this.path(pid, `Assets/${asset.folder}`)))
        this.collision(pid, asset.folder!, asset.name);
    }
    const moves: Move[] = [],
      values: { path: string; value: unknown; beforePath?: string }[] = [],
      directories: string[] = [];
    const files = new Map(
      entry.assets.map((asset, i) => [asset.file!, restored[i]!.file!]),
    );
    const visit = (from: string, original: string) => {
      if (lstatSync(this.path(pid, from)).isDirectory()) {
        const children = readdirSync(this.path(pid, from));
        if (!children.length)
          directories.push(`Assets/原图素材/${original.slice(7)}`);
        for (const child of children)
          visit(`${from}/${child}`, `${original}/${child}`);
        return;
      }
      let to = files.get(original) || `Assets/原图素材/${original.slice(7)}`;
      if (original.endsWith(".meta.json")) {
        const metadata = JSON.parse(readFileSync(this.path(pid, from), "utf8")),
          asset = restored.find((a) => a.id === metadata.id);
        if (asset) {
          to = `Assets/${resourceCategory(asset)}/${original.slice(7)}`;
          values.push({
            path: to,
            beforePath: from,
            value: { ...metadata, folder: asset.folder, file: asset.file },
          });
        }
      }
      moves.push({ from, to });
    };
    for (const root of entry.roots) visit(root.to, root.from);
    values.push({
      path: `.studio/trash/${entry.id}/entry.json`,
      value: { ...entry, status: "restored" },
    });
    this.transaction(pid, moves, values, directories);
    return restored.map((asset) => asset.id);
  }
}
