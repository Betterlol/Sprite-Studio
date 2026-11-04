import { randomUUID, randomBytes } from "node:crypto";
import {
  readFileSync,
  copyFileSync,
  mkdirSync,
  existsSync,
  statSync,
} from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { AppServer, type Message } from "./runtime/app-server.ts";
import { ProjectStore, StudioError } from "./store.ts";
import { interpolationPrompt } from "./interpolation.ts";
import { interpolationSchema } from "./model.ts";
import {
  transformSchema,
  sliceSchema,
  type Session,
  type ChatMessage,
} from "./model.ts";

const textContent = (text: string) => ({ type: "text", text });
export class AgentHub {
  store: ProjectStore;
  endpoint: string;
  clients = new Map<string, AppServer>();
  tokens = new Map<string, string>();
  timers = new Map<string, NodeJS.Timeout>();
  imports = new Map<string, Promise<unknown>[]>();
  prompts = new Map<string, (value: any) => void>();
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
        'mcp_servers.sprite_studio.env_vars=["SPRITE_STUDIO_TOOL_TOKEN"]',
        'mcp_servers.sprite_studio.tools.slice_sheet.approval_mode="approve"',
        'mcp_servers.sprite_studio.tools.adjust_image.approval_mode="approve"',
        'mcp_servers.sprite_studio.tools.adjust_frame.approval_mode="approve"',
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
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        developerInstructions:
          "你是 Sprite Studio 中的精灵图制作助手，使用中文交流。只操作当前项目提供的资源工具。先用 list_assets 查找稳定资源 ID，再用 view_image 查看真实图片。位置、尺寸调整使用 adjust_image，规则网格切割使用 slice_sheet，不要通过图片生成替代确定性处理。需要生成/重绘时必须使用内置 image_gen，并实际提供用户引用的参考图，每次用户请求默认最多生成一张图片；没有明确要求生成就不要生成。输出图会自动保存到资源区，可以直接使用，原始图片保留。你可以在当前任务目录中准备临时文件，但不要探索其他文件、运行程序、安装依赖或使用其他服务。不要声称已经验收动画连贯性；目前可以看静态图、播放编排和逐帧信息，动态评估需结合用户实际观看。工具受限时如实说明，不伪造成果。用户消息中的“资源引用”给出身份、版本与快照路径，引用图片才是视觉输入。",
      };
      params.developerInstructions +=
        "动画引用含 snapshotId、clipId、版本、帧实例和时长。检查动画必须调用 inspect_clip 查看实际逐帧和相邻叠图证据；每次最多16帧，需要时分区间。单帧大小、位置、时长修正用 adjust_frame，明确要求的修改直接更新目标动画，返回的修改记录支持比较与撤回。不要改动其他帧实例，不用生成图片替代确定性修正。边界框变化只是线索，不能把有意运动自动拉平。向用户使用第几帧交流，UUID只在工具调用中使用。静态图和叠图不代表你已观看真实速度播放，不可声称动态验收通过。";
      const result = session.threadId
        ? await client.request("thread/resume", {
            ...params,
            threadId: session.threadId,
            excludeTurns: true,
          })
        : await client.request("thread/start", params);
      session.threadId = result.thread.id;
      session.model = result.model;
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
    const spec = interpolationSchema.parse(input);
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
  ) {
    const session = this.store.session(sessionId);
    if (session.messages.some((message) => message.id === requestId))
      return session;
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
    for (const asset of references) {
      const source = this.store.imagePath(
        session.projectId,
        asset.id,
        asset.revision,
      );
      const snapshot = join(
        this.store.dir(session.projectId),
        ".studio",
        "staging",
        `agent-${session.id}`,
        `${asset.id}-${asset.contentHash}${extname(asset.file)}`,
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
    session.status = "running";
    this.flush(session);
    const result = await client.request("turn/start", {
      threadId: session.threadId,
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
        view_image: "查看图片",
        slice_sheet: "切割图集",
        adjust_image: "调整图片",
        inspect_clip: "检查动画证据",
        adjust_frame: "修改动画帧",
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
            : "本次任务没有返回可用图集，请查看对话；没有自动重试。");
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
      const job = this.interpolation(session);
      if (job?.sheetId) return;
      if (!item.savedPath || !existsSync(item.savedPath))
        throw new Error("生成已完成，但没有取得本地图片");
      if (statSync(item.savedPath).size > 25 * 1024 * 1024)
        throw new Error("生成结果超出当前单图上限");
      const asset = await this.store.importImage(
        session.projectId,
        `生成图片-${session.title.slice(0, 24)}.png`,
        readFileSync(item.savedPath),
        "image",
        { kind: "generation", runId: session.turnId, interpolationId: job?.id },
        job
          ? this.store.asset(session.projectId, job.clipId).folder || ""
          : session.outputFolder || "",
      );
      if (job)
        this.store.interpolations.receive(
          session.projectId,
          job.id,
          asset.id,
          item,
        );
      let msg = session.messages
        .filter((message) => message.role === "assistant")
        .at(-1);
      if (!msg) msg = this.assistant(session, `image-${item.id}`);
      if (!msg.assetIds.includes(asset.id)) msg.assetIds.push(asset.id);
      this.flush(session);
    } catch (error) {
      session.error = `导入生成结果失败：${String(error)}`;
      this.flush(session);
    }
  }
  private requestInput(session: Session, request: Message): Promise<any> {
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
  async stop(sessionId: string) {
    const session = this.store.session(sessionId);
    const client = this.clients.get(sessionId);
    if (session.prompt) this.prompts.get(session.prompt.id)?.({});
    if (client && session.turnId && session.status === "running")
      await client.request("turn/interrupt", {
        threadId: session.threadId,
        turnId: session.turnId,
      });
    else {
      session.status = "interrupted";
      this.flush(session);
      const job = this.interpolation(session);
      if (job && !job.sheetId) {
        job.status = "interrupted";
        job.error = "补帧已停止，没有自动重试。";
        this.store.interpolations.save(job);
      }
    }
  }
  private fail(session: Session, error: unknown) {
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
  async tool(sessionId: string, name: string, input: any) {
    const session = this.store.session(sessionId);
    const pid = session.projectId;
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
          snapshotId: z.string().uuid().optional(),
          clipId: z.string().uuid().optional(),
          revision: z.string().optional(),
          startFrameId: z.string().uuid().optional(),
          endFrameId: z.string().uuid().optional(),
        })
        .refine(
          (input) => !!input.snapshotId || !!input.clipId,
          "请提供快照或动画身份",
        )
        .parse(input);
      const review = await this.store.animation.inspect(pid, spec);
      attach("reviewIds", review.id);
      return { content: evidence(review) };
    }
    if (name === "adjust_frame") {
      const change = await this.store.animation.adjust(
        pid,
        { ...input, requestId: input.requestId || randomUUID() },
        "agent",
      );
      attach("changeIds", change.id);
      const snapshots = this.store.animation.compare(pid, change.id),
        before = await this.store.animation.inspect(pid, {
          snapshotId: snapshots.before.id,
          startFrameId: change.frameId,
          endFrameId: change.frameId,
        }),
        after = await this.store.animation.inspect(pid, {
          snapshotId: snapshots.after.id,
          startFrameId: change.frameId,
          endFrameId: change.frameId,
        });
      return {
        content: [
          textContent(
            JSON.stringify({
              change,
              applied: true,
              clipRevision: snapshots.after.clip.revision,
            }),
          ),
          textContent("Before modification"),
          ...evidence(before).slice(0, 2),
          textContent("After modification"),
          ...evidence(after).slice(0, 2),
        ],
      };
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
                    }
                  : asset,
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
      const asset = this.store.image(pid, assetId());
      const result = await this.store.slice(
        pid,
        asset.id,
        asset.revision,
        sliceSchema.parse(input),
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
  async close() {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const session of this.store.sessions.values())
      this.store.saveSession(session);
    await Promise.all(
      [...this.clients.values()].map((client) => client.close()),
    );
  }
}
