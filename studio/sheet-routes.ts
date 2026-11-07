import type { FastifyInstance } from "fastify";
import { createReadStream } from "node:fs";
import { z } from "zod";
import type { ProjectStore } from "./store.ts";
import { inspectSheetSchema } from "./sheet-schema.ts";
/** Shared with Agent; registering routes has no runtime/model or listener side effects. */
export function registerSheetRoutes(app: FastifyInstance, store: ProjectStore) {
  const pid = (request: any) => z.string().uuid().parse(request.params.projectId);
  app.post("/api/projects/:projectId/sheet-inspections", async request =>
    store.sheetInspection.inspect(pid(request), inspectSheetSchema.parse(request.body)),
  );
  app.get("/api/projects/:projectId/sheet-inspections/:imageHash/image", async (request: any, reply) => {
    const path = store.sheetInspection.imagePath(pid(request), request.params.imageHash);
    return reply.type("image/png").header("Cache-Control", "private, max-age=31536000, immutable").send(createReadStream(path));
  });
}
