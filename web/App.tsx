import { PermissionSettings } from "./PermissionSettings.tsx";
import { ToolApprovals } from "./ToolApprovals.tsx";
import { ResizeHandle } from "./ResizeHandle.tsx";
import {
  FrameAdjustmentPanel,
  type FramePreview,
} from "./FrameAdjustmentPanel.tsx";
import { FrameSaveApprovals } from "./FrameSaveApprovals.tsx";
import { AnimationEditor } from "./AnimationEditor.tsx";
import { GeneratedPreview } from "./GeneratedPreview.tsx";
import type { GeneratedImageInfo } from "../studio/generated.ts";
import type { SheetRecipe } from "../studio/sheet-schema.ts";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { InterpolationPanel } from "./InterpolationPanel.tsx";
import { NewClipDialog } from "./NewClipDialog.tsx";
import { AnimationPanel } from "./AnimationPanel.tsx";
import { ComparisonPlayer } from "./ComparisonPlayer.tsx";
import { api } from "./api.ts";
import { SliceConfigPanel } from "./SliceConfigPanel.tsx";
import { ResourceLibrary } from "./ResourceLibrary.tsx";
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
  Trash2,
  Sun,
  Moon,
  Settings,
} from "lucide-react";
import {
  assetUrl,
  clipFrameUrl,
  snapshotFrameUrl,
  type FrameDraft,
  type TransformPreview,
  categoryFolder,
  folderCategory,
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
  type TrashEntry,
} from "../studio/model.ts";

