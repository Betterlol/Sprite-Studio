import test from "node:test";
import assert from "node:assert/strict";
import { SheetEditorState, switchSheetMethod, parseSheet } from "./sheet-state.ts";
import type { SheetDocument } from "../studio/sheets.ts";
const recipe = {schemaVersion:1 as const,type:"sheet-recipe" as const,slicing:{method:"grid" as const,grid:{columns:2,rows:1,margin:[0,0,0,0] as [number,number,number,number],spacing:[0,0] as [number,number]},items:[{name:"a",enabled:true,cell:[0,0] as [number,number],id:"00000000-0000-4000-8000-000000000001"}],outputFolder:"原图素材/test"}};
function doc(text=JSON.stringify(recipe),revision="d1"): SheetDocument {return {documentId:"source",path:"source.recipe.json",text,documentRevision:revision,definitionRevision:revision,exists:true,recipe:parseSheet(text)!,status:"dirty",outputIds:[]};}
test("one text survives method switching, exact v1 IDs and invalid JSON repair",()=>{
  const state=new SheetEditorState("source:revision");state.read(doc());const original=state.text;
  switchSheetMethod(state,"boxes",80,40,"a".repeat(64));let next=parseSheet(state.text)!;assert.equal(next.schemaVersion,2);assert.equal(next.slicing.items.length,0);
  assert.ok("output" in next.slicing && next.slicing.output.scale===1);const boxes=state.text;
  switchSheetMethod(state,"components",80,40,"a".repeat(64));next=parseSheet(state.text)!;assert.equal(next.slicing.method,"components");
  switchSheetMethod(state,"boxes",80,40,"a".repeat(64));assert.equal(state.text,boxes);
  switchSheetMethod(state,"grid",80,40,"a".repeat(64));assert.equal(state.text,original);assert.equal(parseSheet(state.text)!.slicing.items[0]!.id,recipe.slicing.items[0]!.id);
  state.edit("{");switchSheetMethod(state,"boxes",80,40,"a".repeat(64));assert.equal(state.text,"{");assert.equal(parseSheet(state.text),null);state.edit(original);assert.ok(parseSheet(state.text));
});
test("late previews and save acknowledgments cannot overwrite newer input or ABA edits",()=>{
  const state=new SheetEditorState("source:revision");state.read(doc());state.edit("first");const token=state.token();state.edit("second");state.edit("first");assert.equal(state.current(token),false);
  state.saved(doc("normalized","d2"),token);assert.equal(state.text,"first");assert.equal(state.base,"d1");assert.equal(state.external,true);assert.equal(state.document?.documentRevision,"d2");
  state.reload();state.edit("third");const current=state.token();state.saved(doc("ack","d3"),current);assert.equal(state.text,"ack");assert.equal(state.base,"d3");assert.equal(state.external,false);
  const another=new SheetEditorState("other:revision");assert.equal(another.current(current),false);another.saved(doc("wrong"),current);assert.equal(another.text,"");
});
test("external refresh, 409, reload and session draft preserve the authoritative body/base",()=>{
  const state=new SheetEditorState("source");state.read(doc(),{text:"my unsaved JSON",base:"old"});assert.equal(state.text,"my unsaved JSON");assert.equal(state.base,"old");assert.equal(state.external,true);
  state.read(doc("external","d2"));assert.equal(state.text,"my unsaved JSON");assert.equal(state.document?.text,"external");state.conflict();assert.equal(state.text,"my unsaved JSON");
  const before=state.token();state.reload();assert.equal(state.text,"external");assert.equal(state.base,"d2");assert.equal(state.current(before),false);assert.equal(state.external,false);
  state.read(doc("latest","d3"));assert.equal(state.text,"latest");assert.equal(state.base,"d3");
});
test("automatic new text invalidates inspection tokens and newer server reads win over old save acks",()=>{
  const state=new SheetEditorState("source");state.read(doc());const inspection=state.token();state.read(doc("updated","d2"));assert.equal(state.current(inspection),false);
  state.edit("mine");const save=state.token();state.read(doc("new external","d4"));state.saved(doc("mine acknowledged","d3"),save);
  assert.equal(state.text,"mine");assert.equal(state.document?.text,"new external");assert.equal(state.base,"d2");assert.equal(state.external,true);
});
