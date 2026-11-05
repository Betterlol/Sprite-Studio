import { ResizeHandle } from "./ResizeHandle.tsx";
import { useEffect, useState, useRef } from "react";
import {
  Folder,
  FolderOpen,
  FolderPlus,
  ChevronRight,
  ChevronDown,
  Search,
  Film,
  Trash2,
  Pencil,
  FolderInput,
  RotateCcw,
  X,
  LoaderCircle,
  Upload,
  Plus,
  Image as ImageIcon,
  Images,
} from "lucide-react";
import {
  assetUrl,
  resourceCategories,
  folderCategory,
  resourceCategory,
  type Asset,
  type DeletePlan,
  type LibrarySelection,
  type TrashEntry,
} from "../studio/model.ts";
import { api } from "./api.ts";

type LibraryState = {
  assets: Asset[];
  folders: string[];
  libraryRevision: string;
  trash: TrashEntry[];
};
const parent = (folder: string) =>
  folder.includes("/") ? folder.slice(0, folder.lastIndexOf("/")) : "";
const basename = (folder: string) => folder.split("/").at(-1) || "项目资源";
const inside = (path: string, folder: string) =>
  path === folder || path.startsWith(folder + "/");
const imageKinds = { reference: "参考图", image: "图片" };
export function ResourceLibrary({
  projectId,
  state,
  selectedId,
  folder,
  onFolder,
  onSelect,
  onChanged,
  onImport,
  onNewClip,
  disabled,
}: {
  projectId: string;
  state: LibraryState | null;
  selectedId: string;
  folder: string;
  onFolder: (folder: string) => void;
  onSelect: (id: string) => void;
  onChanged: () => Promise<void>;
  onImport: () => void;
  onNewClip: () => void;
  disabled: boolean;
}) {
  const [search, setSearch] = useState("");
  const [checked, setChecked] = useState<string[]>([]),
    [expanded, setExpanded] = useState<string[]>([...resourceCategories]);
  const [dialog, setDialog] = useState<
    "folder" | "rename" | "move" | "delete" | "trash" | null
  >(null);
  const [name, setName] = useState(""),
    [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [plan, setPlan] = useState<DeletePlan | null>(null);
  const modalRef = useRef<HTMLFormElement>(null);
  const request = useRef<{
    selection: LibrarySelection;
    revision: string;
    folder: string;
  }>({ selection: { assetIds: [], folders: [] }, revision: "", folder: "" });
  useEffect(() => {
    if (!dialog) return;
    const previous = document.activeElement as HTMLElement | null;
    const modal = modalRef.current;
    modal
      ?.querySelector<HTMLElement>("input, select, button:not(:disabled)")
      ?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        setDialog(null);
      }
      if (event.key === "Tab" && modal) {
        const controls = [
          ...modal.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input, select, [tabindex="0"]',
          ),
        ];
        const first = controls[0],
          last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", keyboard);
    return () => {
      document.removeEventListener("keydown", keyboard);
      if (previous?.isConnected) previous.focus();
    };
  }, [dialog, busy]);
  const assets = state?.assets || [],
    folders = state?.folders || [""];
  const selectionReady = useRef(false);
  useEffect(() => {
    setChecked([]);
    setExpanded((old) => [
      ...new Set([
        ...old,
        "",
        ...folder.split("/").map((_, i, a) => a.slice(0, i + 1).join("/")),
      ]),
    ]);
  }, [folder]);
  useEffect(() => {
    if (!selectionReady.current) {
      if (state) selectionReady.current = true;
      return;
    }
    const asset = assets.find((a) => a.id === selectedId);
    if (asset) {
      onFolder(asset.folder || "");
    }
  }, [selectedId]);
  useEffect(() => {
    if (state && !folders.includes(folder)) onFolder("参考图");
  }, [state?.libraryRevision]);
  const visible = assets
    .filter((a) =>
      !search
        ? (a.folder || "") === folder
        : `${a.name} ${a.folder || ""}`
            .toLowerCase()
            .includes(search.toLowerCase()),
    )
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }));
  const children =
    !folder && !search
      ? [...resourceCategories]
      : folders.filter((f) => f && parent(f) === folder && !search);
  const keys = [
    ...children.filter((f) => folderCategory(f) !== f).map((f) => `f:${f}`),
    ...visible.map((a) => `a:${a.id}`),
  ];
  const selectedKeys = checked.filter((key) =>
    key.startsWith("a:")
      ? assets.some((a) => a.id === key.slice(2))
      : folders.includes(key.slice(2)),
  );
  const selection: LibrarySelection = {
    assetIds: selectedKeys
      .filter((k) => k.startsWith("a:"))
      .map((k) => k.slice(2)),
    folders: selectedKeys
      .filter((k) => k.startsWith("f:"))
      .map((k) => k.slice(2)),
  };
  const categories = new Set([
    ...selection.assetIds.map((id) =>
      resourceCategory(assets.find((a) => a.id === id)!),
    ),
    ...selection.folders.map((path) => folderCategory(path)),
  ]);
  const destinations = folders.filter(
    (path) =>
      !!folderCategory(path) &&
      categories.size === 1 &&
      categories.has(folderCategory(path)) &&
      !selection.folders.some((root) => inside(path, root)),
  );
  function toggle(key: string) {
    setChecked((old) =>
      old.includes(key) ? old.filter((k) => k !== key) : [...old, key],
    );
  }
  function open(next: typeof dialog) {
    request.current = {
      selection: structuredClone(selection),
      revision: state?.libraryRevision || "",
      folder,
    };
    setError("");
    setPlan(null);
    setName("");
    setTarget(destinations.includes(folder) ? folder : destinations[0] || "");
    setDialog(next);
    if (next === "rename")
      setName(
        selection.assetIds.length
          ? assets.find((a) => a.id === selection.assetIds[0])!.name
          : basename(selection.folders[0]!),
      );
    if (next === "delete") {
      setBusy(true);
      void api<DeletePlan>(`/api/projects/${projectId}/library/delete-plan`, {
        method: "POST",
        body: JSON.stringify(selection),
      })
        .then(setPlan)
        .catch((e) => setError(e.message))
        .finally(() => setBusy(false));
    }
  }
  async function mutate(path: string, body: unknown) {
    setBusy(true);
    setError("");
    try {
      const result = await api(`/api/projects/${projectId}/${path}`, {
        method: "POST",
        body: JSON.stringify({
          ...(body as object),
          libraryRevision:
            dialog === "trash"
              ? state!.libraryRevision
              : request.current.revision,
        }),
      });
      await onChanged();
      setChecked([]);
      return result;
    } catch (e: any) {
      setError(e.message);
      await onChanged();
      return null;
    } finally {
      setBusy(false);
    }
  }
  async function submit() {
    if (!state) return;
    const selection = request.current.selection;
    if (dialog === "folder") {
      const result = await mutate("folders", {
        parent: request.current.folder,
        name,
      });
      if (result) {
        onFolder(result.folder);
        setDialog(null);
      }
    } else if (dialog === "delete") {
      const result = await mutate("library/delete", { selection });
      if (result) setDialog(null);
    } else {
      const destination =
        dialog === "rename"
          ? selection.folders.length
            ? parent(selection.folders[0]!)
            : assets.find((a) => a.id === selection.assetIds[0])!.folder || ""
          : target;
      const result = await mutate("library/move", {
        selection,
        target: destination,
        ...(dialog === "rename" ? { name } : {}),
      });
      if (result) {
        if (dialog === "move") onFolder(target);
        else if (
          selection.folders.length &&
          inside(folder, selection.folders[0]!)
        ) {
          const old = selection.folders[0]!;
          const next = destination ? `${destination}/${name}` : name;
          onFolder(next + folder.slice(old.length));
        }
        setDialog(null);
      }
    }
  }
  const tree = (path: string) => {
    const kids = folders.filter((f) => f && parent(f) === path);
    const category = folderCategory(path) === path;
    const count = assets.filter((asset) =>
      inside(asset.folder || "", path),
    ).length;
    const Icon = category
      ? path === "动画"
        ? Film
        : path === "参考图"
          ? ImageIcon
          : Images
      : folder === path
        ? FolderOpen
        : Folder;
    return (
      <div key={path}>
        <div
          className={`directory-line ${category ? "category-line" : ""} ${folder === path && dialog !== "trash" ? "active" : ""}`}
          style={{
            paddingLeft: 8 + Math.max(0, path.split("/").length - 1) * 12,
          }}
        >
          <button
            className="directory-toggle"
            aria-label={`${expanded.includes(path) ? "收起" : "展开"}${basename(path)}`}
            aria-expanded={expanded.includes(path)}
            disabled={!kids.length}
            onClick={() =>
              setExpanded((old) =>
                old.includes(path)
                  ? old.filter((f) => f !== path)
                  : [...old, path],
              )
            }
          >
            {expanded.includes(path) ? (
              <ChevronDown size={12} />
            ) : (
              <ChevronRight size={12} />
            )}
          </button>
          <button
            onClick={() => {
              onFolder(path);
              setSearch("");
            }}
            title={path || "项目资源"}
            aria-current={folder === path ? "location" : undefined}
          >
            <Icon size={14} />
            <span>{basename(path)}</span>
            {category && <small className="directory-count">{count}</small>}
          </button>
        </div>
        {expanded.includes(path) && kids.map(tree)}
      </div>
    );
  };
  return (
    <aside className="library managed-library" aria-label="资源管理">
      <div className="panel-heading">
        <h2>项目资源</h2>
        <span>{assets.length}</span>
        <div className="library-heading-actions">
          <button
            className="icon-button"
            aria-label="新建文件夹"
            title={folder ? "新建文件夹" : "请先选择资源分类"}
            disabled={disabled || !folderCategory(folder)}
            onClick={() => open("folder")}
          >
            <FolderPlus size={16} />
          </button>
          <button
            className="icon-button"
            aria-label="打开回收站"
            title={`回收站（${state?.trash.length || 0}）`}
            onClick={() => open("trash")}
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>
      <div className="directory-tree" aria-label="目录树">
        {resourceCategories.map(tree)}
      </div>
      <ResizeHandle
        name="目录树高度"
        target=".directory-tree"
        variable="--tree-height"
        min={64}
        max={500}
      />
      <nav className="directory-breadcrumb" aria-label="当前目录">
        <button onClick={() => onFolder("")}>资源</button>
        {folder
          .split("/")
          .filter(Boolean)
          .map((part, i, parts) => (
            <span key={i}>
              <ChevronRight size={11} />
              <button
                title={parts.slice(0, i + 1).join("/")}
                onClick={() => onFolder(parts.slice(0, i + 1).join("/"))}
              >
                {part}
              </button>
            </span>
          ))}
      </nav>
      <div className="search-box">
        <Search size={14} />
        <input
          aria-label="搜索资源"
          placeholder="搜索整个工程…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setChecked([]);
          }}
        />
        {search && (
          <button aria-label="清空搜索" onClick={() => setSearch("")}>
            <X size={13} />
          </button>
        )}
      </div>
      <div className="library-selection">
        <label>
          <input
            type="checkbox"
            aria-label="全选当前列表"
            checked={!!keys.length && keys.every((k) => checked.includes(k))}
            onChange={(e) => setChecked(e.target.checked ? keys : [])}
          />
          {selectedKeys.length ? `已选 ${selectedKeys.length} 项` : "选择项目"}
        </label>
        <div>
          <button
            aria-label="重命名所选项目"
            title="重命名"
            disabled={disabled || selectedKeys.length !== 1}
            onClick={() => open("rename")}
          >
            <Pencil size={14} />
          </button>
          <button
            aria-label="移动所选项目"
            title={
              categories.size > 1 ? "请选择同一分类内的资源进行移动" : "移动到…"
            }
            disabled={disabled || !selectedKeys.length || !destinations.length}
            onClick={() => open("move")}
          >
            <FolderInput size={15} />
          </button>
          <button
            aria-label="删除所选项目"
            title="移到回收站"
            disabled={disabled || !selectedKeys.length}
            onClick={() => open("delete")}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
      <div className="asset-list">
        {children.map((path) => (
          <div className="library-entry folder-entry" key={path}>
            <input
              type="checkbox"
              aria-label={`选择文件夹 ${basename(path)}`}
              disabled={folderCategory(path) === path}
              checked={checked.includes(`f:${path}`)}
              onChange={() => toggle(`f:${path}`)}
            />
            <button className="asset-row" onClick={() => onFolder(path)}>
              <Folder size={24} />
              <span className="asset-info">
                <strong>{basename(path)}</strong>
                <small>
                  {folderCategory(path) === path
                    ? `${assets.filter((asset) => inside(asset.folder || "", path)).length} 项资源 · 固定分类`
                    : "文件夹"}
                </small>
              </span>
              <ChevronRight size={13} />
            </button>
          </div>
        ))}
        {visible.map((asset) => (
          <div
            key={asset.id}
            className={`library-entry ${asset.id === selectedId ? "selected" : ""}`}
          >
            <input
              type="checkbox"
              aria-label={`选择资源 ${asset.name}`}
              checked={checked.includes(`a:${asset.id}`)}
              onChange={() => toggle(`a:${asset.id}`)}
            />
            <button
              className="asset-row"
              title={`${asset.folder || "资源"}/${asset.name}`}
              onClick={() => onSelect(asset.id)}
              draggable={asset.type === "image"}
              onDragStart={(event) => {
                event.dataTransfer.setData(
                  "application/x-sprite-asset",
                  asset.id,
                );
                event.dataTransfer.effectAllowed = "link";
                const selected = checked
                  .filter((key) => key.startsWith("a:"))
                  .map((key) => key.slice(2))
                  .filter((id) =>
                    assets.some(
                      (a) =>
                        a.id === id && a.type === "image" && a.frameCount === 1,
                    ),
                  );
                event.dataTransfer.setData(
                  "application/x-sprite-assets",
                  JSON.stringify(
                    selected.includes(asset.id) ? selected : [asset.id],
                  ),
                );
              }}
            >
              <span
                className={`asset-thumb ${asset.type === "clip" ? "clip-thumb" : ""}`}
              >
                {asset.type === "image" ? (
                  <img
                    src={assetUrl(projectId, asset.id, asset.revision)}
                    alt=""
                    draggable={false}
                    loading="lazy"
                  />
                ) : (
                  <Film size={22} />
                )}
              </span>
              <span className="asset-info">
                <strong>{asset.name}</strong>
                <small>
                  {search ? `${asset.folder || "资源"} · ` : ""}
                  {asset.type === "image"
                    ? `${imageKinds[asset.kind]} · ${asset.width} × ${asset.height}`
                    : `${asset.frames.length} 帧 · 动画片段`}
                </small>
              </span>
            </button>
          </div>
        ))}
        {!visible.length && !children.length && (
          <div className="library-empty">
            <FolderOpen size={25} />
            <span>{search ? "没有匹配的资源" : "这个目录还是空的"}</span>
            <small>
              {search
                ? "试试资源名称或目录名称"
                : folderCategory(folder) === "动画"
                  ? "新建动画，或从原图素材切割生成"
                  : "导入图片，或新建文件夹"}
            </small>
          </div>
        )}
      </div>
      <div className="library-footer">
        <button
          className="import-button new-clip-button"
          disabled={disabled}
          onClick={onNewClip}
        >
          <Film size={15} />
          新建动画
          <Plus size={13} />
        </button>
        <button
          className="import-button"
          disabled={disabled}
          onClick={onImport}
        >
          <Upload size={15} />
          {folderCategory(folder) === "参考图"
            ? "导入参考图"
            : folderCategory(folder) === "原图素材"
              ? "导入原图素材"
              : "导入原图素材…"}
          <Plus size={13} />
        </button>
      </div>
      {dialog && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !busy) setDialog(null);
          }}
        >
          <form
            ref={modalRef}
            className={`modal library-modal ${dialog === "trash" ? "trash-modal" : ""}`}
            role="dialog"
            aria-modal="true"
            aria-label={
              dialog === "folder"
                ? "新建文件夹"
                : dialog === "rename"
                  ? "重命名"
                  : dialog === "move"
                    ? "移动到"
                    : dialog === "delete"
                      ? "删除确认"
                      : "回收站"
            }
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <div className="modal-heading">
              <h2>
                {
                  {
                    folder: "新建文件夹",
                    rename: "重命名",
                    move: "移动到",
                    delete: "移到回收站",
                    trash: "工程回收站",
                  }[dialog]
                }
              </h2>
              <button
                type="button"
                className="icon-button"
                aria-label="关闭资源管理对话框"
                disabled={busy}
                onClick={() => setDialog(null)}
              >
                <X size={17} />
              </button>
            </div>
            {(dialog === "folder" || dialog === "rename") && (
              <>
                <p>
                  {dialog === "folder"
                    ? `创建于：资源${folder ? "/" + folder : ""}`
                    : "引用会随资源保留。图片请保留原扩展名。"}
                </p>
                <label>
                  名称
                  <input
                    autoFocus
                    required
                    maxLength={100}
                    aria-label="项目名称"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
              </>
            )}
            {dialog === "move" && (
              <>
                <p>移动所选 {selectedKeys.length} 项，动画引用保持不变。</p>
                <label>
                  目标目录
                  <select
                    aria-label="目标目录"
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                  >
                    {destinations.map((f) => (
                      <option key={f} value={f}>
                        资源{f ? "/" + f : ""}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
            {dialog === "delete" && (
              <>
                {busy && !plan ? (
                  <p>正在检查引用…</p>
                ) : (
                  plan && (
                    <>
                      <p>
                        本次包含 {plan.assetIds.length} 项资源、
                        {plan.folders.length} 个目录。删除后可从工程回收站恢复。
                      </p>
                      {!!plan.blockers.length && (
                        <div className="library-blockers">
                          <strong>以下引用需要先处理</strong>
                          {plan.blockers.map((b, i) => (
                            <p key={i}>
                              {b.name}
                              <small>{b.reason}</small>
                            </p>
                          ))}
                        </div>
                      )}
                    </>
                  )
                )}
              </>
            )}
            {dialog === "trash" && (
              <>
                <p>恢复到原目录，保留原资源身份。遇到同名项目时会提示冲突。</p>
                <div className="trash-list">
                  {!state?.trash.length && (
                    <div className="library-empty">
                      <Trash2 size={25} />
                      <span>回收站是空的</span>
                    </div>
                  )}
                  {state?.trash.map((entry) => (
                    <div className="trash-entry" key={entry.id}>
                      <div>
                        <strong>{entry.label}</strong>
                        <small>
                          {entry.assets.length} 项资源 ·{" "}
                          {new Date(entry.deletedAt).toLocaleString("zh-CN")}
                        </small>
                        <small>{entry.roots[0]?.from}</small>
                      </div>
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy || disabled}
                        aria-label={`恢复 ${entry.label}`}
                        onClick={() =>
                          void mutate("library/restore", { id: entry.id })
                        }
                      >
                        <RotateCcw size={14} />
                        恢复
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
            {error && (
              <p className="library-error" role="alert">
                {error}
              </p>
            )}
            {dialog !== "trash" && (
              <div className="library-modal-actions">
                <button
                  className="secondary"
                  type="button"
                  disabled={busy}
                  onClick={() => setDialog(null)}
                >
                  取消
                </button>
                <button
                  className={dialog === "delete" ? "danger-button" : "primary"}
                  type="submit"
                  disabled={
                    busy ||
                    disabled ||
                    (dialog === "delete" &&
                      (!plan || !!plan.blockers.length)) ||
                    ((dialog === "folder" || dialog === "rename") &&
                      !name.trim())
                  }
                >
                  {busy && <LoaderCircle size={14} className="spin" />}
                  {dialog === "delete"
                    ? "确认移到回收站"
                    : dialog === "move"
                      ? "移动到此目录"
                      : dialog === "folder"
                        ? "创建文件夹"
                        : "保存名称"}
                </button>
              </div>
            )}
          </form>
        </div>
      )}
    </aside>
  );
}
