import test from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import type { SheetDocument } from "../studio/sheets.ts";
import type { ImageAsset } from "../studio/model.ts";
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const image: ImageAsset={id:id(1),type:"image",kind:"image",name:"sheet",revision:"source-1",contentHash:"a".repeat(64),file:"sheet.png",createdAt:"now",width:64,height:32,frameCount:1,mime:"image/png"};
const initial={schemaVersion:1 as const,type:"sheet-recipe" as const,slicing:{method:"grid" as const,grid:{columns:2,rows:1,margin:[0,0,0,0] as [number,number,number,number],spacing:[0,0] as [number,number]},items:[{id:id(2),name:"first",enabled:true,cell:[0,0] as [number,number]},{id:id(3),name:"second",enabled:true,cell:[1,0] as [number,number]}],outputFolder:"原图素材/test"}};
const document=(text=JSON.stringify(initial),revision="d1"):SheetDocument=>({documentId:image.id,path:"sheet.png.recipe.json",text,documentRevision:revision,definitionRevision:revision,exists:true,recipe:JSON.parse(text),status:"dirty",outputIds:[]});
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{"Content-Type":"application/json"}});
function descendants(tree:any):any[]{return Array.isArray(tree)?tree.flatMap(descendants):tree&&typeof tree==="object"?[tree,...descendants(tree.props?.children)]:[];}
function text(tree:any):string{return typeof tree==="string"?tree:Array.isArray(tree)?tree.map(text).join(""):tree&&typeof tree==="object"?text(tree.props?.children):"";}
function mount(Component:(props:any)=>any){
  const cells:any[]=[],cleanups:any[]=[];let cursor=0,dirty=true,tree:any,props:any,effects:any[]=[];
  const internals=(React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const same=(a:any[],b:any[])=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
  const dispatcher={
    useState(initial:any){const i=cursor++;if(!(i in cells))cells[i]=typeof initial==="function"?initial():initial;return[cells[i],(value:any)=>{const v=typeof value==="function"?value(cells[i]):value;if(!Object.is(cells[i],v)){cells[i]=v;dirty=true;}}];},
    useRef(initial:any){return cells[cursor++]??={current:initial};},
    useEffect(run:any,deps:any[]){const i=cursor++;if(!same(cells[i],deps)){cells[i]=deps;effects.push({i,run});}},
  };
  const render=(next=props)=>{props=next;dirty=true;for(let n=0;dirty;n++){assert.ok(n<30,"effects settle");dirty=false;cursor=0;effects=[];const old=internals.H;internals.H=dispatcher;try{tree=Component(props);}finally{internals.H=old;}for(const{i,run}of effects){cleanups[i]?.();cleanups[i]=run();}}return tree;};
  return{render,async settle(){for(let i=0;i<8;i++){await new Promise(r=>setImmediate(r));if(dirty)render();}return tree;},unmount(){cleanups.forEach(c=>c?.());}};
}
async function fixture(){
  const previousFetch=globalThis.fetch,previousStorage=(globalThis as any).sessionStorage,storage=new Map<string,string>();
  (globalThis as any).sessionStorage={getItem:(key:string)=>storage.get(key)||null,setItem:(key:string,value:string)=>storage.set(key,value),removeItem:(key:string)=>storage.delete(key)};
  // Transform-only middleware mode: no HTTP listener, model, browser or visual acceptance.
  const vite=await createServer({configFile:false,root:fileURLToPath(new URL("../",import.meta.url)),server:{middlewareMode:true,hmr:false},appType:"custom"});
  const{SliceConfigPanel}=await vite.ssrLoadModule("/web/SliceConfigPanel.tsx"),component=mount(SliceConfigPanel);
  let overlay:any=null;
  const props={projectId:id(4),image,assets:[image],refreshToken:"1",onRefresh:async()=>{},onSelect(){},onOverlay:(value:any)=>{overlay=value;},gridVisible:true,onGridVisible(){},disabled:false};
  globalThis.fetch=async()=>json(document());component.render(props);let tree=await component.settle();
  const update=async()=>tree=await component.settle();
  const field=(label:string)=>{const node=descendants(tree).find(n=>n.props?.["aria-label"]===label);assert.ok(node,`field ${label}`);return node;};
  const button=(label:string)=>{const node=descendants(tree).find(n=>n.type==="button"&&text(n)===label);assert.ok(node,`button ${label}`);return node;};
  return{component,props,storage,field,button,update,get tree(){return tree;},get overlay(){return overlay;},async close(){component.unmount();await vite.close();globalThis.fetch=previousFetch;(globalThis as any).sessionStorage=previousStorage;}};
}
function evidence(action:string){return{id:"inspection",action,assetId:image.id,sourceRevision:image.revision,sourceContentHash:image.contentHash,total:2,start:0,end:2,offset:0,limit:action==="detect"?128:16,algorithmVersion:"alpha-runs-8-v1",parameterHash:"params",detection:{alphaThreshold:16,minComponentPixels:1},discardedCount:0,discardedPixels:0,diagnostics:[],images:[],width:32,height:32,blocking:false,suggestedOutput:{width:12,height:13},candidates:[{key:"b".repeat(64),box:[1,2,12,15],pixelCount:8},{key:"c".repeat(64),box:[20,2,25,15],pixelCount:9}],rectangles:[{index:0,box:[1,2,12,15],enabled:true},{index:1,box:[20,2,25,15],enabled:true}],frames:[]};}

test("actual SliceConfigPanel shares forms/JSON, preserves method drafts/IDs and explicitly groups/reorders",async()=>{
  const f=await fixture();try{
    f.button("编辑配置正文").props.onClick();await f.update();const original=f.field("切割配置正文").props.value;
    f.field("切割方法").props.onChange({target:{value:"boxes"}});await f.update();f.button("添加矩形").props.onClick();await f.update();
    f.field("矩形1右").props.onChange({target:{value:"12"}});await f.update();const boxes=f.field("切割配置正文").props.value;assert.deepEqual(JSON.parse(boxes).slicing.items[0].box,[0,0,12,32]);
    f.field("切割方法").props.onChange({target:{value:"components"}});await f.update();let request:any;
    globalThis.fetch=async(_url,options)=>{request=JSON.parse(String(options?.body));return json(evidence("detect"));};
    f.button("检测透明组件").props.onClick();await f.update();assert.equal(request.action,"detect");assert.equal("items" in request,false);assert.equal("text" in request,false);assert.deepEqual(f.overlay.rectangles[0].box,[1,2,12,15]);
    f.field(`组件${"b".repeat(8)}`).props.onChange({target:{checked:true}});f.field(`组件${"c".repeat(8)}`).props.onChange({target:{checked:true}});await f.update();
    f.button("将所选组件分为新帧").props.onClick();await f.update();let body=JSON.parse(f.field("切割配置正文").props.value);assert.equal(body.slicing.items[0].componentKeys.length,2);assert.equal(body.slicing.items[0].id,undefined);
    f.field("条目1身份").props.onChange({target:{value:id(2)}});await f.update();f.field(`组件${"c".repeat(8)}`).props.onChange({target:{checked:true}});await f.update();f.button("将所选组件分为新帧").props.onClick();await f.update();
    f.field("上移条目2").props.onClick();await f.update();body=JSON.parse(f.field("切割配置正文").props.value);assert.equal(body.slicing.items[1].id,id(2));assert.equal(body.slicing.items[0].componentKeys.length,1);
    f.field("切割方法").props.onChange({target:{value:"boxes"}});await f.update();assert.equal(f.field("切割配置正文").props.value,boxes);
    f.field("切割方法").props.onChange({target:{value:"grid"}});await f.update();assert.equal(f.field("切割配置正文").props.value,original);
  }finally{await f.close();}
});

test("actual SliceConfigPanel rejects late ABA previews and preserves input typed during a save",async()=>{
  const f=await fixture();try{
    f.button("编辑配置正文").props.onClick();await f.update();const original=f.field("切割配置正文").props.value;let release!:(response:Response)=>void;
    globalThis.fetch=async()=>new Promise<Response>(resolve=>{release=resolve;});f.button("预览未保存配方").props.onClick();await f.update();
    f.field("切割配置正文").props.onChange({target:{value:"{"}});await f.update();f.field("切割配置正文").props.onChange({target:{value:original}});await f.update();release(json(evidence("preview")));await f.update();
    assert.equal(descendants(f.tree).some(n=>n.props?.["aria-label"]==="切割预览"),false);assert.equal(f.overlay,null);
    const submitted=structuredClone(initial);submitted.slicing.items[0]!.name="submitted";const submittedText=JSON.stringify(submitted);f.field("切割配置正文").props.onChange({target:{value:submittedText}});await f.update();
    f.button("保存配置").props.onClick();await f.update();const latest=structuredClone(submitted);latest.slicing.items[0]!.name="newer while saving";const latestText=JSON.stringify(latest);f.field("切割配置正文").props.onChange({target:{value:latestText}});await f.update();
    release(json([document(submittedText,"d2")]));await f.update();assert.equal(f.field("切割配置正文").props.value,latestText);assert.match(text(f.tree),/本地草稿已保留/);
    const stored=JSON.parse([...f.storage.values()][0]!);assert.equal(stored.text,latestText);assert.equal(stored.base,"d1");assert.equal(f.button("保存配置").props.disabled,true);
  }finally{await f.close();}
});

test("actual SliceConfigPanel 409 retains JSON/base and reload does not overwrite a newer edit",async()=>{
  const f=await fixture();try{
    f.button("编辑配置正文").props.onClick();await f.update();const mine=JSON.stringify({...initial,slicing:{...initial.slicing,outputFolder:"原图素材/mine"}});
    f.field("切割配置正文").props.onChange({target:{value:mine}});await f.update();globalThis.fetch=async()=>json({error:"VERSION_CONFLICT"},409);
    f.button("保存配置").props.onClick();await f.update();assert.equal(f.field("切割配置正文").props.value,mine);assert.equal(JSON.parse([...f.storage.values()][0]!).base,"d1");
    let release!:(response:Response)=>void;globalThis.fetch=async()=>new Promise<Response>(resolve=>{release=resolve;});f.button("读取新版本").props.onClick();await f.update();
    const newer=mine+"\n";f.field("切割配置正文").props.onChange({target:{value:newer}});await f.update();release(json(document(JSON.stringify(initial),"d3")));await f.update();
    assert.equal(f.field("切割配置正文").props.value,newer);assert.match(text(f.tree),/本地草稿已保留/);
  }finally{await f.close();}
});