type State = {
  project: Project;
  assets: Asset[];
  generatedImages: GeneratedImageInfo[];
  sessions: Session[];
  interpolations: Interpolation[];
  reviews: ClipReview[];
  frameChanges: FrameChange[];
  frameDrafts: FrameDraft[];
  folders: string[];
  libraryRevision: string;
  configurationRevision: string;
  trash: TrashEntry[];
};
type Connection = { connected: boolean; model?: string; error?: string };
const imageKinds = { reference: "参考图", image: "图片" };
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
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const [theme, setTheme] = useState(() =>
    localStorage.getItem("studio.theme") === "light" ? "light" : "dark",
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("studio.theme", theme);
  }, [theme]);
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
  const [folder, setFolder] = useState("参考图");
  useEffect(() => {
    if (state?.project.id === projectId)
      localStorage.setItem(`studio.folder.${projectId}`, folder);
  }, [folder, projectId, state?.project.id]);
  useEffect(() => {
    if (state && selectedId && !state.assets.some((a) => a.id === selectedId)) {
      setSelectedId("");
      setPlaying(false);
      setComparison(null);
      setReferences((old) =>
        old.filter((id) => state.assets.some((a) => a.id === id)),
      );
      setClipReferences((old) =>
        old.filter((ref) => state.assets.some((a) => a.id === ref.clipId)),
      );
    }
  }, [state?.libraryRevision]);
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
  const [sliceGrid, setSliceGrid] = useState<
    SheetRecipe["slicing"]["grid"] | null
  >(null);
  const [showGrid, setShowGrid] = useState(true);
  const [framePreview, setFramePreview] = useState<FramePreview | null>(null);
  useEffect(() => {
    if (tool !== "adjust" && tool !== "review") setFramePreview(null);
  }, [tool]);
  const [imagePreview, setImagePreview] = useState<{
    assetId: string;
    result: TransformPreview;
  } | null>(null);
  const [imagePreviewBusy, setImagePreviewBusy] = useState(false),
    [imagePreviewError, setImagePreviewError] = useState("");
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
  const interpolationClip = clip;
  const displayClip =
    framePreview?.draft.clipId === clip?.id
      ? framePreview?.preview.clip || clip
      : clip;
  const currentImage = (
    clip
      ? state?.assets.find(
          (asset) =>
            asset.id ===
            displayClip!.frames[
              Math.min(frameIndex, displayClip!.frames.length - 1)
            ]?.imageId,
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
        ? {
            ...next,
            sessions: mergeSessions(
              old.sessions.filter((s) =>
                next.sessions.some((n) => n.id === s.id),
              ),
              next.sessions,
            ),
          }
        : next,
    );
    if (initial) {
      const storedFolder =
        localStorage.getItem(`studio.folder.${id}`) || "参考图";
      const storedAsset = localStorage.getItem(`studio.asset.${id}`);
      const nextSelected =
        next.assets.find((asset) => asset.id === storedAsset) || next.assets[0];
      setSelectedId(nextSelected?.id || "");
      setFolder(
        next.folders.includes(storedFolder)
          ? storedFolder
          : nextSelected?.folder || "参考图",
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
    setFramePreview(null);
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
    if (!playing || !displayClip || !displayClip.frames.length) return;
    let index = Math.min(frameIndex, displayClip.frames.length - 1),
      elapsed = 0,
      last = performance.now(),
      request = 0;
    const tick = (time: number) => {
      elapsed += Math.min(time - last, 100);
      last = time;
      let guard = 0;
      while (
        elapsed >= displayClip.frames[index]!.durationUs / 1000 &&
        guard++ < 128
      ) {
        elapsed -= displayClip.frames[index]!.durationUs / 1000;
        if (index === displayClip.frames.length - 1 && !displayClip.loop) {
          setPlaying(false);
          return;
        }
        index = (index + 1) % displayClip.frames.length;
        setFrameIndex(index);
      }
      request = requestAnimationFrame(tick);
    };
    request = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(request);
  }, [playing, displayClip?.revision, playbackRun]);
  useEffect(() => {
    if (!clip) return;
    setFrameIndex((index) =>
      Math.max(0, Math.min(index, clip.frames.length - 1)),
    );
    if (!clip.frames.length) setPlaying(false);
  }, [clip?.revision]);

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
    setFolder("");
    void loadProject(id, true).catch((error) => notify(error.message, true));
  }
  function chooseSession(id: string) {
    setSessionId(id);
    setDraft(localStorage.getItem(`studio.draft.${projectId}.${id}`) || "");
    setReferences([]);
    setClipReferences([]);
    setPromptAnswers({});
  }
  async function deleteSession() {
    if (!session || active(session)) return;
    if (
      !window.confirm(`删除对话“${session.title}”？已生成和保存的资源会保留。`)
    )
      return;
    try {
      await api(`/api/sessions/${session.id}`, { method: "DELETE" });
      localStorage.removeItem(`studio.draft.${projectId}.${session.id}`);
      chooseSession("");
      await refreshRef.current();
    } catch (error: any) {
      notify(error.message, true);
    }
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
    if (!change) throw new Error("修改记录正在同步，请稍后再试");
    const originalProject = projectId;
    setPlaying(false);
    setTool("review");
    if (change.clipId !== selectedId) setSelectedId(change.clipId);
    const result = await api<{ before: ClipSnapshot; after: ClipSnapshot }>(
      `/api/projects/${projectId}/frame-changes/${id}/compare`,
      {
        method: "POST",
        body: JSON.stringify({}),
      },
    );
    if (projectRef.current === originalProject)
      setComparison({ ...result, nonce: Date.now() });
  }
  async function importFiles(files: FileList | File[]) {
    setComparison(null);
    files = Array.from(files);
    const originalProject = projectId;
    const kind = folderCategory(folder) === "参考图" ? "reference" : "image";
    await run("正在导入图片", async () => {
      let latest = "";
      for (const file of Array.from(files)) {
        const body = new FormData();
        body.append("file", file);
        const asset = await api<ImageAsset>(
          `/api/projects/${originalProject}/import?kind=${kind}&folder=${encodeURIComponent(folder)}`,
          { method: "POST", body },
        );
        latest = asset.id;
      }
      if (projectRef.current === originalProject) {
        await refreshRef.current();
        setSelectedId(latest);
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
            outputFolder: folder,
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
          initialFps: next.initialFps || 12,
          loop: next.loop,
        }),
      },
    );
    await refreshRef.current();
    return updated;
  }
  useEffect(() => {
    let cancelled = false;
    setImagePreview(null);
    setImagePreviewError("");
    setImagePreviewBusy(false);
    if (clip || tool !== "adjust" || !currentImage) return;
    if (
      transform.scale === 1 &&
      transform.offsetX === 0 &&
      transform.offsetY === 0 &&
      !transform.width &&
      !transform.height
    )
      return;
    const image = currentImage;
    setImagePreviewBusy(true);
    const timer = setTimeout(() => {
      void api<TransformPreview>(
        `/api/projects/${projectId}/assets/${image.id}/transform-preview`,
        {
          method: "POST",
          body: JSON.stringify({ revision: image.revision, transform }),
        },
      )
        .then((result) => {
          if (!cancelled) setImagePreview({ assetId: image.id, result });
        })
        .catch((error) => {
          if (!cancelled) setImagePreviewError(error.message);
        })
        .finally(() => {
          if (!cancelled) setImagePreviewBusy(false);
        });
    }, 140);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    projectId,
    clip?.id,
    currentImage?.id,
    currentImage?.revision,
    tool,
    transform,
  ]);
  async function applyTransform() {
    if (!currentImage || clip) return;
    await run("正在调整图片", async () => {
      const result = await api<ImageAsset>(
        `/api/projects/${projectId}/assets/${currentImage.id}/transform`,
        {
          method: "POST",
          body: JSON.stringify({ revision: currentImage.revision, transform }),
        },
      );
      await refreshRef.current();
      setSelectedId(result.id);
      setTransform(emptyTransform);
      notify("调整图片已保存");
    });
  }

  const fit = currentImage
    ? Math.max(
        0.05,
        Math.min(
          (stageSize.width - 16) / currentImage.width,
          (stageSize.height - 16) / currentImage.height,
          2,
        ),
      )
    : 1;
  const scale = zoom === "fit" ? fit : zoom;

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
          <button
            className="icon-button"
            title="助手工具权限"
            aria-label="打开权限设置"
            onClick={() => setPermissionsOpen(true)}
          >
            <Settings size={17} />
          </button>
          <button
            className="icon-button"
            title={theme === "dark" ? "切换浅色" : "切换深色"}
            aria-label="切换网页色调"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
          </button>
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
        <ResourceLibrary
          key={projectId}
          projectId={projectId}
          state={state}
          selectedId={selectedId}
          folder={folder}
          onFolder={setFolder}
          onSelect={(id) => {
            setComparison(null);
            setSelectedId(id);
          }}
          onChanged={() => refreshRef.current()}
          onImport={() => upload.current?.click()}
          onNewClip={() => setNewClip(true)}
          disabled={!!operation || agentBusy}
        />
        <ResizeHandle
          name="资源栏宽度"
          target=".library"
          variable="--library-width"
          axis="x"
          min={170}
          max={600}
        />
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
                <small className={`image-kind ${selected.kind}`}>
                  {imageKinds[selected.kind]}
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
          {framePreview?.draft.clipId === clip?.id && framePreview && (
            <div className="frame-preview-banner" role="status">
              草稿预览 · 尚未保存
              <button
                className="text-button"
                onClick={() => setFramePreview(null)}
              >
                查看已保存版本
              </button>
            </div>
          )}
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
                  src={
                    clip && displayClip?.frames[frameIndex]
                      ? framePreview?.draft.clipId === clip.id
                        ? snapshotFrameUrl(
                            projectId,
                            framePreview.preview.id,
                            displayClip.frames[frameIndex]!.id,
                          )
                        : clipFrameUrl(
                            projectId,
                            clip,
                            clip.frames[frameIndex]!,
                            currentImage.revision,
                          )
                      : imagePreview?.assetId === currentImage.id
                        ? imagePreview.result.url
                        : assetUrl(
                            projectId,
                            currentImage.id,
                            currentImage.revision,
                          )
                  }
                  alt={currentImage.name}
                  draggable={false}
                />
                {tool === "slice" &&
                  showGrid &&
                  !clip &&
                  !currentImage.producer &&
                  sliceGrid && (
                    <svg
                      className="grid-overlay"
                      viewBox={`0 0 ${currentImage.width} ${currentImage.height}`}
                      preserveAspectRatio="none"
                      aria-hidden="true"
                    >
                      {Array.from(
                        {
                          length: Math.min(
                            128,
                            sliceGrid.columns * sliceGrid.rows,
                          ),
                        },
                        (_, i) => {
                          const [top, right, bottom, left] = sliceGrid.margin,
                            [gapX, gapY] = sliceGrid.spacing;
                          const width =
                            (currentImage.width -
                              left -
                              right -
                              gapX * (sliceGrid.columns - 1)) /
                            sliceGrid.columns;
                          const height =
                            (currentImage.height -
                              top -
                              bottom -
                              gapY * (sliceGrid.rows - 1)) /
                            sliceGrid.rows;
                          return (
                            <rect
                              key={i}
                              x={
                                left + (i % sliceGrid.columns) * (width + gapX)
                              }
                              y={
                                top +
                                Math.floor(i / sliceGrid.columns) *
                                  (height + gapY)
                              }
                              width={Math.max(0, width)}
                              height={Math.max(0, height)}
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1"
                              vectorEffect="non-scaling-stroke"
                            />
                          );
                        },
                      )}
                    </svg>
                  )}
                {((imagePreview?.result.blocking && !clip) ||
                  framePreview?.warnings?.some(
                    (w) =>
                      w.blocking &&
                      w.frameId === displayClip?.frames[frameIndex]?.id,
                  )) && (
                  <div className="canvas-overflow-border" aria-hidden="true" />
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
                <h1>{clip ? "空动画，等待添加图片" : "从一张参考图开始"}</h1>
                <p>
                  {clip
                    ? "从素材库把图片拖到下方时间轴，"
                    : "把角色、参考图或图集拖进来，"}
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
                <small>原图保留，图片和动画可以直接编辑使用</small>
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
                    ? clip
                      ? "按整份草稿渲染"
                      : imagePreviewBusy
                        ? "正在渲染预览…"
                        : imagePreviewError
                          ? "预览未更新"
                          : "实际渲染预览"
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
            <ResizeHandle
              name="动画编排高度"
              target=".animation-editor"
              variable="--timeline-height"
              reverse
              min={110}
              max={500}
            />
          )}
          {clip && (
            <AnimationEditor
              key={`${projectId}-${clip.id}`}
              projectId={projectId}
              clip={displayClip!}
              previewSnapshot={
                framePreview?.draft.clipId === clip?.id
                  ? framePreview?.preview
                  : undefined
              }
              assets={state?.assets || []}
              frameIndex={frameIndex}
              playing={playing}
              onFrame={(index) => {
                setFrameIndex(index);
                setComparison(null);
                setTransform(emptyTransform);
              }}
              onPlaying={(value) => {
                setPlaying(value);
                setComparison(null);
              }}
              onSave={saveClip}
              onTool={(value) => {
                setTool(value);
                setPlaying(false);
                setComparison(null);
              }}
              disabled={!!operation || agentBusy || !!framePreview}
            />
          )}
          {(currentImage || clip) && (
            <ResizeHandle
              name="工具栏高度"
              target=".tools-panel"
              variable="--tools-height"
              reverse
              min={110}
              max={600}
            />
          )}
          {(currentImage || clip) && (
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
              </div>
              {tool === "review" && clip ? (
                <AnimationPanel
                  key={`${projectId}-${clip.id}`}
                  projectId={projectId}
                  clip={clip}
                  draftPreview={
                    framePreview?.draft.clipId === clip.id
                      ? framePreview
                      : undefined
                  }
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
                !clip &&
                currentImage &&
                !currentImage.producer &&
                currentImage.frameCount === 1 ? (
                  <SliceConfigPanel
                    key={`${projectId}-${currentImage.id}`}
                    projectId={projectId}
                    image={currentImage}
                    assets={state?.assets || []}
                    refreshToken={`${state?.configurationRevision}-${state?.libraryRevision}`}
                    onRefresh={() => refreshRef.current()}
                    onSelect={setSelectedId}
                    onGrid={setSliceGrid}
                    gridVisible={showGrid}
                    onGridVisible={setShowGrid}
                    disabled={!!operation || agentBusy}
                  />
                ) : (
                  <p className="adjust-note">
                    请在原图素材或参考图中选择静态原图配置切割；动画帧可在调整页编辑。
                  </p>
                )
              ) : clip ? (
                <FrameAdjustmentPanel
                  key={projectId + clip.id}
                  projectId={projectId}
                  clip={clip}
                  frameId={clip.frames[frameIndex]?.id || ""}
                  playing={playing}
                  drafts={state?.frameDrafts || []}
                  onPreview={setFramePreview}
                  onRefresh={() => refreshRef.current()}
                />
              ) : !currentImage ? (
                <p className="adjust-note">
                  向动画添加图片后，可在这里调整当前帧。
                </p>
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
                      disabled={
                        !!operation ||
                        imagePreviewBusy ||
                        !!imagePreviewError ||
                        !!imagePreview?.result.blocking
                      }
                      onClick={() => void applyTransform()}
                    >
                      {operation ? (
                        <LoaderCircle size={14} className="spin" />
                      ) : (
                        <Check size={14} />
                      )}{" "}
                      {clip ? "应用到当前帧" : "保存调整图片"}
                    </button>
                  </div>
                  {imagePreview?.result.blocking && (
                    <p className="interpolation-warning" role="alert">
                      可见内容超出画布：
                      {Object.entries(imagePreview.result.overflow)
                        .filter(([, v]) => v)
                        .map(
                          ([k, v]) =>
                            `${({ left: "左", right: "右", top: "上", bottom: "下" } as const)[k as "left"]}${v}px`,
                        )
                        .join("，")}
                      。预览显示画布内部分；请调整参数或勾选允许裁切后再保存。
                    </p>
                  )}
                  {imagePreviewError && (
                    <p className="interpolation-warning" role="alert">
                      预览未更新：{imagePreviewError}
                    </p>
                  )}
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
          <ResizeHandle
            name="助手栏宽度"
            target=".chat-panel"
            variable="--chat-width"
            axis="x"
            reverse
            min={260}
            max={750}
          />
        )}
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
                  onClick={() => chooseSession("")}
                >
                  <Plus size={17} />
                </button>
                <button
                  className="icon-button"
                  title="删除当前对话"
                  disabled={!session || !!active(session)}
                  onClick={() => void deleteSession()}
                >
                  <Trash2 size={16} />
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
                <option value="">新对话（尚未发送）</option>
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
                  {(message.generatedIds || []).map((id) => {
                    const image = state?.generatedImages?.find(
                      (item) => item.id === id,
                    );
                    return image ? (
                      <GeneratedPreview
                        key={id}
                        projectId={projectId}
                        image={image}
                        onSaved={async (asset) => {
                          await refreshRef.current();
                          setSelectedId(asset.id);
                        }}
                      />
                    ) : null;
                  })}
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
              <ToolApprovals
                sessions={state?.sessions || []}
                onRefresh={() => refreshRef.current()}
              />
              <FrameSaveApprovals
                sessions={state?.sessions || []}
                onRefresh={() => refreshRef.current()}
                onCompare={(value) => {
                  setSelectedId(value.before.clip.id);
                  setPlaying(false);
                  setComparison({
                    before: value.before,
                    after: value.preview,
                    nonce: Date.now(),
                  });
                }}
              />
              <div ref={chatEnd} />
            </div>
            <ResizeHandle
              name="消息输入区高度"
              target=".composer textarea"
              variable="--composer-height"
              reverse
              min={60}
              max={350}
            />
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
              <p
                className="composer-note generation-location"
                title={`资源/${categoryFolder("原图素材", folder)}`}
              >
                生成后由助手命名并选择目录保存
              </p>
            </div>
          </aside>
        )}
      </main>
      {permissionsOpen && (
        <PermissionSettings onClose={() => setPermissionsOpen(false)} />
      )}
      <footer className="statusbar">
        <span>
          <i className={online ? "online-dot" : "offline-dot"} />
          {operation || (online ? "本地工作台" : "正在重新连接…")}
        </span>
        <span>
          {agentBusy ? (
            <>
              <LoaderCircle size={11} className="spin" />
              {state?.sessions.some(
                (s) => s.toolApproval || s.frameSaveApproval,
              )
                ? "等待你的审批"
                : "助手正在工作"}
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
          folder={folder}
          initialImageId={currentImage?.id}
          onClose={() => setNewClip(false)}
          onCreated={async (clip) => {
            await refreshRef.current();
            setNewClip(false);
            setSelectedId(clip.id);
            setTool("adjust");
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
