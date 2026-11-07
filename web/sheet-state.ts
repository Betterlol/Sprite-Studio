import type { SheetDocument } from "../studio/sheets.ts";
import { sheetRecipeSchema, SHEET_ALGORITHM, type SheetRecipe } from "../studio/sheet-schema.ts";
export type SheetToken = { generation: number; source: string; serial: number; text: string; base: string };
/** One authoritative text. Generations (not equality) reject edit-away/edit-back ABA. */
export class SheetEditorState {
  text = ""; base = "missing"; savedText = ""; generation = 0; serial = 0;
  loaded = false; external = false; document: SheetDocument | null = null;
  methods = new Map<string, string>();
  source: string;
  constructor(source: string) { this.source = source; }
  edit(text: string) { this.text = text; this.generation++; }
  token(): SheetToken { return { generation: this.generation, source: this.source, serial: ++this.serial, text: this.text, base: this.base }; }
  current(token: SheetToken) { return token.source === this.source && token.generation === this.generation; }
  read(next: SheetDocument, draft?: { text: string; base: string } | null) {
    this.document = next;
    if (!this.loaded) {
      this.loaded = true; this.text = draft?.text ?? next.text; this.base = draft?.base ?? next.documentRevision;
      this.generation++;
      this.savedText = next.text; this.external = this.base !== next.documentRevision;
    } else if (this.text === this.savedText || this.text === next.text) {
      if (this.text !== next.text) this.generation++;
      this.text = next.text; this.savedText = next.text; this.base = next.documentRevision; this.external = false;
    } else if (this.base !== next.documentRevision) this.external = true;
  }
  saved(next: SheetDocument, token: SheetToken) {
    if (token.source !== this.source) return;
    if (this.document && this.document.documentRevision !== token.base && this.document.documentRevision !== next.documentRevision) {
      this.external = true; return; // A refresh already observed a different server version.
    }
    this.document = next; this.savedText = next.text;
    if (this.current(token)) { this.text = next.text; this.base = next.documentRevision; this.external = false; this.generation++; }
    else if (this.base === next.documentRevision && this.text === next.text) this.external = false;
    else this.external = true; // Do not apply IDs or a new base to a newer, unacknowledged body.
  }
  conflict() { this.external = true; }
  reload() {
    if (!this.document) return;
    this.text = this.document.text; this.savedText = this.text; this.base = this.document.documentRevision;
    this.external = false; this.generation++; this.methods.clear();
  }
}
export function parseSheet(text: string): SheetRecipe | null {
  try { const result = sheetRecipeSchema.safeParse(JSON.parse(text)); return result.success ? result.data : null; } catch { return null; }
}
export function switchSheetMethod(state: SheetEditorState, method: "grid" | "boxes" | "components", width: number, height: number, sourceContentHash: string) {
  const recipe = parseSheet(state.text);
  if (!recipe || recipe.schemaVersion === 3) return;
  state.methods.set(recipe.slicing.method, state.text);
  const previous = state.methods.get(method);
  if (previous) { state.edit(previous); return; }
  const common = { outputFolder: recipe.slicing.outputFolder, output: "output" in recipe.slicing ? recipe.slicing.output : { width: Math.min(4096,width), height: Math.min(4096,height), scale: 1, alignment: "center" as const } };
  const next: SheetRecipe = { schemaVersion: 2, type: "sheet-recipe", slicing: method === "grid" ? { ...common, method, grid: { columns: 1, rows: 1, margin: [0,0,0,0], spacing: [0,0] }, items: [] } : method === "boxes" ? { ...common, method, items: [] } : { ...common, method, sourceContentHash, algorithmVersion: SHEET_ALGORITHM, detection: { alphaThreshold: 16, minComponentPixels: 1 }, items: [] } };
  state.edit(JSON.stringify(next,null,2)+"\n");
}
