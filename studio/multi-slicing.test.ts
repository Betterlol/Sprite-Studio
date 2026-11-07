import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { ProjectStore, StudioError, sha256 } from "./store.ts";
import { SHEET_ALGORITHM, sheetRecipeSchema, type SheetRecipe, type SheetRecipeV2 } from "./sheet-schema.ts";
import { registerSheetRoutes } from "./sheet-routes.ts";
import { AgentHub } from "./agent.ts";
import { toolPolicyParents, productionWrite } from "./workflow-agent.ts";

function python(script: string, args: string[] = []) {
  const out=spawnSync(process.env.SPRITE_STUDIO_PYTHON || "python",["-I","-c",script,...args],{windowsHide:true});
  assert.equal(out.status,0,out.stderr.toString());return out.stdout.toString();
}
async function fixture(script = "d.rectangle((1,1,9,9),outline=(255,0,0,255));d.rectangle((4,4,6,6),fill=(0,0,255,128));im.putpixel((12,2),(0,255,0,255));im.putpixel((13,3),(0,255,0,255));im.putpixel((18,2),(255,255,0,16));im.putpixel((19,2),(255,255,0,17))", size="(24,16)") {
  const root=mkdtempSync(join(tmpdir(),"multi-sheet-")),file=join(root,"sheet.png");
  python(`from PIL import Image,ImageDraw;import sys;im=Image.new('RGBA',${size});d=ImageDraw.Draw(im);${script};im.save(sys.argv[1])`,[file]);
  const store=new ProjectStore(join(root,"projects")),pid=store.createProject("multi").id;
  const source=await store.importImage(pid,"sheet.png",readFileSync(file),"image");
  const inspect=(input: any={})=>store.sheetInspection.inspect(pid,{action:"detect",assetId:source.id,expectedSourceRevision:source.revision,...input});
  const save=(recipe: SheetRecipe)=>store.sheets.write(pid,[{documentId:source.id,expectedDocumentRevision:store.sheets.read(pid,source.id).documentRevision,text:JSON.stringify(recipe)}])[0]!;
  return {root,file,store,pid,source,inspect,save};
}
function boxes(items: number[][], width=12,height=12,scale=1): SheetRecipeV2 {
  return sheetRecipeSchema.parse({schemaVersion:2,type:"sheet-recipe",slicing:{method:"boxes",outputFolder:"原图素材/boxes",output:{width,height,scale},items:items.map((box,i)=>({box,name:String(i+1),enabled:true}))}}) as SheetRecipeV2;
}
function components(sourceHash: string, keys: string[][], detection={alphaThreshold:16,minComponentPixels:1}): SheetRecipeV2 {
  return sheetRecipeSchema.parse({schemaVersion:2,type:"sheet-recipe",slicing:{method:"components",sourceContentHash:sourceHash,algorithmVersion:SHEET_ALGORITHM,detection,outputFolder:"原图素材/components",output:{width:16,height:16},items:keys.map((componentKeys,i)=>({componentKeys,name:String(i+1),enabled:true}))}}) as SheetRecipeV2;
}
function pixels(path: string) { return JSON.parse(python("from PIL import Image;import sys,json;im=Image.open(sys.argv[1]).convert('RGBA');print(json.dumps({'size':im.size,'pixels':list(im.getdata())}))",[path])) as {size:number[];pixels:number[][]}; }
async function preview(f: Awaited<ReturnType<typeof fixture>>,recipe: SheetRecipe, start=0) { return f.inspect({action:"preview",text:JSON.stringify(recipe),start}); }
async function waitFor(check:()=>unknown) {for(let i=0;i<100&&!check();i++)await new Promise(r=>setTimeout(r,5));assert.ok(check());}
function hubFor(store: ProjectStore) {return Object.assign(Object.create(AgentHub.prototype),{store,imports:new Map(),timers:new Map(),frameSaves:new Map(),clients:new Map(),prompts:new Map()}) as AgentHub;}

