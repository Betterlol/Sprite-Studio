import { z } from "zod";
import { inspectSheetSchema } from "./sheet-schema.ts";
import { request as httpRequest } from "node:http";
import { createInterface } from "node:readline";
const endpoint = process.argv[2]!;
const sessionId = process.argv[3]!;
const token = process.env.SPRITE_STUDIO_TOOL_TOKEN;
if (!token || !/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint))
  throw new Error("Invalid studio tool connection");
const idProperty = {
  type: "string",
  description: "Resource UUID returned by list_assets, not a filename",
};
const tools = [
  {
    name: "list_generated_images",
    description:
      "List this chat's generated images, including generatedId (id), dimensions and saved asset IDs. Call after image_gen, then save_image with an explicit name and category-relative folder. Produces no new generation.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "save_image",
    description:
      "Save a generated image as a project asset, choosing its exact filename and category. type=reference goes under 参考图; type=resource under 原图素材. folder is relative to that category: empty or '.' means its root. PNG extension can be omitted. Does not overwrite or silently rename conflicts. Reuse requestId only to retry the same save.",
    inputSchema: {
      type: "object",
      properties: {
        generatedId: {
          type: "string",
          description:
            "Generated image id returned by list_generated_images; not a project resource ID",
        },
        type: { type: "string", enum: ["reference", "resource"] },
        name: { type: "string" },
        folder: { type: "string" },
        requestId: { type: "string" },
      },
      required: ["generatedId", "type", "name", "requestId"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "create_clip",
    description:
      "Create an empty animation with a name and initial fps. folder is relative to 动画; empty or '.' is its root. Returns clip and document IDs. Then use read_document/write_documents to freely edit frames (imageId, durationUs, instance id), loop and initialFps. Creation does not require endpoint images.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        fps: { type: "number", minimum: 1, maximum: 60 },
        folder: { type: "string" },
        requestId: { type: "string" },
      },
      required: ["name", "requestId"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "get_schema",
    description:
      "Read the current configuration JSON schema (type sheet-recipe or clip; default sheet-recipe). Editing uses document text; frame-edit drafts can be previewed before save_frame_draft applies them.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["sheet-recipe", "clip", "frame-edit", "clip-edit"] },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "read_document",
    description:
      "Read the actual editable source slicing recipe or animation config text, document and definition revisions, path, build state and output IDs for a source image. A missing document returns an unsaved template; initialize items explicitly. Preserves logical item IDs on later edits.",
    inputSchema: {
      type: "object",
      properties: { documentId: idProperty },
      required: ["documentId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "validate_document",
    description:
      "Validate recipe or clip JSON text and references without saving or slicing.",
    inputSchema: {
      type: "object",
      properties: { documentId: idProperty, text: { type: "string" } },
      required: ["documentId", "text"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "write_documents",
    description:
      "Write 1-16 recipe, clip config or frame-edit draft documents atomically from complete JSON text and expected document revisions. Returns normalized documents and stable IDs for new items. Writing frame-edit only updates the draft, not the animation; use inspect_clip then save_frame_draft. Does not slice, generate images or create animations. Re-read on version conflict; never discard another editor's changes.",
    inputSchema: {
      type: "object",
      properties: {
        documents: {
          type: "array",
          minItems: 1,
          maxItems: 16,
          items: {
            type: "object",
            properties: {
              documentId: idProperty,
              expectedDocumentRevision: { type: "string" },
              text: { type: "string" },
            },
            required: ["documentId", "expectedDocumentRevision", "text"],
            additionalProperties: false,
          },
        },
      },
      required: ["documents"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "inspect_sheet",
    description: "Read-only deterministic transparent-sheet evidence. action=detect requires only assetId/expectedSourceRevision, optional detection {alphaThreshold:16,minComponentPixels:1}, offset/limit (max128 candidates). Returns fresh candidate keys WITHOUT slice IDs and actual overlay PNG. action=preview takes complete unsaved recipe text, start/limit (max16 frames), returns resolved rectangles, fixed-canvas contact PNG, overflow/diagnostics and suggestedOutput. No recipes/assets/clips are saved. Explicitly group keys and adopt a canvas suggestion in recipe text, save with write_documents, then slice_sheet. Inherits read_document and inspect_clip permissions even on cache hits. Do not claim static evidence is visual acceptance or invent missing poses.",
    inputSchema: { type: "object", ...z.toJSONSchema(inspectSheetSchema) },
    annotations: { readOnlyHint: true },
  },
  {
    name: "inspect_clip",
    description:
      "Inspect a draft (draftId + documentRevision), animation snapshot or current clip: returns actual ordered contact sheet, red/cyan adjacent onion skins including loop boundary, frame instance IDs, microsecond timings and alpha bounds. These are static evidence, not observed video playback. At most 16 selected frames per call; use frame IDs to inspect further ranges.",
    inputSchema: {
      type: "object",
      properties: {
        draftId: {
          type: "string",
          description:
            "Single-frame draft documentId; requires documentRevision. Renders draft config without saving.",
        },
        documentRevision: { type: "string" },
        snapshotId: { type: "string" },
        clipId: idProperty,
        revision: { type: "string" },
        startFrameId: idProperty,
        endFrameId: idProperty,
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "create_frame_draft",
    description:
      "Create or reopen ONE shared frame-edit v2 draft per animation and editor session. frameId is only initial focus. Returns a documentId; read_document/write_documents edit frames[{frameId,transform,durationUs}], preserving prior edits on other frames. inspect_clip previews ALL changes together and reports overflow warnings. Does not apply or create image resources.",
    inputSchema: {
      type: "object",
      properties: {
        clipId: idProperty,
        revision: { type: "string" },
        frameId: idProperty,
      },
      required: ["clipId", "revision", "frameId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "save_frame_draft",
    description:
      "Save ALL modified frames of the exact previewed animation draft in one commit. Default policy asks the user to Accept/Deny in the webpage; waits and returns the decision and denial reason. Never claim saved before this succeeds. No new image resource; preserves unchanged frame instances and source pixels. Resolve blocking overflow warnings before saving.",
    inputSchema: {
      type: "object",
      properties: { draftId: idProperty, documentRevision: { type: "string" } },
      required: ["draftId", "documentRevision"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "list_assets",
    description:
      "List current project images and clips with stable resource IDs, image kinds and sizes.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "view_image",
    description:
      "Inspect an actual project image. Returns image pixels, not just a path. For a clip use a frame image ID.",
    inputSchema: {
      type: "object",
      properties: { assetId: idProperty },
      required: ["assetId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "slice_sheet",
    description:
      "Execute the source image's saved slicing recipe. Use read_document and write_documents to edit first. Updates the same slice IDs on repeated runs, returns output image IDs, preserves source and existing animation references. Does not create an animation.",
    inputSchema: {
      type: "object",
      properties: {
        assetId: idProperty,
        expectedDefinitionRevision: { type: "string" },
        requestId: { type: "string" },
      },
      required: ["assetId", "expectedDefinitionRevision", "requestId"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "adjust_image",
    description:
      "Save a new image by scaling/repositioning an image on a canvas. Deterministic image operation; does not regenerate or overwrite the original. Positive X is right, positive Y is down. Scale is relative to the original full canvas.",
    inputSchema: {
      type: "object",
      properties: {
        assetId: idProperty,
        scale: { type: "number", minimum: 0.05, maximum: 4 },
        offsetX: { type: "number" },
        offsetY: { type: "number" },
        width: { type: "integer", minimum: 1, maximum: 4096 },
        height: { type: "integer", minimum: 1, maximum: 4096 },
        clip: {
          type: "boolean",
          description:
            "Explicitly allow clipping visible pixels. Defaults false.",
        },
      },
      required: ["assetId"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "create_clip_draft",
    description: "Create a full clip-edit document owned by this session. Preserves complete arrangement, transforms, durations, loop and FPS. For human draft context explicitly pass fromDraftId and expectedFromDocumentRevision; never edit the human original. Inherits create_frame_draft permissions. Use write_documents, inspect_clip, then save_clip_draft.",
    inputSchema: { type: "object", properties: { clipId: idProperty, revision: { type: "string" }, frameId: idProperty, fromDraftId: idProperty, expectedFromDocumentRevision: { type: "string" } }, required: ["clipId", "revision"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "save_clip_draft",
    description: "Commit the exact full object draft once. Requires approved task direction AND tool permission; inherits save_frame_draft policies. Uses a publish-time intent/session/barrier guard, preserves original pixels and history. Human-draft derivatives return {saved:false,delivered:true,pendingHumanAdoption:true,delivery:{draftId,documentRevision,snapshotId,target}}; they freeze a read-only proposal and NEVER publish the clip. The user explicitly adopts it into the source human draft with CAS, then separately saves the animation (legacy frame-edit sources explicitly start a new unified human session and remain untouched). Normal Agent production still saves autonomously. No model may report success before receipt. Rendering/checking is not dynamic playback acceptance.",
    inputSchema: { type: "object", properties: { draftId: idProperty, documentRevision: { type: "string" } }, required: ["draftId", "documentRevision"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "review_sequence",
    description: "List/create/update/capture/inspect/archive a multi-action Review. archive requires sequenceId, expectedRevision and archived boolean; false restores the definition, while captured snapshots/history remain. create definition={requestId,name,loop,segments:[{id,clipId,startFrameId?,endFrameId?,repeat?,speed?}]}; update adds expectedRevision instead of requestId. inspect returns actual images for ALL batches, full coverage, source mappings and dependency stale; these are static evidence, not temporal passed. capture/inspect require sequenceId, optional inspect snapshotId is a sequence snapshot ID. Inherits existing configuration or inspection permissions.",
    inputSchema: { type: "object", properties: { action: { type: "string", enum: ["list", "create", "update", "capture", "inspect", "archive"] }, sequenceId: idProperty, snapshotId: idProperty, definition: { type: "object" }, expectedRevision: { type: "string" }, archived: { type: "boolean" } }, required: ["action"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "workflow_task",
    description: "Use the task bound to this session: status, check (real renderer over exact contract scope, static and unverified temporal), ready (reruns trusted checks and requests human playback/acceptance). No passed/findings input is accepted. Task readiness is not human acceptance or conversation completion. New native generation is disabled in production; never regenerate automatically. Inherits list_assets/inspect_clip policies.",
    inputSchema: { type: "object", properties: { action: { type: "string", enum: ["status", "check", "ready"] } }, required: ["action"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
];
const send = (value: unknown) =>
  process.stdout.write(JSON.stringify(value) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  let request: any;
  try {
    request = JSON.parse(line);
    if (request.id === undefined) return;
    if (request.method === "initialize")
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: request.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "sprite-studio", version: "0.1.0" },
          instructions:
            "Use stable project resource IDs. Inspect actual images before making visual claims. Image operations preserve originals; frame edits use config drafts, preview before saving and request permission to apply; saved edits record undo history. Every tool follows configurable webpage permissions; an approval request remains pending until the user decides, and denial includes a reason. Wait for that result before continuing.",
        },
      });
    else if (request.method === "ping")
      send({ jsonrpc: "2.0", id: request.id, result: {} });
    else if (request.method === "tools/list")
      send({ jsonrpc: "2.0", id: request.id, result: { tools } });
    else if (request.method === "tools/call") {
      const id = request.id;
      // Native HTTP has no hidden fetch headers timeout while a person reviews.
      new Promise<any>((resolve, reject) => {
        const body = JSON.stringify(request.params);
        const call = httpRequest(
          `${endpoint}/internal/tools/${sessionId}`,
          {
            method: "POST",
            timeout: 0,
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body),
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("error", reject);
            response.on("end", () => {
              try {
                const result = JSON.parse(Buffer.concat(chunks).toString());
                if ((response.statusCode || 500) >= 400)
                  throw new Error(result.error || "项目操作失败");
                resolve(result);
              } catch (error) {
                reject(error);
              }
            });
          },
        );
        call.on("error", reject);
        call.end(body);
      })
        .then((result) => send({ jsonrpc: "2.0", id, result }))
        .catch((error) =>
          send({
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [{ type: "text", text: String(error) }],
            },
          }),
        );
    } else
      send({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: "Method not found" },
      });
  } catch {
    if (request?.id !== undefined)
      send({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32700, message: "Invalid JSON" },
      });
  }
});
