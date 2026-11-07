import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { StudioError, type ProjectStore } from "./store.ts";
import type { AgentHub } from "./agent.ts";
import { editingContextSchema, productionContractSchema } from "./workflow-model.ts";
import { agentModelSchema, clipReferenceSchema, markdownReferenceSchema } from "./model.ts";

const uuid = z.string().uuid();
export const toolApprovalBindingSchema = z.object({ sessionId: uuid, approvalId: uuid }).strict();
export const taskActionSchema = z.object({
  expectedRevision: z.number().int().positive(), action: z.enum(["pause", "resume", "stop", "handoff", "feedback", "save-location", "ready", "accept"]),
  text: z.string().trim().min(1).max(10000).optional(), snapshotId: uuid.optional(),
  feedbackKind: z.enum(["local", "direction"]).optional(), toolApproval: toolApprovalBindingSchema.optional(),
}).strict();
export const taskDirectionSchema = z.object({
  expectedRevision: z.number().int().positive(), accept: z.boolean(), feedback: z.string().trim().min(1).max(10000).optional(),
  generatedId: uuid.optional(), assetId: uuid.optional(), snapshotId: uuid.optional(), contentHash: z.string().optional(), toolApproval: toolApprovalBindingSchema.optional(),
}).strict();
export function checkFromDraftRevision(store: ProjectStore, pid: string, id?: string, revision?: string) {
  if (!id) { if (revision) throw new StudioError("来源版本需要fromDraftId"); return; }
  const document = store.clipDrafts.has(pid, id) ? store.clipDrafts.read(pid, id) : store.frameDrafts.read(pid, id);
  if (revision !== undefined && document.documentRevision !== revision) throw new StudioError("VERSION_CONFLICT：来源草稿已改变", 409);
}

/** Kept separately so real routes can be exercised with an isolated store/stub runtime. */
export function registerWorkflowRoutes(app: FastifyInstance, store: ProjectStore, agent: AgentHub) {
  const pid = (request: any) => uuid.parse(request.params.projectId);
  const id = (request: any, key: string) => uuid.parse(request.params[key]);
  app.post("/api/sessions/:sessionId/messages", async (request: any, reply) => {
    const input = z.object({ text: z.string().trim().min(1).max(12000), assetIds: z.array(uuid).max(5).default([]), requestId: uuid, clipReferences: z.array(clipReferenceSchema).max(3).default([]), markdownReferences: z.array(markdownReferenceSchema).max(3).default([]), outputFolder: z.string().optional(), model: agentModelSchema.optional(), context: editingContextSchema.optional(), taskId: uuid.optional(), feedbackKind: z.enum(["local", "direction"]).optional() }).parse(request.body);
    const session = agent.send(uuid.parse(request.params.sessionId), input.text, input.assetIds, input.requestId, undefined, input.clipReferences, input.outputFolder, input.model, input.context, input.taskId, input.feedbackKind, input.markdownReferences);
    return reply.code(202).send(session);
  });
  app.post("/api/projects/:projectId/tasks", async request => {
    const input = z.object({ requestId: uuid, title: z.string().trim().min(1).max(200), description: z.string().max(10000), target: editingContextSchema.optional(), referenceIds: z.array(uuid).optional(), contract: productionContractSchema.refine(contract => contract.generationLimit <= 1, "当前生成授权上限仍为1，不扩大额度").optional() }).strict().parse(request.body);
    const projectId = pid(request);
    let task = store.tasks.create(projectId, input);
    if (!task.sessionId) {
      const session = store.createSession(projectId);
      task = store.tasks.bindSession(projectId, task.id, session.id);
      session.taskId = task.id; store.saveSession(session);
    }
    return task;
  });
  app.post("/api/projects/:projectId/tasks/:taskId/actions", async request => agent.taskAction(pid(request), id(request, "taskId"), taskActionSchema.parse(request.body)));
  app.post("/api/projects/:projectId/tasks/:taskId/direction", async request => agent.decideTaskDirection(pid(request), id(request, "taskId"), taskDirectionSchema.parse(request.body)));
  app.get("/api/projects/:projectId/snapshots/:snapshotId", async request => store.animation.snapshot(pid(request), id(request, "snapshotId")));
  app.post("/api/projects/:projectId/clip-drafts", async request => {
    const { source, expectedFromDocumentRevision, ...input } = z.object({ clipId: uuid, revision: z.string(), frameId: uuid.optional(), fromDraftId: uuid.optional(), expectedFromDocumentRevision: z.string().optional(), source: z.literal("human").default("human") }).strict().parse(request.body);
    checkFromDraftRevision(store, pid(request), input.fromDraftId, expectedFromDocumentRevision);
    return store.clipDrafts.create(pid(request), input, source);
  });
  app.get("/api/projects/:projectId/clip-drafts/:draftId", async request => store.clipDrafts.read(pid(request), id(request, "draftId")));
  app.put("/api/projects/:projectId/clip-drafts/:draftId", async request => store.clipDrafts.write(pid(request), id(request, "draftId"), z.object({ expectedDocumentRevision: z.string(), text: z.string() }).strict().parse(request.body)));
  for (const action of ["preview", "save", "discard"] as const) app.post(`/api/projects/:projectId/clip-drafts/:draftId/${action}`, async request => {
    const { documentRevision } = z.object({ documentRevision: z.string() }).strict().parse(request.body);
    return store.clipDrafts[action](pid(request), id(request, "draftId"), documentRevision);
  });
  app.post("/api/projects/:projectId/clip-drafts/:draftId/adopt", async request => store.clipDrafts.adopt(pid(request), id(request, "draftId"), z.object({ expectedDocumentRevision: z.string(), resultDraftId: uuid, expectedResultDocumentRevision: z.string() }).strict().parse(request.body)));
  app.get("/api/projects/:projectId/review-sequences", async request => store.reviewSequences.list(pid(request)));
  app.post("/api/projects/:projectId/review-sequences", async request => store.reviewSequences.create(pid(request), request.body));
  app.put("/api/projects/:projectId/review-sequences/:sequenceId", async request => store.reviewSequences.update(pid(request), id(request, "sequenceId"), request.body));
  app.post("/api/projects/:projectId/review-sequences/:sequenceId/archive", async request => store.reviewSequences.archive(pid(request), id(request, "sequenceId"), request.body));
  app.post("/api/projects/:projectId/review-sequences/:sequenceId/capture", async request => { z.object({}).strict().parse(request.body || {}); return store.reviewSequences.capture(pid(request), id(request, "sequenceId")); });
  app.get("/api/projects/:projectId/review-sequences/:sequenceId/snapshots", async request => store.reviewSequences.listSnapshots(pid(request), id(request, "sequenceId")));
  app.post("/api/projects/:projectId/review-sequences/:sequenceId/inspect", async request => store.reviewSequences.inspect(pid(request), id(request, "sequenceId"), z.object({ snapshotId: uuid.optional() }).strict().parse(request.body || {})));
}