test("v1 schema normalization and worker pixels/definition remain byte-compatible",async()=>{
  const f=await fixture("d.rectangle((0,0,4,6),fill=(255,0,0,128));d.rectangle((5,0,10,6),fill=(0,0,255,255))","(11,7)");
  try {
    const r: SheetRecipe={schemaVersion:1,type:"sheet-recipe",slicing:{method:"grid",grid:{columns:2,rows:1,margin:[0,0,0,0],spacing:[0,0]},items:[{cell:[0,0],name:"a",enabled:true},{cell:[1,0],name:"b",enabled:true}],outputFolder:"原图素材/legacy"}};
    const doc=f.save(r);assert.equal(doc.recipe.schemaVersion,1);assert.equal(doc.definitionRevision,sha256(JSON.stringify(doc.recipe)));
    const receipt=await f.store.sheets.execute(f.pid,f.source.id,doc.definitionRevision,randomUUID());
    const out=receipt.outputIds.map(id=>pixels(f.store.imagePath(f.pid,id)));
    assert.deepEqual(out.map(p=>p.size),[[6,7],[6,7]]);
    // Python round ties-to-even: first cell is 6 pixels wide, second is 5 + transparent padding.
    assert.deepEqual(out[0]!.pixels[5],[0,0,255,255]);assert.deepEqual(out[1]!.pixels[5],[0,0,0,0]);
    assert.equal(f.store.sheets.read(f.pid,f.source.id).text,doc.text);
    assert.deepEqual(JSON.parse(doc.text),doc.recipe);
    const p=await preview(f,doc.recipe);assert.deepEqual(p.rectangles?.map(r=>r.box),[[0,0,6,7],[6,0,11,7]]);
  } finally {f.store.worker.close();}
});

