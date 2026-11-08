import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AgentHub } from "./agent.ts";
import type { ProjectStore } from "./store.ts";

/** Kept separate from the server so project lifecycle routes can be exercised with an isolated store. */
export function registerProjectRoutes(
  app: FastifyInstance,
  store: ProjectStore,
  agent: AgentHub,
) {
  const pid = (request: any) => z.string().uuid().parse(request.params.projectId);
  app.get("/api/projects", async () => [...store.projects.values()]);
  app.post("/api/projects", async (request) => {
    const input = z
      .object({ name: z.string().trim().min(1).max(100) })
      .parse(request.body);
    return store.createProject(input.name);
  });
  // Overlay configuration only: it changes what the web canvas draws, not any
  // frame, snapshot, inspection image or export.
  app.put("/api/projects/:projectId/idle", async (request) =>
    store.setIdle(pid(request), request.body),
  );
  app.delete("/api/projects/:projectId/idle", async (request) =>
    store.clearIdle(pid(request)),
  );
  // Permanent: the exact project name confirms that every asset, conversation,
  // snapshot, export and recycle-bin entry of this one project is meant to be lost.
  app.delete("/api/projects/:projectId", async (request) => {
    const input = z
      .object({ name: z.string().trim().min(1).max(100) })
      .strict()
      .parse(request.body ?? {});
    const { project, cleanupPending } = await agent.deleteProject(
      pid(request),
      input.name,
    );
    // cleanupPending means a live process still pins the directory: the project is
    // already gone from the workbench and the files are swept on the next start.
    return {
      deleted: true,
      projectId: project.id,
      name: project.name,
      cleanupPending,
    };
  });
}
