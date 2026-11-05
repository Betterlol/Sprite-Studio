import { permissionTools, type PermissionTool } from "./tool-permissions.ts";
import { randomUUID, randomBytes } from "node:crypto";
import { readFileSync, copyFileSync, mkdirSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { AppServer, type Message } from "./runtime/app-server.ts";
import { ProjectStore, StudioError, sha256 } from "./store.ts";
import { clipDocumentSchema } from "./documents.ts";
import { interpolationPrompt } from "./interpolation.ts";
import {
  interpolationSchema,
  agentModelSchema,
  defaultAgentModel,
  frameEditSchema,
  type FrameSaveApproval,
} from "./model.ts";
import { transformSchema, type Session, type ChatMessage } from "./model.ts";

const textContent = (text: string) => ({ type: "text", text });
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
    { sessionId: string; finish: (value: any) => void; timer: NodeJS.Timeout }
  >();
  toolWaits = new Map<
    string,
    {
      finish: (decision: { accept: boolean; reason: string }) => void;
      timer: NodeJS.Timeout;
    }
  >();
  toolTails = new Map<string, Promise<void>>();
  toolEpochs = new Map<string, number>();
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
  private async client(session: Session) {
    if (this.clients.has(session.id)) return this.clients.get(session.id)!;
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
    const client = new AppServer(
      workspace,
      [
        "features.shell_tool=false",
        "features.unified_exec=false",
        "features.view_image=false",
        "features.image_generation=true",
        `mcp_servers.sprite_studio.command=${JSON.stringify(process.execPath)}`,
        `mcp_servers.sprite_studio.args=${JSON.stringify([fileURLToPath(new URL("./mcp.ts", import.meta.url)), this.endpoint, session.id])}`,
        "mcp_servers.sprite_studio.enabled=true",
        "mcp_servers.sprite_studio.required=true",
        "mcp_servers.sprite_studio.tool_timeout_sec=86400",
        'mcp_servers.sprite_studio.env_vars=["SPRITE_STUDIO_TOOL_TOKEN"]',
        'mcp_servers.sprite_studio.tools.slice_sheet.approval_mode="approve"',
        'mcp_servers.sprite_studio.tools.write_documents.approval_mode="approve"',
        'mcp_servers.sprite_studio.tools.save_image.approval_mode="approve"',
        'mcp_servers.sprite_studio.tools.create_clip.approval_mode="approve"',
        'mcp_servers.sprite_studio.tools.adjust_image.approval_mode="approve"',
        'mcp_servers.sprite_studio.tools.create_frame_draft.approval_mode="approve"',
        'mcp_servers.sprite_studio.tools.save_frame_draft.approval_mode="approve"',
      ],
      this.disabled,
      undefined,
      { SPRITE_STUDIO_TOOL_TOKEN: token },
    );
    this.clients.set(session.id, client);
    client.on("notification", (message) => {
      void this.notification(session, message).catch((error) =>
        this.fail(session, error),
      );
    });
    client.on("stopped", (error) => {
      this.clients.delete(session.id);
      if (!this.stopped && ["starting", "running"].includes(session.status))
        this.fail(session, error);
    });
    client.serverRequest = (request) => this.requestInput(session, request);
    try {
      await client.initialize();
      const params = {
        cwd: workspace,
        model: session.model || defaultAgentModel,
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        developerInstructions:
          "你是 Sprite Studio 中的精灵图制作助手，使用中文交流。只操作当前项目提供的资源工具。先用 list_assets 查找稳定资源 ID，再用 view_image 查看真实图片。位置、尺寸调整使用 adjust_image，规则网格切割使用 slice_sheet，不要通过图片生成替代确定性处理。需要生成/重绘时必须使用内置 image_gen，并实际提供用户引用的参考图，每次用户请求默认最多生成一张图片；没有明确要求生成就不要生成。生成完成后先用list_generated_images取得生成产物ID，然后用save_image明确指定type(reference/resource)、name和分类内folder保存；folder为空或点号表示分类根目录。不得声称未保存的产物已进入资源区。没有指定名称目录时依据任务合理命名并告知用户；同名冲突不能覆盖。你可以在当前任务目录中准备临时文件，但不要探索其他文件、运行程序、安装依赖或使用其他服务。不要声称已经验收动画连贯性；目前可以看静态图、播放编排和逐帧信息，动态评估需结合用户实际观看。工具受限时如实说明，不伪造成果。用户消息中的“资源引用”给出身份、版本与快照路径，引用图片才是视觉输入。",
      };
      params.developerInstructions +=
        "切割配置已改为持久JSON配方：先read_document读取原图的documentId与全文，必要时get_schema查看格式，再用write_documents提交正文和expectedDocumentRevision。新配方items为空，需要明确添加待切单元；新增条目可省略ID，保存会返回ID，后续保留已有ID。slice_sheet只接收assetId、expectedDefinitionRevision和requestId，读取已保存配置执行。重复切割更新原切片而不创建动画，禁止以旧columns/rows工具参数执行。当前仅支持规则网格，动画可用create_clip创建空动画，read_document/write_documents编辑clip JSON中的frames(imageId、id、durationUs)、loop、initialFps；帧id新增可省略，重排保留id。单帧变换已有frame-edit草稿配置，按下述流程执行。";
      params.developerInstructions +=
        "所有项目工具的权限由网页设置控制。需要审批时工具调用保持等待，必须等用户决定后再继续；不要把等待请求当作成功，不要尝试并行工具或换工具绕过。拒绝结果附带用户理由，按理由调整后再请求。默认只有save_image需要审批，其他项目工具为full access，用户可逐项更改。";
      params.developerInstructions +=
        "动画引用含snapshotId、clipId、版本、帧实例和时长。检查用inspect_clip看实际帧图与相邻叠图，每次最多16帧。动画帧缩放、位移、裁切与时长修复：create_frame_draft取得同一动画草稿documentId，frameId仅指定起始焦点；同一动画后续帧复用这份草稿。read_document读取配置，通过write_documents修改frame-edit v2 JSON的frames数组，每项含frameId、transform、durationUs，transform为相对源图的绝对参数；保留其他条目，不把上次修改丢掉，再用inspect_clip传draftId、documentRevision检查草稿。预览不会修改动画或新增图片资源。可以连续修改多帧，一起预览播放编排，inspect_clip返回越界warnings；有blocking警告先修正，不能把画布内截断图当作未越界。检查后调用save_frame_draft一次保存所有修改；按网页权限设置等待用户Accept/Deny或直接执行，拒绝理由会返回，不能把待审批或拒绝说成已保存。用户要求先看看时停在草稿预览。不要通过直接编辑clip配置或adjust_image绕过单帧修复的草稿与保存流程。其他帧实例不变。边界框变化只是线索，不自动拉平有意运动。向用户用第几帧交流，UUID用于工具。静态图和叠图不代表已观看实际速度播放，不可声称动态验收通过。";
      const result = session.threadId
        ? await client.request("thread/resume", {
            ...params,
            threadId: session.threadId,
            excludeTurns: true,
          })
        : await client.request("thread/start", params);
      session.threadId = result.thread.id;
      session.model = session.model || result.model || defaultAgentModel;
      const inventory = await client.request("mcpServerStatus/list", {
        threadId: session.threadId,
        detail: "toolsAndAuthOnly",
        limit: 100,
      });
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
      this.clients.delete(session.id);
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
    const references = assetIds.map((id) =>
      this.store.image(session.projectId, id),
    );
    const clipReferences = clipInputs.map((input) =>
      this.store.animation.reference(session.projectId, input),
    );
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
      clipReferences,
      createdAt: new Date().toISOString(),
    });
    this.flush(session);
    void this.startTurn(session, text, references).catch((error) =>
      this.fail(session, error),
    );
    return session;
  }
  private async startTurn(
    session: Session,
    text: string,
    references: ReturnType<ProjectStore["image"]>[],
  ) {
    const client = await this.client(session);
    if (session.status !== "starting") return;
    const inputs: any[] = [{ type: "text", text, text_elements: [] }];
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
        text: `动画引用（固定快照，须用 inspect_clip 取得真实图像证据）：${JSON.stringify({ ...ref, loop: snapshot.clip.loop, totalFrames: snapshot.clip.frames.length, frames: snapshot.clip.frames.slice(range.start, range.end + 1).map((frame, index) => ({ ...frame, frameNumber: range.start + index + 1 })) })}`,
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
    if (interpolation) this.store.interpolations.save(interpolation);
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
        slice_sheet: "切割图集",
        adjust_image: "调整图片",
        inspect_clip: "检查动画证据",
      };
      const status =
        message.method === "item/started"
          ? "running"
          : item.error || item.failure || item.status === "failed"
            ? "failed"
            : "completed";
      const activity = {
        id: item.id,
        label:
          item.type === "imageGeneration"
            ? "生成图片"
            : names[item.tool] || item.tool,
        status,
        detail: item.error?.message || item.failure?.message,
      } as const;
      const index = session.activities.findIndex(
        (activity) => activity.id === item.id,
      );
      if (index < 0) session.activities.push(activity);
      else session.activities[index] = activity;
      this.flush(session);
      if (
        message.method === "item/completed" &&
        item.type === "imageGeneration" &&
        item.status === "completed"
      ) {
        const pending = this.importGenerated(session, item);
        const list = this.imports.get(session.id) || [];
        list.push(pending);
        this.imports.set(session.id, list);
      }
    }
    if (message.method === "turn/completed") {
      this.cancelTools(session, "任务已结束，待审批操作未执行");
      this.cancelFrameSave(session, "任务已结束，待审批修改未保存");
      await Promise.allSettled(this.imports.get(session.id) || []);
      this.imports.delete(session.id);
      session.status =
        params.turn.status === "interrupted"
          ? "interrupted"
          : params.turn.status === "failed"
            ? "failed"
            : "idle";
      if (params.turn.error?.message) session.error = params.turn.error.message;
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
      session.error = params.error?.message || params.message;
      this.schedule(session);
    }
  }
  private async importGenerated(session: Session, item: any) {
    try {
      const generated = await this.store.generated.capture(
        session.projectId,
        session.id,
        item,
        this.interpolation(session)?.id,
      );
      let msg = session.messages
        .filter((message) => message.role === "assistant")
        .at(-1);
      if (!msg) msg = this.assistant(session, `image-${item.id}`);
      msg.generatedIds ??= [];
      if (!msg.generatedIds.includes(generated.id))
        msg.generatedIds.push(generated.id);
      this.flush(session);
    } catch (error) {
      session.error = `接收生成图片失败：${String(error)}`;
      this.flush(session);
    }
  }
  private async requestInput(session: Session, request: Message): Promise<any> {
    // Serialize native user questions behind pending project tools as well.
    await this.toolTails?.get(session.id);
    if (!["starting", "running"].includes(session.status))
      return { decision: "decline" };
    const params = request.params;
    const id = randomUUID();
    if (
      request.method === "tool/requestUserInput" ||
      request.method === "mcpServer/elicitation/request"
    ) {
      const isTool = request.method === "tool/requestUserInput";
      const schema = params.requestedSchema || params.request?.requestedSchema;
      const questions = isTool
        ? params.questions.map((question: any) => ({
            id: question.id,
            question: question.question,
            options: (question.options || []).map(
              (option: any) => option.label,
            ),
          }))
        : Object.entries(schema?.properties || {}).map(
            ([key, value]: [string, any]) => ({
              id: key,
              question: value.title || params.message || key,
              options: value.enum || [],
            }),
          );
      if (!questions.length) return Promise.resolve({ action: "decline" });
      session.prompt = { id, questions };
      this.flush(session);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          this.prompts.delete(id);
          session.prompt = undefined;
          this.flush(session);
          resolve(isTool ? { answers: {} } : { action: "decline" });
        }, 15 * 60_000);
        this.prompts.set(id, (value) => {
          clearTimeout(timer);
          this.prompts.delete(id);
          session.prompt = undefined;
          this.flush(session);
          resolve(
            isTool
              ? {
                  answers: Object.fromEntries(
                    Object.entries(value).map(([key, answer]) => [
                      key,
                      { answers: [answer] },
                    ]),
                  ),
                }
              : { action: "accept", content: value },
          );
        });
      });
    }
    return Promise.resolve({ decision: "decline" });
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
      });
    });
    this.flush(session);
    return promise;
  }
  cancelFrameSave(session: Session, reason: string) {
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
    this.flush(session);
    pending.finish({ saved: false, reason });
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
        reason || "用户拒绝此次保存，请保留草稿并继续调整",
      );
      return { saved: false };
    }
    const pending = this.frameSaves.get(approvalId)!;
    this.frameSaves.delete(approvalId);
    clearTimeout(pending.timer);
    try {
      const change = await this.store.frameDrafts.save(
        session.projectId,
        approval.draftId,
        approval.documentRevision,
      );
      const result = { saved: true, change };
      pending.finish(result);
      return result;
    } catch (error) {
      const draft = this.store.frameDrafts.get(
        session.projectId,
        approval.draftId,
      );
      if (draft.status === "pending")
        this.store.frameDrafts.persist({ ...draft, status: "editing" });
      pending.finish({ saved: false, reason: String(error) });
      throw error;
    } finally {
      session.frameSaveApproval = undefined;
      this.flush(session);
    }
  }
  async stop(sessionId: string, reason = "任务已停止，待审批操作未执行") {
    const session = this.store.session(sessionId);
    const client = this.clients.get(sessionId);
    // Interrupt the model before releasing blocked tool calls, so it cannot resume
    // reasoning from a timeout/cancellation result while still running.
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
    session.status = "interrupted";
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
  }
  private fail(session: Session, error: unknown) {
    this.cancelTools(session, "任务失败，待审批操作未执行");
    this.cancelFrameSave(session, "任务失败，修改未保存");
    session.status = "failed";
    session.error = error instanceof Error ? error.message : String(error);
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
      );
  }
  resolveToolApproval(
    sessionId: string,
    approvalId: string,
    accept: boolean,
    reason = "",
  ) {
    const session = this.store.session(sessionId);
    const pending = this.toolWaits?.get(approvalId);
    if (!pending || session.toolApproval?.id !== approvalId)
      throw new StudioError("审批已结束，请刷新", 409);
    clearTimeout(pending.timer);
    this.toolWaits.delete(approvalId);
    session.toolApproval = undefined;
    this.flush(session);
    pending.finish({
      accept,
      reason:
        reason || (accept ? "用户已允许" : "用户拒绝此次操作，请调整方案"),
    });
    return { accepted: accept };
  }
  private async approveTool(
    session: Session,
    name: PermissionTool,
    input: any,
  ) {
    const policy = this.store.permissions.read()[name];
    if (policy === "allow") return { accept: true, reason: "" };
    if (policy === "deny")
      return {
        accept: false,
        reason: "权限设置禁止此操作，请勿使用其他工具绕过",
      };
    const id = randomUUID();
    this.toolWaits ??= new Map();
    session.toolApproval = {
      id,
      tool: name,
      label: permissionTools.find((t) => t.name === name)!.label,
      arguments: input,
      createdAt: new Date().toISOString(),
    };
    const result = new Promise<{ accept: boolean; reason: string }>(
      (finish) => {
        const timer = setTimeout(
          () => {
            void this.stop(session.id, "等待审批超时，任务已停止，操作未执行");
          },
          23 * 60 * 60_000,
        );
        this.toolWaits.set(id, { finish, timer });
      },
    );
    this.flush(session);
    return result;
  }
  async tool(sessionId: string, name: string, input: any) {
    const session = this.store.session(sessionId);
    if (this.stopped) throw new StudioError("服务正在停止，操作未执行", 409);
    if (!permissionTools.some((t) => t.name === name))
      throw new StudioError("未知项目工具");
    this.toolTails ??= new Map();
    this.toolEpochs ??= new Map();
    const args = structuredClone(input);
    const epoch = this.toolEpochs.get(sessionId) || 0;
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
      // Frame saves keep their existing image comparison and exact-revision approval.
      if (name !== "save_frame_draft") {
        const decision = await this.approveTool(
          session,
          name as PermissionTool,
          args,
        );
        if (!decision.accept)
          return {
            isError: true,
            content: [
              textContent(
                JSON.stringify({ executed: false, reason: decision.reason }),
              ),
            ],
          };
      }
      if ((this.toolEpochs.get(sessionId) || 0) !== epoch)
        throw new StudioError("任务已取消，操作未执行", 409);
      return await this.executeTool(sessionId, name, args);
    } finally {
      release();
      if (this.toolTails.get(sessionId) === tail)
        this.toolTails.delete(sessionId);
    }
  }
  private async executeTool(sessionId: string, name: string, input: any) {
    const session = this.store.session(sessionId);
    const pid = session.projectId;
    if (name === "get_schema")
      return {
        content: [
          textContent(
            JSON.stringify(
              input.type === "frame-edit"
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
      const documents = z
        .array(
          z.object({
            documentId: z.string().uuid(),
            expectedDocumentRevision: z.string(),
            text: z.string(),
          }),
        )
        .min(1)
        .max(16)
        .parse(input.documents);
      for (const doc of documents) {
        if (this.store.frameDrafts.has(doc.documentId)) {
          const draft = this.store.frameDrafts.get(pid, doc.documentId);
          if (draft.sessionId !== sessionId)
            throw new StudioError("请使用当前对话创建的单帧草稿");
        } else {
          const asset = this.store.asset(pid, doc.documentId);
          if (asset.type === "clip") {
            const config = this.store.documents.parse(
              pid,
              asset.id,
              doc.text,
            ) as z.infer<typeof clipDocumentSchema>;
            if (
              config.frames.some((f) => {
                const old = asset.frames.find((o) => o.id === f.id);
                return (
                  old &&
                  JSON.stringify(old.transform) !== JSON.stringify(f.transform)
                );
              })
            )
              throw new StudioError("已有帧的变换请通过单帧草稿编辑并请求保存");
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
                const clip = this.store.documents.createClip(pid, spec);
                return { ...clip, documentId: clip.id };
              })(),
            ),
          ),
        ],
      };
    }
    const assetId = () => z.string().uuid().parse(input.assetId);
    const attach = (kind: "reviewIds" | "changeIds", id: string) => {
      let msg = session.messages
        .filter((message) => message.role === "assistant")
        .at(-1);
      if (!msg) {
        msg = this.assistant(session, `tool-result-${id}`);
        msg.status = "completed";
      }
      msg[kind] ??= [];
      if (!msg[kind]!.includes(id)) msg[kind]!.push(id);
      this.flush(session);
    };
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
      if (spec.draftId) {
        if (!spec.documentRevision)
          throw new StudioError("检查草稿必须指定documentRevision");
        const result = await this.store.frameDrafts.preview(
          pid,
          spec.draftId,
          spec.documentRevision,
        );
        spec.snapshotId = result.preview.id;
      }
      const review = await this.store.animation.inspect(pid, spec);
      attach("reviewIds", review.id);
      return { content: evidence(review) };
    }
    if (name === "create_frame_draft") {
      return {
        content: [
          textContent(
            JSON.stringify(
              this.store.frameDrafts.create(pid, input, "agent", sessionId),
            ),
          ),
        ],
      };
    }
    if (name === "save_frame_draft") {
      const spec = z
        .object({ draftId: z.string().uuid(), documentRevision: z.string() })
        .strict()
        .parse(input);
      const result = await this.requestFrameSave(
        session,
        spec.draftId,
        spec.documentRevision,
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
                  : { ...asset, documentId: asset.id },
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
  async close() {
    this.stopped = true;
    await Promise.allSettled(
      [...this.clients.values()].map((client) => client.close()),
    );
    for (const session of this.store.sessions.values()) {
      this.cancelTools(session, "服务已停止，待审批操作未执行");
      this.cancelFrameSave(session, "服务已停止，修改未保存");
    }
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const session of this.store.sessions.values())
      this.store.saveSession(session);
  }
}