test("8-connected alpha candidates are deterministic, filter-visible, paginated and genuinely read-only",async()=>{
  const f=await fixture();try {
    const before=f.store.state(f.pid), doc=f.store.sheets.read(f.pid,f.source.id);
    const a=await f.inspect();assert.equal(a.total,4);assert.equal(a.algorithmVersion,SHEET_ALGORITHM);assert.equal(a.candidates?.find(c=>c.pixelCount===2)?.box.join(","),"12,2,14,4");
    assert.ok(a.candidates?.every(c=>!("id" in c)));assert.equal(f.store.assets(f.pid).length,1);
    assert.equal(f.store.sheets.read(f.pid,f.source.id).documentRevision,"missing");assert.equal(existsSync(f.store.safePath(f.pid,doc.path)),false);
    assert.equal(before.configurationRevision,f.store.state(f.pid).configurationRevision);assert.equal(before.libraryRevision,f.store.state(f.pid).libraryRevision);
    const calls=f.store.worker.run;f.store.worker.run=async()=>{throw new Error("cache miss");};assert.deepEqual(await f.inspect(),a);f.store.worker.run=calls;
    const page=await f.inspect({offset:1,limit:1});assert.equal(page.candidates?.length,1);assert.equal(page.total,4);
    assert.equal((await f.inspect()).candidates?.length,4); // Page manifests cannot poison first-page cache.
    const filtered=await f.inspect({detection:{alphaThreshold:16,minComponentPixels:3}});assert.equal(filtered.total,2);assert.equal(filtered.discardedCount,2);assert.equal(filtered.discardedPixels,3);assert.ok(filtered.diagnostics.some(d=>d.code==="filtered"));
    assert.notEqual(filtered.candidates![0]!.key,a.candidates![0]!.key);
    const image=f.store.sheetInspection.imagePath(f.pid,a.images[0]!.hash);assert.ok(readFileSync(image).subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
    writeFileSync(image,"tampered");assert.throws(()=>f.store.sheetInspection.imagePath(f.pid,a.images[0]!.hash),/已改变/);
    await assert.rejects(f.inspect({limit:129}));
  } finally {f.store.worker.close();}
});

test("component masks do not leak overlapping bbox contents; explicit groups preserve selected RGBA",async()=>{
  const f=await fixture();try {
    const detected=await f.inspect(), cs=detected.candidates!;
    const ring=cs.find(c=>c.pixelCount===32)!,inner=cs.find(c=>c.pixelCount===9)!,diagonal=cs.find(c=>c.pixelCount===2)!;
    const recipe=components(f.source.contentHash,[[ring.key],[inner.key],[diagonal.key]]);
    const doc=f.save(recipe),receipt=await f.store.sheets.execute(f.pid,f.source.id,doc.definitionRevision,randomUUID());
    const ringPixels=pixels(f.store.imagePath(f.pid,receipt.outputIds[0]!));assert.equal(ringPixels.pixels.filter(p=>p[3]!>0).length,32);assert.equal(ringPixels.pixels.some(p=>p[2]===255),false);
    const blue=pixels(f.store.imagePath(f.pid,receipt.outputIds[1]!));assert.equal(blue.pixels.filter(p=>p[3]===128).length,9);assert.ok(blue.pixels.filter(p=>p[3]!>0).every(p=>p.join(",")==="0,0,255,128"));
    const clip=f.store.createClip(f.pid,"reference",receipt.outputIds.map(imageId=>({id:randomUUID(),imageId,durationUs:100000})));
    const changed=f.store.sheets.read(f.pid,f.source.id).recipe;
    if(changed.schemaVersion===3 || changed.slicing.method!=="components")throw new Error("components");
    changed.slicing.items[0]!.componentKeys=[ring.key,inner.key];changed.slicing.items.reverse();
    const saved=f.save(changed),next=await f.store.sheets.execute(f.pid,f.source.id,saved.definitionRevision,randomUUID());assert.deepEqual(next.outputIds,[...receipt.outputIds].reverse());
    assert.equal(pixels(f.store.imagePath(f.pid,receipt.outputIds[0]!)).pixels.filter(p=>p[3]!>0).length,41);
    assert.deepEqual(f.store.animation.clip(f.pid,clip.id).frames,clip.frames);
    changed.slicing.items.pop();assert.throws(()=>f.save(changed),/仍被使用/);
    const unfettered=await f.inspect();assert.equal(unfettered.total,4); // Detection bypasses removal/reference checks.
  } finally {f.store.worker.close();}
});

test("boxes and v2 grid preserve full regions, half-up nearest scaling and floor/bottom-center placement",async()=>{
  const f=await fixture("im.putpixel((0,0),(12,34,56,128));im.putpixel((2,0),(90,80,70,255))","(5,3)");try {
    const recipe=boxes([[0,0,3,1]],7,5,1.5);
    if(recipe.slicing.method!=="boxes")throw new Error("boxes");recipe.slicing.output.alignment="bottom-center";
    const p=await preview(f,recipe);assert.deepEqual(p.frames![0]!.scaledSize,[5,2]);assert.deepEqual(p.frames![0]!.offset,[1,3]);
    const doc=f.save(recipe),r=await f.store.sheets.execute(f.pid,f.source.id,doc.definitionRevision,randomUUID());const px=pixels(f.store.imagePath(f.pid,r.outputIds[0]!));assert.deepEqual(px.size,[7,5]);assert.deepEqual(px.pixels[3*7+1],[12,34,56,128]);assert.deepEqual(px.pixels[0],[0,0,0,0]);
    const grid=sheetRecipeSchema.parse({schemaVersion:2,type:"sheet-recipe",slicing:{method:"grid",grid:{columns:2,rows:1,margin:[0,0,0,0],spacing:[0,0]},items:[{name:"x",enabled:true,cell:[0,0]},{name:"y",enabled:true,cell:[1,0]}],outputFolder:"原图素材/v2grid",output:{width:4,height:4}}});
    const gp=await preview(f,grid);assert.deepEqual(gp.rectangles?.map(r=>r.box),[[0,0,2,3],[2,0,5,3]]);assert.deepEqual(gp.frames?.map(f=>f.offset),[[1,0],[0,0]]);
    const gd=f.save(grid),gr=await f.store.sheets.execute(f.pid,f.source.id,gd.definitionRevision,randomUUID());assert.equal(gr.outputIds.length,2);
  } finally {f.store.worker.close();}
});

test("overflow and expected-count diagnose preview but block execution; canvas suggestions never change recipes",async()=>{
  const f=await fixture();try {
    const r=boxes([[0,0,20,10]],3,3);const p=await preview(f,r);assert.equal(p.blocking,true);assert.deepEqual(p.suggestedOutput,{width:20,height:10});assert.ok(p.frames![0]!.overflow.left!>0);
    const doc=f.save(r);await assert.rejects(f.store.sheets.execute(f.pid,f.source.id,doc.definitionRevision,randomUUID()),/溢出/);assert.equal(f.store.assets(f.pid).length,1);assert.equal(f.store.sheets.read(f.pid,f.source.id).documentRevision,doc.documentRevision);
    const count=boxes([[0,0,2,2]],3,3);count.slicing.expectedFrames=2;
    assert.ok((await preview(f,count)).diagnostics.some(d=>d.code==="frame-count"));const c=f.save(count);await assert.rejects(f.store.sheets.execute(f.pid,f.source.id,c.definitionRevision,randomUUID()),/帧数/);
  } finally {f.store.worker.close();}
});

test("stale components remain structurally readable and repairable; saves bind keys to real cached analysis",async()=>{
  const f=await fixture();try {
    const d=await f.inspect(),recipe=components(f.source.contentHash,[[d.candidates![0]!.key]]);const doc=f.save(recipe);
    const path=f.store.safePath(f.pid,doc.path), stale=structuredClone(doc.recipe);
    if(stale.schemaVersion===3 || stale.slicing.method!=="components")throw new Error("components");stale.slicing.sourceContentHash="0".repeat(64);stale.slicing.algorithmVersion="old";writeFileSync(path,JSON.stringify(stale));
    const readable=f.store.sheets.read(f.pid,f.source.id).recipe;if(readable.schemaVersion===3)throw new Error("legacy components");assert.equal(readable.slicing.method,"components");assert.ok(f.store.state(f.pid).configurationRevision);
    assert.throws(()=>f.save(stale),/STALE_ANALYSIS/);await assert.rejects(f.store.sheets.execute(f.pid,f.source.id,f.store.sheets.read(f.pid,f.source.id).definitionRevision,randomUUID()),/STALE_ANALYSIS/);
    const refreshed=await f.inspect();stale.slicing.sourceContentHash=f.source.contentHash;stale.slicing.algorithmVersion=SHEET_ALGORITHM;stale.slicing.items[0]!.componentKeys=[refreshed.candidates![1]!.key];const fixed=f.save(stale);assert.equal(fixed.recipe.slicing.items[0]!.id,doc.recipe.slicing.items[0]!.id);
    stale.slicing.items[0]!.componentKeys=["f".repeat(64)];assert.throws(()=>f.save(stale),/组件key/);
    const other=await f.store.importImage(f.pid,"other.png",readFileSync(f.file),"image");assert.throws(()=>f.store.sheets.write(f.pid,[{documentId:other.id,expectedDocumentRevision:"missing",text:fixed.text}]),/ID 不属于/);
    const noAnalysis=components(f.source.contentHash,[[refreshed.candidates![0]!.key]],{alphaThreshold:15,minComponentPixels:1});assert.throws(()=>f.save(noAnalysis),/先按当前/);
    // Execution must recompute actual membership even if the document was modified outside write_documents.
    writeFileSync(path,JSON.stringify(stale));const arbitrary=f.store.sheets.read(f.pid,f.source.id);await assert.rejects(f.store.sheets.execute(f.pid,f.source.id,arbitrary.definitionRevision,randomUUID()),/组件key/);
  } finally {f.store.worker.close();}
});

test("candidate/run/output budgets are checked before large allocation; empty/opaque/filter/unassigned evidence is explicit",async()=>{
  const f=await fixture();try {
    assert.throws(()=>f.save(boxes([[0,0,1,1],[1,0,2,1],[2,0,3,1],[3,0,4,1],[4,0,5,1]],4096,4096)),/预算/);
    assert.throws(()=>boxes(Array.from({length:129},()=>[0,0,1,1])),/Too big/);
  } finally {f.store.worker.close();}
  for(const [script,code] of [["pass","empty"],["d.rectangle((0,0,23,15),fill='white')","suspected-background"]]) {
    const x=await fixture(script!);try{assert.ok((await x.inspect()).diagnostics.some(d=>d.code===code));}finally{x.store.worker.close();}
  }
  const noise=await fixture("[im.putpixel((x,y),(255,0,0,255)) for y in range(0,130,2) for x in range(0,130,2)]","(130,130)");try{await assert.rejects(noise.inspect(),/4096/);}finally{noise.store.worker.close();}
  const runs=await fixture("[im.putpixel((x,y),(255,0,0,255)) for y in range(0,1026,2) for x in range(0,1026,2)]","(1026,1026)");try{await assert.rejects(runs.inspect({detection:{minComponentPixels:2}}),/复杂度/);}finally{runs.store.worker.close();}
});

test("inspection HTTP uses the shared service, validates inputs and serves hash-checked actual PNG without a listener",async()=>{
  const f=await fixture(),app=Fastify();registerSheetRoutes(app,f.store);app.setErrorHandler((e:any,_q,r)=>r.code(e.statusCode||400).send({error:e.message}));
  try {
    const result=await app.inject({method:"POST",url:`/api/projects/${f.pid}/sheet-inspections`,payload:{action:"detect",assetId:f.source.id,expectedSourceRevision:f.source.revision}});assert.equal(result.statusCode,200);const info=result.json();
    const img=await app.inject(info.images[0].url);assert.equal(img.statusCode,200);assert.equal(img.headers["content-type"],"image/png");assert.equal(sha256(img.rawPayload),info.images[0].hash);
    assert.equal((await app.inject({method:"POST",url:`/api/projects/${f.pid}/sheet-inspections`,payload:{action:"detect",assetId:f.source.id,expectedSourceRevision:"old"}})).statusCode,409);
    assert.equal((await app.inject({method:"POST",url:`/api/projects/${f.pid}/sheet-inspections`,payload:{action:"detect",assetId:f.source.id,expectedSourceRevision:f.source.revision,path:"arbitrary"}})).statusCode,400);
    assert.equal(f.store.assets(f.pid).length,1);
  }finally{await app.close();f.store.worker.close();}
});

test("Agent inspection inherits both parent policies on cache hits, waits/denies/cancels, and returns image bytes",async()=>{
  const f=await fixture(),hub=hubFor(f.store),session=f.store.createSession(f.pid),args={action:"detect",assetId:f.source.id,expectedSourceRevision:f.source.revision};
  try {
    await f.inspect();assert.deepEqual(toolPolicyParents("inspect_sheet",args),["read_document","inspect_clip"]);assert.equal(productionWrite("inspect_sheet",args),false);
    f.store.permissions.write({read_document:"deny"});const denied=await hub.tool(session.id,"inspect_sheet",args);assert.ok("isError" in denied && denied.isError);
    f.store.permissions.write({read_document:"allow",inspect_clip:"ask"});const pending=hub.tool(session.id,"inspect_sheet",args);await waitFor(()=>session.toolApproval);hub.resolveToolApproval(session.id,session.toolApproval!.id,true);const result=await pending;
    const image=result.content.find((c:any)=>c.type==="image") as any;assert.ok(image);assert.equal(image.mimeType,"image/png");assert.ok(Buffer.from(image.data,"base64").subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
    const cancelled=hub.tool(session.id,"inspect_sheet",args);await waitFor(()=>session.toolApproval);hub.cancelTools(session,"cancel inspection");const cancelledResult=await cancelled;assert.ok("isError" in cancelledResult && cancelledResult.isError);assert.match(JSON.stringify(cancelledResult),/cancel inspection/);
    assert.equal(f.store.assets(f.pid).length,1);
  }finally{hub.cancelTools(session,"end");f.store.worker.close();}
});

test("async source/config/output races and malformed worker outputs cannot publish",async()=>{
  for(const scenario of ["source","config","output","count","order","size","guard"]){
    const f=await fixture();try {
      const doc=f.save(boxes([[0,0,2,2]],4,4));const first=await f.store.sheets.execute(f.pid,f.source.id,doc.definitionRevision,randomUUID());
      const changed=structuredClone(doc.recipe);changed.slicing.outputFolder="原图素材/changed";const saved=f.save(changed);
      const original=f.store.worker.run.bind(f.store.worker);let intercepted=false;
      f.store.worker.run=async(method,params)=>{
        const result=await original(method,params);
        if(method==="recipe_slice" && !intercepted){intercepted=true;
          if(scenario==="source")writeFileSync(f.store.imagePath(f.pid,f.source.id),"changed source");
          if(scenario==="config"){const next=structuredClone(saved.recipe);next.slicing.items[0]!.name="race";f.save(next);}
          if(scenario==="output")writeFileSync(f.store.imagePath(f.pid,first.outputIds[0]!),"changed output");
          if(scenario==="count")result.files=[];
          if(scenario==="order")result.itemIndexes=[99];
          if(scenario==="size")python("from PIL import Image;import sys;Image.new('RGBA',(1,1)).save(sys.argv[1])",[result.files[0]]);
        }
        return result;
      };
      let guardCalls=0;const execute=()=>f.store.sheets.execute(f.pid,f.source.id,saved.definitionRevision,randomUUID());
      if(scenario==="guard")await assert.rejects(f.store.guarded(()=>{if(++guardCalls>0)throw new StudioError("late guard",409);},execute),/late guard/);
      else await assert.rejects(execute(),/来源|外部修改|切割期间|数量|顺序|解码尺寸/);
      assert.equal(f.store.assets(f.pid).filter(a=>a.type==="image" && a.producer).length,1);
    }finally{f.store.worker.close();}
  }
});

test("source mismatch after async detection rejects even before derived cache publication",async()=>{
  const f=await fixture();try {
    const original=f.store.worker.run.bind(f.store.worker);f.store.worker.run=async(m,p)=>{const r=await original(m,p);if(m==="sheet_detect")writeFileSync(f.store.imagePath(f.pid,f.source.id),"changed");return r;};
    await assert.rejects(f.inspect(),/外部修改/);assert.equal(f.store.assets(f.pid).length,1);assert.equal(existsSync(f.store.safePath(f.pid,".studio/sheet-inspections")),false);
  }finally{f.store.worker.close();}
});

test("large candidate pages and preview batches preserve global order and bounded evidence",async()=>{
  const f=await fixture("[im.putpixel((x,y),(255,0,0,255)) for y in range(0,20,2) for x in range(0,26,2)]","(26,20)");
  try {
    const page2=await f.inspect({offset:128});assert.equal(page2.total,130);assert.equal(page2.candidates?.length,2);
    const page1=await f.inspect();assert.equal(page1.candidates?.length,128);assert.notEqual(page1.id,page2.id);
    const keys=[...page1.candidates!,...page2.candidates!].map(c=>c.key);assert.equal(new Set(keys).size,130);
    const recipe=components(f.source.contentHash,keys.slice(0,17).map(k=>[k]));const a=await preview(f,recipe),b=await preview(f,recipe,16);
    assert.equal(a.total,17);assert.equal(a.frames?.length,16);assert.equal(a.end,16);assert.equal(b.frames?.length,1);assert.equal(b.start,16);assert.equal(b.end,17);
    assert.deepEqual([...a.frames!,...b.frames!].map(x=>x.index),Array.from({length:17},(_,i)=>i));assert.ok(a.diagnostics.some(d=>d.code==="unassigned"));
    const doc=f.save(recipe),requestId=randomUUID(),r=await f.store.sheets.execute(f.pid,f.source.id,doc.definitionRevision,requestId);
    const run=f.store.worker.run;f.store.worker.run=async()=>{throw new Error("cache must not execute");};assert.deepEqual(await f.store.sheets.execute(f.pid,f.source.id,doc.definitionRevision,requestId),r);assert.deepEqual(await f.store.sheets.execute(f.pid,f.source.id,doc.definitionRevision,randomUUID()),r);f.store.worker.run=run;
    // Removing unreferenced entries never implicitly deletes their existing assets.
    const next=structuredClone(doc.recipe);next.slicing.items=next.slicing.items.slice(0,1) as typeof next.slicing.items;const saved=f.save(next);await f.store.sheets.execute(f.pid,f.source.id,saved.definitionRevision,randomUUID());assert.equal(f.store.assets(f.pid).length,18);
  }finally{f.store.worker.close();}
});

test("v2 prepare stays synchronous and mixed document failures are atomic",async()=>{
  const f=await fixture();try {
    const clip=f.store.documents.createClip(f.pid,{name:"mixed",fps:12,folder:"",requestId:randomUUID()}),clipDoc=f.store.documents.read(f.pid,clip.id),sourceDoc=f.store.sheets.read(f.pid,f.source.id);
    const value=JSON.parse(clipDoc.text);value.loop=false;
    assert.throws(()=>f.store.documents.write(f.pid,[{documentId:clip.id,expectedDocumentRevision:clipDoc.documentRevision,text:JSON.stringify(value)},{documentId:f.source.id,expectedDocumentRevision:"missing",text:JSON.stringify(boxes([[0,0,100,100]]))}]),/矩形/);
    assert.equal(f.store.documents.read(f.pid,clip.id).documentRevision,clipDoc.documentRevision);assert.equal(f.store.sheets.read(f.pid,f.source.id).exists,false);
    const prepared=f.store.sheets.prepare(f.pid,{documentId:f.source.id,expectedDocumentRevision:sourceDoc.documentRevision,text:JSON.stringify(boxes([[0,0,2,2]]))});assert.equal(prepared instanceof Promise,false);
    const docs=f.store.documents.write(f.pid,[{documentId:clip.id,expectedDocumentRevision:clipDoc.documentRevision,text:JSON.stringify(value)},{documentId:f.source.id,expectedDocumentRevision:"missing",text:JSON.stringify(boxes([[0,0,2,2]]))}]);assert.equal(docs.length,2);assert.equal(f.store.animation.clip(f.pid,clip.id).loop,false);
  }finally{f.store.worker.close();}
});

test("inspection task source scope, async cancellation and late publication baseline guard hold",async()=>{
  const f=await fixture(),hub=hubFor(f.store),session=f.store.createSession(f.pid);
  try {
    const task=f.store.tasks.create(f.pid,{requestId:randomUUID(),title:"scope",description:"scope",target:{mode:"saved",assetId:f.source.id},sessionId:session.id});
    session.taskId=task.id;session.workflowIntent={taskId:task.id,intentVersion:task.intentVersion,barrierVersion:task.barrierVersion};
    const other=await f.store.importImage(f.pid,"unrelated.png",readFileSync(f.file),"image");await f.store.sheetInspection.inspect(f.pid,{action:"detect",assetId:other.id,expectedSourceRevision:other.revision});
    await assert.rejects(hub.tool(session.id,"inspect_sheet",{action:"detect",assetId:other.id,expectedSourceRevision:other.revision}),/任务约定范围/);
    const original=f.store.worker.run.bind(f.store.worker);let cancel=false;
    f.store.worker.run=async(m,p)=>{const result=await original(m,p);if(m==="sheet_preview" && !cancel){cancel=true;hub.cancelTools(session,"cancel active inspection");}return result;};
    await assert.rejects(hub.tool(session.id,"inspect_sheet",{action:"preview",assetId:f.source.id,expectedSourceRevision:f.source.revision,text:JSON.stringify(boxes([[0,0,2,2]]))}),/取消/);
    f.store.worker.run=original;
    const doc=f.save(boxes([[0,0,2,2]])),old=await f.store.sheets.execute(f.pid,f.source.id,doc.definitionRevision,randomUUID());const next=structuredClone(doc.recipe);next.slicing.items[0]!.name="change-key";const saved=f.save(next);
    const safe=f.store.safePath.bind(f.store);let mutated=false;
    f.store.safePath=(pid,path)=>{const full=safe(pid,path);if(!mutated && path.endsWith("/operation.json") && path.startsWith(".studio/config-operations/")){mutated=true;writeFileSync(safe(f.pid,f.store.image(f.pid,old.outputIds[0]!).file!),"concurrent output bytes");}return full;};
    await assert.rejects(f.store.sheets.execute(f.pid,f.source.id,saved.definitionRevision,randomUUID()),/外部修改/);f.store.safePath=safe;assert.equal(mutated,true);
    assert.equal(readFileSync(safe(f.pid,f.store.image(f.pid,old.outputIds[0]!).file!),"utf8"),"concurrent output bytes");
  }finally{hub.cancelTools(session,"end");f.store.worker.close();}
});

test("the 4096-candidate limit can actually be explicitly grouped and saved as v2 text",async()=>{
  const f=await fixture("[im.putpixel((x,y),(255,0,0,255)) for y in range(0,128,2) for x in range(0,128,2)]","(128,128)");
  try {
    assert.equal((await f.inspect()).total,4096);
    const real=await f.store.worker.run("sheet_detect",{path:f.store.imagePath(f.pid,f.source.id),outputDir:f.store.stage(f.pid),detection:{alphaThreshold:16,minComponentPixels:1},offset:0,limit:128});
    const recipe=components(f.source.contentHash,[real.allKeys]);if(recipe.slicing.method!=="components")throw new Error("components");recipe.slicing.output={width:128,height:128,scale:1,alignment:"center"};
    const text=JSON.stringify(recipe,null,2);assert.ok(Buffer.byteLength(text)>256*1024);
    const doc=f.store.sheets.write(f.pid,[{documentId:f.source.id,expectedDocumentRevision:"missing",text}])[0]!;const receipt=await f.store.sheets.execute(f.pid,f.source.id,doc.definitionRevision,randomUUID());
    assert.equal(pixels(f.store.imagePath(f.pid,receipt.outputIds[0]!)).pixels.filter(p=>p[3]!>0).length,4096);
  }finally{f.store.worker.close();}
});

test("async worker failures still surface a source revision conflict as 409",async()=>{
  const f=await fixture();try{
    const original=f.store.worker.run.bind(f.store.worker);f.store.worker.run=async(m,p)=>{if(m==="sheet_detect"){writeFileSync(f.store.imagePath(f.pid,f.source.id),"source raced worker failure");throw new Error("worker decode failure");}return original(m,p);};
    await assert.rejects(f.inspect(),(error:any)=>error.statusCode===409 && error.message.includes("外部修改"));
  }finally{f.store.worker.close();}
});

test("a newly occupied output path at the final guard is retained and never overwritten or recovered over",async()=>{
  const f=await fixture();try{
    const recipe=boxes([[0,0,2,2]]);recipe.slicing.outputFolder="原图素材";const doc=f.save(recipe),item=doc.recipe.slicing.items[0]!,target=`Assets/原图素材/${item.name}-${item.id!.slice(0,8)}.png`;
    const safe=f.store.safePath.bind(f.store);let raced=false;
    f.store.safePath=(pid,path)=>{const full=safe(pid,path);if(!raced && path.startsWith(".studio/config-operations/") && path.endsWith("/operation.json")){raced=true;writeFileSync(safe(pid,target),"external occupant");}return full;};
    await assert.rejects(f.store.sheets.execute(f.pid,f.source.id,doc.definitionRevision,randomUUID()),/输出路径或元数据/);f.store.safePath=safe;
    assert.equal(readFileSync(safe(f.pid,target),"utf8"),"external occupant");assert.equal(f.store.assets(f.pid).length,1);
  }finally{f.store.worker.close();}
});

test("MCP advertises the readonly shared inspect contract without a runtime or HTTP connection",()=>{
  const out=spawnSync(process.execPath,["studio/mcp.ts","http://127.0.0.1:1","test-session"],{input:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list"})+"\n",env:{...process.env,SPRITE_STUDIO_TOOL_TOKEN:"stub"},windowsHide:true});
  assert.equal(out.status,0,out.stderr.toString());const tool=JSON.parse(out.stdout.toString()).result.tools.find((t:any)=>t.name==="inspect_sheet");assert.ok(tool);assert.equal(tool.annotations.readOnlyHint,true);assert.equal(tool.inputSchema.type,"object");assert.equal(tool.inputSchema.oneOf?.length || tool.inputSchema.anyOf?.length,4);
});
