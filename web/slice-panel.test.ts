import test from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import type {SheetDocument} from '../studio/sheets.ts';
import type {ImageAsset} from '../studio/model.ts';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const image:ImageAsset={id:id(1),type:'image',kind:'image',name:'sheet',revision:'source-1',contentHash:'a'.repeat(64),file:'sheet.png',createdAt:'now',width:64,height:32,frameCount:1,mime:'image/png'};
const initial={schemaVersion:3 as const,type:'sheet-recipe' as const,slicing:{output:{width:32,height:32,scale:1,alignment:'center' as const},outputFolder:'原图素材/test',items:[{id:id(2),name:'first',enabled:true,box:[0,0,32,32] as [number,number,number,number]},{id:id(3),name:'second',enabled:true,box:[32,0,64,32] as [number,number,number,number]}]}};
const document=(text=JSON.stringify(initial),revision='d1'):SheetDocument=>({documentId:image.id,path:'sheet.recipe.json',text,documentRevision:revision,definitionRevision:revision,exists:true,recipe:JSON.parse(text),status:'dirty',outputIds:[]});
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
function nodes(tree:any):any[]{return Array.isArray(tree)?tree.flatMap(nodes):tree&&typeof tree==='object'?[tree,...nodes(tree.props?.children),...nodes(tree.children)]:[];}
function text(tree:any):string{return typeof tree==='string'?tree:Array.isArray(tree)?tree.map(text).join(''):tree&&typeof tree==='object'?text(tree.props?.children):'';}
function mount(Component:(props:any)=>any){
  const cells:any[]=[],cleanups:any[]=[];let cursor=0,dirty=true,tree:any,props:any,effects:any[]=[];
  const internals=(React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const same=(a:any[],b:any[])=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
  const dispatcher={
    useState(initial:any){const i=cursor++;if(!(i in cells))cells[i]=typeof initial==='function'?initial():initial;return[cells[i],(value:any)=>{const v=typeof value==='function'?value(cells[i]):value;if(!Object.is(cells[i],v)){cells[i]=v;dirty=true;}}];},
    useRef(initial:any){return cells[cursor++]??={current:initial};},
    useEffect(run:any,deps:any[]){const i=cursor++;if(!same(cells[i],deps)){cells[i]=deps;effects.push({i,run});}},
  };
  const render=(next=props)=>{props=next;dirty=true;for(let n=0;dirty;n++){assert.ok(n<40,'effects settle');dirty=false;cursor=0;effects=[];const old=internals.H;internals.H=dispatcher;try{tree=Component(props);}finally{internals.H=old;}for(const{i,run}of effects){cleanups[i]?.();cleanups[i]=run();}}return tree;};
  return{render,async settle(delay=0){if(delay)await new Promise(r=>setTimeout(r,delay));for(let i=0;i<8;i++){await new Promise(r=>setImmediate(r));if(dirty)render();}return tree;},unmount(){cleanups.forEach(c=>c?.());}};
}
function evidence(){return{id:'inspection',action:'preview',assetId:image.id,sourceRevision:image.revision,sourceContentHash:image.contentHash,total:2,start:0,end:2,limit:16,width:32,height:32,blocking:false,diagnostics:[],images:[],frameImages:initial.slicing.items.map((_,index)=>({index,raw:{hash:`raw${index}`,url:`/raw${index}.png`},output:{hash:`out${index}`,url:`/out${index}.png`}}))};}
async function fixture(propertiesHost:HTMLElement|null=null){
  const oldFetch=globalThis.fetch,oldStorage=(globalThis as any).sessionStorage,storage=new Map<string,string>();
  (globalThis as any).sessionStorage={getItem:(k:string)=>storage.get(k)||null,setItem:(k:string,v:string)=>storage.set(k,v),removeItem:(k:string)=>storage.delete(k)};
  const vite=await createServer({configFile:false,root:fileURLToPath(new URL('../',import.meta.url)),server:{middlewareMode:true,hmr:false},appType:'custom'});
  const {SliceWorkbench}=await vite.ssrLoadModule('/web/SliceWorkbench.tsx'),component=mount(SliceWorkbench);
  globalThis.fetch=async(_url,options)=>options?.method==='POST'?json(evidence()):json(document());
  const props={projectId:id(4),image,propertiesHost,refreshToken:'1',onRefresh:async()=>{},disabled:false};
  let tree=component.render(props);tree=await component.settle();
  return{Component:SliceWorkbench,component,storage,props,get tree(){return tree;},async update(delay=0){tree=await component.settle(delay);},button(label:string){const n=nodes(tree).find(n=>n.type==='button'&&text(n)===label);assert.ok(n,`button ${label}`);return n;},key(key:string,extra:any={}){tree.props.onKeyDown({key,target:{closest:()=>null},preventDefault(){},...extra});},async close(){component.unmount();await vite.close();globalThis.fetch=oldFetch;(globalThis as any).sessionStorage=oldStorage;}};
}
test('JSON-added regions can move, resize and undo/redo without losing their local keys',async()=>{
  const f=await fixture({nodeType:1} as HTMLElement);
  const oldRaf=globalThis.requestAnimationFrame,oldCancel=globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame=()=>1;globalThis.cancelAnimationFrame=()=>{};
  const inspector=()=>nodes(f.tree).find(n=>typeof n.type==='function'&&n.type.name==='SliceConfigPanel').props;
  const stored=()=>JSON.parse([...f.storage.values()].find(v=>v.includes('"base"'))!);
  try {
    const next:Record<string,any>=structuredClone(initial);
    next.slicing.items.push({name:'new',enabled:true,box:[20,5,40,25]});
    inspector().onText(JSON.stringify(next));await f.update();
    const newKey=stored().keys[2];assert.ok(newKey);assert.equal(new Set(stored().keys).size,3);
    nodes(f.tree).find(n=>n.props?.['aria-label']==='选择原帧 3').props.onClick();await f.update();
    const svg={getBoundingClientRect:()=>({left:0,top:0,width:64,height:32}),hasPointerCapture:()=>false};
    nodes(f.tree).find(n=>n.props?.className==='artboard slice-artboard').props.ref.current={querySelector:()=>svg};
    nodes(f.tree).find(n=>n.props?.['aria-label']==='切割画布，拖动编辑区域，方向键微移').props.ref.current={focus(){}};
    async function drag(start:number[],end:number[]) {
      const event=([clientX,clientY]:number[])=>({button:0,pointerId:1,clientX,clientY,currentTarget:{setPointerCapture(){}},preventDefault(){}});
      nodes(f.tree).find(n=>n.type==='svg').props.onPointerDown(event(start));await f.update();
      nodes(f.tree).find(n=>n.type==='svg').props.onPointerUp(event(end));await f.update();
    }
    await drag([30,15],[35,15]);assert.deepEqual(inspector().recipe.slicing.items[2].box,[25,5,45,25]);
    await drag([45,15],[50,15]);assert.deepEqual(inspector().recipe.slicing.items[2].box,[25,5,50,25]);
    assert.equal(stored().keys[2],newKey);
    f.key('z',{ctrlKey:true});await f.update();assert.deepEqual(inspector().recipe.slicing.items[2].box,[25,5,45,25]);
    f.key('z',{ctrlKey:true});await f.update();assert.deepEqual(inspector().recipe.slicing.items[2].box,[20,5,40,25]);
    f.key('y',{ctrlKey:true});await f.update();f.key('y',{ctrlKey:true});await f.update();
    assert.deepEqual(inspector().recipe.slicing.items[2].box,[25,5,50,25]);assert.equal(stored().keys[2],newKey);
    const reordered=structuredClone(inspector().recipe);reordered.slicing.items.reverse();
    inspector().onText(JSON.stringify(reordered));await f.update();
    assert.equal(stored().keys[0],newKey);assert.equal(stored().keys[1],initial.slicing.items[1]!.id);
    const shortened=structuredClone(inspector().recipe);shortened.slicing.items.pop();
    inspector().onText(JSON.stringify(shortened));await f.update();assert.equal(inspector().selected,1);
    assert.equal(stored().keys.length,2);
  } finally {globalThis.requestAnimationFrame=oldRaf;globalThis.cancelAnimationFrame=oldCancel;await f.close();}
});

// Real component hook/effect paths; genuine pointer/layout behavior is checked in browser QA.
test('workbench exposes editable source regions and bottom strip; selection and micro-adjustment share stable frames',async()=>{
  const f=await fixture();try{
    assert.equal(nodes(f.tree).filter(n=>n.props?.className?.startsWith?.('region-box')).length,2);
    assert.equal(nodes(f.tree).filter(n=>n.props?.role==='option').length,2);
    const first=JSON.parse([...f.storage.values()][0]||'null');assert.equal(first,null);
    f.key('ArrowRight');await f.update();
    const saved=JSON.parse([...f.storage.values()][0]!);assert.deepEqual(JSON.parse(saved.text).slicing.items[0].box,[1,0,33,32]);assert.equal(JSON.parse(saved.text).slicing.items[0].id,id(2));
    assert.match(text(f.tree),/手动调整/);
    f.key('z',{ctrlKey:true});await f.update();const undone=JSON.parse([...f.storage.values()][0]!);assert.deepEqual(JSON.parse(undone.text).slicing.items[0].box,[0,0,32,32]);
    const second=nodes(f.tree).find(n=>n.props?.['aria-label']==='选择原帧 2');second.props.onClick();await f.update();assert.match(text(f.tree),/2 \/ 2/);
    assert.equal(nodes(f.tree).some(n=>n.props?.['aria-label']==='切割方法'),false);
  }finally{await f.close();}
});
test('workbench save ack cannot overwrite newer geometry or execute a superseded body',async()=>{
  const f=await fixture();try{
    let release!:(r:Response)=>void,executions=0;
    globalThis.fetch=async(url,options)=>{if(String(url).endsWith('/documents')&&options?.method==='POST')return new Promise<Response>(r=>{release=r;});if(String(url).endsWith('/slice-config'))executions++;return json(evidence());};
    f.key('s',{ctrlKey:true});await f.update();f.key('ArrowRight');await f.update();
    release(json([document(JSON.stringify(initial),'d2')]));await f.update();
    const stored=JSON.parse([...f.storage.values()][0]!);assert.deepEqual(JSON.parse(stored.text).slicing.items[0].box,[1,0,33,32]);assert.equal(stored.base,'d1');assert.equal(executions,0);
    assert.equal(f.button('保存当前切割').props.disabled,true);
  }finally{await f.close();}
});
test('regenerating regions previews the visible new batch instead of only the selected thumbnail',async()=>{
  const f=await fixture();try{
    await f.update(380);assert.ok(nodes(f.tree).some(n=>n.type==='img'&&String(n.props.src).startsWith('/raw')));
    const generated=structuredClone(initial);generated.slicing.items[0]!.box=[5,5,20,25];generated.slicing.items[1]!.box=[40,5,55,25];generated.slicing.output.width=15;generated.slicing.output.height=20;
    let requestedLimit=0;
    globalThis.fetch=async(_url,options)=>{const body=JSON.parse(String(options?.body));if(body.action==='generate')return json({...evidence(),action:'generate',recipe:generated});requestedLimit=body.limit;return json({...evidence(),width:15,height:20});};
    f.button('自动识别').props.onClick();await f.update();f.button('识别区域').props.onClick();await f.update();f.button('替换区域').props.onClick();await f.update();await f.update(380);
    assert.equal(requestedLimit,16);assert.equal(nodes(f.tree).filter(n=>n.type==='img'&&String(n.props.src).startsWith('/raw')).length,2);
  }finally{await f.close();}
});

test('queued grid generation cannot replace a subsequent manual edit (controlled debounce clock)',async()=>{
  const f=await fixture();const originalTimeout=globalThis.setTimeout,originalClear=globalThis.clearTimeout;
  const timers=new Map<number,()=>void>();let next=-1,generations=0;
  try {
    globalThis.fetch=async(_url,options)=>{const body=options?.body?JSON.parse(String(options.body)):null;if(body?.action==='generate'){generations++;return json({...evidence(),action:'generate',recipe:initial});}return body?json(evidence()):json(document());};
    f.button('网格生成').props.onClick();await f.update();f.button('生成网格区域').props.onClick();await f.update();f.button('替换区域').props.onClick();await f.update();
    assert.match(text(f.tree),/网格生成结果/);f.button('网格生成').props.onClick();await f.update();
    (globalThis as any).setTimeout=(callback:any,delay:any,...args:any[])=>{if(delay===350){const handle=next--;timers.set(handle,()=>callback(...args));return handle;}return originalTimeout(callback,delay,...args);};
    (globalThis as any).clearTimeout=(handle:any)=>{if(timers.has(handle))timers.delete(handle);else originalClear(handle);};
    const columns=nodes(f.tree).find(n=>n.props?.['aria-label']==='生成网格列数');columns.props.onChange({target:{value:'3'}});await f.update();
    f.key('ArrowRight');await f.update();for(const callback of [...timers.values()])callback();timers.clear();await f.update();
    assert.equal(generations,1);assert.match(text(f.tree),/手动调整/);
    assert.deepEqual(JSON.parse(JSON.parse([...f.storage.values()].find(v=>v.includes('"base"'))!).text).slicing.items[0].box,[1,0,33,32]);
  }finally{timers.clear();globalThis.setTimeout=originalTimeout;globalThis.clearTimeout=originalClear;await f.close();}
});
test('unmounted save completions cannot overwrite a revisited editor draft or dispatch a stale slice',async()=>{
  for(const status of [200,409]){
    const f=await fixture();let revisit:ReturnType<typeof mount>|undefined;
    try {
      let release!:(response:Response)=>void,executions=0;
      globalThis.fetch=async(url,options)=>{if(String(url).endsWith('/documents')&&options?.method==='POST')return new Promise<Response>(r=>{release=r;});if(String(url).endsWith('/slice-config'))executions++;return options?.method==='POST'?json(evidence()):json(document());};
      f.key('s',{ctrlKey:true});await f.update();assert.ok(release);f.component.unmount();
      revisit=mount(f.Component);let tree=revisit.render(f.props);tree=await revisit.settle();
      tree.props.onKeyDown({key:'ArrowRight',target:{closest:()=>null},preventDefault(){}});tree=await revisit.settle();
      const stored=[...f.storage.values()].find(v=>v.includes('"base"'))!;assert.deepEqual(JSON.parse(JSON.parse(stored).text).slicing.items[0].box,[1,0,33,32]);
      release(status===200?json([document(JSON.stringify(initial),'d2')]):json({error:'VERSION_CONFLICT'},409));tree=await revisit.settle();
      assert.equal([...f.storage.values()].find(v=>v.includes('"base"')),stored);assert.equal(executions,0);
    }finally{revisit?.unmount();await f.close();}
  }
});

test('workbench rejects ABA preview responses instead of showing old thumbnails',async()=>{
  const f=await fixture();try{
    let release!:(r:Response)=>void;
    globalThis.fetch=async()=>new Promise<Response>(r=>{release=r;});await f.update(380);
    assert.ok(release);f.key('ArrowRight');await f.update();f.key('ArrowLeft');await f.update();
    release(json(evidence()));await f.update();
    assert.equal(nodes(f.tree).some(n=>n.type==='img'&&String(n.props.src).startsWith('/raw')),false);
  }finally{await f.close();}
});
