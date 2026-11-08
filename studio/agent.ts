import { ordinaryAgentInstructions } from "./agent-instructions.ts";
import { checkDirectClipTransforms, documentWritesSchema, prepareAnimationApproval, writesSavedAnimation } from "./animation-approval.ts";
import { inspectSheetSchema } from "./sheet-schema.ts";
import { permissionTools, type PermissionTool } from "./tool-permissions.ts";
import { randomUUID, randomBytes } from "node:crypto";
import { readFileSync, copyFileSync, mkdirSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  AppServer,
  RpcRequestError,
  type Message,
} from "./runtime/app-server.ts";
import { ProjectStore, StudioError, sha256 } from "./store.ts";
import { clipDocumentSchema } from "./documents.ts";
import { interpolationPrompt } from "./interpolation.ts";
import { freezeEditingContext } from "./workflow-context.ts";
import { captureTaskIntent, assertTaskIntent, precheckTaskTool, toolPolicyParents, type TaskIntent } from "./workflow-agent.ts";
import { checkFromDraftRevision, taskActionSchema, taskDirectionSchema } from "./workflow-routes.ts";
import { clipEditSchema, type EditingContext } from "./workflow-model.ts";
import {
  interpolationSchema,
  agentModelSchema,
  turnPlanSchema,
  defaultAgentModel,
  frameEditSchema,
  type FrameSaveApproval,
  type AnimationApprovalPreview,
  type UserApprovalFeedback,
} from "./model.ts";
import { transformSchema, type Session, type ChatMessage } from "./model.ts";

