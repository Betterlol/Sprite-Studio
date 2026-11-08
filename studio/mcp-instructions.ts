import { readFileSync } from "node:fs";

/** Tool knowledge and the small authoring guide are maintained outside the goal prompt. */
export const mcpInstructions = ["mcp-tools.md", "sprite-authoring.md"]
  .map(name => readFileSync(new URL(`./prompts/${name}`, import.meta.url), "utf8").trim())
  .join("\n\n");
