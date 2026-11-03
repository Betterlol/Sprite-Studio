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
    name: "list_assets",
    description:
      "List current project images and clips with stable resource IDs, roles and sizes.",
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
      "Slice a static spritesheet into a regular grid and create a playable candidate animation. Original pixels are retained.",
    inputSchema: {
      type: "object",
      properties: {
        assetId: idProperty,
        columns: { type: "integer", minimum: 1, maximum: 32 },
        rows: { type: "integer", minimum: 1, maximum: 32 },
        fps: { type: "number", minimum: 1, maximum: 60 },
        name: { type: "string" },
      },
      required: ["assetId", "columns", "rows"],
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
      "Create a candidate by scaling/repositioning an image on a canvas. Deterministic image operation; does not regenerate or overwrite the original. Positive X is right, positive Y is down. Scale is relative to the original full canvas.",
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
            "Use stable project resource IDs. Inspect actual images before making visual claims. Operations create candidates and preserve originals.",
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
        signal: AbortSignal.timeout(120_000),
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
