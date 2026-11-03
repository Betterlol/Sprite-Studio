import React, { useCallback, useEffect, useRef, useState } from "react";
import { InterpolationPanel } from "./InterpolationPanel.tsx";
import { NewClipDialog } from "./NewClipDialog.tsx";
import { AnimationPanel } from "./AnimationPanel.tsx";
import { ComparisonPlayer } from "./ComparisonPlayer.tsx";
import { api } from "./api.ts";
import {
  Upload,
  Plus,
  Search,
  Image as ImageIcon,
  Film,
  Sparkles,
  ArrowUp,
  Square,
  X,
  RefreshCw,
  Download,
  Link2,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Maximize2,
  ZoomIn,
  ZoomOut,
  Grid2X2,
  SlidersHorizontal,
  Check,
  LoaderCircle,
  ChevronLeft,
  ChevronRight,
  MessageSquare,
  FolderOpen,
  AlertCircle,
  PanelRightClose,
  ScanEye,
} from "lucide-react";
import {
  assetUrl,
  type Asset,
  type ImageAsset,
  type ClipAsset,
  type Project,
  type Session,
  type Transform,
  type Interpolation,
  type ClipReference,
  type ClipReview,
  type FrameChange,
  type ClipSnapshot,
} from "../studio/model.ts";

type State = {
  project: Project;
  assets: Asset[];
  sessions: Session[];
  interpolations: Interpolation[];
  reviews: ClipReview[];
  frameChanges: FrameChange[];
};
type Connection = { connected: boolean; model?: string; error?: string };
const roles = { reference: "参考图", source: "已采纳", candidate: "候选" };
const emptyTransform: Transform = {
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  clip: false,
};
const active = (session?: Session | null) =>
  session && ["starting", "running"].includes(session.status);