const textContent = (text: string) => ({ type: "text", text });
type ToolDecision = {
  accept: boolean;
  reason: string;
  result?: any;
  userApproval?: UserApprovalFeedback;
  validate?: () => void;
  animations?: AnimationApprovalPreview[];
};
export class AgentHub {
  store: ProjectStore;
  endpoint: string;
  clients = new Map<string, AppServer>();
  tokens = new Map<string, string>();
  timers = new Map<string, NodeJS.Timeout>();
  imports = new Map<string, Promise<unknown>[]>();
  prompts = new Map<string, (value: any) => void>();
  frameSaves = new Map<
    string,
    { sessionId: string; finish: (value: any) => void; timer: NodeJS.Timeout; guard?: () => void }
  >();
  toolWaits = new Map<
    string,
    {
      finish: (decision: ToolDecision) => void;
      timer: NodeJS.Timeout;
      frozenArguments: any;
      argumentsHash: string;
      intent?: TaskIntent;
      taskRevision?: number;
      directionRequired?: boolean;
      claimed?: boolean;
      validate: () => void;
    }
  >();
  toolTails = new Map<string, Promise<void>>();
  toolEpochs = new Map<string, number>();
  clientGenerationModes = new Map<string, boolean>();
  generationIntents = new Map<string, TaskIntent & { referenceHashes?: string[] }>();
  transitioning = new Set<string>();
  promptTails = new Map<string, Promise<void>>();
  staleTurns = new Map<string, Set<string>>();
  disabled: string[] = [];
  status: {
    connected: boolean;
    model?: string;
    account?: string;
    imageGeneration?: boolean;
    error?: string;
  } = { connected: false };
  bootstrapPromise: Promise<void>;
  stopped = false;
  constructor(store: ProjectStore, endpoint: string) {
    this.store = store;
    this.endpoint = endpoint;
    this.bootstrapPromise = this.bootstrap();
  }
  async bootstrap() {
    let server: AppServer | undefined;
    try {
      server = new AppServer(this.store.root);
      await server.initialize();
      const config = await server.request("config/read", {
        includeLayers: false,
      });
      this.disabled = Object.keys(config.config?.mcp_servers ?? {});
      const account = await server.request("account/read", {
        refreshToken: false,
      });
      const models = await server.request("model/list", { limit: 50 });
      const capabilities = await server.request(
        "modelProvider/capabilities/read",
      );
      this.status = {
        connected: !!account.account,
        account: account.account?.type,
        model:
          config.config.model ||
          models.data.find((model: any) => model.isDefault)?.model,
        imageGeneration: capabilities.imageGeneration,
      };
      if (!account.account)
        this.status.error = "请先在本机 Codex 中登录，再点击重新连接";
    } catch (error) {
      this.status = { connected: false, error: String(error) };
    } finally {
      await server?.close();
      this.store.emit("status", this.status);
    }
  }
  private flush(session: Session) {
    const timer = this.timers.get(session.id);
    if (timer) clearTimeout(timer);
    this.timers.delete(session.id);
    this.store.saveSession(session);
  }
  private diagnose(
    session: Session,
    kind: "approval" | "runtime" | "tool",
    message: string,
    method?: string,
  ) {
    session.diagnostics = [
      ...(session.diagnostics || []),
      {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        kind,
        message,
        method,
        turnId: session.turnId,
      },
    ].slice(-40);
    this.flush(session);
  }
  private schedule(session: Session) {
    if (!this.timers.has(session.id))
      this.timers.set(
        session.id,
        setTimeout(() => this.flush(session), 180),
      );
  }
  private assistant(session: Session, id: string): ChatMessage {
    let message = session.messages.find((message) => message.id === id);
    if (!message) {
      message = {
        id,
        role: "assistant",
        text: "",
        assetIds: [],
        createdAt: new Date().toISOString(),
        status: "streaming",
      };
      session.messages.push(message);
    }
    return message;
  }
  private createRuntime(workspace: string, overrides: string[], env: Record<string, string>) {
    return new AppServer(workspace, overrides, this.disabled, undefined, env);
  }
  private async client(session: Session) {
    const task = this.store.tasksEnabled && session.taskId ? this.store.tasks.get(session.projectId, session.taskId) : undefined;
    const generationEnabled = !task || (task.phase === "direction" && task.contract.generationLimit > 0 && task.attempts.length === 0);
    this.clientGenerationModes ??= new Map();
    if (this.clients.has(session.id)) {
      if (!this.clientGenerationModes.has(session.id) || this.clientGenerationModes.get(session.id) === generationEnabled) return this.clients.get(session.id)!;
      const old = this.clients.get(session.id)!;
      this.clients.delete(session.id); this.tokens.delete(session.id);
      await old.close();
    }
    await this.bootstrapPromise;
    if (!this.status.connected)
      throw new StudioError(this.status.error || "Codex 尚未连接");
    const workspace = join(
      this.store.dir(session.projectId),
      ".studio",
      "staging",
      `agent-${session.id}`,
    );
    mkdirSync(workspace, { recursive: true });
    const token = randomBytes(32).toString("hex");
    this.tokens.set(session.id, token);
    const client = this.createRuntime(
      workspace,
      [
        "features.shell_tool=false",
        "features.unified_exec=false",
        "features.view_image=false",
        `features.image_generation=${generationEnabled}`,
        `mcp_servers.sprite_studio.command=${JSON.stringify(process.execPath)}`,
        `mcp_servers.sprite_studio.args=${JSON.stringify([fileURLToPath(new URL("./mcp.ts", import.meta.url)), this.endpoint, session.id])}`,
        "mcp_servers.sprite_studio.enabled=true",
        "mcp_servers.sprite_studio.required=true",
        "mcp_servers.sprite_studio.tool_timeout_sec=86400",
        'mcp_servers.sprite_studio.env_vars=["SPRITE_STUDIO_TOOL_TOKEN","SPRITE_STUDIO_TASKS_ENABLED"]',
        'mcp_servers.sprite_studio.tools.slice_sheet.approval_mode="approve"',
        'mcp_servers.sprite_studio.tools.write_documents.approval_mode="approve"',
        'mcp_servers.sprite_studio.tools.save_image.approval_mode="approve"',
        'mcp_servers.sprite_studio.tools.create_clip.approval_mode="approve"',
        'mcp_servers.sprite_studio.tools.adjust_image.approval_mode="approve"',
        'mcp_servers.sprite_studio.tools.create_frame_draft.approval_mode="approve"',
        'mcp_servers.sprite_studio.tools.save_frame_draft.approval_mode="approve"',
      ],
      { SPRITE_STUDIO_TOOL_TOKEN: token, SPRITE_STUDIO_TASKS_ENABLED: this.store.tasksEnabled ? "1" : "0" },
    );
    this.clients.set(session.id, client);
    this.clientGenerationModes.set(session.id, generationEnabled);
    client.on("notification", (message) => {
      if (this.clients.get(session.id) !== client) return;
      void this.notification(session, message).catch((error) =>
        this.fail(session, error),
      );
    });
    client.on("requestError", (event) => {
      if (this.clients.get(session.id) === client)
        this.diagnose(session, "runtime", event.message, event.method);
    });
    client.on("stopped", (error) => {
      if (this.clients.get(session.id) !== client) return;
      this.clients.delete(session.id);
      if (!this.stopped && ["starting", "running"].includes(session.status))
        this.fail(session, error);
    });
    client.serverRequest = (request) => this.requestInput(session, request);
    try {
      const assertConnection = () => {
        if (this.clients.get(session.id) !== client || this.stopped || this.transitioning?.has(session.id)) throw new StudioError("连接已被新的回合或阶段替换", 409);
        if (task) assertTaskIntent(this.store, session, { taskId: task.id, intentVersion: task.intentVersion, barrierVersion: task.barrierVersion });
      };
      await client.initialize();
      assertConnection();
      if (task && !generationEnabled) {
        const effective = await client.request("config/read", { includeLayers: false });
        if (effective.config?.features?.image_generation !== false) throw new StudioError("无法确认production runtime已关闭原生生成，拒绝启动制作回合", 409);
      }
      const params = {
        cwd: workspace,
        model: session.model || defaultAgentModel,
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        developerInstructions: ordinaryAgentInstructions,
      };
      if (task) params.developerInstructions += `当前制作任务约定与能力边界：${JSON.stringify({ task, capabilities: this.store.quality.capabilities(), nativeGenerationEnabled: generationEnabled, preflightHardControl: false })}`;
      const result = session.threadId
        ? await client.request("thread/resume", {
            ...params,
            threadId: session.threadId,
            excludeTurns: true,
          })
        : await client.request("thread/start", params);
      assertConnection();
      session.threadId = result.thread.id;
      session.model = session.model || result.model || defaultAgentModel;
      const inventory = await client.request("mcpServerStatus/list", {
        threadId: session.threadId,
        detail: "toolsAndAuthOnly",
        limit: 100,
      });
      assertConnection();
      if (
        inventory.nextCursor ||
        inventory.data.some(
          (entry: any) =>
            entry.name !== "sprite_studio" &&
            Object.keys(entry.tools || {}).length > 0,
        )
      )
        throw new StudioError("发现未预期的外部工具，已停止本次连接");
      this.flush(session);
      return client;
    } catch (error) {
      if (this.clients.get(session.id) === client) {
        this.clients.delete(session.id); this.tokens.delete(session.id); this.clientGenerationModes.delete(session.id);
      }
      await client.close();
      throw error;
    }
  }
  startInterpolation(projectId: string, input: unknown) {
    const { model, ...spec } = interpolationSchema
      .extend({ model: agentModelSchema.optional() })
      .parse(input);
    if (this.store.interpolations.jobs.has(spec.requestId))
      return this.store.interpolations.get(projectId, spec.requestId);
    if (
      [...this.store.sessions.values()].some(
        (session) =>
          session.projectId === projectId &&
          ["starting", "running"].includes(session.status),
      )
    )
      throw new StudioError("当前工程有任务正在进行，请先等待或停止", 409);
    const job = this.store.interpolations.create(projectId, spec);
    try {
      this.send(
        job.sessionId,
        interpolationPrompt(job),
        [job.start.imageId, job.end.imageId],
        job.id,
        `以两张引用图片为首尾，生成 ${job.count} 张中间帧。${job.description}`,
        [],
        undefined,
        model,
      );
    } catch (error) {
      job.status = "failed";
      job.error = String(error);
      this.store.interpolations.save(job);
      throw error;
    }
    return job;
  }
  private interpolation(session: Session) {
    return session.interpolationId &&
      session.messages.filter((message) => message.role === "user").at(-1)
        ?.id === session.interpolationId
      ? this.store.interpolations.get(
          session.projectId,
          session.interpolationId,
        )
      : undefined;
  }
  send(
    sessionId: string,
    text: string,
    assetIds: string[],
    requestId: string,
    displayText?: string,
    clipInputs: unknown[] = [],
    outputFolder?: string,
    model?: string,
    context?: EditingContext,
    taskId?: string,
    feedbackKind?: "local" | "direction",
    markdownInputs: unknown[] = [],
  ) {
    const session = this.store.session(sessionId);
    if (session.messages.some((message) => message.id === requestId))
      return session;
    const selectedModel = agentModelSchema.parse(
      model ??
        (agentModelSchema.safeParse(session.model).success
          ? session.model
          : defaultAgentModel),
    );
    if (outputFolder !== undefined)
      this.store.library.folder(session.projectId, outputFolder);
    if (
      [...this.store.sessions.values()].some(
        (other) =>
          other.projectId === session.projectId &&
          ["starting", "running"].includes(other.status),
      )
    )
      throw new StudioError("当前工程有任务正在进行，请先等待或停止", 409);
    const frozenContext = context ? freezeEditingContext(this.store, session.projectId, context) : undefined;
    const boundId = this.store.tasksEnabled ? taskId || session.taskId : undefined;
    let task = boundId ? this.store.tasks.get(session.projectId, boundId) : undefined;
    if (task && session.taskId && session.taskId !== task.id && !["stopped", "accepted"].includes(this.store.tasks.get(session.projectId, session.taskId).status) && !this.store.tasks.wasAccepted(session.projectId, session.taskId)) throw new StudioError("对话已绑定另一个制作任务", 409);
    const wasAccepted = !!task && this.store.tasks.wasAccepted(session.projectId, task.id);
    // Resolve every attachment and source before binding, advancing intent,
    // cancelling queues, or touching session state. A rejected request has no
    // workflow side effects and its requestId remains safe to reconcile.
    const referenceIds = [...new Set([...assetIds, ...(frozenContext?.assetId && this.store.asset(session.projectId, frozenContext.assetId).type === "image" ? [frozenContext.assetId] : []), ...(task?.referenceIds || []), ...(task?.contract.roleReferenceIds || []), ...(task?.target?.assetId && this.store.asset(session.projectId, task.target.assetId).type === "image" ? [task.target.assetId] : [])])];
    const references = referenceIds.map(id => { this.store.imagePath(session.projectId, id); return this.store.image(session.projectId, id); });
    const clipReferences = clipInputs.map(input => this.store.animation.reference(session.projectId, input));
    const markdownReferences = this.store.markdown.references(session.projectId, markdownInputs);
    if (task) {
      if (["paused", "stopped", "failed", "blocked"].includes(task.status) && !(task.status === "blocked" && wasAccepted)) throw new StudioError("请先在任务上显式恢复，再继续对话", 409);
      this.store.tasks.bindSession(session.projectId, task.id, session.id, true);
      const continuation = feedbackKind || wasAccepted || ["ready", "accepted"].includes(task.status);
      const feedback = { action: "feedback" as const, expectedRevision: task.revision, text, feedbackKind: feedbackKind || "local" as const };
      const source = feedbackKind && frozenContext?.clipId ? frozenContext : undefined;
      if (continuation) this.store.tasks.action(session.projectId, task.id, feedback, source, true);
      task = this.store.tasks.bindSession(session.projectId, task.id, session.id);
      if (continuation) task = this.store.tasks.action(session.projectId, task.id, { ...feedback, expectedRevision: task.revision }, source);
      session.taskId = task.id;
      session.workflowIntent = { taskId: task.id, intentVersion: task.intentVersion, barrierVersion: task.barrierVersion };
    }
    session.editingContext = frozenContext;
    this.cancelTools(session, "新回合已开始，旧排队操作未执行");
    this.staleTurns ??= new Map();
    const previousTurns = this.staleTurns.get(session.id) || new Set<string>();
    if (session.turnId) previousTurns.add(session.turnId);
    this.staleTurns.set(session.id, new Set([...previousTurns].slice(-40)));
    session.turnId = undefined;
    session.model = selectedModel;
    session.status = "starting";
    session.outputFolder = outputFolder;
    session.error = undefined;
    session.prompt = undefined;
    session.activities = [];
    session.title = session.messages.length
      ? session.title
      : (displayText || text).slice(0, 30);
    session.messages.push({
      id: requestId,
      role: "user",
      text,
      displayText,
      assetIds: references.map((asset) => asset.id),
      context: frozenContext,
      taskId: task?.id,
      clipReferences,
      ...(markdownReferences.length ? { markdownReferences } : {}),
      createdAt: new Date().toISOString(),
    });
    this.flush(session);
    void this.startTurn(session, text, references).catch((error) => {
      if (
        session.messages.filter((m) => m.role === "user").at(-1)?.id ===
          requestId &&
        ["starting", "running"].includes(session.status)
      )
        this.fail(session, error);
    });
    return session;
  }
  private async startTurn(
    session: Session,
    text: string,
    references: ReturnType<ProjectStore["image"]>[],
  ) {
    const messageId = session.messages
      .filter((m) => m.role === "user")
      .at(-1)?.id;
    const current = () =>
      session.messages.filter((m) => m.role === "user").at(-1)?.id ===
      messageId;
    const intent = captureTaskIntent(this.store, session);
    const client = await this.client(session);
    if (session.status !== "starting" || !current()) return;
    assertTaskIntent(this.store, session, intent);
    const inputs: any[] = [{ type: "text", text, text_elements: [] }];
    for (const ref of session.messages.find(message => message.id === messageId)?.markdownReferences || []) {
      inputs.push({ type: "text", text: `用户引用的Markdown材料（发送时的正文；后续读写使用Markdown工具）：${JSON.stringify(ref)}`, text_elements: [] });
    }
    const actualReferenceHashes: string[] = [];
    const task = this.store.tasksEnabled && session.taskId ? this.store.tasks.get(session.projectId, session.taskId) : undefined;
    const context = session.editingContext || task?.target;
    if (task) inputs.push({ type: "text", text: `制作任务记录：${JSON.stringify({ task, capabilities: this.store.quality.capabilities(), preflightHardControl: false })}`, text_elements: [] });
    if (context) {
      inputs.push({ type: "text", text: `编辑对象快照（来源、版本及草稿正文）：${JSON.stringify(context)}`, text_elements: [] });
      if (context.draftId) inputs.push({ type: "text", text: this.store.documents.read(session.projectId, context.draftId).text, text_elements: [] });
      if (context.snapshotId) {
        const snapshot = this.store.animation.snapshot(session.projectId, context.snapshotId), range = snapshot.clip.frames.length ? this.store.animation.range(snapshot, context.startFrameId, context.endFrameId) : { start: 0, end: -1 };
        inputs.push({ type: "text", text: `真实快照编排：${JSON.stringify(snapshot.clip)}`, text_elements: [] });
        const frames = context.frameId ? snapshot.clip.frames.filter(f => f.id === context.frameId) : snapshot.clip.frames.slice(range.start, Math.min(range.end + 1, range.start + 16));
        const visualSnapshot = snapshot.renderMode === "preview" ? snapshot : this.store.animation.captureClip(session.projectId, snapshot.clip, snapshot.images, true);
        for (const frame of frames) {
          const rendered = await this.store.animation.renderFrame(session.projectId, visualSnapshot.id, frame.id), hash = sha256(readFileSync(rendered.path));
          const warnings = rendered.bounds && rendered.overflow && Object.values(rendered.overflow).some(value => value > 0)
            ? [{ frameId: frame.id, bounds: rendered.bounds, overflow: rendered.overflow, blocking: !!rendered.blocking }] : [];
          actualReferenceHashes.push(hash);
          inputs.push({ type: "text", text: `渲染帧引用（诊断preview；blocking=true时图像可能被画布截断，边界数据见warnings）：${JSON.stringify({ sourceSnapshotId: snapshot.id, previewSnapshotId: visualSnapshot.id, frameId: frame.id, sha256: hash, warnings })}`, text_elements: [] }, { type: "localImage", path: rendered.path });
        }
      }
    }
    inputs.push({
      type: "text",
      text: `当前网页目录：${session.outputFolder || "项目资源根目录"}。显式保存图片时按任务选择参考图或原图素材；save_image.folder只填写所选分类内部的相对目录，空或点号为分类根目录。`,
      text_elements: [],
    });
    for (const ref of session.messages
      .filter((message) => message.role === "user")
      .at(-1)?.clipReferences || []) {
      const snapshot = this.store.animation.snapshot(
          session.projectId,
          ref.snapshotId,
        ),
        range = this.store.animation.range(
          snapshot,
          ref.startFrameId,
          ref.endFrameId,
        );
      inputs.push({
        type: "text",
        text: `动画快照引用（帧编排与时长；inspect_clip提供逐帧和相邻叠图）：${JSON.stringify({ ...ref, loop: snapshot.clip.loop, totalFrames: snapshot.clip.frames.length, frames: snapshot.clip.frames.slice(range.start, range.end + 1).map((frame, index) => ({ ...frame, frameNumber: range.start + index + 1 })) })}`,
        text_elements: [],
      });
    }
    const interpolation = this.interpolation(session);
    const endpoints = interpolation
      ? this.store.animation.capture(
          session.projectId,
          interpolation.clipId,
          interpolation.clipRevision,
        )
      : undefined;
    for (const [index, asset] of references.entries()) {
      let source = this.store.imagePath(
        session.projectId,
        asset.id,
        asset.revision,
      );
      // Endpoint generation keeps its existing workflow, but must see the same
      // saved frame pixels as playback after source-relative transforms exist.
      if (interpolation && endpoints) {
        const ref = index === 0 ? interpolation.start : interpolation.end;
        source = (
          await this.store.animation.renderFrame(
            session.projectId,
            endpoints.id,
            ref.frameId,
          )
        ).path;
        ref.contentHash = sha256(readFileSync(source));
      }
      const referenceHash = sha256(readFileSync(source));
      actualReferenceHashes.push(referenceHash);
      const snapshot = join(
        this.store.dir(session.projectId),
        ".studio",
        "staging",
        `agent-${session.id}`,
        `${asset.id}-${referenceHash}${extname(asset.file)}`,
      );
      if (!existsSync(snapshot)) copyFileSync(source, snapshot);
      inputs.push(
        {
          type: "text",
          text: `资源引用：${asset.name}；assetId=${asset.id}；revision=${asset.revision}；快照路径=${snapshot}`,
          text_elements: [],
        },
        { type: "localImage", path: snapshot },
      );
    }
    if (session.status !== "starting" || !current()) return;
    assertTaskIntent(this.store, session, intent);
    if (interpolation) this.store.interpolations.save(interpolation);
    session.workflowReferenceHashes = [...new Set(actualReferenceHashes)];
    session.status = "running";
    this.flush(session);
    const result = await client.request("turn/start", {
      threadId: session.threadId,
      model: session.model || defaultAgentModel,
      input: inputs,
      effort: "medium",
      clientUserMessageId: session.messages
        .filter((message) => message.role === "user")
        .at(-1)!.id,
    });
    if (!current() || session.status !== "running") return;
    session.turnId = result.turn.id;
    this.flush(session);
  }
  private async notification(session: Session, message: Message) {
    const params = message.params;
    if (
      !params ||
      (params.threadId &&
        session.threadId &&
        params.threadId !== session.threadId)
    )
      return;
    const eventTurnId = params.turnId || params.turn?.id;
    const stale = !!(eventTurnId && (this.staleTurns?.get(session.id)?.has(eventTurnId) || (session.turnId && eventTurnId !== session.turnId)));
    const generation = params.item?.type === "imageGeneration" ? params.item : undefined;
    if (generation && ["item/started", "item/completed"].includes(message.method!)) {
      this.generationIntents ??= new Map();
      const key = `${session.id}:${generation.id}`;
      if (!stale && this.store.tasksEnabled && session.workflowIntent && !this.generationIntents.has(key)) this.generationIntents.set(key, { ...structuredClone(session.workflowIntent), referenceHashes: [...(session.workflowReferenceHashes || [])] });
      const intent = this.generationIntents.get(key);
      if (message.method === "item/started" && intent) {
        this.store.tasks.observeGeneration(session.projectId, intent.taskId, { ...intent, sessionId: session.id, runtimeItemId: generation.id });
        const task = this.store.tasks.get(session.projectId, intent.taskId);
        if (task.phase !== "direction" || task.attempts.length > task.contract.generationLimit) void this.stop(session.id, "原生生成越过阶段/额度边界，已中断；事件日志不是调用前硬控制，未知结果保留");
      }
      if (message.method === "item/completed" && generation.status === "completed") {
        const pending = this.importGenerated(session, generation, intent);
        const list = this.imports.get(session.id) || []; list.push(pending); this.imports.set(session.id, list);
      } else if (message.method === "item/completed" && intent) this.store.tasks.observeGeneration(session.projectId, intent.taskId, { ...intent, sessionId: session.id, runtimeItemId: generation.id, failed: true });
    }
    if (stale || this.transitioning?.has(session.id)) return;
    if (message.method === "turn/plan/updated") {
      const plan = turnPlanSchema.safeParse(params);
      if (plan.success && session.status === "running") {
        session.plan = plan.data;
        this.flush(session);
      }
      return;
    }
    if (
      message.method === "serverRequest/resolved" &&
      session.prompt?.requestId === params.requestId
    ) {
      this.prompts.get(session.prompt!.id)?.({});
      this.diagnose(
        session,
        "runtime",
        "原生提问已由运行时结束或取消",
        message.method,
      );
      return;
    }
    if (message.method === "turn/started") {
      session.turnId = params.turn.id;
      this.schedule(session);
    }
    if (message.method === "item/agentMessage/delta") {
      this.assistant(session, params.itemId).text += params.delta;
      this.schedule(session);
    }
    const item = params.item;
    if (message.method === "item/started" && item?.type === "agentMessage") {
      this.assistant(session, item.id).phase = item.phase;
    }
    if (message.method === "item/completed" && item?.type === "agentMessage") {
      const msg = this.assistant(session, item.id);
      msg.text = item.text;
      msg.phase = item.phase;
      msg.status = "completed";
      this.schedule(session);
    }
    if (
      ["item/started", "item/completed"].includes(message.method!) &&
      ["mcpToolCall", "imageGeneration"].includes(item?.type)
    ) {
      const names: Record<string, string> = {
        read_markdown: "读取项目文档",
        create_markdown: "新建项目文档",
        write_markdown: "更新项目文档",
        list_assets: "查找工程资源",
        list_generated_images: "查看生成产物",
        save_image: "保存生成图片",
        create_clip: "新建动画",
        get_schema: "读取配置格式",
        read_document: "读取制作配置",
        validate_document: "检查制作配置",
        write_documents: "编辑制作配置",
        create_frame_draft: "建立动画调整草稿",
        save_frame_draft: "请求保存帧调整",
        view_image: "查看图片",
        inspect_sheet: "检测切割证据",
        slice_sheet: "切割图集",
        adjust_image: "调整图片",
        inspect_clip: "检查动画证据",
      };
      const content = item.result?.content || [];
      const returnedText = content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text || "")
        .join("\n");
      let outcome: any;
      try {
        outcome = JSON.parse(returnedText);
      } catch {}
      const rejected = outcome?.executed === false || (outcome?.saved === false && outcome?.delivered !== true);
      const detail =
        item.error?.message ||
        item.failure?.message ||
        outcome?.reason ||
        (item.result?.isError ? returnedText.slice(0, 900) : undefined);
      const status =
        message.method === "item/started"
          ? "running"
          : item.error ||
              item.failure ||
              item.result?.isError ||
              rejected ||
              item.status === "failed"
            ? "failed"
            : "completed";
      const activity = {
        id: item.id,
        label:
          item.type === "imageGeneration"
            ? "生成图片"
            : names[item.tool] || item.tool,
        status,
        detail,
      } as const;
      const index = session.activities.findIndex(
        (activity) => activity.id === item.id,
      );
      if (index < 0) session.activities.push(activity);
      else session.activities[index] = activity;
      this.flush(session);
      if (message.method === "item/completed" && detail)
        this.diagnose(
          session,
          "tool",
          `${activity.label}：${detail}`,
          message.method,
        );
    }
    if (message.method === "turn/completed") {
      const endedTurn = params.turn.id;
      const endedMessage = session.messages
        .filter((m) => m.role === "user")
        .at(-1)?.id;
      const waiting = !!(
        session.toolApproval ||
        session.frameSaveApproval ||
        (session.prompt && session.prompt.blocking !== false)
      );
      const pendingError = waiting
        ? "Codex回合在等待用户决定时已经结束；待审批操作未执行。请发送消息继续，不能把已结束回合当作仍在等待。"
        : undefined;
      this.cancelTools(session, "任务已结束，待审批操作未执行");
      this.cancelFrameSave(session, "任务已结束，待审批修改未保存");
      if (session.prompt) this.prompts.get(session.prompt.id)?.({});
      await Promise.allSettled(this.imports.get(session.id) || []);
      if (
        (session.turnId && session.turnId !== endedTurn) ||
        session.messages.filter((m) => m.role === "user").at(-1)?.id !==
          endedMessage
      )
        return;
      this.imports.delete(session.id);
      session.status =
        params.turn.status === "failed"
          ? "failed"
          : params.turn.status === "interrupted" || pendingError
            ? "interrupted"
            : "idle";
      session.error =
        params.turn.error?.message ||
        pendingError ||
        (session.status === "failed"
          ? session.error ||
            "Codex回合失败，但未返回详细错误。请查看下方诊断记录。"
          : session.status === "interrupted"
            ? session.error ||
              "Codex报告回合中断（未提供具体原因）。已完成的资源会保留。"
            : session.error);
      this.diagnose(
        session,
        "runtime",
        session.error || "本轮对话正常完成",
        message.method,
      );
      session.prompt = undefined;
      for (const msg of session.messages)
        if (msg.status === "streaming")
          msg.status =
            params.turn.status === "completed" ? "completed" : "interrupted";
      for (const activity of session.activities)
        if (activity.status === "running")
          activity.status =
            params.turn.status === "completed" ? "completed" : "failed";
      this.flush(session);
      const job = this.interpolation(session);
      if (job && !job.sheetId) {
        job.status =
          session.status === "interrupted" ? "interrupted" : "failed";
        job.error =
          session.error ||
          (session.status === "interrupted"
            ? "补帧已停止，没有自动重试。"
            : "本次任务尚未保存可用图集，请查看生成产物并保存；没有自动重试。");
        this.store.interpolations.save(job);
      }
    }
    if (message.method === "error") {
      const error =
        params.error?.message || params.message || "Codex返回未说明原因的错误";
      if (!params.willRetry) session.error = error;
      this.diagnose(
        session,
        "runtime",
        `${params.willRetry ? "连接重试中：" : "运行错误："}${error}${params.error?.additionalDetails ? "；" + params.error.additionalDetails : ""}`,
        message.method,
      );
    }
  }
  private async importGenerated(session: Session, item: any, intent?: TaskIntent & { referenceHashes?: string[] }) {
    const messageId = session.messages.filter(message => message.role === "user").at(-1)?.id;
    const stillCurrent = () => {
      const task = intent ? this.store.tasks.get(session.projectId, intent.taskId) : undefined;
      return session.messages.filter(message => message.role === "user").at(-1)?.id === messageId && (!intent || (session.workflowIntent?.taskId === intent.taskId && session.workflowIntent.intentVersion === intent.intentVersion && session.workflowIntent.barrierVersion === intent.barrierVersion && task?.intentVersion === intent.intentVersion && task.barrierVersion === intent.barrierVersion));
    };
    try {
      const generated = await this.store.generated.capture(
        session.projectId,
        session.id,
        item,
        this.interpolation(session)?.id,
      );
      if (intent) this.store.tasks.observeGeneration(session.projectId, intent.taskId, { ...intent, sessionId: session.id, runtimeItemId: item.id, generatedId: generated.id });
      let msg = stillCurrent() ? session.messages
        .filter((message) => message.role === "assistant")
        .at(-1) : undefined;
      if (!msg) msg = this.assistant(session, `image-${item.id}`);
      msg.generatedIds ??= [];
      if (!msg.generatedIds.includes(generated.id))
        msg.generatedIds.push(generated.id);
      this.flush(session);
    } catch (error) {
      const reason = `接收生成图片失败：${String(error)}`;
      if (stillCurrent()) session.error = reason;
      this.diagnose(session, "runtime", reason, "workflow/generation-capture");
    }
  }
  private async requestInput(session: Session, request: Message): Promise<any> {
    const method = request.method;
    const params = request.params || {};
    if (
      params.threadId &&
      session.threadId &&
      params.threadId !== session.threadId
    )
      throw new RpcRequestError("请求不属于当前对话", -32602);
    if (params.turnId && session.turnId && params.turnId !== session.turnId)
      throw new RpcRequestError("请求来自已结束的回合", -32602);
    if (method === "currentTime/read")
      return { currentTimeAt: Math.floor(Date.now() / 1000) };
    // This callback can be needed by a tool already in flight. Waiting for that
    // tool's tail here makes both sides wait on each other.
    if (
      method === "item/tool/requestUserInput" ||
      method === "tool/requestUserInput"
    ) {
      this.promptTails ??= new Map();
      this.toolEpochs ??= new Map();
      const epoch = this.toolEpochs.get(session.id) || 0;
      const previous = this.promptTails.get(session.id);
      let release!: () => void;
      const tail = new Promise<void>((r) => {
        release = r;
      });
      this.promptTails.set(session.id, tail);
      await previous;
      try {
        if (
          !["starting", "running"].includes(session.status) ||
          (this.toolEpochs.get(session.id) || 0) !== epoch
        )
          return { answers: {} };
        const questions = z
          .array(
            z.object({
              id: z.string(),
              question: z.string(),
              options: z
                .array(z.object({ label: z.string() }))
                .nullable()
                .optional(),
            }),
          )
          .parse(params.questions)
          .map((q) => ({
            id: q.id,
            question: q.question,
            options: (q.options || []).map((o) => o.label),
          }));
        if (!questions.length) return { answers: {} };
        const id = randomUUID();
        session.prompt = {
          id,
          requestId: request.id,
          questions,
          blocking: params.isBlocking !== false,
        };
        const result = new Promise((resolve) => {
          const timer = setTimeout(
            () => {
              void this.stop(session.id, "等待用户回答超时，任务已停止");
            },
            23 * 60 * 60_000,
          );
          this.prompts.set(id, (answers) => {
            clearTimeout(timer);
            this.prompts.delete(id);
            if (session.prompt?.id === id) session.prompt = undefined;
            this.flush(session);
            resolve({
              answers: Object.fromEntries(
                Object.entries(answers).map(([key, value]) => [
                  key,
                  { answers: [value] },
                ]),
              ),
            });
          });
        });
        this.diagnose(
          session,
          "runtime",
          "助手正在等待回答（这是任务提问，不是工具审批）",
          method,
        );
        return await result;
      } finally {
        release();
        if (this.promptTails.get(session.id) === tail)
          this.promptTails.delete(session.id);
      }
    }
    // Our project MCP advertises tools only, never form elicitation. Do not turn
    // an unexpected authorization request into an unrelated save/settings form.
    const response =
      method === "mcpServer/elicitation/request"
        ? { action: "decline", content: null, _meta: null }
        : method === "item/permissions/requestApproval"
          ? { permissions: {}, scope: "turn" }
          : method === "item/commandExecution/requestApproval" ||
              method === "item/fileChange/requestApproval"
            ? { decision: "decline" }
            : method === "execCommandApproval" ||
                method === "applyPatchApproval"
              ? {
                  decision: {
                    denied: {
                      rejection:
                        "请使用当前工程的项目工具；宿主执行或文件权限不在本次授权范围",
                    },
                  },
                }
              : method === "item/tool/call"
                ? { success: false, contentItems: [] }
                : undefined;
    if (response) {
      this.diagnose(
        session,
        "runtime",
        `已拒绝未接入的原生请求 ${method}；请使用项目工具审批，未开放额外宿主权限。`,
        method,
      );
      return response;
    }
    throw new RpcRequestError(
      `工作台未接入原生请求 ${method}，没有自动授权；请查看对话诊断记录。`,
    );
  }
  answer(sessionId: string, id: string, answers: Record<string, string>) {
    const session = this.store.session(sessionId);
    if (session.prompt?.id !== id || !this.prompts.has(id))
      throw new StudioError("这个问题已经结束，请刷新对话");
    this.prompts.get(id)!(answers);
  }
  async requestFrameSave(
    session: Session,
    draftId: string,
    revision: string,
    guard: () => void = () => {},
  ): Promise<any> {
    const drafts = this.store.frameDrafts,
      pid = session.projectId;
    const draft = drafts.get(pid, draftId);
    if (draft.sessionId !== session.id)
      throw new StudioError("草稿不属于当前对话");
    if (draft.status === "saved")
      return { saved: true, change: await drafts.save(pid, draftId, revision) };
    drafts.check(pid, draftId, revision);
    if (draft.status !== "editing" || session.frameSaveApproval)
      throw new StudioError("已有保存请求等待处理", 409);
    const policy = drafts.policy();
    if (policy === "deny")
      return { saved: false, reason: "当前设置禁止助手保存单帧配置" };
    const preview = await drafts.preview(pid, draftId, revision);
    drafts.check(pid, draftId, revision);
    if (
      drafts.get(pid, draftId).status !== "editing" ||
      session.frameSaveApproval
    )
      throw new StudioError("草稿状态已改变", 409);
    if (policy === "allow")
      return { saved: true, change: await drafts.save(pid, draftId, revision) };
    if (!preview.modifiedFrameIds.length)
      return { saved: false, reason: "没有需要保存的帧修改" };
    const blocked = preview.warnings.filter((w) => w.blocking);
    if (blocked.length)
      throw new StudioError(
        `第 ${blocked.map((w) => w.frameNumber).join("、")} 帧可见内容超出画布，请调整后再请求保存`,
      );
    const frameChanges = preview.modifiedFrameIds.map((frameId) => {
      const before = preview.before.clip.frames.find((f) => f.id === frameId)!,
        after = preview.preview.clip.frames.find((f) => f.id === frameId)!;
      return {
        frameId,
        frameNumber:
          preview.before.clip.frames.findIndex((f) => f.id === frameId) + 1,
        before: { transform: before.transform, durationUs: before.durationUs },
        after: { transform: after.transform, durationUs: after.durationUs },
      };
    });
    const first = frameChanges[0]!;
    const approval: FrameSaveApproval = {
      id: randomUUID(),
      clipId: preview.before.clip.id,
      draftId,
      documentRevision: revision,
      beforeSnapshotId: preview.before.id,
      previewSnapshotId: preview.preview.id,
      frameChanges,
      before: first.before,
      after: first.after,
      frameNumber: first.frameNumber,
      clipName: preview.before.clip.name,
    };
    drafts.persist({ ...drafts.get(pid, draftId), status: "pending" });
    session.frameSaveApproval = approval;
    const promise = new Promise((resolve) => {
      const timer = setTimeout(
        () => {
          void this.stop(session.id, "等待审批超时，任务已停止，修改未保存");
        },
        23 * 60 * 60_000,
      );
      this.frameSaves.set(approval.id, {
        sessionId: session.id,
        finish: resolve,
        timer,
        guard,
      });
    });
    this.diagnose(
      session,
      "approval",
      `等待审批：保存动画“${approval.clipName}”的帧调整`,
    );
    return promise;
  }
  cancelFrameSave(session: Session, reason: string, userApproval?: UserApprovalFeedback) {
    const approval = session.frameSaveApproval;
    if (!approval) return;
    const pending = this.frameSaves.get(approval.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.frameSaves.delete(approval.id);
    session.frameSaveApproval = undefined;
    const draft = this.store.frameDrafts.get(
      session.projectId,
      approval.draftId,
    );
    if (draft.status === "pending")
      this.store.frameDrafts.persist({ ...draft, status: "editing" });
    this.diagnose(session, "approval", `帧调整未保存：${reason}`);
    pending.finish({ saved: false, reason, ...(userApproval ? { userApproval } : {}) });
  }
  async resolveFrameSave(
    sessionId: string,
    approvalId: string,
    accept: boolean,
    reason = "",
  ) {
    const session = this.store.session(sessionId),
      approval = session.frameSaveApproval;
    if (
      !approval ||
      approval.id !== approvalId ||
      !this.frameSaves.has(approvalId)
    )
      throw new StudioError("保存请求已结束，请刷新", 409);
    if (!accept) {
      this.cancelFrameSave(
        session,
        reason || "用户拒绝此次保存，请保留草稿并根据反馈调整",
        { approvalId, accepted: false, feedback: reason, snapshotIds: [approval.previewSnapshotId] },
      );
      return { saved: false };
    }
    const pending = this.frameSaves.get(approvalId)!;
    this.frameSaves.delete(approvalId);
    clearTimeout(pending.timer);
    try {
      pending.guard?.();
      const change = await this.store.guarded(pending.guard || (() => {}), () => this.store.frameDrafts.save(
        session.projectId,
        approval.draftId,
        approval.documentRevision,
      ));
      const result = { saved: true, change, userApproval: { approvalId, accepted: true, feedback: reason, snapshotIds: [approval.previewSnapshotId] } };
      this.diagnose(
        session,
        "approval",
        `已允许并保存动画“${approval.clipName}”的帧调整`,
      );
      pending.finish(result);
      return result;
    } catch (error) {
      const draft = this.store.frameDrafts.get(
        session.projectId,
        approval.draftId,
      );
      if (draft.status === "pending")
        this.store.frameDrafts.persist({ ...draft, status: "editing" });
      pending.finish({ saved: false, reason: String(error), userApproval: { approvalId, accepted: true, feedback: reason, snapshotIds: [approval.previewSnapshotId] } });
      throw error;
    } finally {
      session.frameSaveApproval = undefined;
      this.flush(session);
    }
  }
  private frozenTaskApproval(pid: string, taskId: string, binding: { sessionId: string; approvalId: string }, expectedRevision: number, runtimeGuard = true) {
    const task = this.store.tasks.get(pid, taskId), session = this.store.session(binding.sessionId), pending = this.toolWaits?.get(binding.approvalId), approval = session.toolApproval;
    if (task.revision !== expectedRevision || task.sessionId !== session.id || session.projectId !== pid || session.taskId !== taskId || !pending || approval?.id !== binding.approvalId || approval.tool !== "save_image" || pending.intent?.taskId !== taskId || pending.taskRevision !== expectedRevision || pending.intent.intentVersion !== task.intentVersion || pending.intent.barrierVersion !== task.barrierVersion) throw new StudioError("任务或冻结工具审批已过期/不属于该会话", 409);
    if (runtimeGuard && pending.claimed) throw new StudioError("该冻结审批已有决定正在提交", 409);
    if (sha256(JSON.stringify(approval.arguments)) !== pending.argumentsHash || sha256(JSON.stringify(pending.frozenArguments)) !== pending.argumentsHash) throw new StudioError("冻结审批参数已改变", 409);
    if (this.effectivePolicy("save_image", pending.frozenArguments) === "deny") throw new StudioError("权限已禁止保存图片", 409);
    if (runtimeGuard) pending.validate();
    return { task, session, pending, approval };
  }
  async taskAction(pid: string, taskId: string, input: z.infer<typeof taskActionSchema>) {
    if (!this.store.tasksEnabled) throw new StudioError("自建制作任务已停用", 409);
    const { toolApproval, ...action } = taskActionSchema.parse(input);
    let task = this.store.tasks.get(pid, taskId);
    if (task.revision !== action.expectedRevision) throw new StudioError("VERSION_CONFLICT：任务已变化", 409);
    if (toolApproval && action.action !== "save-location") throw new StudioError("该动作不能携带工具决定");
    if (toolApproval) this.frozenTaskApproval(pid, taskId, toolApproval, action.expectedRevision);
    if (action.action === "ready") {
      const token = { intentVersion: task.intentVersion, barrierVersion: task.barrierVersion };
      const guard = () => { const current = this.store.tasks.get(pid, taskId); if (current.intentVersion !== token.intentVersion || current.barrierVersion !== token.barrierVersion || current.status !== "running" || current.phase !== "production") throw new StudioError("制作意图已失效", 409); };
      const checked = await this.store.quality.checkTask(pid, taskId, guard);
      if (action.snapshotId && action.snapshotId !== checked.snapshot.id) throw new StudioError("需要当前确切交付快照", 409);
      task = this.store.tasks.action(pid, taskId, { ...action, expectedRevision: checked.task.revision, snapshotId: checked.snapshot.id });
    } else task = this.store.tasks.action(pid, taskId, action);
    if (action.action === "save-location" && toolApproval) {
      // The typed action, not a natural-language prefix, preserves direction.
      this.toolEpochs ??= new Map(); this.toolEpochs.set(toolApproval.sessionId, (this.toolEpochs.get(toolApproval.sessionId) || 0) + 1);
      this.resolveToolApproval(toolApproval.sessionId, toolApproval.approvalId, false, `仅修改保存位置；保留方向与生成产物，同generatedId、新requestId重提审批：${action.text}`);
    }
    if (["pause", "stop", "handoff", "feedback"].includes(action.action) && task.sessionId) await this.stop(task.sessionId, action.text || (action.action === "handoff" ? "人工接手，旧Agent意图已取消" : "任务屏障已改变，旧操作未执行"), true);
    return this.store.tasks.get(pid, taskId);
  }
  async decideTaskDirection(pid: string, taskId: string, input: z.infer<typeof taskDirectionSchema>) {
    if (!this.store.tasksEnabled) throw new StudioError("自建制作任务已停用", 409);
    const { toolApproval, ...direction } = taskDirectionSchema.parse(input);
    let task = this.store.tasks.get(pid, taskId);
    const session = task.sessionId ? this.store.session(task.sessionId) : undefined;
    if (session && this.transitioning?.has(session.id)) throw new StudioError("方向决定正在阶段切换，请等待", 409);
    const frozen = toolApproval ? this.frozenTaskApproval(pid, taskId, toolApproval, direction.expectedRevision) : undefined;
    if (session?.toolApproval?.directionRequired && !frozen) throw new StudioError("请一次提交方向和同一冻结save_image审批", 409);
    if (frozen && (direction.generatedId !== frozen.pending.frozenArguments.generatedId || direction.assetId || direction.snapshotId)) throw new StudioError("方向产物与冻结save_image参数不一致", 409);
    this.store.tasks.decideDirection(pid, taskId, direction, true);
    if (!direction.accept) {
      task = this.store.tasks.decideDirection(pid, taskId, direction);
      if (session) await this.stop(session.id, direction.feedback || "方向被拒绝，保留已有产物，不自动重新生成", true);
      return task;
    }
    const wasActive = !!session && ["starting", "running"].includes(session.status);
    if (frozen) frozen.pending.claimed = true;
    const acceptedIntent = task.intentVersion, acceptedBarrier = task.barrierVersion;
    const oldClient = session ? this.clients.get(session.id) : undefined;
    let result: any;
    if (session) {
      this.transitioning ??= new Set(); this.transitioning.add(session.id);
      this.toolEpochs ??= new Map(); this.toolEpochs.set(session.id, (this.toolEpochs.get(session.id) || 0) + 1);
    }
    try {
      // No hot native tool toggle is proven. Retire direction runtime before
      // committing its approved save or allowing any production continuation.
      if (oldClient && session?.turnId && session.status === "running") {
        try { await oldClient.request("turn/interrupt", { threadId: session.threadId, turnId: session.turnId }); }
        catch { await oldClient.close(); }
      }
      if (frozen && toolApproval) this.frozenTaskApproval(pid, taskId, toolApproval, direction.expectedRevision, false);
      this.store.tasks.decideDirection(pid, taskId, direction, true);
      task = this.store.tasks.decideDirection(pid, taskId, direction);
      if (session && frozen && toolApproval) {
        const intent = { taskId, intentVersion: task.intentVersion, barrierVersion: task.barrierVersion };
        const guard = () => { if (this.toolWaits.get(toolApproval.approvalId) !== frozen.pending || session.toolApproval?.id !== toolApproval.approvalId) throw new StudioError("冻结保存决定已取消", 409); precheckTaskTool(this.store, session, intent, "save_image", frozen.pending.frozenArguments); if (this.effectivePolicy("save_image", frozen.pending.frozenArguments) === "deny") throw new StudioError("权限已禁止保存图片", 409); };
        try { result = await this.store.guarded(guard, () => this.executeTool(session.id, "save_image", frozen.pending.frozenArguments, guard, intent)); }
        catch (error) { result = { isError: true, content: [textContent(JSON.stringify({ saved: false, directionAccepted: true, reason: String(error), generatedId: direction.generatedId, guidance: "方向已认可，修正保存位置后用同产物新requestId重提保存；不要重生成" }))] }; }
        this.resolveToolApproval(session.id, toolApproval.approvalId, true, "方向与冻结工具请求已一次决定；实际保存结果见回执", result);
      }
    } catch (error) {
      if (session) await this.stop(session.id, `阶段切换未完成：${String(error)}`, true);
      throw error;
    } finally {
      if (session) {
        this.clients.delete(session.id); this.tokens?.delete(session.id); this.clientGenerationModes?.delete(session.id);
        await oldClient?.close();
        this.transitioning?.delete(session.id);
      }
    }
    if (session) {
      if (session.turnId) { this.staleTurns ??= new Map(); const turns = this.staleTurns.get(session.id) || new Set<string>(); turns.add(session.turnId); this.staleTurns.set(session.id, turns); }
      session.status = "idle"; session.error = undefined;
      this.cancelFrameSave(session, "方向runtime已退出，制作阶段使用完整对象草稿");
      if (session.prompt) this.prompts.get(session.prompt.id)?.({});
      this.diagnose(session, "runtime", "受控阶段切换：方向已认可，旧runtime已退出；production禁用原生生成，任务尚未交付", "workflow/production");
      task = this.store.tasks.get(pid, taskId);
      if (wasActive && task.status === "running" && task.intentVersion === acceptedIntent && task.barrierVersion === acceptedBarrier) this.send(session.id, `方向已通过，继续已认可成果的确定性制作、检查与交付。禁止重新生成。冻结保存请求的真实结果：${JSON.stringify(result || { saved: false, reason: "本次方向决定不包含图片保存" })}。完整任务：${JSON.stringify(task)}`, [], randomUUID(), "方向通过，继续确定性制作", [], session.outputFolder, session.model, undefined, taskId);
    }
    return this.store.tasks.get(pid, taskId);
  }
  async stop(sessionId: string, reason = "任务已停止，待审批操作未执行", preserveTask = false) {
    const session = this.store.session(sessionId);
    // Invalidate writes BEFORE waiting for runtime acknowledgement. Keep blocked
    // callbacks pending until interrupt is acknowledged, preserving old safety.
    this.transitioning ??= new Set(); this.transitioning.add(sessionId);
    if (session.turnId) { this.staleTurns ??= new Map(); const turns = this.staleTurns.get(sessionId) || new Set<string>(); turns.add(session.turnId); this.staleTurns.set(sessionId, turns); }
    this.toolEpochs ??= new Map();
    this.toolEpochs.set(sessionId, (this.toolEpochs.get(sessionId) || 0) + 1);
    if (this.store.tasksEnabled && session.taskId && !preserveTask) {
      const task = this.store.tasks.get(session.projectId, session.taskId);
      if (!["paused", "stopped", "accepted", "ready"].includes(task.status)) this.store.tasks.action(session.projectId, task.id, { expectedRevision: task.revision, action: "pause" });
    }
    const client = this.clients.get(sessionId);
    const interruptedTurn = session.turnId;
    const interruptedMessage = session.messages
      .filter((m) => m.role === "user")
      .at(-1)?.id;
    // Interrupt the model before releasing blocked tool calls, so it cannot resume
    // reasoning from a timeout/cancellation result while still running.
    if (client && session.status === "starting") {
      if (this.clients.get(sessionId) === client) { this.clients.delete(sessionId); this.tokens?.delete(sessionId); this.clientGenerationModes?.delete(sessionId); }
      await client.close();
    }
    if (client && session.turnId && session.status === "running") {
      try {
        await client.request("turn/interrupt", {
          threadId: session.threadId,
          turnId: session.turnId,
        });
      } catch {
        await client.close();
      }
    }
    if (
      (session.turnId && session.turnId !== interruptedTurn) ||
      session.messages.filter((m) => m.role === "user").at(-1)?.id !==
        interruptedMessage
    ) {
      this.transitioning.delete(sessionId);
      return;
    }
    session.status = "interrupted";
    session.error = reason;
    this.diagnose(session, "runtime", reason, "turn/interrupt");
    this.cancelTools(session, reason);
    this.cancelFrameSave(session, reason);
    if (session.prompt) this.prompts.get(session.prompt.id)?.({});
    this.flush(session);
    const job = this.interpolation(session);
    if (job && !job.sheetId) {
      job.status = "interrupted";
      job.error = "补帧已停止，没有自动重试。";
      this.store.interpolations.save(job);
    }
    this.transitioning.delete(sessionId);
  }
  private fail(session: Session, error: unknown) {
    const client = this.clients.get(session.id);
    this.clients.delete(session.id);
    this.tokens?.delete(session.id);
    if (client) void client.close().catch(() => {});
    this.cancelTools(session, "任务失败，待审批操作未执行");
    this.cancelFrameSave(session, "任务失败，修改未保存");
    session.status = "failed";
    session.error = error instanceof Error ? error.message : String(error);
    if (this.store.tasksEnabled && session.taskId) this.store.tasks.pauseForRuntime(session.projectId, session.taskId, session.error, session.error.includes("无法确认production"));
    this.diagnose(session, "runtime", session.error, "runtime/failure");
    if (session.prompt) this.prompts.get(session.prompt.id)?.({});
    for (const msg of session.messages)
      if (msg.status === "streaming") msg.status = "failed";
    this.flush(session);
    const job = this.interpolation(session);
    if (job && !job.sheetId) {
      job.status = "failed";
      job.error = session.error;
      this.store.interpolations.save(job);
    }
  }
  cancelTools(session: Session, reason: string) {
    this.toolEpochs ??= new Map();
    this.toolEpochs.set(session.id, (this.toolEpochs.get(session.id) || 0) + 1);
    if (session.toolApproval)
      this.resolveToolApproval(
        session.id,
        session.toolApproval.id,
        false,
        reason,
        undefined,
        true,
      );
  }
  resolveToolApproval(
    sessionId: string,
    approvalId: string,
    accept: boolean,
    reason = "",
    resolvedResult?: any,
    internalCancel = false,
  ) {
    const session = this.store.session(sessionId);
    const pending = this.toolWaits?.get(approvalId);
    if (!pending || session.toolApproval?.id !== approvalId)
      throw new StudioError("审批已结束，请刷新", 409);
    if (pending.claimed && resolvedResult === undefined && !internalCancel) throw new StudioError("该冻结审批已有决定正在提交", 409);
    if (accept && resolvedResult === undefined) {
      if (pending.directionRequired) throw new StudioError("需要一次明确的任务方向+工具决定，请使用任务direction入口", 409);
      try { pending.validate(); }
      catch (error) {
        if (session.toolApproval.animations?.length)
          this.resolveToolApproval(sessionId, approvalId, false, `候选已过期，未保存；请读取当前版本后重新提交：${String(error)}`, undefined, true);
        throw error;
      }
    }
    clearTimeout(pending.timer);
    const snapshotIds = session.toolApproval.animations?.map(animation => animation.previewSnapshotId);
    this.toolWaits.delete(approvalId);
    session.toolApproval = undefined;
    this.diagnose(
      session,
      "approval",
      `${accept ? "已允许" : "已拒绝"}工具审批${reason ? "：" + reason : ""}`,
    );
    pending.finish({
      accept,
      result: resolvedResult,
      reason:
        reason || (accept ? "用户已允许" : "用户拒绝此次操作，请调整方案"),
      ...(!internalCancel ? { userApproval: { approvalId, accepted: accept, feedback: reason, ...(snapshotIds ? { snapshotIds } : {}) } } : {}),
    });
    return { accepted: accept };
  }
  private effectivePolicy(name: PermissionTool, input: any, pid?: string) {
    const keys = [name, ...toolPolicyParents(name, input)];
    if (name === "write_documents" && pid && writesSavedAnimation(this.store, pid, input))
      keys.push("save_clip_draft", "save_frame_draft");
    const policies = this.store.permissions.read(), values = keys.map(key => policies[key]);
    return values.includes("deny") ? "deny" : values.includes("ask") ? "ask" : "allow";
  }
  private async approveTool(
    session: Session,
    name: PermissionTool,
    input: any,
    validate: () => void,
    intent?: TaskIntent,
  ): Promise<ToolDecision> {
    const policy = this.effectivePolicy(name, input, session.projectId);
    const task = intent ? this.store.tasks.get(session.projectId, intent.taskId) : undefined;
    const directionRequired = name === "save_image" && !!task && !this.store.tasks.directionCurrent(session.projectId, task);
    if (policy === "allow" && !directionRequired) return { accept: true, reason: "" };
    if (policy === "deny")
      return {
        accept: false,
        reason: "权限设置禁止此操作，请勿使用其他工具绕过",
      };
    const candidate = await this.store.reading(session.projectId, () => prepareAnimationApproval(this.store, session.projectId, session.id, name, input));
    validate();
    candidate.validate();
    if (name === "save_clip_draft" && !candidate.animations.length)
      return { accept: true, reason: "" }; // Completed save/delivery retry, not a new visual decision.
    const id = randomUUID();
    this.toolWaits ??= new Map();
    session.toolApproval = {
      id,
      tool: name,
      label: permissionTools.find((t) => t.name === name)!.label,
      arguments: structuredClone(input),
      createdAt: new Date().toISOString(),
      ...(candidate.animations.length ? { animations: candidate.animations } : {}),
      taskId: task?.id, taskRevision: task?.revision, intentVersion: task?.intentVersion, barrierVersion: task?.barrierVersion, directionRequired,
    };
    const result = new Promise<ToolDecision>(
      (finish) => {
        const timer = setTimeout(
          () => {
            void this.stop(session.id, "等待审批超时，任务已停止，操作未执行");
          },
          23 * 60 * 60_000,
        );
        this.toolWaits.set(id, { finish, timer, frozenArguments: structuredClone(input), argumentsHash: sha256(JSON.stringify(input)), intent, taskRevision: task?.revision, directionRequired, validate: () => {
          validate();
          candidate.validate();
          if (session.toolApproval?.id !== id || sha256(JSON.stringify(session.toolApproval.arguments)) !== sha256(JSON.stringify(input))) throw new StudioError("冻结审批参数已改变", 409);
        } });
      },
    );
    this.diagnose(
      session,
      "approval",
      `等待审批：${session.toolApproval!.label}`,
    );
    return { ...await result, validate: candidate.validate, animations: candidate.animations };
  }
  async tool(sessionId: string, name: string, input: any) {
    const session = this.store.session(sessionId);
    if (this.stopped) throw new StudioError("服务正在停止，操作未执行", 409);
    if (name === "workflow_task" && !this.store.tasksEnabled) throw new StudioError("自建制作任务已停用，请直接使用项目资源工具", 409);
    if (!permissionTools.some((t) => t.name === name))
      throw new StudioError("未知项目工具");
    this.toolTails ??= new Map();
    this.toolEpochs ??= new Map();
    const args = structuredClone(input);
    if (this.transitioning?.has(sessionId)) throw new StudioError("任务正在阶段切换或中断，操作未执行", 409);
    const intent = captureTaskIntent(this.store, session);
    precheckTaskTool(this.store, session, intent, name, args);
    const epoch = this.toolEpochs.get(sessionId) || 0;
    let approvedCandidate: (() => void) | undefined;
    let userApproval: UserApprovalFeedback | undefined;
    const guard = () => {
      if ((this.toolEpochs.get(sessionId) || 0) !== epoch || this.stopped || this.transitioning?.has(sessionId)) throw new StudioError("任务已取消，排队操作未执行", 409);
      precheckTaskTool(this.store, session, intent, name, args);
      if (this.effectivePolicy(name as PermissionTool, args, session.projectId) === "deny") throw new StudioError("权限已禁止此操作，结果未发布", 409);
      approvedCandidate?.();
    };
    const previous = this.toolTails.get(sessionId);
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.toolTails.set(sessionId, tail);
    await previous;
    try {
      if ((this.toolEpochs.get(sessionId) || 0) !== epoch)
        throw new StudioError("任务已取消，排队操作未执行", 409);
      precheckTaskTool(this.store, session, intent, name, args);
      // Frame saves keep their existing image comparison and exact-revision approval.
      if (name !== "save_frame_draft") {
        const decision = await this.approveTool(
          session,
          name as PermissionTool,
          args,
          guard,
          intent,
        );
        if (decision.result !== undefined) return decision.userApproval
          ? { ...decision.result, content: [...decision.result.content, textContent(JSON.stringify({ userApproval: decision.userApproval }))] }
          : decision.result;
        if (!decision.accept)
          return {
            ...(!decision.userApproval || !decision.animations?.length ? { isError: true } : {}),
            content: [textContent(JSON.stringify({ executed: false, reason: decision.reason, userApproval: decision.userApproval, animations: decision.animations }))],
          };
        approvedCandidate = decision.validate;
        userApproval = decision.userApproval;
      }
      guard();
      const result = await this.store.guarded(guard, () => this.executeTool(sessionId, name, args, guard, intent));
      return userApproval ? { ...result, content: [...result.content, textContent(JSON.stringify({ userApproval }))] } : result;
    } catch (error) {
      this.diagnose(
        session,
        "tool",
        `${name} 未执行或失败：${error instanceof Error ? error.message : String(error)}`,
      );
      if (userApproval) return { isError: true, content: [textContent(JSON.stringify({ executed: false, reason: error instanceof Error ? error.message : String(error), userApproval }))] };
      throw error;
    } finally {
      release();
      if (this.toolTails.get(sessionId) === tail)
        this.toolTails.delete(sessionId);
    }
  }
  private async executeTool(sessionId: string, name: string, input: any, guard: () => void = () => {}, intent?: TaskIntent) {
    const session = this.store.session(sessionId);
    const pid = session.projectId;
    const attach = (kind: "reviewIds" | "changeIds" | "clipDraftIds", id: string) => {
      let msg = session.messages.filter(message => message.role === "assistant").at(-1);
      if (!msg) { msg = this.assistant(session, `tool-result-${id}`); msg.status = "completed"; }
      msg[kind] ??= [];
      if (!msg[kind]!.includes(id)) msg[kind]!.push(id);
      this.flush(session);
    };
    if (name === "read_markdown") {
      const spec = z.object({ assetId: z.string().uuid() }).strict().parse(input);
      return { content: [textContent(JSON.stringify(this.store.markdown.read(pid, spec.assetId)))] };
    }
    if (name === "create_markdown") return { content: [textContent(JSON.stringify(this.store.markdown.create(pid, input)))] };
    if (name === "write_markdown") {
      const { assetId, ...spec } = z.object({ assetId: z.string().uuid(), expectedRevision: z.string(), text: z.string() }).strict().parse(input);
      return { content: [textContent(JSON.stringify(this.store.markdown.write(pid, assetId, spec)))] };
    }
    if (name === "create_clip_draft") {
      const { expectedFromDocumentRevision, ...spec } = z.object({ clipId: z.string().uuid(), revision: z.string(), frameId: z.string().uuid().optional(), fromDraftId: z.string().uuid().optional(), expectedFromDocumentRevision: z.string().optional() }).strict().parse(input);
      checkFromDraftRevision(this.store, pid, spec.fromDraftId, expectedFromDocumentRevision);
      const source = session.editingContext?.mode === "draft" ? session.editingContext : intent ? this.store.tasks.get(pid, intent.taskId).target : undefined;
      if (source?.mode === "draft" && source.clipId === spec.clipId && (source.draftId !== spec.fromDraftId || source.documentRevision !== expectedFromDocumentRevision)) throw new StudioError("需要从上下文确切正文显式派生完整草稿", 409);
      guard();
      const document = this.store.clipDrafts.create(pid, spec, "agent", session.id, intent ? { taskId: intent.taskId, intentVersion: intent.intentVersion } : undefined);
      if (intent) this.store.tasks.registerDraft(pid, intent.taskId, { sessionId, ...intent, draftId: document.documentId, kind: "clip" });
      session.agentDraftId = document.documentId; this.flush(session);
      return { content: [textContent(JSON.stringify(document))] };
    }
    if (name === "save_clip_draft") {
      const spec = z.object({ draftId: z.string().uuid(), documentRevision: z.string() }).strict().parse(input);
      const draft = this.store.clipDrafts.read(pid, spec.draftId).draft;
      if (draft.sessionId !== session.id || draft.source !== "agent") throw new StudioError("草稿不属于当前Agent会话", 409);
      if (intent) this.store.tasks.registerDraft(pid, intent.taskId, { sessionId, ...intent, draftId: spec.draftId, kind: "clip" });
      try {
        if (draft.deliveryTarget) {
          const delivery = await this.store.clipDrafts.deliver(pid, spec.draftId, spec.documentRevision, guard);
          attach("clipDraftIds", spec.draftId);
          return { content: [textContent(JSON.stringify({ saved: false, delivered: true, pendingHumanAdoption: true, delivery }))] };
        }
        const saved = await this.store.clipDrafts.save(pid, spec.draftId, spec.documentRevision, guard);
        return { content: [textContent(JSON.stringify({ saved: true, ...saved }))] };
      } catch (error) {
        // Failed publication is still a real attempted repair. Renderer-backed
        // draft checks cannot satisfy delivery, but do bound repeated no-progress.
        if (intent && this.store.clipDrafts.read(pid, spec.draftId).draft.status === "editing") {
          try { await this.store.quality.checkDraft(pid, intent.taskId, spec.draftId, spec.documentRevision, guard); } catch {}
        }
        throw error;
      }
    }
    if (name === "workflow_task") {
      const spec = z.object({ action: z.enum(["status", "check", "ready"]) }).strict().parse(input);
      if (!intent) throw new StudioError("当前会话没有制作任务");
      if (spec.action === "status") return { content: [textContent(JSON.stringify(this.store.tasks.get(pid, intent.taskId)))] };
      const current = this.store.tasks.get(pid, intent.taskId);
      if (current.phase !== "production" || current.status !== "running" || !this.store.tasks.directionCurrent(pid, current)) throw new StudioError("请先通过任务方向并恢复制作", 409);
      const checked = await this.store.quality.checkTask(pid, intent.taskId, guard);
      if (spec.action === "ready") {
        guard(); checked.task = this.store.tasks.action(pid, intent.taskId, { expectedRevision: checked.task.revision, action: "ready", snapshotId: checked.snapshot.id });
      }
      return { content: [textContent(JSON.stringify({ ...checked, pendingHumanDynamicReview: true }))] };
    }
    if (name === "get_schema")
      return {
        content: [
          textContent(
            JSON.stringify(
              input.type === "clip-edit"
                ? z.toJSONSchema(clipEditSchema)
                : input.type === "frame-edit"
                ? z.toJSONSchema(frameEditSchema)
                : input.type === "clip"
                  ? z.toJSONSchema(clipDocumentSchema)
                  : this.store.sheets.schema(),
            ),
          ),
        ],
      };
    if (name === "read_document")
      return {
        content: [
          textContent(
            JSON.stringify(
              this.store.documents.read(
                pid,
                z.string().uuid().parse(input.documentId),
              ),
            ),
          ),
        ],
      };
    if (name === "validate_document")
      return {
        content: [
          textContent(
            JSON.stringify(
              this.store.documents.parse(
                pid,
                z.string().uuid().parse(input.documentId),
                z.string().parse(input.text),
              ),
            ),
          ),
        ],
      };
    if (name === "write_documents") {
      const documents = documentWritesSchema.parse(input.documents);
      for (const doc of documents) {
        if (this.store.clipDrafts.has(pid, doc.documentId)) {
          const draft = this.store.clipDrafts.read(pid, doc.documentId).draft;
          if (draft.source !== "agent" || draft.sessionId !== sessionId) throw new StudioError("请显式派生当前会话的对象草稿，不能修改人工正文", 409);
          if (intent) this.store.tasks.registerDraft(pid, intent.taskId, { sessionId, ...intent, draftId: doc.documentId, kind: "clip" });
        } else if (this.store.frameDrafts.has(doc.documentId)) {
          const draft = this.store.frameDrafts.get(pid, doc.documentId);
          if (draft.sessionId !== sessionId)
            throw new StudioError("请使用当前对话创建的单帧草稿");
          if (intent) this.store.tasks.registerDraft(pid, intent.taskId, { sessionId, ...intent, draftId: doc.documentId, kind: "frame" });
        } else {
          const asset = this.store.asset(pid, doc.documentId);
          if (asset.type === "clip") {
            const config = this.store.documents.parse(
              pid,
              asset.id,
              doc.text,
            ) as z.infer<typeof clipDocumentSchema>;
            checkDirectClipTransforms(asset, config);
          }
        }
      }
      return {
        content: [
          textContent(
            JSON.stringify(this.store.documents.write(pid, documents)),
          ),
        ],
      };
    }
    if (name === "list_generated_images") {
      await Promise.allSettled(this.imports.get(session.id) || []);
      return {
        content: [
          textContent(
            JSON.stringify(this.store.generated.list(pid, session.id)),
          ),
        ],
      };
    }
    if (name === "save_image") {
      await Promise.allSettled(this.imports.get(session.id) || []);
      const spec = z
        .object({
          generatedId: z.string().uuid(),
          type: z.enum(["reference", "resource"]),
          name: z.string(),
          folder: z.string().default(""),
          requestId: z.string().uuid(),
        })
        .strict()
        .parse(input);
      const asset = this.store.generated.save(pid, spec),
        generated = this.store.generated.record(pid, spec.generatedId);
      if (intent) this.store.tasks.recordSavedImage(pid, intent.taskId, { sessionId, intentVersion: intent.intentVersion, barrierVersion: intent.barrierVersion, generatedId: generated.id, assetId: asset.id });
      if (generated.interpolationId && spec.type === "resource")
        this.store.interpolations.receive(
          pid,
          generated.interpolationId,
          asset.id,
          { id: generated.generationId, inputImages: generated.inputImages },
        );
      let msg = session.messages.filter((m) => m.role === "assistant").at(-1);
      if (!msg) msg = this.assistant(session, `saved-${asset.id}`);
      if (!msg.assetIds.includes(asset.id)) msg.assetIds.push(asset.id);
      this.flush(session);
      return {
        content: [
          textContent(JSON.stringify(asset)),
          {
            type: "image",
            mimeType: asset.mime,
            data: readFileSync(this.store.imagePath(pid, asset.id)).toString(
              "base64",
            ),
          },
        ],
      };
    }
    if (name === "create_clip") {
      const spec = z
        .object({
          name: z.string(),
          fps: z.number().min(1).max(60).default(12),
          folder: z.string().default(""),
          requestId: z.string().uuid(),
        })
        .strict()
        .parse(input);
      return {
        content: [
          textContent(
            JSON.stringify(
              (() => {
                const clip = this.store.documents.createClip(pid, spec, intent ? { sessionId, ...intent } : undefined);
                if (intent) {
                  guard();
                  const task = this.store.tasks.get(pid, intent.taskId);
                  this.store.tasks.bindProducedClip(pid, intent.taskId, { expectedRevision: task.revision, sessionId, requestId: spec.requestId, clipId: clip.id, intentVersion: intent.intentVersion, barrierVersion: intent.barrierVersion });
                }
                return { ...clip, documentId: clip.id };
              })(),
            ),
          ),
        ],
      };
    }
    const assetId = () => z.string().uuid().parse(input.assetId);
    const evidence = (review: any) => [
      {
        type: "text",
        text: JSON.stringify({
          ...review,
          files: undefined,
          hashes: undefined,
          observation:
            "Static evidence only. Frame index is zero based; onion red=previous, cyan=next. Alpha bounds use alpha > 16. Motion is not inherently a defect.",
        }),
      },
      ...(["contact", "onion"] as const).map((kind) => ({
        type: "image",
        mimeType: "image/png",
        data: readFileSync(
          this.store.animation.evidence(pid, review.id, kind),
        ).toString("base64"),
      })),
    ];
    if (name === "review_sequence") {
      const spec = z.object({ action: z.enum(["list", "create", "update", "capture", "inspect", "archive"]), sequenceId: z.string().uuid().optional(), snapshotId: z.string().uuid().optional(), definition: z.record(z.string(), z.unknown()).optional(), expectedRevision: z.string().optional(), archived: z.boolean().optional() }).strict().parse(input);
      if (spec.action === "list") return { content: [textContent(JSON.stringify(this.store.reviewSequences.list(pid)))] };
      if (spec.action === "create") return { content: [textContent(JSON.stringify(this.store.reviewSequences.create(pid, spec.definition)))] };
      if (!spec.sequenceId) throw new StudioError("需要sequenceId");
      if (spec.action === "update") return { content: [textContent(JSON.stringify(this.store.reviewSequences.update(pid, spec.sequenceId, spec.definition)))] };
      if (spec.action === "archive") return { content: [textContent(JSON.stringify(this.store.reviewSequences.archive(pid, spec.sequenceId, { expectedRevision: spec.expectedRevision, archived: spec.archived })))] };
      if (spec.action === "capture") return { content: [textContent(JSON.stringify(this.store.reviewSequences.capture(pid, spec.sequenceId)))] };
      const inspected = await this.store.reviewSequences.inspect(pid, spec.sequenceId, { snapshotId: spec.snapshotId });
      guard();
      for (const review of inspected.sequence.reviews) attach("reviewIds", review.id);
      return { content: [textContent(JSON.stringify({ ...inspected.sequence, reviews: inspected.sequence.reviews.map(r => ({ ...r, files: undefined, hashes: undefined })), observation: "全部批次静态证据；时序仍unverified，不代表实际速度播放验收" })), ...inspected.sequence.reviews.flatMap(r => evidence(r).slice(1))] };
    }
    if (name === "inspect_sheet") {
      const result = await this.store.sheetInspection.inspect(pid, inspectSheetSchema.parse(input));
      guard();
      return { content: [textContent(JSON.stringify(result)), ...result.images.map(image => ({ type: "image", mimeType: "image/png", data: readFileSync(this.store.sheetInspection.imagePath(pid, image.hash)).toString("base64") }))] };
    }
    if (name === "inspect_clip") {
      const spec = z
        .object({
          draftId: z.string().uuid().optional(),
          documentRevision: z.string().optional(),
          snapshotId: z.string().uuid().optional(),
          clipId: z.string().uuid().optional(),
          revision: z.string().optional(),
          startFrameId: z.string().uuid().optional(),
          endFrameId: z.string().uuid().optional(),
        })
        .refine(
          (input) => !!input.draftId || !!input.snapshotId || !!input.clipId,
          "请提供快照或动画身份",
        )
        .parse(input);
      const context = freezeEditingContext(this.store, pid, { ...spec, mode: spec.draftId ? "draft" : "saved" });
      spec.snapshotId = context.snapshotId;
      const review = await this.store.animation.inspect(pid, spec);
      guard();
      let taskQuality;
      if (intent && spec.draftId && this.store.tasks.get(pid, intent.taskId).phase === "production") {
        const document = this.store.documents.read(pid, spec.draftId);
        if (document.draft.source === "agent" && document.draft.sessionId === session.id && !document.draft.readOnly) {
          this.store.tasks.registerDraft(pid, intent.taskId, { sessionId, ...intent, draftId: spec.draftId, kind: this.store.clipDrafts.has(pid, spec.draftId) ? "clip" : "frame" });
          taskQuality = await this.store.quality.checkDraft(pid, intent.taskId, spec.draftId, spec.documentRevision!, guard);
        }
      }
      attach("reviewIds", review.id);
      return { content: evidence({ ...review, ...(taskQuality ? { taskQuality } : {}) }) };
    }
    if (name === "create_frame_draft") {
      const document = this.store.frameDrafts.create(pid, input, "agent", sessionId, intent ? { taskId: intent.taskId, intentVersion: intent.intentVersion } : undefined);
      if (intent) this.store.tasks.registerDraft(pid, intent.taskId, { sessionId, ...intent, draftId: document.documentId, kind: "frame" });
      session.agentDraftId = document.documentId; this.flush(session);
      return { content: [textContent(JSON.stringify(document))] };
    }
    if (name === "save_frame_draft") {
      const spec = z
        .object({ draftId: z.string().uuid(), documentRevision: z.string() })
        .strict()
        .parse(input);
      if (intent) this.store.tasks.registerDraft(pid, intent.taskId, { sessionId, ...intent, draftId: spec.draftId, kind: "frame" });
      const result = await this.requestFrameSave(
        session,
        spec.draftId,
        spec.documentRevision,
        guard,
      );
      if (result.saved && result.change) attach("changeIds", result.change.id);
      return { content: [textContent(JSON.stringify(result))] };
    }

    if (name === "list_assets")
      return {
        content: [
          textContent(
            JSON.stringify(
              this.store.assets(pid).map((asset) =>
                asset.type === "image"
                  ? {
                      id: asset.id,
                      name: asset.name,
                      folder: asset.folder || "",
                      kind: asset.kind,
                      width: asset.width,
                      height: asset.height,
                      revision: asset.revision,
                      documentId:
                        !asset.producer && asset.frameCount === 1
                          ? asset.id
                          : undefined,
                      producer: asset.producer,
                    }
                  : asset.type === "markdown" ? { ...asset } : { ...asset, documentId: asset.id },
              ),
            ),
          ),
        ],
      };
    if (name === "view_image") {
      const asset = this.store.image(pid, assetId());
      return {
        content: [
          {
            type: "image",
            mimeType: asset.mime,
            data: readFileSync(this.store.imagePath(pid, asset.id)).toString(
              "base64",
            ),
          },
        ],
      };
    }
    if (name === "slice_sheet") {
      const result = await this.store.sheets.execute(
        pid,
        assetId(),
        z.string().parse(input.expectedDefinitionRevision),
        z.string().uuid().parse(input.requestId),
      );
      return { content: [textContent(JSON.stringify(result))] };
    }
    if (name === "adjust_image") {
      const asset = this.store.image(pid, assetId());
      const result = await this.store.transform(
        pid,
        asset.id,
        asset.revision,
        transformSchema.parse(input),
      );
      return {
        content: [
          textContent(
            JSON.stringify({
              id: result.id,
              name: result.name,
              kind: result.kind,
            }),
          ),
          {
            type: "image",
            mimeType: result.mime,
            data: readFileSync(this.store.imagePath(pid, result.id)).toString(
              "base64",
            ),
          },
        ],
      };
    }
    throw new StudioError("未知项目工具");
  }
  async deleteSession(id: string) {
    const session = this.store.session(id);
    if (["starting", "running"].includes(session.status))
      throw new StudioError("请先停止任务，再删除对话", 409);
    const client = this.clients.get(id);
    // Release the idle runtime before removing local history; project assets remain.
    this.clients.delete(id);
    await client?.close();
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    this.tokens.delete(id);
    this.store.deleteSession(id);
  }
  /**
   * Deletes a whole project. Validation runs first, then the idle runtimes of its
   * conversations are released before the store removes files and in-memory state;
   * releasing them also lets the file erase succeed instead of waiting for a restart.
   */
  async deleteProject(id: string, name: string) {
    this.store.assertProjectDeletable(id, name);
    for (const session of [...this.store.sessions.values()]) {
      if (session.projectId !== id) continue;
      this.cancelTools(session, "工程已删除，待审批操作未执行");
      this.cancelFrameSave(session, "工程已删除，修改未保存");
      if (session.prompt) this.prompts.get(session.prompt.id)?.({});
      const client = this.clients.get(session.id);
      this.clients.delete(session.id);
      await client?.close();
      const timer = this.timers.get(session.id);
      if (timer) clearTimeout(timer);
      this.timers.delete(session.id);
      this.tokens.delete(session.id);
      this.toolTails.delete(session.id);
      this.toolEpochs.delete(session.id);
      this.promptTails.delete(session.id);
      this.staleTurns.delete(session.id);
      this.clientGenerationModes.delete(session.id);
      this.transitioning.delete(session.id);
      this.imports.delete(session.id);
    }
    return this.store.deleteProject(id, name);
  }
  async close() {
    this.stopped = true;
    await Promise.allSettled(
      [...this.clients.values()].map((client) => client.close()),
    );
    for (const session of this.store.sessions.values()) {
      this.cancelTools(session, "服务已停止，待审批操作未执行");
      this.cancelFrameSave(session, "服务已停止，修改未保存");
      if (session.prompt) this.prompts.get(session.prompt.id)?.({});
    }
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const session of this.store.sessions.values())
      this.store.saveSession(session);
  }
}
