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
        type: { type: "string", enum: ["sheet-recipe", "clip", "frame-edit"] },
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
      "Create or reopen a single animation frame config draft from saved source-relative transform and duration. Returns a documentId. Use read_document/write_documents to edit its frame-edit JSON; inspect_clip(draftId,documentRevision) previews it. Does not apply changes or create image resources.",
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
      "Save the exact previewed frame config draft. Default policy asks the user to Accept/Deny in the webpage; waits and returns the decision and denial reason. Never claim saved before this succeeds. No new image resource; preserves other frame instances and source pixels.",
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
            "Use stable project resource IDs. Inspect actual images before making visual claims. Image operations preserve originals; frame edits use config drafts, preview before saving and request permission to apply; saved edits record undo history.",
        },
      });
    else if (request.method === "ping")
      send({ jsonrpc: "2.0", id: request.id, result: {} });
    else if (request.method === "tools/list")
      send({ jsonrpc: "2.0", id: request.id, result: { tools } });
    else if (request.method === "tools/call") {
      const id = request.id;
      fetch(`${endpoint}/internal/tools/${sessionId}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request.params),
        signal: AbortSignal.timeout(
          request.params.name === "save_frame_draft" ? 16 * 60_000 : 120_000,
        ),
      })
        .then(async (response) => {
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || "项目操作失败");
          return result;
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
