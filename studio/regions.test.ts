import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ProjectStore } from './store.ts';
import { AgentHub } from './agent.ts';
import type { SheetRecipeV3 } from './sheet-schema.ts';

async function fixture() {
  const root=mkdtempSync(join(tmpdir(),'region-editor-')),file=join(root,'source.png');
  const p=spawnSync(process.env.SPRITE_STUDIO_PYTHON||'python',['-I','-c',"from PIL import Image,ImageDraw;import sys;im=Image.new('RGBA',(64,40));d=ImageDraw.Draw(im);d.rectangle((2,2,25,25),outline=(255,0,0,255),width=2);d.rectangle((10,10,14,14),fill=(0,0,255,128));d.rectangle((40,4,55,30),fill=(0,255,0,255));im.save(sys.argv[1])",file],{windowsHide:true});
  assert.equal(p.status,0,p.stderr.toString());
  const store=new ProjectStore(join(root,'projects')),pid=store.createProject('regions').id;
  const image=await store.importImage(pid,'source.png',readFileSync(file),'image');
  const inspect=(input:any)=>store.sheetInspection.inspect(pid,{assetId:image.id,expectedSourceRevision:image.revision,...input});
  const save=(recipe:unknown)=>store.sheets.write(pid,[{documentId:image.id,expectedDocumentRevision:store.sheets.read(pid,image.id).documentRevision,text:JSON.stringify(recipe)}])[0]!;
  const execute=async()=>{const d=store.sheets.read(pid,image.id);return store.sheets.execute(pid,image.id,d.definitionRevision,randomUUID());};
  return {root,store,pid,image,inspect,save,execute};
}
const grid={columns:2,rows:1,margin:[0,0,0,0] as [number,number,number,number],spacing:[0,0] as [number,number]};

test('default legacy resolve is bound to the effective saved recipe, not only source pixels',async()=>{
  const f=await fixture();try {
    const d=f.store.sheets.read(f.pid,f.image.id);if(d.recipe.schemaVersion!==1)throw new Error('legacy');
    d.recipe.slicing.grid=grid;d.recipe.slicing.items=[{name:'before',enabled:true,cell:[0,0]},{name:'other',enabled:true,cell:[1,0]}];
    const before=f.save(d.recipe),a=await f.inspect({action:'resolve'});
    const changed=structuredClone(before.recipe);if(changed.schemaVersion!==1)throw new Error('legacy');
    changed.slicing.items[0]!.name='after';changed.slicing.grid.margin[0]=1;f.save(changed);
    const b=await f.inspect({action:'resolve'});
    assert.notEqual(a.id,b.id);assert.equal(b.recipe!.slicing.items[0]!.name,'after');
    assert.equal(b.recipe!.slicing.items[0]!.box[1],1);assert.equal(b.recipe!.slicing.output.height,39);
    assert.deepEqual(b.recipe!.slicing.items.map(i=>i.id),before.recipe.slicing.items.map(i=>i.id));
  } finally {f.store.worker.close();}
});

test('generators return one v3 region form; generation parameters never enter saved config',async()=>{
  const f=await fixture();try {
    const generated=await f.inspect({action:'generate',method:'grid',grid});
    assert.equal(generated.recipe!.schemaVersion,3);
    assert.equal(generated.recipe!.slicing.items.length,2);
    assert.deepEqual(generated.recipe!.slicing.items.map((i:any)=>i.box),[[0,0,32,40],[32,0,64,40]]);
    const d=f.save(generated.recipe);assert.equal(d.recipe.schemaVersion,3);
    const text=JSON.parse(d.text);assert.equal('method' in text.slicing,false);assert.equal('grid' in text.slicing,false);assert.equal('detection' in text.slicing,false);
    assert.ok(d.recipe.slicing.items.every(i=>i.id));
    const out=await f.execute();assert.equal(out.outputIds.length,2);
    assert.equal(f.store.assets(f.pid).filter(a=>a.type==='clip').length,0);
  } finally {f.store.worker.close();}
});

test('component selections are frozen; v3 preview and recut never rerun detection',async()=>{
  const f=await fixture();try {
    const generated=await f.inspect({action:'generate',method:'components'}),recipe=generated.recipe! as SheetRecipeV3;
    assert.equal(recipe.slicing.items.length,3);assert.ok(recipe.slicing.items.every(i=>i.selection));
    assert.equal(JSON.stringify(recipe).includes('componentKeys'),false);
    const d=f.save(recipe),first=await f.execute();
    const preview=await f.inspect({action:'preview',text:d.text});
    assert.equal(preview.frameImages!.length,3);
    assert.ok(preview.frameImages!.every(i=>i.raw.url && i.output.url));
    // If v3 accidentally enters the old components resolver it would fail on missing method/keys.
    const reordered=structuredClone(d.recipe) as SheetRecipeV3;reordered.slicing.items.reverse();
    const again=f.save(reordered);const out=await f.execute();assert.deepEqual(out.outputIds,[...first.outputIds].reverse());
    assert.equal(again.recipe.schemaVersion,3);
  } finally {f.store.worker.close();}
});