function mergeSessions(old: Session[], incoming: Session[]) {
  const map = new Map(old.map((session) => [session.id, session]));
  for (const session of incoming)
    if (
      !map.has(session.id) ||
      map.get(session.id)!.updatedAt <= session.updatedAt
    )
      map.set(session.id, session);
  return [...map.values()].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
}

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [state, setState] = useState<State | null>(null);
  const [projectId, setProjectId] = useState("");
  const projectRef = useRef("");
  const [selectedId, setSelectedId] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [connection, setConnection] = useState<Connection>({
    connected: false,
  });
  const [online, setOnline] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [frameIndex, setFrameIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [playbackRun, setPlaybackRun] = useState(0);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [background, setBackground] = useState("checker");
  const [tool, setTool] = useState<
    "slice" | "adjust" | "interpolate" | "review"
  >(() => {
    const saved = localStorage.getItem("studio.tool");
    return saved === "adjust" || saved === "interpolate" || saved === "review"
      ? saved
      : "slice";
  });
  const playbackIntent = useRef<string | null>(null);
  const frameIntent = useRef<{ clipId: string; frameId: string } | null>(null);
  const [comparison, setComparison] = useState<{
    before: ClipSnapshot;
    after: ClipSnapshot;
    nonce: number;
  } | null>(null);
  useEffect(() => {
    localStorage.setItem("studio.tool", tool);
  }, [tool]);
  const [columns, setColumns] = useState(4);
  const [rows, setRows] = useState(1);
  const [fps, setFps] = useState(12);
  const [showGrid, setShowGrid] = useState(false);
  const [transform, setTransform] = useState<Transform>(emptyTransform);
  const [draft, setDraft] = useState("");
  const [references, setReferences] = useState<string[]>([]);
  const [clipReferences, setClipReferences] = useState<ClipReference[]>([]);
  const [focusedReviewId, setFocusedReviewId] = useState(""),
    [focusedChangeId, setFocusedChangeId] = useState("");
  const [operation, setOperation] = useState("");
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(
    null,
  );
  const [newProject, setNewProject] = useState(false);
  const [newClip, setNewClip] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [promptAnswers, setPromptAnswers] = useState<Record<string, string>>(
    {},
  );
  const [chatVisible, setChatVisible] = useState(true);
  const upload = useRef<HTMLInputElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const chatEnd = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState({ width: 800, height: 500 });
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const notify = (text: string, error = false) => setToast({ text, error });
  const selected = state?.assets.find((asset) => asset.id === selectedId);
  const clip = selected?.type === "clip" ? selected : undefined;
  const comparing =
    comparison &&
    [comparison.before.clip.id, comparison.after.clip.id].includes(selectedId)
      ? comparison
      : null;
  const repairBaseId = state?.frameChanges?.find(
    (change) => change.candidateClipId === clip?.id,
  )?.clipId;
  const interpolationPreviewId = repairBaseId || clip?.id;
  const originalClipId = state?.interpolations?.find(
    (job) => job.prepared?.clipId === interpolationPreviewId,
  )?.clipId;
  const interpolationClip = (
    originalClipId
      ? state?.assets.find((asset) => asset.id === originalClipId)
      : repairBaseId
        ? state?.assets.find((asset) => asset.id === repairBaseId)
        : clip
  ) as ClipAsset | undefined;
  const currentImage = (
    clip
      ? state?.assets.find(
          (asset) =>
            asset.id ===
            clip.frames[Math.min(frameIndex, clip.frames.length - 1)]?.imageId,
        )
      : selected
  ) as ImageAsset | undefined;
  const session = state?.sessions.find((session) => session.id === sessionId);
  const agentBusy = !!state?.sessions.some((session) => active(session));

  const loadProject = useCallback(async (id: string, initial = false) => {
    const next = await api<State>(`/api/projects/${id}`);
    if (projectRef.current !== id) return;
    setState((old) =>
      old?.project.id === id
        ? { ...next, sessions: mergeSessions(old.sessions, next.sessions) }
        : next,
    );
    if (initial) {
      const storedAsset = localStorage.getItem(`studio.asset.${id}`);
      setSelectedId(
        next.assets.some((asset) => asset.id === storedAsset)
          ? storedAsset!
          : next.assets[0]?.id || "",
      );
      const storedSession = localStorage.getItem(`studio.session.${id}`);
      const nextSession = next.sessions.some(
        (session) => session.id === storedSession,
      )
        ? storedSession!
        : next.sessions[0]?.id || "";
      setSessionId(nextSession);
      setDraft(localStorage.getItem(`studio.draft.${id}.${nextSession}`) || "");
      setReferences([]);
      setClipReferences([]);
      setFrameIndex(0);
      setPlaying(false);
    }
  }, []);
  refreshRef.current = () =>
    projectRef.current ? loadProject(projectRef.current) : Promise.resolve();
  useEffect(() => {
    void Promise.all([
      api<Project[]>("/api/projects"),
      api<Connection>("/api/status"),
    ])
      .then(([projects, status]) => {
        setProjects(projects);
        setConnection(status);
        const stored = localStorage.getItem("studio.project");
        const id =
          projects.find((project) => project.id === stored)?.id ||
          projects[0]?.id;
        if (id) {
          projectRef.current = id;
          setProjectId(id);
          void loadProject(id, true);
        }
      })
      .catch((error) => notify(String(error), true));
    const events = new EventSource("/api/events");
    events.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "connected") {
        setOnline(true);
        setConnection(message.data.status);
        void refreshRef.current();
      }
      if (message.type === "status") setConnection(message.data);
      if (
        message.type === "assets" &&
        message.data.projectId === projectRef.current
      )
        void refreshRef.current();
      if (
        message.type === "session" &&
        message.data.projectId === projectRef.current
      )
        setState((old) =>
          old
            ? { ...old, sessions: mergeSessions(old.sessions, [message.data]) }
            : old,
        );
    };
    events.onerror = () => setOnline(false);
    return () => events.close();
  }, [loadProject]);
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), toast.error ? 8000 : 3500);
      return () => clearTimeout(timer);
    }
  }, [toast]);
  useEffect(() => {
    if (projectId && state?.project.id === projectId) {
      localStorage.setItem("studio.project", projectId);
      localStorage.setItem(`studio.asset.${projectId}`, selectedId);
      localStorage.setItem(`studio.session.${projectId}`, sessionId);
      localStorage.setItem(`studio.draft.${projectId}.${sessionId}`, draft);
    }
  }, [projectId, state?.project.id, selectedId, sessionId, draft]);
  useEffect(() => {
    setFrameIndex(
      frameIntent.current?.clipId === selectedId
        ? Math.max(
            0,
            (
              state?.assets.find((asset) => asset.id === selectedId) as
                | ClipAsset
                | undefined
            )?.frames.findIndex(
              (frame) => frame.id === frameIntent.current?.frameId,
            ) ?? 0,
          )
        : 0,
    );
    frameIntent.current = null;
    setPlaying(playbackIntent.current === selectedId);
    playbackIntent.current = null;
    setTransform(emptyTransform);
    setZoom("fit");
  }, [selectedId]);
  useEffect(() => {
    if (
      selected?.type === "image" &&
      (tool === "interpolate" || tool === "review")
    )
      setTool("slice");
  }, [selected?.type]);
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]!.contentRect;
      setStageSize({ width: rect.width, height: rect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [state, chatVisible]);
  useEffect(() => {
    chatEnd.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [
    session?.messages.at(-1)?.text,
    session?.status,
    session?.activities.length,
  ]);
  useEffect(() => {
    if (!playing || !clip) return;
    let index = frameIndex,
      elapsed = 0,
      last = performance.now(),
      request = 0;
    const tick = (time: number) => {
      elapsed += Math.min(time - last, 100);
      last = time;
      let guard = 0;
      while (
        elapsed >= clip.frames[index]!.durationUs / 1000 &&
        guard++ < 128
      ) {
        elapsed -= clip.frames[index]!.durationUs / 1000;
        if (index === clip.frames.length - 1 && !clip.loop) {
          setPlaying(false);
          return;
        }
        index = (index + 1) % clip.frames.length;
        setFrameIndex(index);
      }
      request = requestAnimationFrame(tick);
    };
    request = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(request);
  }, [playing, clip?.revision, playbackRun]);

  async function run(label: string, action: () => Promise<void>) {
    setOperation(label);
    try {
      await action();
    } catch (error) {
      notify((error as Error).message, true);
    } finally {
      setOperation("");
    }
  }
  function chooseProject(id: string) {
    setComparison(null);
    setClipReferences([]);
    projectRef.current = id;
    setProjectId(id);
    setState(null);
    setSearch("");
    setFilter("all");
    void loadProject(id, true).catch((error) => notify(error.message, true));
  }
  function chooseSession(id: string) {
    setSessionId(id);
    setDraft(localStorage.getItem(`studio.draft.${projectId}.${id}`) || "");
    setReferences([]);
    setClipReferences([]);
    setPromptAnswers({});
  }
  async function makeSession() {
    const created = await api<Session>(`/api/projects/${projectId}/sessions`, {
      method: "POST",
    });
    setState((old) =>
      old ? { ...old, sessions: mergeSessions(old.sessions, [created]) } : old,
    );
    chooseSession(created.id);
    return created;
  }
  function addReference(id?: string) {
    if (!id) return;
    setReferences((old) =>
      old.includes(id)
        ? old
        : old.length >= 5
          ? (notify("一次最多引用 5 张图片"), old)
          : [...old, id],
    );
  }
  function addClipReference(ref: ClipReference) {
    setClipReferences((old) =>
      old.some((item) => item.clipId === ref.clipId)
        ? old.map((item) => (item.clipId === ref.clipId ? ref : item))
        : old.length < 3
          ? [...old, ref]
          : (notify("一次最多引用 3 段动画"), old),
    );
    setChatVisible(true);
  }
  function previewClip(id: string, frameId?: string, play = true) {
    if (
      frameId &&
      !(
        state?.assets.find((asset) => asset.id === id) as ClipAsset | undefined
      )?.frames.some((frame) => frame.id === frameId)
    ) {
      notify("该帧实例已不在当前动画中，请查看旧快照或重新检查", true);
      return;
    }
    setComparison(null);
    setTool("review");
    setPlaying(false);
    if (id === selectedId) {
      setFrameIndex(
        frameId
          ? Math.max(
              0,
              clip?.frames.findIndex((frame) => frame.id === frameId) ?? 0,
            )
          : 0,
      );
      setPlaybackRun((value) => value + 1);
      setPlaying(play);
    } else {
      if (frameId) frameIntent.current = { clipId: id, frameId };
      playbackIntent.current = play ? id : null;
      setSelectedId(id);
    }
  }
  async function compareChange(id: string) {
    setFocusedChangeId(id);
    const change = state?.frameChanges?.find((change) => change.id === id);
    if (!change) throw new Error("候选正在同步，请稍后再试");
    const candidate = state?.assets.find(
      (asset) => asset.id === change.candidateClipId,
    ) as ClipAsset;
    const originalProject = projectId;
    setPlaying(false);
    setTool("review");
    if (![change.clipId, change.candidateClipId].includes(selectedId))
      setSelectedId(change.clipId);
    const result = await api<{ before: ClipSnapshot; after: ClipSnapshot }>(
      `/api/projects/${projectId}/frame-changes/${id}/compare`,
      {
        method: "POST",
        body: JSON.stringify({ candidateRevision: candidate.revision }),
      },
    );
    if (projectRef.current === originalProject)
      setComparison({ ...result, nonce: Date.now() });
  }
  async function importFiles(files: FileList | File[]) {
    setComparison(null);
    files = Array.from(files);
    const originalProject = projectId;
    await run("正在导入图片", async () => {
      let latest = "";
      for (const file of Array.from(files)) {
        const body = new FormData();
        body.append("file", file);
        const asset = await api<ImageAsset>(
          `/api/projects/${originalProject}/import?role=reference`,
          { method: "POST", body },
        );
        latest = asset.id;
      }
      if (projectRef.current === originalProject) {
        await refreshRef.current();
        setSelectedId(latest);
        setFilter("all");
      }
      notify(`已导入 ${files.length} 张图片`);
    });
  }
  async function sendMessage() {
    if (!draft.trim() || agentBusy) return;
    const text = draft.trim(),
      attached = [...references],
      attachedClips = [...clipReferences],
      originalProject = projectId;
    try {
      const target = session || (await makeSession());
      setDraft("");
      setReferences([]);
      setClipReferences([]);
      const updated = await api<Session>(
        `/api/sessions/${target.id}/messages`,
        {
          method: "POST",
          body: JSON.stringify({
            text,
            assetIds: attached,
            clipReferences: attachedClips,
            requestId: crypto.randomUUID(),
          }),
        },
      );
      if (projectRef.current === originalProject)
        setState((old) =>
          old
            ? { ...old, sessions: mergeSessions(old.sessions, [updated]) }
            : old,
        );
    } catch (error) {
      setDraft((old) => old || text);
      setReferences(attached);
      setClipReferences(attachedClips);
      notify((error as Error).message, true);
    }
  }
  async function saveClip(next: ClipAsset) {
    const updated = await api<ClipAsset>(
      `/api/projects/${projectId}/clips/${next.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          revision: next.revision,
          frames: next.frames,
          loop: next.loop,
        }),
      },
    );
    await refreshRef.current();
    return updated;
  }
  async function applySlice() {
    if (!currentImage) return;
    await run("正在切割图集", async () => {
      const result = await api<ClipAsset>(
        `/api/projects/${projectId}/assets/${currentImage.id}/slice`,
        {
          method: "POST",
          body: JSON.stringify({
            revision: currentImage.revision,
            spec: { columns, rows, fps },
          }),
        },
      );
      await refreshRef.current();
      setSelectedId(result.id);
      setFilter("all");
      notify(`已创建 ${result.frames.length} 帧动画，原图已保留`);
    });
  }
  async function applyTransform() {
    if (!currentImage) return;
    await run("正在生成调整候选", async () => {
      if (
        clip &&
        !state?.frameChanges?.some(
          (change) =>
            change.candidateClipId === clip.id && change.status === "draft",
        )
      ) {
        const change = await api<FrameChange>(
          `/api/projects/${projectId}/frame-changes`,
          {
            method: "POST",
            body: JSON.stringify({
              requestId: crypto.randomUUID(),
              clipId: clip.id,
              revision: clip.revision,
              frameId: clip.frames[frameIndex]!.id,
              transform,
            }),
          },
        );
        await refreshRef.current();
        previewClip(change.candidateClipId, change.frameId, false);
        setFocusedChangeId(change.id);
        notify("单帧修正候选已准备，原动画未覆盖");
        return;
      }
      const result = await api<ImageAsset>(
        `/api/projects/${projectId}/assets/${currentImage.id}/transform`,
        {
          method: "POST",
          body: JSON.stringify({ revision: currentImage.revision, transform }),
        },
      );
      if (clip) {
        await saveClip({
          ...clip,
          frames: clip.frames.map((frame, index) =>
            index === frameIndex ? { ...frame, imageId: result.id } : frame,
          ),
        });
      } else {
        await refreshRef.current();
        setSelectedId(result.id);
      }
      setTransform(emptyTransform);
      notify(
        clip
          ? "当前帧已更新，原图保留为独立资源"
          : "调整候选已生成，原图未覆盖",
      );
    });
  }
  const visibleAssets =
    state?.assets.filter(
      (asset) =>
        (!search || asset.name.toLowerCase().includes(search.toLowerCase())) &&
        (filter === "all" || filter === "clip"
          ? filter !== "clip" || asset.type === "clip"
          : asset.type === "image" && asset.role === filter),
    ) || [];
  const fit = currentImage
    ? Math.max(
        0.05,
        Math.min(
          (stageSize.width - 96) / currentImage.width,
          (stageSize.height - 96) / currentImage.height,
          2,
        ),
      )
    : 1;
  const scale = zoom === "fit" ? fit : zoom;
  const previewTransform =
    tool === "adjust"
      ? `translate(${transform.offsetX * scale}px,${transform.offsetY * scale}px) scale(${transform.scale})`
      : undefined;

  return (
    <div
      className="app"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        if (event.dataTransfer.files.length) {
          event.preventDefault();
          void importFiles(event.dataTransfer.files);
        }
      }}
    >
      <header className="header">
        <div className="brand">
          <span className="brand-mark">
            <i />
            <i />
            <i />
            <i />
          </span>
          <span>
            Sprite<span className="brand-light"> Studio</span>
          </span>
          <span className="beta">预览版</span>
        </div>
        <div className="project-switch">
          <FolderOpen size={15} />
          <select
            aria-label="当前工程"
            value={projectId}
            disabled={!projects.length || !!operation}
            onChange={(event) => chooseProject(event.target.value)}
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          <button
            className="icon-button"
            title="新建工程"
            onClick={() => setNewProject(true)}
          >
            <Plus size={16} />
          </button>
        </div>
        <div className="header-right">
          <span
            className={`connection ${connection.connected ? "connected" : ""}`}
          >
            <i />
            {connection.connected ? "Codex 已连接" : "Codex 未连接"}
          </span>
          <button
            className="icon-button"
            title="重新连接 Codex"
            onClick={() =>
              void run("连接 Codex", async () => {
                const next = await api<Connection>("/api/connect", {
                  method: "POST",
                });
                setConnection(next);
                if (next.error) notify(next.error, true);
              })
            }
          >
            <RefreshCw
              size={14}
              className={operation === "连接 Codex" ? "spin" : ""}
            />
          </button>
          <span className="header-divider" />
          <button
            className="icon-button"
            title={chatVisible ? "收起助手" : "展开助手"}
            onClick={() => setChatVisible(!chatVisible)}
          >
            <MessageSquare size={17} />
          </button>
        </div>
      </header>
      <main className={`workspace ${chatVisible ? "" : "without-chat"}`}>
        <aside className="library">
          <div className="panel-heading">
            <h2>项目资源</h2>
            <span>{state?.assets.length || 0}</span>
          </div>
          <div className="search-box">
            <Search size={14} />
            <input
              aria-label="搜索资源"
              placeholder="搜索资源…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <kbd>/</kbd>
          </div>
          <div className="resource-tabs">
            {[
              ["all", "全部"],
              ["reference", "参考"],
              ["candidate", "候选"],
              ["clip", "动画"],
            ].map(([value, label]) => (
              <button
                key={value}
                className={filter === value ? "active" : ""}
                onClick={() => setFilter(value!)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="asset-list">
            {visibleAssets.map((asset) => (
              <button
                key={asset.id}
                className={`asset-row ${asset.id === selectedId ? "selected" : ""}`}
                onClick={() => {
                  setComparison(null);
                  setSelectedId(asset.id);
                }}
                draggable={asset.type === "image"}
                onDragStart={(event) => {
                  event.dataTransfer.setData(
                    "application/x-sprite-asset",
                    asset.id,
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
                      loading="lazy"
                    />
                  ) : (
                    <Film size={22} />
                  )}
                </span>
                <span className="asset-info">
                  <strong>{asset.name}</strong>
                  <small>
                    {asset.type === "image"
                      ? `${roles[asset.role]} · ${asset.width} × ${asset.height}`
                      : `${asset.frames.length} 帧 · 动画片段`}
                  </small>
                </span>
                {asset.type === "image" && asset.role === "candidate" && (
                  <span className="candidate-dot" />
                )}
              </button>
            ))}
            {!visibleAssets.length && (
              <div className="library-empty">
                <ImageIcon size={23} />
                <span>{search ? "没有匹配的资源" : "还没有资源"}</span>
                <small>导入图片，开始一次制作</small>
              </div>
            )}
          </div>
          <div className="library-footer">
            <button
              className="import-button new-clip-button"
              disabled={
                (state?.assets.filter(
                  (asset) => asset.type === "image" && asset.frameCount === 1,
                ).length || 0) < 2
              }
              onClick={() => setNewClip(true)}
            >
              <Film size={15} />
              新建动画<span>＋</span>
            </button>
            <button
              className="import-button"
              disabled={!!operation}
              onClick={() => upload.current?.click()}
            >
              {operation === "正在导入图片" ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <Upload size={15} />
              )}
              导入图片<span>＋</span>
            </button>
            <p>PNG、JPEG、WebP、GIF · 拖入即可</p>
          </div>
        </aside>
        <section className="editor">
          <div className="editor-toolbar">
            <div className="asset-title">
              {selected?.type === "clip" ? (
                <Film size={16} />
              ) : (
                <ImageIcon size={16} />
              )}
              <span>{selected?.name || "预览画布"}</span>
              {selected?.type === "image" && (
                <small className={`role-tag ${selected.role}`}>
                  {roles[selected.role]}
                </small>
              )}
            </div>
            <div className="toolbar-actions">
              {currentImage && (
                <button
                  className="text-button"
                  title={clip ? "引用当前动画到聊天" : "引用当前图片到聊天"}
                  onClick={() => {
                    if (clip)
                      addClipReference({
                        clipId: clip.id,
                        revision: clip.revision,
                      });
                    else addReference(currentImage.id);
                    setChatVisible(true);
                  }}
                >
                  <Link2 size={14} />
                  <span>引用到对话</span>
                </button>
              )}
              {selected && (
                <a
                  className="icon-button"
                  title={clip ? "导出动画 WebP" : "下载图片"}
                  href={
                    clip
                      ? `/api/projects/${projectId}/clips/${clip.id}/export`
                      : assetUrl(projectId, selected.id)
                  }
                  download={clip ? `${clip.name}.webp` : selected.name}
                >
                  <Download size={16} />
                </a>
              )}
            </div>
          </div>
          <div className={`stage ${background}`} ref={stage}>
            {comparing ? (
              <ComparisonPlayer
                key={comparing.nonce}
                before={comparing.before}
                after={comparing.after}
                onClose={() => setComparison(null)}
              />
            ) : currentImage ? (
              <div
                className="artboard"
                style={{
                  width: currentImage.width * scale,
                  height: currentImage.height * scale,
                }}
              >
                <img
                  src={assetUrl(
                    projectId,
                    currentImage.id,
                    currentImage.revision,
                  )}
                  alt={currentImage.name}
                  draggable={false}
                  style={{ transform: previewTransform }}
                />
                {tool === "slice" && showGrid && !clip && (
                  <div
                    className="grid-overlay"
                    style={{
                      backgroundSize: `${100 / columns}% ${100 / rows}%`,
                    }}
                  />
                )}
                <div className="canvas-corners">
                  <i />
                  <i />
                  <i />
                  <i />
                </div>
              </div>
            ) : (
              <div className="stage-empty">
                <div className="empty-sprite">
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                </div>
                <h1>从一张参考图开始</h1>
                <p>
                  把角色、参考图或图集拖进来，
                  <br />
                  和助手一起完成下一帧。
                </p>
                <button
                  className="primary"
                  onClick={() => upload.current?.click()}
                >
                  <Upload size={15} />
                  导入第一张图片
                </button>
                <small>原图保留，每次调整都可以生成独立候选</small>
              </div>
            )}
            {currentImage && !comparing && (
              <div className="stage-status">
                <span>
                  {currentImage.width} × {currentImage.height}
                </span>
                <span>
                  {tool === "adjust" &&
                  (transform.scale !== 1 ||
                    transform.offsetX !== 0 ||
                    transform.offsetY !== 0)
                    ? "调整预览 · 应用后生成精确结果"
                    : "固定画布"}
                </span>
              </div>
            )}
            {!comparing && (
              <div className="view-controls">
                <div className="backgrounds">
                  {["checker", "dark", "light"].map((value) => (
                    <button
                      key={value}
                      title={
                        {
                          checker: "棋盘背景",
                          dark: "深色背景",
                          light: "浅色背景",
                        }[value]
                      }
                      className={`background-swatch ${value} ${background === value ? "active" : ""}`}
                      onClick={() => setBackground(value)}
                    />
                  ))}
                </div>
                <span className="control-divider" />
                <button
                  className="icon-button"
                  title="缩小"
                  onClick={() => setZoom(Math.max(0.1, scale / 1.25))}
                >
                  <ZoomOut size={15} />
                </button>
                <button className="zoom-label" onClick={() => setZoom(1)}>
                  {Math.round(scale * 100)}%
                </button>
                <button
                  className="icon-button"
                  title="放大"
                  onClick={() => setZoom(Math.min(8, scale * 1.25))}
                >
                  <ZoomIn size={15} />
                </button>
                <button
                  className={`icon-button ${zoom === "fit" ? "is-active" : ""}`}
                  title="适应画布"
                  onClick={() => setZoom("fit")}
                >
                  <Maximize2 size={15} />
                </button>
              </div>
            )}
          </div>
          {clip && (
            <div className="timeline">
              <div className="timeline-heading">
                <div className="playback">
                  <button
                    className="icon-button"
                    title="上一帧"
                    onClick={() => {
                      setPlaying(false);
                      setFrameIndex(Math.max(0, frameIndex - 1));
                    }}
                  >
                    <SkipBack size={14} />
                  </button>
                  <button
                    className={`play-button ${playing ? "playing" : ""}`}
                    aria-label={playing ? "暂停动画" : "播放动画"}
                    onClick={() => {
                      setComparison(null);
                      setPlaying(!playing);
                    }}
                  >
                    {playing ? <Pause size={16} /> : <Play size={16} />}
                  </button>
                  <button
                    className="icon-button"
                    title="下一帧"
                    onClick={() => {
                      setPlaying(false);
                      setFrameIndex(
                        Math.min(clip.frames.length - 1, frameIndex + 1),
                      );
                    }}
                  >
                    <SkipForward size={14} />
                  </button>
                  <span>
                    {String(frameIndex + 1).padStart(2, "0")}
                    <em> / {String(clip.frames.length).padStart(2, "0")}</em>
                  </span>
                </div>
                <div className="timeline-options">
                  <label>
                    <input
                      type="checkbox"
                      checked={clip.loop}
                      onChange={(event) =>
                        void run("保存循环设置", async () => {
                          await saveClip({
                            ...clip,
                            loop: event.target.checked,
                          });
                        })
                      }
                    />
                    循环
                  </label>
                  <span>
                    {(
                      clip.frames.reduce(
                        (total, frame) => total + frame.durationUs,
                        0,
                      ) / 1_000_000
                    ).toFixed(2)}{" "}
                    s
                  </span>
                </div>
              </div>
              <div className="frame-strip">
                {clip.frames.map((frame, index) => {
                  const image = state?.assets.find(
                    (asset) => asset.id === frame.imageId,
                  ) as ImageAsset | undefined;
                  return (
                    <button
                      key={frame.id}
                      className={`frame ${index === frameIndex ? "selected" : ""}`}
                      onClick={() => {
                        setPlaying(false);
                        setFrameIndex(index);
                        setComparison(null);
                        setTransform(emptyTransform);
                      }}
                    >
                      <span className="frame-number">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      {image && (
                        <img
                          src={assetUrl(projectId, image.id, image.revision)}
                          alt={`第 ${index + 1} 帧`}
                        />
                      )}
                      <small>{(frame.durationUs / 1000).toFixed(1)} ms</small>
                    </button>
                  );
                })}
              </div>
              <div className="frame-settings">
                <span>选中帧</span>
                <label>
                  停留
                  <input
                    aria-label="当前帧停留毫秒"
                    type="number"
                    min="1"
                    onFocus={() => {
                      setPlaying(false);
                      setComparison(null);
                    }}
                    key={`${clip.revision}-${frameIndex}`}
                    defaultValue={
                      (clip.frames[frameIndex]?.durationUs || 1000) / 1000
                    }
                    onBlur={(event) => {
                      const duration = Number(event.target.value);
                      if (
                        duration > 0 &&
                        Math.round(duration * 1000) !==
                          clip.frames[frameIndex]?.durationUs
                      )
                        void run("保存时长", async () => {
                          if (
                            !state?.frameChanges?.some(
                              (change) =>
                                change.candidateClipId === clip.id &&
                                change.status === "draft",
                            )
                          ) {
                            const change = await api<FrameChange>(
                              `/api/projects/${projectId}/frame-changes`,
                              {
                                method: "POST",
                                body: JSON.stringify({
                                  requestId: crypto.randomUUID(),
                                  clipId: clip.id,
                                  revision: clip.revision,
                                  frameId: clip.frames[frameIndex]!.id,
                                  durationUs: Math.round(duration * 1000),
                                }),
                              },
                            );
                            await refreshRef.current();
                            previewClip(
                              change.candidateClipId,
                              change.frameId,
                              false,
                            );
                            setFocusedChangeId(change.id);
                            return;
                          }
                          await saveClip({
                            ...clip,
                            frames: clip.frames.map((frame, index) =>
                              index === frameIndex
                                ? {
                                    ...frame,
                                    durationUs: Math.round(duration * 1000),
                                  }
                                : frame,
                            ),
                          });
                        });
                    }}
                  />
                  <span>ms</span>
                </label>
                <div className="reorder">
                  <button
                    className="icon-button"
                    title="将当前帧前移"
                    disabled={frameIndex === 0 || !!operation}
                    onClick={() =>
                      void run("调整帧顺序", async () => {
                        const frames = [...clip.frames];
                        [frames[frameIndex - 1], frames[frameIndex]] = [
                          frames[frameIndex]!,
                          frames[frameIndex - 1]!,
                        ];
                        await saveClip({ ...clip, frames });
                        setFrameIndex(frameIndex - 1);
                      })
                    }
                  >
                    <ChevronLeft size={14} />
                  </button>
                  <button
                    className="icon-button"
                    title="将当前帧后移"
                    disabled={
                      frameIndex >= clip.frames.length - 1 || !!operation
                    }
                    onClick={() =>
                      void run("调整帧顺序", async () => {
                        const frames = [...clip.frames];
                        [frames[frameIndex], frames[frameIndex + 1]] = [
                          frames[frameIndex + 1]!,
                          frames[frameIndex]!,
                        ];
                        await saveClip({ ...clip, frames });
                        setFrameIndex(frameIndex + 1);
                      })
                    }
                  >
                    <ChevronRight size={14} />
                  </button>
                </div>
                <span className="timeline-hint">
                  在实际速度下播放，检查动作节奏
                </span>
              </div>
            </div>
          )}
          {currentImage && (
            <section className="tools-panel">
              <div className="tools-tabs">
                <button
                  className={tool === "slice" ? "active" : ""}
                  onClick={() => {
                    setTool("slice");
                    setTransform(emptyTransform);
                  }}
                >
                  <Grid2X2 size={14} />
                  切割图集
                </button>
                <button
                  className={tool === "adjust" ? "active" : ""}
                  onClick={() => {
                    setTool("adjust");
                    setPlaying(false);
                  }}
                >
                  <SlidersHorizontal size={14} />
                  调整{clip ? "当前帧" : "图片"}
                </button>
                {interpolationClip && (
                  <button
                    className={tool === "interpolate" ? "active" : ""}
                    onClick={() => {
                      setTool("interpolate");
                      setPlaying(false);
                      setTransform(emptyTransform);
                    }}
                  >
                    <Sparkles size={14} />
                    首尾补帧
                  </button>
                )}
                {clip && (
                  <button
                    className={tool === "review" ? "active" : ""}
                    onClick={() => {
                      setTool("review");
                      setPlaying(false);
                      setTransform(emptyTransform);
                    }}
                  >
                    <ScanEye size={14} />
                    动画检查
                  </button>
                )}
                {currentImage.role === "candidate" && (
                  <button
                    className="adopt-button"
                    disabled={!!operation}
                    onClick={() =>
                      void run("采纳候选", async () => {
                        await api(
                          `/api/projects/${projectId}/assets/${currentImage.id}/adopt`,
                          {
                            method: "POST",
                            body: JSON.stringify({
                              revision: currentImage.revision,
                            }),
                          },
                        );
                        await refreshRef.current();
                        notify("已标记为采纳资源");
                      })
                    }
                  >
                    <Check size={13} />
                    采纳候选
                  </button>
                )}
              </div>
              {tool === "review" && clip ? (
                <AnimationPanel
                  key={`${projectId}-${repairBaseId || clip.id}`}
                  projectId={projectId}
                  clip={clip}
                  assets={state?.assets || []}
                  reviews={state?.reviews || []}
                  focusReviewId={focusedReviewId}
                  focusChangeId={focusedChangeId}
                  changes={state?.frameChanges || []}
                  onRefresh={() => refreshRef.current()}
                  onReference={addClipReference}
                  onFrame={(clipId, frameId) =>
                    previewClip(clipId, frameId, false)
                  }
                  onAdjust={() => {
                    setTool("adjust");
                    setComparison(null);
                    setPlaying(false);
                  }}
                  onCompare={compareChange}
                  onPreview={(id) => previewClip(id)}
                />
              ) : tool === "interpolate" && interpolationClip ? (
                <InterpolationPanel
                  key={`${projectId}-${interpolationClip.id}`}
                  projectId={projectId}
                  clip={interpolationClip}
                  assets={state?.assets || []}
                  jobs={state?.interpolations || []}
                  sessions={state?.sessions || []}
                  connected={connection.connected}
                  busy={agentBusy}
                  refresh={() => refreshRef.current()}
                  onSession={(id) => {
                    chooseSession(id);
                    setChatVisible(true);
                  }}
                  onPreview={(id) => {
                    setComparison(null);
                    setFrameIndex(0);
                    setPlaybackRun((value) => value + 1);
                    if (id === selectedId) setPlaying(true);
                    else {
                      playbackIntent.current = id;
                      setSelectedId(id);
                    }
                  }}
                />
              ) : tool === "slice" ? (
                <div className="tool-content">
                  <label>
                    列
                    <input
                      aria-label="切割列数"
                      type="number"
                      min="1"
                      max="32"
                      value={columns}
                      onChange={(event) =>
                        setColumns(
                          Math.max(1, Math.min(32, Number(event.target.value))),
                        )
                      }
                    />
                  </label>
                  <span className="multiply">×</span>
                  <label>
                    行
                    <input
                      aria-label="切割行数"
                      type="number"
                      min="1"
                      max="32"
                      value={rows}
                      onChange={(event) =>
                        setRows(
                          Math.max(1, Math.min(32, Number(event.target.value))),
                        )
                      }
                    />
                  </label>
                  <label>
                    帧率
                    <input
                      aria-label="新动画帧率"
                      type="number"
                      min="1"
                      max="60"
                      value={fps}
                      onChange={(event) =>
                        setFps(
                          Math.max(1, Math.min(60, Number(event.target.value))),
                        )
                      }
                    />
                    <small>fps</small>
                  </label>
                  <label className="grid-toggle">
                    <input
                      type="checkbox"
                      checked={showGrid}
                      onChange={(event) => setShowGrid(event.target.checked)}
                    />
                    网格
                  </label>
                  <span className="tool-spacer" />
                  <button
                    className="secondary"
                    disabled={!!operation || columns * rows > 128}
                    onClick={() => void applySlice()}
                  >
                    {operation === "正在切割图集" ? (
                      <LoaderCircle size={14} className="spin" />
                    ) : (
                      <Grid2X2 size={14} />
                    )}
                    创建 {columns * rows} 帧动画
                  </button>
                </div>
              ) : (
                <div className="adjust-content">
                  <div className="tool-content">
                    <label>
                      缩放
                      <input
                        aria-label="图片缩放百分比"
                        type="number"
                        min="5"
                        max="400"
                        value={Math.round(transform.scale * 100)}
                        onChange={(event) =>
                          setTransform((old) => ({
                            ...old,
                            scale: Math.max(
                              0.05,
                              Math.min(4, Number(event.target.value) / 100),
                            ),
                          }))
                        }
                      />
                      <small>%</small>
                    </label>
                    <label>
                      X
                      <input
                        aria-label="图片水平偏移"
                        type="number"
                        value={transform.offsetX}
                        onChange={(event) =>
                          setTransform((old) => ({
                            ...old,
                            offsetX: Number(event.target.value),
                          }))
                        }
                      />
                    </label>
                    <label>
                      Y
                      <input
                        aria-label="图片垂直偏移"
                        type="number"
                        value={transform.offsetY}
                        onChange={(event) =>
                          setTransform((old) => ({
                            ...old,
                            offsetY: Number(event.target.value),
                          }))
                        }
                      />
                    </label>
                    <span className="tool-spacer" />
                    <button
                      className="secondary"
                      disabled={!!operation}
                      onClick={() => void applyTransform()}
                    >
                      {operation ? (
                        <LoaderCircle size={14} className="spin" />
                      ) : (
                        <Check size={14} />
                      )}{" "}
                      {clip ? "准备单帧修正候选" : "另存调整候选"}
                    </button>
                  </div>
                  <div className="adjust-note">
                    <label>
                      <input
                        type="checkbox"
                        checked={transform.clip}
                        onChange={(event) =>
                          setTransform((old) => ({
                            ...old,
                            clip: event.target.checked,
                          }))
                        }
                      />
                      允许超出画布的内容裁切
                    </label>
                    <button onClick={() => setTransform(emptyTransform)}>
                      重置
                    </button>
                  </div>
                </div>
              )}
            </section>
          )}
        </section>
        {chatVisible && (
          <aside
            className="chat-panel"
            onDragOver={(event) => {
              if (
                event.dataTransfer.types.includes("application/x-sprite-asset")
              )
                event.preventDefault();
            }}
            onDrop={(event) => {
              const id = event.dataTransfer.getData(
                "application/x-sprite-asset",
              );
              if (id) {
                event.preventDefault();
                event.stopPropagation();
                addReference(id);
              }
            }}
          >
            <div className="chat-header">
              <div className="chat-heading">
                <span className="assistant-icon">
                  <Sparkles size={16} />
                </span>
                <div>
                  <h2>制作助手</h2>
                  <small>{connection.model || "Codex"}</small>
                </div>
              </div>
              <div className="chat-header-actions">
                <button
                  className="icon-button"
                  title="新建对话"
                  onClick={() =>
                    void makeSession().catch((error) =>
                      notify(error.message, true),
                    )
                  }
                >
                  <Plus size={17} />
                </button>
                <button
                  className="icon-button"
                  title="收起助手"
                  onClick={() => setChatVisible(false)}
                >
                  <PanelRightClose size={16} />
                </button>
              </div>
            </div>
            {!!state?.sessions.length && (
              <select
                className="session-select"
                aria-label="对话记录"
                value={sessionId}
                onChange={(event) => chooseSession(event.target.value)}
              >
                {state.sessions.map((session) => (
                  <option key={session.id} value={session.id}>
                    {active(session) ? "◌ " : ""}
                    {session.title}
                  </option>
                ))}
              </select>
            )}
            <div className="messages">
              {!session?.messages.length && (
                <div className="chat-empty">
                  <div className="chat-orbit">
                    <Sparkles size={26} />
                  </div>
                  <h3>把想法变成下一帧</h3>
                  <p>
                    引用一张图片，告诉我你想做什么。
                    <br />
                    也可以先聊角色和动作的方向。
                  </p>
                  <div className="suggestions">
                    {[
                      "看看这张参考图，分析角色特征",
                      "把这张图集切割成动画帧",
                      "调整这一帧的位置和大小",
                    ].map((text) => (
                      <button
                        key={text}
                        onClick={() => {
                          setDraft(text);
                          addReference(currentImage?.id);
                        }}
                      >
                        <span>{text}</span>
                        <ArrowUp size={13} />
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {session?.messages.map((message) => (
                <div
                  className={`message ${message.role} ${message.phase === "commentary" ? "commentary" : ""}`}
                  key={message.id}
                >
                  <div className="message-label">
                    {message.role === "assistant" ? (
                      <>
                        <Sparkles size={12} />
                        助手
                      </>
                    ) : (
                      <>
                        你
                        <span>
                          {new Date(message.createdAt).toLocaleTimeString(
                            "zh-CN",
                            { hour: "2-digit", minute: "2-digit" },
                          )}
                        </span>
                      </>
                    )}
                  </div>
                  {message.text && (
                    <div className="message-text">
                      {message.displayText || message.text}
                    </div>
                  )}
                  {!!message.clipReferences?.length && (
                    <div className="message-clip-refs">
                      {message.clipReferences.map((ref) => (
                        <button
                          key={ref.snapshotId}
                          onClick={() => {
                            setComparison(null);
                            setSelectedId(ref.clipId);
                            setTool("review");
                          }}
                        >
                          <Film size={13} />
                          {ref.name}
                          {ref.startFrameId ? " · 已选区间" : " · 动画引用"}
                        </button>
                      ))}
                    </div>
                  )}
                  {!!message.reviewIds?.length && (
                    <div className="message-clip-refs">
                      {message.reviewIds.map((id) => {
                        const review = state?.reviews?.find(
                          (review) => review.id === id,
                        );
                        return review ? (
                          <button
                            key={id}
                            onClick={() => {
                              setComparison(null);
                              setSelectedId(review.clipId);
                              setFocusedReviewId(id);
                              setTool("review");
                            }}
                          >
                            <ScanEye size={13} />
                            查看动画检查证据
                          </button>
                        ) : null;
                      })}
                    </div>
                  )}
                  {!!message.changeIds?.length && (
                    <div className="message-clip-refs">
                      {message.changeIds.map((id) => {
                        const change = state?.frameChanges?.find(
                          (change) => change.id === id,
                        );
                        return change ? (
                          <button
                            key={id}
                            onClick={() =>
                              void run("载入修改对比", () => compareChange(id))
                            }
                          >
                            <Play size={13} />
                            查看单帧修正与前后对比
                          </button>
                        ) : null;
                      })}
                    </div>
                  )}
                  {message.assetIds.length > 0 && (
                    <div className="message-images">
                      {message.assetIds.map((id) => {
                        const asset = state?.assets.find(
                          (asset) => asset.id === id,
                        );
                        return asset?.type === "image" ? (
                          <button
                            key={id}
                            onClick={() => setSelectedId(id)}
                            title={asset.name}
                          >
                            <img
                              src={assetUrl(projectId, id, asset.revision)}
                              alt={asset.name}
                            />
                            <span>{asset.name}</span>
                          </button>
                        ) : null;
                      })}
                    </div>
                  )}
                  {message.status === "streaming" && !message.text && (
                    <span className="typing">
                      <i />
                      <i />
                      <i />
                    </span>
                  )}
                </div>
              ))}
              {session?.activities.length ? (
                <div className="activities">
                  {session.activities.map((activity) => (
                    <div
                      key={activity.id}
                      className={`activity ${activity.status}`}
                    >
                      {activity.status === "running" ? (
                        <LoaderCircle size={12} className="spin" />
                      ) : activity.status === "failed" ? (
                        <AlertCircle size={12} />
                      ) : (
                        <Check size={12} />
                      )}
                      <span>{activity.label}</span>
                      {activity.status === "running" && <small>进行中</small>}
                    </div>
                  ))}
                </div>
              ) : null}
              {session?.error && (
                <div className="inline-error">
                  <AlertCircle size={14} />
                  <span>{session.error}</span>
                </div>
              )}
              {session?.status === "interrupted" && !session.error && (
                <div className="inline-error">
                  <Square size={12} />
                  <span>本次任务已停止，已经完成的结果仍会保留。</span>
                </div>
              )}
              {session?.prompt && (
                <form
                  className="prompt-card"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void api(`/api/sessions/${session.id}/answer`, {
                      method: "POST",
                      body: JSON.stringify({
                        promptId: session.prompt!.id,
                        answers: promptAnswers,
                      }),
                    }).catch((error) => notify(error.message, true));
                  }}
                >
                  <strong>需要你的选择</strong>
                  {session.prompt.questions.map((question) => (
                    <label key={question.id}>
                      {question.question}
                      {question.options.length ? (
                        <select
                          required
                          value={promptAnswers[question.id] || ""}
                          onChange={(event) =>
                            setPromptAnswers((old) => ({
                              ...old,
                              [question.id]: event.target.value,
                            }))
                          }
                        >
                          <option value="">请选择</option>
                          {question.options.map((option) => (
                            <option key={option}>{option}</option>
                          ))}
                        </select>
                      ) : (
                        <input
                          required
                          value={promptAnswers[question.id] || ""}
                          onChange={(event) =>
                            setPromptAnswers((old) => ({
                              ...old,
                              [question.id]: event.target.value,
                            }))
                          }
                        />
                      )}
                    </label>
                  ))}
                  <button className="primary" type="submit">
                    继续
                  </button>
                </form>
              )}
              <div ref={chatEnd} />
            </div>
            <div className="composer-area">
              <div className="composer">
                {!!clipReferences.length && (
                  <div className="reference-chips">
                    {clipReferences.map((ref) => (
                      <div className="reference-chip" key={ref.clipId}>
                        <Film size={15} />
                        <span>
                          {state?.assets.find(
                            (asset) => asset.id === ref.clipId,
                          )?.name || "动画"}
                          {ref.startFrameId ? " · 已选区间" : ""}
                        </span>
                        <button
                          aria-label="移除动画引用"
                          onClick={() =>
                            setClipReferences((old) =>
                              old.filter((item) => item.clipId !== ref.clipId),
                            )
                          }
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {!!references.length && (
                  <div className="reference-chips">
                    {references.map((id) => {
                      const image = state?.assets.find(
                        (asset) => asset.id === id,
                      ) as ImageAsset;
                      return image ? (
                        <div className="reference-chip" key={id}>
                          <img
                            src={assetUrl(projectId, id, image.revision)}
                            alt=""
                          />
                          <span>{image.name}</span>
                          <button
                            aria-label={`移除引用 ${image.name}`}
                            onClick={() =>
                              setReferences((old) =>
                                old.filter((value) => value !== id),
                              )
                            }
                          >
                            <X size={12} />
                          </button>
                        </div>
                      ) : null;
                    })}
                  </div>
                )}
                <textarea
                  aria-label="给制作助手发消息"
                  placeholder="描述想法，或拖入资源作为参考…"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      void sendMessage();
                    }
                  }}
                />
                <div className="composer-controls">
                  <button
                    className="icon-button"
                    title={clip ? "引用当前动画" : "引用当前图片"}
                    disabled={!currentImage}
                    onClick={() =>
                      clip
                        ? addClipReference({
                            clipId: clip.id,
                            revision: clip.revision,
                          })
                        : addReference(currentImage?.id)
                    }
                  >
                    <Link2 size={15} />
                  </button>
                  <span>
                    {references.length
                      ? `${references.length} 张参考`
                      : "Enter 发送 · Shift+Enter 换行"}
                  </span>
                  {active(session) ? (
                    <button
                      className="send-button stop"
                      aria-label="停止任务"
                      onClick={() =>
                        void api(`/api/sessions/${session!.id}/stop`, {
                          method: "POST",
                        }).catch((error) => notify(error.message, true))
                      }
                    >
                      <Square size={14} fill="currentColor" />
                    </button>
                  ) : (
                    <button
                      className="send-button"
                      aria-label="发送消息"
                      disabled={
                        !draft.trim() || agentBusy || !connection.connected
                      }
                      onClick={() => void sendMessage()}
                    >
                      <ArrowUp size={18} />
                    </button>
                  )}
                </div>
              </div>
              <p className="composer-note">生成结果先作为候选，原图保留</p>
            </div>
          </aside>
        )}
      </main>
      <footer className="statusbar">
        <span>
          <i className={online ? "online-dot" : "offline-dot"} />
          {operation || (online ? "本地工作台" : "正在重新连接…")}
        </span>
        <span>
          {agentBusy ? (
            <>
              <LoaderCircle size={11} className="spin" />
              助手正在工作
            </>
          ) : (
            <>
              <Check size={11} />
              更改已保存在本机
            </>
          )}
        </span>
      </footer>
      <input
        ref={upload}
        className="hidden"
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        onChange={(event) => {
          if (event.target.files) void importFiles(event.target.files);
          event.target.value = "";
        }}
      />
      {toast && (
        <div className={`toast ${toast.error ? "error" : ""}`} role="status">
          {toast.error ? <AlertCircle size={16} /> : <Check size={16} />}
          <span>{toast.text}</span>
          <button aria-label="关闭通知" onClick={() => setToast(null)}>
            <X size={14} />
          </button>
        </div>
      )}
      {newClip && state && (
        <NewClipDialog
          projectId={projectId}
          assets={state.assets}
          initialImageId={currentImage?.id}
          onClose={() => setNewClip(false)}
          onCreated={async (clip) => {
            await refreshRef.current();
            setNewClip(false);
            setSelectedId(clip.id);
            setTool("interpolate");
            setFilter("all");
          }}
        />
      )}
      {newProject && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setNewProject(false);
          }}
        >
          <form
            className="modal"
            onSubmit={(event) => {
              event.preventDefault();
              void run("创建工程", async () => {
                const project = await api<Project>("/api/projects", {
                  method: "POST",
                  body: JSON.stringify({ name: projectName }),
                });
                setProjects((old) => [...old, project]);
                setNewProject(false);
                setProjectName("");
                chooseProject(project.id);
              });
            }}
          >
            <div className="modal-heading">
              <h2>新建工程</h2>
              <button
                type="button"
                className="icon-button"
                aria-label="关闭"
                onClick={() => setNewProject(false)}
              >
                <X size={18} />
              </button>
            </div>
            <p>为一组角色、参考图与动画准备独立空间。</p>
            <label>
              工程名称
              <input
                autoFocus
                required
                maxLength={100}
                placeholder="例如：森林里的小骑士"
                value={projectName}
                onChange={(event) => setProjectName(event.target.value)}
              />
            </label>
            <button
              className="primary"
              type="submit"
              disabled={!!operation || !projectName.trim()}
            >
              <Plus size={15} />
              创建工程
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
