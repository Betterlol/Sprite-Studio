import { MessageRecoveries } from "./MessageRecoveries.tsx";
import { sendMessageAttempt, postMessageInput, messageRecoveries, clearSubmittedComposer, restoreMessageInput, dismissMessageRecovery, MessageAttemptError, type MessageRecovery, type MessageInput, type ComposerInput } from "./message-recovery.ts";
import { createPortal } from "react-dom";
import { ClipWorkbench, type ClipEditorBridge } from "./ClipWorkbench.tsx";
import { TaskCenter, QualityStatus } from "./TaskCenter.tsx";
import { ReviewSequences } from "./ReviewSequences.tsx";
import { SnapshotPlayer } from "./SnapshotPlayer.tsx";
import { editingBlock, ordinaryConversation, taskConversation, assertConversation, conversationDestination, messageContinuation, type TaskContinuation, type ArchivableReviewDefinition, type ConversationSelection } from "./workflow-state.ts";
import type { EditingContext, ProductionTask, ClipDraft, QualityCapabilities, ReviewSequenceDefinition } from "../studio/workflow-model.ts";
import { PermissionSettings } from "./PermissionSettings.tsx";
import { ToolApprovals } from "./ToolApprovals.tsx";
import { ResizeHandle } from "./ResizeHandle.tsx";
import type { FramePreview } from "./FrameAdjustmentPanel.tsx";
import { FrameSaveApprovals } from "./FrameSaveApprovals.tsx";
import { GeneratedPreview } from "./GeneratedPreview.tsx";
import type { GeneratedImageInfo } from "../studio/generated.ts";
import type { SheetOverlay } from "./SliceConfigPanel.tsx";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  agentModels,
  agentModelSchema,
  defaultAgentModel,
  type AgentModel,
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
  tasks?: ProductionTask[];
  qualityCapabilities?: QualityCapabilities;
  reviewSequences?: ReviewSequenceDefinition[];
  project: Project;
  assets: Asset[];
  generatedImages: GeneratedImageInfo[];
  sessions: Session[];
  interpolations: Interpolation[];
  reviews: ClipReview[];
  frameChanges: FrameChange[];
  frameDrafts: FrameDraft[];
  clipDrafts?: ClipDraft[];
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
  const [agentModel, setAgentModel] = useState<AgentModel>(() => {
    const saved = agentModelSchema.safeParse(
      localStorage.getItem("studio.model"),
    );
    return saved.success ? saved.data : defaultAgentModel;
  });
  useEffect(() => {
    localStorage.setItem("studio.model", agentModel);
  }, [agentModel]);
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
  const loadVersion = useRef(0), initialLoad = useRef("");
  const [selectedId, setSelectedId] = useState("");
  const [conversation, setConversation] = useState<ConversationSelection>({ taskId: "", sessionId: "" });
  const { taskId, sessionId } = conversation;
  const conversationEpoch = useRef(0), latestTasks = useRef<ProductionTask[]>([]);
  latestTasks.current = state?.tasks || [];
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
  const [sliceOverlay, setSliceOverlay] = useState<SheetOverlay | null>(null);
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
  const [rightTab, setRightTab] = useState<"properties" | "assistant" | "checks">("properties");
  const [propertiesHost, setPropertiesHost] = useState<HTMLDivElement | null>(null);
  const [context, setContext] = useState<EditingContext | null>(null);
  const [useContext, setUseContext] = useState(true), [shareDraft, setShareDraft] = useState(false);
  const [restoredMessage, setRestoredMessage] = useState<MessageRecovery | null>(null);
  const [taskContinuation, setTaskContinuation] = useState<TaskContinuation>("none");
  const [recoveryVersion, setRecoveryVersion] = useState(0);
  const activeMessageRequest = useRef("");
  const composerInput = useRef<ComposerInput>({text:draft,assetIds:references,clipReferences});
  const displayedContext = restoredMessage ? restoredMessage.input.context : context;
  composerInput.current = {text:draft,assetIds:references,clipReferences,context:useContext?displayedContext || undefined:undefined,taskId:taskId || undefined,model:agentModel,outputFolder:restoredMessage?.input.outputFolder ?? folder,feedbackKind:taskContinuation === "none"?undefined:taskContinuation,recoverySourceId:restoredMessage?.requestId};
  const recoveries = useMemo(() => messageRecoveries(localStorage,projectId,sessionId),[projectId,sessionId,recoveryVersion]);
  const selectedTask = state?.tasks?.find(task => task.id === taskId);
  const continuationClipId = useContext && displayedContext?.clipId && displayedContext.clipId === (selectedTask?.target?.clipId || selectedTask?.contract.scope?.clipId) ? displayedContext.clipId : "";
  useEffect(() => { if (!continuationClipId && !restoredMessage) setTaskContinuation("none"); }, [continuationClipId, restoredMessage?.requestId]);
  const [handoffs, setHandoffs] = useState<Record<string, number>>({});
  const [fixedSnapshot, setFixedSnapshot] = useState<ClipSnapshot | null>(null);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const snapshotRequest = useRef(0);
  const editorBridge = useRef<ClipEditorBridge | null>(null);
  const blocker = editingBlock(state?.tasks || [], selectedId, handoffs, state?.sessions || []);
  const setBridge = useCallback((bridge: ClipEditorBridge | null) => { editorBridge.current = bridge; }, []);
  const updateContext = useCallback((next: EditingContext) => setContext(next), []);
  async function stableContext(): Promise<EditingContext | undefined> {
    if (!useContext) return undefined;
    const bridge = editorBridge.current;
    if (restoredMessage) {
      const original = restoredMessage.input.context;
      if (original?.mode === "draft") {
        if (!shareDraft) throw new Error("请明确勾选将恢复记录中的人工草稿作为助手输入");
        if (!restoredMessage.contextFrozen) {
          if (!bridge || bridge.clipId !== original.clipId || selectedId !== original.clipId) throw new Error("此恢复上下文尚未稳定，请先返回原动画草稿，或明确改用当前工作对象");
          const stable = await bridge.stabilize();
          if (original.draftId && stable.draftId !== original.draftId) throw new Error("原草稿已切换，请明确选择新的上下文；没有自动替换恢复记录中的目标");
          return {...stable,frameId:original.frameId,startFrameId:original.startFrameId,endFrameId:original.endFrameId};
        }
      }
      return original;
    }
    if (context?.mode === "draft" && !shareDraft) throw new Error("当前为人工动画草稿，请明确勾选将我的未保存草稿交给助手，或移除上下文后发送。");
    if (bridge && bridge.clipId === selectedId) return bridge.stabilize();
    if (context?.mode === "draft") throw new Error("请返回草稿工作对象，等待精确版本暂存后再发送；固定快照播放不会替代草稿上下文。");
    return context || undefined;
  }
  async function playSnapshot(snapshotId: string) {
    const original = projectId, token = ++snapshotRequest.current;
    await run("载入固定快照", async () => {
      const value = await api<ClipSnapshot>(`/api/projects/${projectId}/snapshots/${snapshotId}`);
      if (projectRef.current === original && token === snapshotRequest.current) { setFixedSnapshot(value); setComparison(null); /* Playback is not an editing-context or saved-version selection. */ }
    });
  }

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
  const waitingSession = state?.sessions.find(
    (s) => s.toolApproval || s.frameSaveApproval || s.prompt,
  );
  const waitingId =
    waitingSession?.toolApproval?.id ||
    waitingSession?.frameSaveApproval?.id ||
    waitingSession?.prompt?.id ||
    "";
  const agentBusy = !!state?.sessions.some((session) => active(session));

  const loadProject = useCallback(async (id: string, initial = false) => {
    const token = ++loadVersion.current;
    if (initial) initialLoad.current = id;
    const next = await api<State>(`/api/projects/${id}`);
    if (projectRef.current !== id || token !== loadVersion.current) return;
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
    if (initialLoad.current === id) {
      initialLoad.current = "";
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
      setConversation(ordinaryConversation(next.tasks || [], nextSession));
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
        ["assets", "tasks", "task", "review-sequences", "clip-drafts"].includes(message.type) &&
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
    snapshotRequest.current++; setFixedSnapshot(null); setShareDraft(false);
    const asset = state?.assets.find(a => a.id === selectedId);
    if (asset?.type === "image") setContext({assetId: asset.id, revision: asset.revision, mode: "saved"});
    else setContext(asset ? {clipId: asset.id, revision: asset.revision, mode: "saved"} : null);
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
  }, [state, chatVisible, selectedId, fixedSnapshot?.id, comparing?.nonce]);
  useEffect(() => {
    chatEnd.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [
    session?.messages.at(-1)?.text,
    session?.status,
    session?.activities.length,
    session?.toolApproval?.id,
    session?.frameSaveApproval?.id,
    session?.prompt?.id,
    chatVisible,
    waitingId,
  ]);
  const displayedApproval = useRef("");
  useEffect(() => {
    if (
      waitingId &&
      waitingId !== displayedApproval.current &&
      waitingSession
    ) {
      displayedApproval.current = waitingId;
      setChatVisible(true); setRightTab("assistant");
    }
  }, [waitingId]);
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
    conversationEpoch.current++; setConversation({taskId:"",sessionId:""}); setRestoredMessage(null); setTaskContinuation("none"); setHandoffs({}); setContext(null); setShareDraft(false); setFixedSnapshot(null);
    setComparison(null);
    setClipReferences([]);
    projectRef.current = id;
    setProjectId(id);
    setState(null);
    setFolder("");
    void loadProject(id, true).catch((error) => notify(error.message, true));
  }
  function selectConversation(next: ConversationSelection) {
    conversationEpoch.current++;
    setConversation(next);
    setRestoredMessage(null); setTaskContinuation("none"); setShareDraft(false);
    setDraft(localStorage.getItem(`studio.draft.${projectId}.${next.sessionId}`) || "");
    setReferences([]); setClipReferences([]); setPromptAnswers({});
  }
  function chooseSession(id: string) {
    selectConversation(ordinaryConversation(state?.tasks || [], id));
  }
  function chooseTask(id: string) {
    if (!id) { chooseSession(""); return; }
    const task = state?.tasks?.find(task => task.id === id);
    if (!task) { notify("任务正在同步，请刷新后重试；当前对话未改变",true); return; }
    selectConversation(taskConversation(task));
  }
  function createdTask(task: ProductionTask) {
    if (task.projectId !== projectRef.current) return;
    setState(old => old ? {...old,tasks:[...(old.tasks || []).filter(item=>item.id!==task.id),task]} : old);
    selectConversation(taskConversation(task));
  }
  function publishReviewDefinition(definition: ArchivableReviewDefinition) {
    setState(old => {
      if (!old || old.project.id !== definition.projectId) return old;
      const definitions = old.reviewSequences || [];
      return {...old,reviewSequences:definitions.some(item=>item.id===definition.id) ? definitions.map(item=>item.id===definition.id?definition:item) : [...definitions,definition]};
    });
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
  async function makeSession(epoch: number) {
    const originalProject = projectId;
    const created = await api<Session>(`/api/projects/${projectId}/sessions`, {
      method: "POST",
    });
    if (projectRef.current !== originalProject || epoch !== conversationEpoch.current) throw new Error("工程或对话已切换，消息未发送");
    setState((old) =>
      old ? { ...old, sessions: mergeSessions(old.sessions, [created]) } : old,
    );
    setConversation(old => ({...old,sessionId:created.id}));
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
    setChatVisible(true); setRightTab("assistant");
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
    setTool("review"); setRightTab("checks");
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
    setTool("review"); setRightTab("checks");
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
  function restoreMessage(record: MessageRecovery) {
    if (record.projectId !== projectRef.current || record.sessionId !== sessionId || activeMessageRequest.current === record.requestId) return;
    const input = restoreMessageInput(record,composerInput.current);
    if (!input) { notify("当前已有新输入，不会覆盖；原消息及引用仍保留在恢复记录中",true); return; }
    conversationEpoch.current++;
    setConversation({taskId:input.taskId || "",sessionId:record.sessionId});
    setDraft(input.text); setReferences(input.assetIds); setClipReferences(input.clipReferences);
    setAgentModel(input.model); setRestoredMessage(record); setUseContext(!!input.context);
    setShareDraft(record.contextFrozen && input.context?.mode === "draft");
    setTaskContinuation(input.feedbackKind || "none");
    notify("已恢复完整草稿，没有发送；未确认的原请求可能已经发送，请先核对对话");
  }
  function dismissRecovery(record: MessageRecovery) {
    if (activeMessageRequest.current === record.requestId || !window.confirm("移除此本地恢复记录？不会撤回任何可能已发送的消息，当前输入也不会改变。")) return;
    dismissMessageRecovery(localStorage,record); setRecoveryVersion(version=>version+1);
  }
  async function sendMessage() {
    if (!draft.trim() || agentBusy || sendingRef.current) return;
    sendingRef.current = true; setSending(true);
    const originalProject = projectId, submittedSelection = conversation, submittedEpoch = conversationEpoch.current;
    const requestId = crypto.randomUUID(), sourceRecovery = restoredMessage;
    const input: MessageInput = {
      text:draft, assetIds:[...references], clipReferences:structuredClone(clipReferences),
      context:useContext ? displayedContext || undefined : undefined,
      taskId:submittedSelection.taskId || undefined,
      feedbackKind:taskContinuation === "none" ? undefined : taskContinuation,
      model:agentModel, outputFolder:sourceRecovery?.input.outputFolder ?? folder,
    };
    activeMessageRequest.current = requestId;
    try {
      const updated = await sendMessageAttempt<Session>({
        store:localStorage, projectId:originalProject, sessionId:submittedSelection.sessionId, requestId, input,
        recoveredFrom:sourceRecovery || undefined, initialContextFrozen:sourceRecovery?.contextFrozen,
        onChange:()=>setRecoveryVersion(version=>version+1),
        prepare:async()=>{
          const destination = conversationDestination(latestTasks.current,submittedSelection);
          const frozenContext = await stableContext();
          if (projectRef.current !== originalProject || submittedEpoch !== conversationEpoch.current) throw new Error("工程或对话已切换，消息接口尚未提交");
          const target = destination.needsSession ? await makeSession(submittedEpoch) : {id:destination.sessionId};
          if (projectRef.current !== originalProject || submittedEpoch !== conversationEpoch.current) throw new Error("工程或对话已切换，消息接口尚未提交");
          assertConversation(latestTasks.current,{taskId:submittedSelection.taskId,sessionId:target.id});
          const kind = messageContinuation(latestTasks.current.find(task=>task.id===submittedSelection.taskId),frozenContext,taskContinuation);
          return {sessionId:target.id,input:{...input,context:frozenContext,feedbackKind:kind}};
        },
        onPrepared:record=>{
          if (projectRef.current !== originalProject || submittedEpoch !== conversationEpoch.current) throw new Error("工程或对话已切换，消息接口尚未提交");
          const current = composerInput.current, cleared = clearSubmittedComposer(current,{...record.input,recoverySourceId:sourceRecovery?.requestId});
          if (cleared !== current) {
            setDraft(cleared.text); setReferences(cleared.assetIds); setClipReferences(cleared.clipReferences);
            setRestoredMessage(null); setTaskContinuation("none");
          }
        },
        send:postMessageInput,
      });
      if (projectRef.current === originalProject) setState(old=>old?{...old,sessions:mergeSessions(old.sessions,[updated])}:old);
    } catch (error) {
      if (error instanceof MessageAttemptError) {
        const unknown = error.recovery.status === "unknown";
        notify(`${unknown?"发送结果未确认，可能已经发送":"消息未完成"}；完整输入已保留在原工程/会话的恢复记录中，请在该会话核对错误与内容。`,true);
      } else notify(`本地恢复记录写入失败，消息未提交，输入未清空：${(error as Error).message}`,true);
    } finally {
      activeMessageRequest.current = ""; sendingRef.current = false; setSending(false); setRecoveryVersion(version=>version+1);
    }
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
    if (!currentImage || clip || blocker) return;
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
          stageSize.width / currentImage.width,
          stageSize.height / currentImage.height,
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
          disabled={!!operation}
          blockedAssetIds={(state?.assets || []).filter(asset => editingBlock(state?.tasks || [], asset.id, handoffs, state?.sessions || [])).map(asset => asset.id)}
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
                  title={clip ? "引用已保存动画到聊天（草稿通过上下文单独传入）" : "引用当前图片到聊天"}
                  onClick={() => {
                    if (clip)
                      addClipReference({
                        clipId: clip.id,
                        revision: clip.revision,
                      });
                    else addReference(currentImage.id);
                    setChatVisible(true); setRightTab("assistant");
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
          {fixedSnapshot ? <SnapshotPlayer key={fixedSnapshot.id} snapshot={fixedSnapshot} onClose={() => { setFixedSnapshot(null); if (selected?.type === "image") setContext({assetId:selected.id,revision:selected.revision,mode:"saved"}); }}/> : comparing ? <div className="stage checker"><ComparisonPlayer key={comparing.nonce} before={comparing.before} after={comparing.after} onClose={() => setComparison(null)}/></div> : clip ? <ClipWorkbench
            key={`${projectId}-${clip.id}`} projectId={projectId} clip={clip} assets={state?.assets || []}
            frameIndex={frameIndex} onFrame={setFrameIndex} playing={playing} onPlaying={setPlaying} propertiesHost={propertiesHost}
            locked={blocker ? `任务“${blocker.title}”持有此对象` : undefined}
            onContext={updateContext} onBridge={setBridge} onSaved={() => refreshRef.current()}
            legacyDrafts={state?.frameDrafts || []} clipDrafts={state?.clipDrafts || []} onLegacyPreview={id => void playSnapshot(id)}
            onTool={value => { setTool(value); setRightTab(value === "review" ? "checks" : "properties"); }}
          /> : <>
          <div className={`stage ${background}`} ref={stage}>
            {currentImage ? (
              <div
                className="artboard"
                style={{
                  width: currentImage.width * scale,
                  height: currentImage.height * scale,
                }}
              >
                <img
                  src={
                    imagePreview?.assetId === currentImage.id
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
                {tool === "slice" && showGrid && !clip && !currentImage.producer &&
                  sliceOverlay?.sourceId === currentImage.id && sliceOverlay.sourceRevision === currentImage.revision && (
                    <svg className="grid-overlay sheet-overlay" viewBox={`0 0 ${currentImage.width} ${currentImage.height}`} preserveAspectRatio="none" aria-label="原图切割区域">
                      {sliceOverlay.rectangles.map((rect,i) => <rect key={`${rect.selection}-${i}`} x={rect.box[0]} y={rect.box[1]} width={rect.box[2]!-rect.box[0]!} height={rect.box[3]!-rect.box[1]!}
                        className={rect.selection===sliceOverlay.selected?"selected":""} fill="transparent" stroke="currentColor" strokeWidth="1" vectorEffect="non-scaling-stroke"
                        role="button" tabIndex={0} aria-label={`选择原图区域${i+1}`} onClick={()=>sliceOverlay.onSelect(rect.selection)} onKeyDown={e=>{if(e.key==="Enter" || e.key===" "){e.preventDefault();sliceOverlay.onSelect(rect.selection);}}} />)}
                    </svg>
                  )}
                {imagePreview?.result.blocking && (
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
          </>}
          {!clip && currentImage && propertiesHost && createPortal(
            <section className="tools-panel image-tools">
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
              </div>
              {tool === "slice" ? (
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
                    onOverlay={setSliceOverlay}
                    gridVisible={showGrid}
                    onGridVisible={setShowGrid}
                    disabled={!!operation || !!blocker}
                  />
                ) : (
                  <p className="adjust-note">
                    请在原图素材或参考图中选择静态原图配置切割；动画帧可在调整页编辑。
                  </p>
                )
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
                        !!blocker ||
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
            </section>, propertiesHost
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
            className="chat-panel workflow-right"
            data-tab={rightTab}
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
            <div className="right-tabs" role="tablist" aria-label="右侧工作区">
              {(["properties", "assistant", "checks"] as const).map(tab => <button key={tab} role="tab" aria-selected={rightTab === tab} onClick={() => setRightTab(tab)}>{tab === "properties" ? "属性" : tab === "assistant" ? "助手" : "检查"}</button>)}
              <button aria-label="重置工作区尺寸" title="重置工作区尺寸" onClick={() => { for (const name of ["--library-width", "--chat-width", "--timeline-height", "--tools-height"]) document.documentElement.style.removeProperty(name); for (const key of Object.keys(localStorage)) if (key.startsWith("studio.layout.")) localStorage.removeItem(key); }}>重置</button>
            </div>
            <div className="properties-view" hidden={rightTab !== "properties"}>
              <div ref={setPropertiesHost}/>
              {clip && <details open={tool === "interpolate"}><summary>区间补帧（先保存动画草稿）</summary>
                <InterpolationPanel key={`${projectId}-${clip.id}`} projectId={projectId} clip={clip} assets={state?.assets || []} jobs={state?.interpolations || []} sessions={state?.sessions || []} connected={connection.connected} model={agentModel} busy={agentBusy || !!blocker || context?.mode === "draft"} refresh={() => refreshRef.current()} onSession={id => {chooseSession(id);setRightTab("assistant");}} onPreview={id => previewClip(id)}/>
              </details>}
            </div>
            <div className="checks-view" hidden={rightTab !== "checks"}>
              <QualityStatus capabilities={state?.qualityCapabilities}/>
              <ReviewSequences key={projectId} projectId={projectId} clips={(state?.assets || []).filter((a): a is ClipAsset => a.type === "clip")} definitions={state?.reviewSequences || []} dependencyRevision={state?.libraryRevision} onDefinition={publishReviewDefinition} onRefresh={() => refreshRef.current()} onPlay={id => void playSnapshot(id)}/>
              {clip && <details open><summary>单动画检查与旧修改历史</summary><AnimationPanel key={`${projectId}-${clip.id}`} projectId={projectId} clip={clip} disabled={!!blocker} assets={state?.assets || []} reviews={state?.reviews || []} focusReviewId={focusedReviewId} focusChangeId={focusedChangeId} changes={state?.frameChanges || []} onRefresh={() => refreshRef.current()} onReference={addClipReference} onFrame={(id, frame) => previewClip(id,frame,false)} onAdjust={() => setRightTab("properties")} onCompare={compareChange} onPreview={id => previewClip(id)}/></details>}
            </div>
            <div className="chat-header">
              <div className="chat-heading">
                <span className="assistant-icon">
                  <Sparkles size={16} />
                </span>
                <div>
                  <h2>制作助手</h2>
                  <select
                    className="agent-model-select"
                    aria-label="助手模型"
                    title={
                      agentBusy
                        ? "任务运行或等待审批时不能切换模型"
                        : "选择下一次聊天或首尾补帧使用的模型；保留当前对话上下文"
                    }
                    value={agentModel}
                    disabled={agentBusy}
                    onChange={(event) =>
                      setAgentModel(agentModelSchema.parse(event.target.value))
                    }
                  >
                    {agentModels.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </select>
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
              <TaskCenter key={projectId} projectId={projectId} tasks={state?.tasks || []} clipDrafts={state?.clipDrafts || []} reviewSequences={state?.reviewSequences || []} sessions={state?.sessions || []} assets={state?.assets || []} referenceIds={references} context={useContext ? displayedContext || undefined : undefined} selectedTaskId={taskId} onSelect={chooseTask} onCreated={createdTask} onRefresh={() => refreshRef.current()} onHandoff={task => setHandoffs(old => ({...old,[task.id]:task.barrierVersion}))} stabilize={stableContext} onPlay={id => void playSnapshot(id)} onBrowse={setSelectedId}/>

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
                            setTool("review"); setRightTab("checks");
                          }}
                        >
                          <Film size={13} />
                          {ref.name}
                          {ref.startFrameId ? " · 已选区间" : " · 动画引用"}
                        </button>
                      ))}
                    </div>
                  )}
                  {!!message.clipDraftIds?.length && <div className="message-clip-refs">{message.clipDraftIds.map(id => {
                    const result = state?.clipDrafts?.find(draft => draft.id === id);
                    return result?.delivery ? <span key={id}><button className="text-button" onClick={() => void playSnapshot(result.delivery!.snapshotId)}>助手固定结果 · 待采用到我的草稿</button><button className="text-button" onClick={() => { setSelectedId(result.clipId); setFixedSnapshot(null); setRightTab("properties"); }}>返回来源动画采用（不自动保存）</button></span> : <small key={id}>助手结果稿 {id} · 历史记录保留</small>;
                  })}</div>}
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
                              setTool("review"); setRightTab("checks");
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
                        awaitingApproval={state?.sessions.some(
                          (s) =>
                            s.toolApproval?.tool === "save_image" &&
                            s.toolApproval.arguments.generatedId === image.id,
                        )}
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
                      {activity.detail && (
                        <small className="activity-detail">
                          {activity.detail}
                        </small>
                      )}
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
              {!!session?.diagnostics?.length && (
                <details className="session-diagnostics">
                  <summary>
                    本地诊断记录（{session.diagnostics.length}）
                  </summary>
                  <ol>
                    {session.diagnostics.slice(-15).map((entry) => (
                      <li key={entry.id}>
                        <time>
                          {new Date(entry.createdAt).toLocaleTimeString()}
                        </time>
                        <span>{entry.message}</span>
                        {entry.method && <code>{entry.method}</code>}
                      </li>
                    ))}
                  </ol>
                </details>
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
                  <strong>助手提问（不是工具审批）</strong>
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
                sessions={(state?.sessions || []).filter(s => !(state?.tasks || []).some(t => t.sessionId === s.id && t.phase === "direction" && !(t.direction?.accept && t.direction.intentVersion === t.intentVersion) && s.toolApproval?.tool === "save_image"))}
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
              <MessageRecoveries records={recoveries} activeRequestId={activeMessageRequest.current} composerHasInput={!!draft.length || !!references.length || !!clipReferences.length || taskContinuation!=="none"} onRestore={restoreMessage} onDismiss={dismissRecovery}/>
              <div className="composer">
                {restoredMessage && <div className="context-chip"><strong>恢复的原输入：不会自动发送</strong><small>上下文/保存建议目录锁定为原记录，浏览资源不会替换。{restoredMessage.contextFrozen?"原上下文已稳定；版本过期会被拒绝，不自动刷新。":"原上下文尚未稳定，发送前须返回原草稿重新核对。"} · 目录：{restoredMessage.input.outputFolder || "项目根目录"} · 续接意图：{restoredMessage.input.feedbackKind || "仅讨论"}</small><button className="text-button" onClick={()=>{setRestoredMessage(null);setTaskContinuation("none");setUseContext(true);setShareDraft(false);}}>明确改用当前工作对象与目录</button></div>}
                {displayedContext && <div className="context-chip"><label><input type="checkbox" checked={useContext} onChange={e => setUseContext(e.target.checked)}/>正在讨论：{state?.assets.find(a => a.id === (displayedContext.clipId || displayedContext.assetId))?.name || "工作对象"}{displayedContext.frameId ? restoredMessage ? ` · 帧实例 ${displayedContext.frameId.slice(0,8)}` : ` · 第 ${frameIndex + 1} 帧实例` : ""} · {displayedContext.mode === "draft" ? "人工草稿" : displayedContext.snapshotId ? "固定快照" : "保存版本"}</label><small>{displayedContext.frameId || displayedContext.snapshotId || displayedContext.clipId || displayedContext.assetId} · {displayedContext.documentRevision || displayedContext.revision}</small>{displayedContext.mode === "draft" && useContext && <label><input type="checkbox" checked={shareDraft} onChange={e => setShareDraft(e.target.checked)}/>明确将此人工草稿作为助手输入（不授权覆盖原稿）</label>}</div>}
                {continuationClipId && selectedTask && <label className="context-chip">以当前草稿/版本续接任务<select aria-label="消息任务续接意图" value={taskContinuation} onChange={e=>setTaskContinuation(e.target.value as TaskContinuation)}><option value="none">仅讨论（不更新任务目标）</option><option value="local" disabled={selectedTask.status==="paused" || !(selectedTask.direction?.accept&&selectedTask.direction.intentVersion===selectedTask.intentVersion)}>局部续接（同来源像素，保留方向）</option><option value="direction" disabled={selectedTask.status==="paused"}>方向续接（新来源/方向，重新确认）</option></select><small>必须显式选择才发送 feedbackKind；普通浏览不更新任务基线。新增/更换来源像素请选方向续接；暂停任务须先继续。</small></label>}
                {taskId && <small className="context-chip">关联任务：{state?.tasks?.find(t => t.id === taskId)?.title || taskId}；浏览不会改变任务目标</small>}

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
                        !draft.trim() || agentBusy || sending || !connection.connected
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
                title={`资源/${categoryFolder("原图素材", restoredMessage?.input.outputFolder ?? folder)}`}
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
                : state?.sessions.some((s) => s.prompt)
                  ? "等待你的回答"
                  : "助手正在工作"}
            </>
          ) : (
            <>
              <Check size={11} />
              {context?.mode === "draft" ? "草稿编辑中 · 保存动画后提交" : "本地工作台"}
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