test('manual box edits preserve IDs and switch only the edited selection to rectangle pixels',async()=>{
  const f=await fixture();try {
    const generated=await f.inspect({action:'generate',method:'components'}),d=f.save(generated.recipe),first=await f.execute();
    const recipe=structuredClone(d.recipe) as SheetRecipeV3,originalId=recipe.slicing.items[0]!.id;
    const untouched=recipe.slicing.items[1]!.selection;
    recipe.slicing.items[0]!.box=[1,1,27,27];
    const saved=f.save(recipe) as any;assert.equal(saved.recipe.slicing.items[0].selection,undefined);
    assert.equal(saved.recipe.slicing.items[0].id,originalId);assert.equal(saved.recipe.slicing.items[1].selection,untouched);
    saved.recipe.slicing.output={width:32,height:40,scale:1,alignment:'center'};
    f.save(saved.recipe);const next=await f.execute();assert.deepEqual(next.outputIds,first.outputIds);
    const p=spawnSync(process.env.SPRITE_STUDIO_PYTHON||'python',['-I','-c',"from PIL import Image;import sys;im=Image.open(sys.argv[1]);assert any(b>0 and r==0 for r,g,b,a in im.getdata() if a>0)",f.store.imagePath(f.pid,next.outputIds[0]!)],{windowsHide:true});
    assert.equal(p.status,0,p.stderr.toString());
  } finally {f.store.worker.close();}
});

test('legacy resolve preserves IDs and pixels without modifying the saved recipe',async()=>{
  const f=await fixture();try {
    const old=f.store.sheets.read(f.pid,f.image.id);assert.equal(old.recipe.schemaVersion,1);
    if(old.recipe.schemaVersion!==1)throw new Error('legacy');
    old.recipe.slicing.grid=grid;old.recipe.slicing.items=[{name:'a',enabled:true,cell:[0,0]},{name:'b',enabled:true,cell:[1,0]}];
    const saved=f.save(old.recipe),out=await f.execute();
    const resolved=await f.inspect({action:'resolve',text:saved.text});
    assert.equal(f.store.sheets.read(f.pid,f.image.id).text,saved.text);
    assert.deepEqual(resolved.recipe!.slicing.items.map(i=>i.id),saved.recipe.slicing.items.map(i=>i.id));
    assert.equal(resolved.recipe!.schemaVersion,3);
    const next=f.save(resolved.recipe);const recut=await f.execute();assert.deepEqual(recut.outputIds,out.outputIds);
    assert.equal(next.recipe.schemaVersion,3);
  } finally {f.store.worker.close();}
});

test('frozen selection tampering fails safely and a stale source stays readable',async()=>{
  const f=await fixture();try {
    const generated=await f.inspect({action:'generate',method:'components'}),saved=f.save(generated.recipe);
    const recipe=structuredClone(saved.recipe) as SheetRecipeV3;
    recipe.slicing.items[0]!.selection='0'.repeat(64);assert.throws(()=>f.save(recipe),/选区|selection/);
    const reference=f.store.sheetInspection.selection(f.pid,(saved.recipe as SheetRecipeV3).slicing.items[0]!.selection!);
    writeFileSync(reference.path,'changed');
    assert.equal(f.store.sheets.read(f.pid,f.image.id).recipe.schemaVersion,3);
    await assert.rejects(f.execute(),/选区|selection/);
  } finally {f.store.worker.close();}
});

test('real Agent dispatch generates regions, edits only boxes, cuts and builds an animation',async()=>{
  const f=await fixture(),hub=Object.assign(Object.create(AgentHub.prototype),{store:f.store,imports:new Map(),timers:new Map(),frameSaves:new Map(),clients:new Map(),prompts:new Map()}) as AgentHub,session=f.store.createSession(f.pid);
  async function call(name:string,input:any){const r=await hub.tool(session.id,name as any,input);assert.ok(!('isError'in r&&r.isError),JSON.stringify(r));return JSON.parse((r.content.find((c:any)=>c.type==='text') as any).text);}
  try {
    const initial=await call('read_document',{documentId:f.image.id});
    const generated=await call('inspect_sheet',{action:'generate',method:'grid',grid,assetId:f.image.id,expectedSourceRevision:f.image.revision});
    const [saved]=await call('write_documents',{documents:[{documentId:f.image.id,expectedDocumentRevision:initial.documentRevision,text:JSON.stringify(generated.recipe)}]});
    const out=await call('slice_sheet',{assetId:f.image.id,expectedDefinitionRevision:saved.definitionRevision,requestId:randomUUID()});
    const changed=structuredClone(saved.recipe);changed.slicing.items[0].box=[1,1,30,39];
    const [edited]=await call('write_documents',{documents:[{documentId:f.image.id,expectedDocumentRevision:saved.documentRevision,text:JSON.stringify(changed)}]});
    const next=await call('slice_sheet',{assetId:f.image.id,expectedDefinitionRevision:edited.definitionRevision,requestId:randomUUID()});assert.deepEqual(next.outputIds,out.outputIds);
    const clip=await call('create_clip',{name:'regions',requestId:randomUUID()});const doc=await call('read_document',{documentId:clip.id}),body=JSON.parse(doc.text);
    body.frames=next.outputIds.map((imageId:string)=>({imageId,durationUs:100000}));await call('write_documents',{documents:[{documentId:clip.id,expectedDocumentRevision:doc.documentRevision,text:JSON.stringify(body)}]});
    await call('inspect_clip',{clipId:clip.id});assert.equal(f.store.animation.clip(f.pid,clip.id).frames.length,2);
  } finally {hub.cancelTools(session,'end');f.store.worker.close();}
});
