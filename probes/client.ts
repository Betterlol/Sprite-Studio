import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AppServer as Transport } from "../studio/runtime/app-server.ts";
export {
  assistantText,
  codexCommand,
  type Message,
} from "../studio/runtime/app-server.ts";
export class AppServer extends Transport {
  constructor(
    cwd: string,
    overrides: string[] = [],
    isolateMcp = true,
    launch?: { executable: string; prefix: string[] },
  ) {
    const file = fileURLToPath(
      new URL("../.local/mcp-names.json", import.meta.url),
    );
    if (isolateMcp && !existsSync(file))
      throw new Error("Run the inspect probe before model probes.");
    const disabled: string[] = isolateMcp
      ? JSON.parse(readFileSync(file, "utf8"))
      : [];
    super(cwd, overrides, disabled, launch);
  }
}
