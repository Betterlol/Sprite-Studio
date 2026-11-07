import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {MousePointer2,SquareDashed,Grid2X2,Scan,Save,Undo2,Redo2,ZoomIn,ZoomOut,Maximize2,Trash2,Plus} from 'lucide-react';
import {assetUrl,type ImageAsset} from '../studio/model.ts';
import {sheetRecipeV3Schema,type SheetRecipeV3,type RegionItem,type SheetGrid} from '../studio/sheet-schema.ts';
import type {SheetDocument} from '../studio/sheets.ts';
import type {SheetInspection} from '../studio/sheet-inspection.ts';
import {api} from './api.ts';
import {SheetEditorState,parseSheet,type SheetToken} from './sheet-state.ts';
import {SliceConfigPanel} from './SliceConfigPanel.tsx';
import {RegionHistory,editedRegion,moveRegion,createRegionBox,sourcePoint,hitRegion,regionHandles,regionSignature,reconcileRegionKeys,regionShortcutAllowed,type RegionMode,type RegionSnapshot,type Box,type Handle} from './region-editor-state.ts';

const textOf=(recipe:SheetRecipeV3)=>JSON.stringify(recipe,null,2)+'\n';
const localKey=()=>globalThis.crypto?.randomUUID?.() || `local-${Date.now()}-${Math.random()}`;
type FrameImage=NonNullable<SheetInspection['frameImages']>[number];
type Drag={pointer:number;start:[number,number];box:Box;index:number;handle:Handle;generation:number;key:string;preview:Box};
export function SliceWorkbench({projectId,image,propertiesHost,refreshToken,onRefresh,disabled,onOpenFrame}:{
  projectId:string;image:ImageAsset;propertiesHost:HTMLElement|null;refreshToken:string;onRefresh:()=>Promise<void>;disabled:boolean;onOpenFrame?:(id:string)=>void;
}) {
  const source=`${projectId}:${image.id}:${image.revision}`;
  const editor=useRef(new SheetEditorState(source));
  if(editor.current.source!==source)editor.current=new SheetEditorState(source);
  const state=editor.current;
  const [,render]=useState(0),redraw=()=>render(n=>n+1);
  const [resolved,setResolved]=useState<{text:string;recipe:SheetRecipeV3}|null>(null);
  const parsed=parseSheet(state.text),recipe=parsed?.schemaVersion===3?parsed:resolved?.text===state.text?resolved.recipe:null;
  const current=useRef({recipe,state});current.current={recipe,state};
  const [selected,setSelected]=useState(0),[mode,setMode]=useState<RegionMode>('manual');
  const modeRef=useRef(mode);modeRef.current=mode;
  const [busy,setBusy]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [tool,setTool]=useState<'select'|'create'>('select');
  const [view,setView]=useState<'source'|'raw'|'output'>('source');
  const [generator,setGenerator]=useState<'grid'|'components'|null>(null);
  const [grid,setGrid]=useState<SheetGrid>({columns:Math.min(4,image.width),rows:1,margin:[0,0,0,0],spacing:[0,0]});
  const [gridVersion,setGridVersion]=useState(0),[detection,setDetection]=useState({alphaThreshold:16,minComponentPixels:1});
  const [replace,setReplace]=useState<'grid'|'components'|null>(null);
  const history=useRef(new RegionHistory()),keys=useRef<string[]>([]);
  const frameCache=useRef(new Map<string,FrameImage>());
  const [preview,setPreview]=useState<{text:string;value:SheetInspection}|null>(null),[previewLoading,setPreviewLoading]=useState(false);
  const [zoom,setZoom]=useState<number|'fit'>('fit'),[size,setSize]=useState({width:500,height:400});
  const stage=useRef<HTMLDivElement>(null),artboard=useRef<HTMLDivElement>(null);
  const drag=useRef<Drag|null>(null),raf=useRef(0),[ghost,setGhost]=useState<{index:number;box:Box}|null>(null);
  const docSequence=useRef(0),previewSequence=useRef(0),sourceSequence=useRef(0);
  const generatorSequence=useRef(0),gridApplied=useRef(0);
  const [gridPending,setGridPending]=useState(false);
  const alive=(epoch:number)=>sourceSequence.current === epoch && editor.current === state;
  const latest=useRef({image,onRefresh,disabled});latest.current={image,onRefresh,disabled};
  const storageKey=`studio.recipe.${projectId}.${image.id}`;
  const selectedItem=recipe?.slicing.items[selected];
  function persist(){sessionStorage.setItem(storageKey,JSON.stringify({text:state.text,base:state.base,mode:modeRef.current,keys:keys.current,selected}));}
  function snapshot():RegionSnapshot{return {text:recipe?textOf(recipe):state.text,mode:modeRef.current,selected,keys:[...keys.current]};}
  function ensureKeys(value:SheetRecipeV3){if(keys.current.length!==value.slicing.items.length)keys.current=value.slicing.items.map(i=>i.id||localKey());}
  function commit(next:SheetRecipeV3,nextMode:RegionMode='manual',index=selected,nextKeys=keys.current){
    const before=snapshot(),text=textOf(next);
    if(recipe&&text===textOf(recipe))return;
    const after={text,mode:nextMode,selected:Math.max(0,Math.min(index,next.slicing.items.length-1)),keys:[...nextKeys]};
    history.current.record(before,after);keys.current=[...nextKeys];state.edit(text);modeRef.current=nextMode;
    if(nextMode==='manual'){generatorSequence.current++;setGridPending(false);setBusy(value=>value==='generate'?'':value);}
    setMode(nextMode);setSelected(after.selected);setError('');setNotice('');persist();redraw();
  }
  function restore(value:RegionSnapshot|undefined){if(!value)return;cancelDrag();generatorSequence.current++;gridApplied.current=gridVersion;setGridPending(false);setBusy(v=>v==='generate'?'':v);state.edit(value.text);keys.current=value.keys?[...value.keys]:[];modeRef.current=value.mode;setMode(value.mode);setSelected(value.selected);setError('');persist();redraw();}
  function undo(){restore(history.current.undo(snapshot()));}
  function redo(){restore(history.current.redo(snapshot()));}
  function editText(text:string){
    const before=snapshot(),value=parseSheet(text);
    let index=selected;
    if(value?.schemaVersion===3){
      keys.current=reconcileRegionKeys(recipe?.slicing.items||[],keys.current,value.slicing.items,localKey);
      index=Math.max(0,Math.min(selected,value.slicing.items.length-1));
    }
    history.current.record(before,{text,mode:'manual',selected:index,keys:[...keys.current]});
    generatorSequence.current++;setGridPending(false);setBusy(v=>v==='generate'?'':v);state.edit(text);modeRef.current='manual';setMode('manual');setSelected(index);persist();redraw();
  }
  function editItem(next:RegionItem){if(!recipe||!selectedItem)return;const value=structuredClone(recipe);value.slicing.items[selected]=next;commit(value);}
  function editBox(box:Box){if(selectedItem)editItem(editedRegion(selectedItem,box));}
  function remove(){if(!recipe||!selectedItem)return;const next=structuredClone(recipe);next.slicing.items.splice(selected,1);const k=[...keys.current];k.splice(selected,1);commit(next,'manual',Math.min(selected,next.slicing.items.length-1),k);}
  function duplicate(){if(!recipe||!selectedItem||recipe.slicing.items.length>=128)return;const next=structuredClone(recipe),{id,...copy}=selectedItem;next.slicing.items.splice(selected+1,0,{...copy,name:selectedItem.name+' 副本'});const k=[...keys.current];k.splice(selected+1,0,localKey());commit(next,'manual',selected+1,k);}
  function reorder(delta:number){if(!recipe||!selectedItem||selected+delta<0||selected+delta>=recipe.slicing.items.length)return;const next=structuredClone(recipe),k=[...keys.current],target=selected+delta;[next.slicing.items[selected],next.slicing.items[target]]=[next.slicing.items[target]!,next.slicing.items[selected]!];[k[selected],k[target]]=[k[target]!,k[selected]!];commit(next,'manual',target,k);}
  function select(index:number){cancelDrag();setSelected(Math.max(0,index));}
  function validResponse(result:SheetInspection){if(result.assetId!==image.id||result.sourceRevision!==image.revision)throw new Error('预览来源已变化，请刷新');}
  async function materialize(raw:string,token:SheetToken,newDocument:boolean){
    const epoch=sourceSequence.current;
    const value=parseSheet(raw);if(!value)return;
    if(value.schemaVersion===3){ensureKeys(value);setResolved(null);return;}
    const isNew=newDocument&&!value.slicing.items.length;
    const initialGrid='method'in value.slicing&&value.slicing.method==='grid'?value.slicing.grid:grid;
    const response=await api<SheetInspection>(`/api/projects/${projectId}/sheet-inspections`,{method:'POST',body:JSON.stringify({assetId:image.id,expectedSourceRevision:image.revision,...(isNew?{action:'generate',method:'grid',grid:initialGrid}:{action:'resolve',text:raw})})});
    if(!alive(epoch)||!state.current(token))return;validResponse(response);
    const unified=sheetRecipeV3Schema.parse(response.recipe);setResolved({text:raw,recipe:unified});ensureKeys(unified);
    if(isNew){modeRef.current='grid';setMode('grid');setGrid(initialGrid);setGenerator('grid');}
  }
  useEffect(()=>{
    sourceSequence.current++;generatorSequence.current++;gridApplied.current=gridVersion;setGridPending(false);setPreviewLoading(false);history.current=new RegionHistory();keys.current=[];frameCache.current.clear();setResolved(null);setPreview(null);setSelected(0);setMode('manual');modeRef.current='manual';setError('');setNotice('');setBusy('');setGhost(null);drag.current=null;
    return ()=>{sourceSequence.current++;if(raf.current)cancelAnimationFrame(raf.current);};
  },[source]);
  useEffect(()=>{
    let cancelled=false;const epoch=sourceSequence.current,request=++docSequence.current,token=state.token();
    void api<SheetDocument>(`/api/projects/${projectId}/documents/${image.id}`).then(async next=>{
      if(cancelled||!alive(epoch)||request!==docSequence.current)return;
      let saved:any=null;try{saved=JSON.parse(sessionStorage.getItem(storageKey)||'null');}catch{}
      const previous=state.text;
      if(state.loaded&&!state.current(token)){state.document=next;if(state.base!==next.documentRevision)state.conflict();}
      else state.read(next,saved);
      if(saved?.keys?.length&&!keys.current.length)keys.current=saved.keys;
      if(!state.loaded)return;
      const resolveToken=state.token();redraw();
      if(previous!==state.text||!current.current.recipe)await materialize(state.text,resolveToken,!next.exists);
      if(alive(epoch))redraw();
    }).catch(e=>{if(!cancelled&&alive(epoch))setError(e.message);});
    return ()=>{cancelled=true;};
  },[source,refreshToken]);
  useEffect(()=>{
    const element=stage.current;if(!element)return;
    const observer=new ResizeObserver(entries=>{const r=entries[0]!.contentRect;setSize({width:Math.max(1,r.width-64),height:Math.max(1,r.height-64)});});observer.observe(element);return()=>observer.disconnect();
  },[]);
  async function performGenerate(method:'grid'|'components'){
    const epoch=sourceSequence.current,generation=++generatorSequence.current,token=state.token();
    if(method==='grid')gridApplied.current=gridVersion;
    setGridPending(false);setBusy('generate');setError('');setNotice('');
    try{
      const result=await api<SheetInspection>(`/api/projects/${projectId}/sheet-inspections`,{method:'POST',body:JSON.stringify({action:'generate',method,assetId:image.id,expectedSourceRevision:image.revision,...(method==='grid'?{grid}:{detection}),text:recipe?textOf(recipe):state.text})});
      if(!alive(epoch)||generation!==generatorSequence.current||!state.current(token))return;validResponse(result);
      const next=sheetRecipeV3Schema.parse(result.recipe);
      const nextKeys=next.slicing.items.map(i=>{const old=recipe?.slicing.items.findIndex(v=>v.id&&v.id===i.id)??-1;return old>=0?keys.current[old]!:localKey();});
      commit(next,method,0,nextKeys);modeRef.current=method;setMode(method);setGenerator(null);setView('source');setNotice(result.diagnostics.map(d=>d.message).join('；'));
    }catch(e:any){if(alive(epoch)&&generation===generatorSequence.current&&state.current(token))setError(e.message);}
    finally{if(alive(epoch)&&generation===generatorSequence.current)setBusy('');}
  }
  function requestGenerate(method:'grid'|'components'){
    if(recipe?.slicing.items.length&&modeRef.current==='manual'){setReplace(method);return;}
    void performGenerate(method);
  }
  function changeGrid(next:SheetGrid){setGrid(next);generatorSequence.current++;setBusy(v=>v==='generate'?'':v);sessionStorage.setItem(storageKey+'.generator',JSON.stringify(next));if(modeRef.current==='grid'){setGridPending(true);setGridVersion(n=>n+1);}}
  function changeDetection(next:typeof detection){generatorSequence.current++;setBusy(v=>v==='generate'?'':v);setDetection(next);}
  useEffect(()=>{
    if(!gridVersion||gridApplied.current===gridVersion||mode!=='grid'){setGridPending(false);return;}
    const epoch=sourceSequence.current,token=state.token(),parameters=generatorSequence.current;
    const timer=setTimeout(()=>{
      if(!alive(epoch))return;
      if(!state.current(token)||modeRef.current!=='grid'||generatorSequence.current!==parameters){setGridPending(false);return;}
      void performGenerate('grid');
    },350);
    return()=>clearTimeout(timer);
  },[gridVersion,mode,source]);
  const signature=selectedItem?regionSignature(selectedItem,recipe!.slicing.output):'';
  const outputKey=recipe?JSON.stringify(recipe.slicing.output):'';
  useEffect(()=>{
    if(!recipe)return;
    if(preview?.text===state.text&&(!selectedItem?.enabled||frameCache.current.has(signature)))return;
    const epoch=sourceSequence.current,sequence=++previewSequence.current,token=state.token(),captured=recipe;
    const enabledItems=recipe.slicing.items.filter(item=>item.enabled);
    const enabledBefore=recipe.slicing.items.slice(0,selected).filter(i=>i.enabled).length;
    const position=selectedItem?.enabled?enabledBefore:0,page=Math.floor(position/16)*16;
    const missing=enabledItems.slice(page,page+16).filter(item=>!frameCache.current.has(regionSignature(item,recipe.slicing.output))).length;
    const start=missing>1?page:position,limit=missing>1?16:1;
    const timer=setTimeout(()=>{
      if(!alive(epoch)||!state.current(token)||sequence!==previewSequence.current)return;
      setPreviewLoading(true);
      void api<SheetInspection>(`/api/projects/${projectId}/sheet-inspections`,{method:'POST',body:JSON.stringify({action:'preview',assetId:image.id,expectedSourceRevision:image.revision,text:textOf(captured),start,limit})}).then(value=>{
        if(!alive(epoch)||!state.current(token)||sequence!==previewSequence.current)return;validResponse(value);
        for(const frame of value.frameImages||[]){const item=captured.slicing.items[frame.index];if(item)frameCache.current.set(regionSignature(item,captured.slicing.output),frame);}
        while(frameCache.current.size>512)frameCache.current.delete(frameCache.current.keys().next().value!);
        setPreview({text:token.text,value});setError('');
      }).catch(e=>{if(alive(epoch)&&state.current(token)&&sequence===previewSequence.current)setError(e.message);})
        .finally(()=>{if(alive(epoch)&&sequence===previewSequence.current)setPreviewLoading(false);});
    },preview?.text===state.text?0:350);
    return()=>{clearTimeout(timer);};
  },[source,state.text,selected,signature,!!recipe,outputKey]);
  function acknowledgeHistory(submittedKeys:string[],saved:SheetRecipeV3){
    const assigned=new Map(submittedKeys.map((key,index)=>[key,saved.slicing.items[index]?.id]));
    for(const stack of [history.current.past,history.current.future])for(const entry of stack){
      const value=parseSheet(entry.text);if(value?.schemaVersion!==3||!entry.keys)continue;
      value.slicing.items.forEach((item,index)=>{if(!item.id){const id=assigned.get(entry.keys![index]!);if(id)item.id=id;}});entry.text=textOf(value);
    }
  }
  async function save(execute:boolean){
    if(!recipe||state.external||latest.current.disabled||busy||gridPending)return;
    const epoch=sourceSequence.current,token=state.token(),submittedKeys=[...keys.current],body=textOf(recipe);let savedConfig=false;
    setBusy('save');setError('');setNotice('');
    try{
      const docs=await api<SheetDocument[]>(`/api/projects/${projectId}/documents`,{method:'POST',body:JSON.stringify({documents:[{documentId:image.id,expectedDocumentRevision:token.base,text:body}]})});
      const next=docs[0];if(!next||next.documentId!==image.id)throw new Error('保存返回了不匹配的区域配置');
      if(!alive(epoch))return;
      const unchanged=state.current(token);state.saved(next,token);savedConfig=true;
      if(next.recipe.schemaVersion===3)acknowledgeHistory(submittedKeys,next.recipe);
      persist();redraw();
      if(execute&&unchanged&&!state.external){
        const result=await api<{outputIds:string[]}>(`/api/projects/${projectId}/assets/${image.id}/slice-config`,{method:'POST',body:JSON.stringify({expectedDefinitionRevision:next.definitionRevision,requestId:crypto.randomUUID()})});
        if(!alive(epoch))return;setNotice(`已保存 ${result.outputIds.length} 帧切片`);
      }else setNotice(execute?'配置已保存；检测到新的本地编辑，尚未执行切割':'区域配置已保存，尚未执行切割');
      await latest.current.onRefresh();
    }catch(e:any){if(!alive(epoch))return;if(e.status===409)state.conflict();setError((savedConfig?'配置已保存，切片未更新：':'')+e.message);persist();redraw();}
    finally{if(alive(epoch))setBusy('');}
  }
  async function reload(){
    const epoch=sourceSequence.current,token=state.token(),sequence=++docSequence.current;setBusy('reload');setError('');
    try{const next=await api<SheetDocument>(`/api/projects/${projectId}/documents/${image.id}`);if(!alive(epoch)||sequence!==docSequence.current)return;state.document=next;if(!state.current(token)){state.conflict();redraw();return;}state.reload();history.current=new RegionHistory();keys.current=[];await materialize(state.text,state.token(),!next.exists);if(!alive(epoch))return;persist();redraw();}
    catch(e:any){if(alive(epoch))setError(e.message);}finally{if(alive(epoch))setBusy('');}
  }
  function point(event:{clientX:number;clientY:number}):[number,number]{const bounds=(artboard.current!.querySelector('svg')||artboard.current!).getBoundingClientRect();return sourcePoint([event.clientX,event.clientY],bounds,[image.width,image.height]);}
  function beginDrag(event:React.PointerEvent<SVGSVGElement>){
    if(event.button!==0||!recipe||view!=='source')return;
    const start=point(event),hit=tool==='create'?null:hitRegion(recipe.slicing.items,selected,start,7/scale);
    if(!hit&&recipe.slicing.items.length>=128){setError('最多128个区域');return;}
    event.preventDefault();stage.current?.focus();
    const index=hit?.index??recipe.slicing.items.length;
    if(hit)setSelected(index);
    drag.current={pointer:event.pointerId,start,index,handle:hit?.handle??'create',box:hit?recipe.slicing.items[index]!.box:[...start,...start],generation:state.generation,key:keys.current[index]||'',preview:hit?recipe.slicing.items[index]!.box:[...start,...start]};
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }
  function updateDrag(event:{pointerId:number;clientX:number;clientY:number}){
    const d=drag.current;if(!d||d.pointer!==event.pointerId)return;
    const end=point(event);d.preview=d.handle==='create'?createRegionBox(d.start,end,[image.width,image.height]):moveRegion(d.box,d.handle,[end[0]-d.start[0],end[1]-d.start[1]],[image.width,image.height]);
    if(!raf.current)raf.current=requestAnimationFrame(()=>{raf.current=0;if(drag.current===d)setGhost({index:d.index,box:d.preview});});
  }
  function cancelDrag(){
    const previous=drag.current;drag.current=null;
    const svg=artboard.current?.querySelector('svg');
    if(previous&&svg?.hasPointerCapture(previous.pointer))svg.releasePointerCapture(previous.pointer);
    if(raf.current)cancelAnimationFrame(raf.current);raf.current=0;setGhost(null);
  }
  function finishDrag(event:React.PointerEvent<SVGSVGElement>){
    const d=drag.current;if(!d||d.pointer!==event.pointerId)return;updateDrag(event);cancelDrag();
    if(!recipe||state.generation!==d.generation||(d.handle!=='create'&&keys.current[d.index]!==d.key))return;
    const [l,t,r,b]=d.preview;if(r-l<1||b-t<1)return;
    const next=structuredClone(recipe),nextKeys=[...keys.current];
    if(d.handle==='create'){next.slicing.items.push({name:`${next.slicing.items.length+1}`.padStart(2,'0'),enabled:true,box:d.preview});nextKeys.push(localKey());}
    else {if(d.preview.every((v,i)=>v===d.box[i]))return;next.slicing.items[d.index]=editedRegion(next.slicing.items[d.index]!,d.preview);}
    commit(next,'manual',d.index,nextKeys);
  }
  function keyDown(event:React.KeyboardEvent){
    if(!regionShortcutAllowed(event.target))return;
    if(event.key==='Escape'){event.preventDefault();cancelDrag();setReplace(null);return;}
    if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'){event.preventDefault();void save(true);return;}
    if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'){event.preventDefault();event.shiftKey?redo():undo();return;}
    if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='y'){event.preventDefault();redo();return;}
    if(!selectedItem)return;
    if(event.key==='Delete'||event.key==='Backspace'){event.preventDefault();cancelDrag();remove();return;}
    const direction:Record<string,[number,number]>={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};
    if(direction[event.key]){event.preventDefault();cancelDrag();const [x,y]=direction[event.key]!,n=event.shiftKey?10:1;editBox(moveRegion(selectedItem.box,'move',[x*n,y*n],[image.width,image.height]));}
  }
  const frameImage=signature?frameCache.current.get(signature):undefined;
  const viewingSource=view==='source';
  const logicalWidth=viewingSource?image.width:view==='raw'&&selectedItem?selectedItem.box[2]-selectedItem.box[0]:recipe?.slicing.output.width||image.width;
  const logicalHeight=viewingSource?image.height:view==='raw'&&selectedItem?selectedItem.box[3]-selectedItem.box[1]:recipe?.slicing.output.height||image.height;
  const scale=zoom==='fit'?Math.max(.01,Math.min(size.width/logicalWidth,size.height/logicalHeight,4)):zoom;
  const currentPreview=preview?.text===state.text?preview.value:null;
  const dirty=!!state.document&&state.text!==state.savedText;
  const enabled=recipe?.slicing.items.filter(i=>i.enabled).length||0;
  const savedItems=state.document?.recipe.slicing.items.filter(i=>i.enabled)||[];
  const savedIndex=selectedItem?.id?savedItems.findIndex(i=>i.id===selectedItem.id):-1;
  const savedImageId=savedIndex>=0?state.document?.outputIds[savedIndex]:undefined;
  const selectedBox=ghost?.index===selected?ghost.box:selectedItem?.box;
  const jsonText=parsed?.schemaVersion===3||!recipe?state.text:textOf(recipe);
  return <div className="slice-workbench" onKeyDown={keyDown}>
    <div className="slice-workbench-toolbar" aria-label="切割工具栏">
      <div className="region-tool-group"><button className={tool==='select'?'is-active':''} aria-label="选择和移动区域" onClick={()=>{cancelDrag();setTool('select');setView('source');}}><MousePointer2 size={15}/><span>选择</span></button><button className={tool==='create'?'is-active':''} aria-label="在画布新增区域" onClick={()=>{cancelDrag();setTool('create');setView('source');}}><SquareDashed size={15}/><span>加框</span></button></div>
      <button onClick={()=>setGenerator(generator==='grid'?null:'grid')} aria-expanded={generator==='grid'}><Grid2X2 size={15}/>网格生成</button>
      <button onClick={()=>setGenerator(generator==='components'?null:'components')} aria-expanded={generator==='components'}><Scan size={15}/>自动识别</button>
      <span className="region-mode" role="status">{mode==='manual'?'手动调整':mode==='grid'?'网格生成结果':'自动识别结果'}</span>
      <div className="region-toolbar-spacer"/>
      <button aria-label="撤销区域修改" disabled={!history.current.past.length} onClick={undo}><Undo2 size={15}/></button><button aria-label="重做区域修改" disabled={!history.current.future.length} onClick={redo}><Redo2 size={15}/></button>
      <button className="primary" disabled={!recipe||!enabled||!!busy||gridPending||disabled||state.external} onClick={()=>void save(true)}><Save size={15}/>{busy==='save'?'正在保存…':'保存当前切割'}</button>
    </div>
    {generator&&<div className="region-generator" aria-label="生成区域参数">
      {generator==='grid'?<><label>列<input aria-label="生成网格列数" type="number" min={1} max={32} value={grid.columns} onChange={e=>changeGrid({...grid,columns:Math.max(1,Math.min(32,Number(e.target.value)))})}/></label><span>×</span><label>行<input aria-label="生成网格行数" type="number" min={1} max={32} value={grid.rows} onChange={e=>changeGrid({...grid,rows:Math.max(1,Math.min(32,Number(e.target.value)))})}/></label><details><summary>边距与间距</summary><div className="region-coordinate-grid">{grid.margin.map((n,i)=><label key={i}>{['上','右','下','左'][i]}<input aria-label={`生成边距${i}`} type="number" min={0} value={n} onChange={e=>{const next=structuredClone(grid);next.margin[i]=Math.max(0,Number(e.target.value));changeGrid(next);}}/></label>)}{grid.spacing.map((n,i)=><label key={`gap${i}`}>{i?'纵间距':'横间距'}<input aria-label={`生成间距${i}`} type="number" min={0} value={n} onChange={e=>{const next=structuredClone(grid);next.spacing[i]=Math.max(0,Number(e.target.value));changeGrid(next);}}/></label>)}</div></details></>:<><span>按真实透明度识别区域</span><details><summary>识别参数</summary><label>Alpha阈值<input aria-label="识别透明度阈值" type="number" min={0} max={255} value={detection.alphaThreshold} onChange={e=>changeDetection({...detection,alphaThreshold:Number(e.target.value)})}/></label><label>最小像素<input aria-label="识别最小像素" type="number" min={1} value={detection.minComponentPixels} onChange={e=>changeDetection({...detection,minComponentPixels:Number(e.target.value)})}/></label></details></>}
      <button disabled={!!busy||!state.document} onClick={()=>requestGenerate(generator)}>{busy==='generate'?'正在生成…':generator==='grid'?'生成网格区域':'识别区域'}</button><button aria-label="收起生成工具" onClick={()=>setGenerator(null)}>收起</button><small>生成只是起点，任何框都可继续手动修改。</small>
    </div>}
    {replace&&<div className="region-replace-confirm" role="dialog" aria-label="确认重新生成区域"><strong>重新生成将替换当前区域草案，手动调整不会自动保留。</strong><button className="primary" onClick={()=>{const method=replace;setReplace(null);void performGenerate(method);}}>替换区域</button><button onClick={()=>setReplace(null)}>取消</button></div>}
    <div className="region-viewbar"><div role="group" aria-label="切割视图">{([['source','原图区域'],['raw','原帧预览'],['output','输出预览']] as const).map(([v,label])=><button key={v} className={view===v?'is-active':''} onClick={()=>{cancelDrag();setView(v);setZoom('fit');}}>{label}</button>)}</div><span>{image.width} × {image.height} · {recipe?.slicing.items.length||0} 个区域</span><div className="region-toolbar-spacer"/><button aria-label="缩小切割视图" onClick={()=>setZoom(Math.max(.02,scale/1.25))}><ZoomOut size={14}/></button><button onClick={()=>setZoom(1)}>{Math.round(scale*100)}%</button><button aria-label="放大切割视图" onClick={()=>setZoom(Math.min(16,scale*1.25))}><ZoomIn size={14}/></button><button aria-label="适应切割画布" onClick={()=>setZoom('fit')}><Maximize2 size={14}/></button></div>
    <div className={`stage checker slice-stage ${tool==='create'?'is-drawing':''}`} ref={stage} tabIndex={0} aria-label="切割画布，拖动编辑区域，方向键微移" onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget))cancelDrag();}}>
      {(viewingSource||frameImage)?<div ref={artboard} className="artboard slice-artboard" style={{width:logicalWidth*scale,height:logicalHeight*scale}}>
        <img src={viewingSource?assetUrl(projectId,image.id,image.revision):view==='raw'?frameImage!.raw.url:frameImage!.output.url} alt={viewingSource?image.name:`区域 ${selected+1} ${view==='raw'?'原帧':'输出'}预览`} draggable={false}/>
        {viewingSource&&<svg className="region-overlay" viewBox={`0 0 ${image.width} ${image.height}`} preserveAspectRatio="none" aria-label="可编辑切割区域" onPointerDown={beginDrag} onPointerMove={updateDrag} onPointerUp={finishDrag} onPointerCancel={cancelDrag} onLostPointerCapture={()=>{if(drag.current)cancelDrag();}}>
          {recipe?.slicing.items.map((item,index)=>{const b=ghost?.index===index?ghost.box:item.box;return <g key={keys.current[index]||index} className={index===selected?'selected':''}><rect x={b[0]} y={b[1]} width={b[2]-b[0]} height={b[3]-b[1]} className={`region-box ${item.enabled?'':'disabled'}`} vectorEffect="non-scaling-stroke"/><text x={b[0]+3/scale} y={b[1]+14/scale} fontSize={12/scale}>{String(index+1).padStart(2,'0')}</text></g>;})}
          {selectedBox&&Object.entries(regionHandles(selectedBox)).map(([h,[x,y]])=><rect key={h} className="region-handle" data-handle={h} x={x-4/scale} y={y-4/scale} width={8/scale} height={8/scale} style={{cursor:h+'-resize'}}/>)}
          {ghost&&ghost.index===(recipe?.slicing.items.length||0)&&<rect className="region-box selected" x={ghost.box[0]} y={ghost.box[1]} width={ghost.box[2]-ghost.box[0]} height={ghost.box[3]-ghost.box[1]} vectorEffect="non-scaling-stroke"/>}
        </svg>}
      </div>:<div className="region-empty">{selectedItem?.enabled?'正在准备所选帧预览…':'请选择启用的区域查看预览'}<button onClick={()=>setView('source')}>返回原图编辑</button></div>}
      {!recipe&&<div className="region-canvas-note">正在解析切割区域…</div>}
    </div>
    <div className="region-strip-header"><strong>原帧预览</strong><span>{selectedItem?`${selected+1} / ${recipe?.slicing.items.length} · ${selectedItem.box[2]-selectedItem.box[0]} × ${selectedItem.box[3]-selectedItem.box[1]}`:'在原图上加框开始'}</span><span role="status">{ghost?'拖动中，松开更新预览':previewLoading?'更新预览…':currentPreview?.blocking?'输出存在溢出':dirty?'区域草案 · 未保存':state.document?.status==='ready'?'切片已更新':'预览不改写素材'}</span><div className="region-toolbar-spacer"/><button disabled={!selectedItem||selected===0} onClick={()=>reorder(-1)}>前移</button><button disabled={!selectedItem||selected===(recipe?.slicing.items.length||0)-1} onClick={()=>reorder(1)}>后移</button><button aria-label="删除所选切割区域" disabled={!selectedItem} onClick={remove}><Trash2 size={14}/></button>{onOpenFrame&&<button disabled={!savedImageId||dirty||state.document?.status!=='ready'} onClick={()=>savedImageId&&onOpenFrame(savedImageId)}>调整此帧 →</button>}</div>
    <div className="region-filmstrip" role="listbox" aria-label="切割原帧列表" onKeyDown={e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();e.stopPropagation();select(Math.min((recipe?.slicing.items.length||1)-1,selected+(e.key==='ArrowLeft'?-1:1)));}}}>
      {recipe?.slicing.items.map((item,index)=>{const cached=frameCache.current.get(regionSignature(item,recipe.slicing.output));return <button key={keys.current[index]||index} role="option" aria-selected={index===selected} aria-label={`选择原帧 ${index+1}`} className={`region-thumb ${index===selected?'selected':''} ${item.enabled?'':'disabled'}`} onClick={()=>select(index)}>{cached?<img src={view==='output'?cached.output.url:cached.raw.url} alt={`原帧 ${index+1}`}/>:<span className="region-thumb-placeholder">{item.enabled?'待预览':'停用'}</span>}<span>{String(index+1).padStart(2,'0')} · {item.name}</span></button>;})}
      {!recipe?.slicing.items.length&&<p className="adjust-note">用网格、自动识别生成区域，或直接在画布上拖拽加框。</p>}
    </div>
    {(error||notice||currentPreview?.diagnostics.length||currentPreview?.blocking||disabled)&&<div className={`region-message ${error?'error':''}`} role={error?'alert':'status'}>{error||notice||currentPreview?.diagnostics.map(d=>d.message).join('；')||(currentPreview?.blocking?'部分区域超出统一输出画布，原始框仍可自由编辑。':'当前对象被任务占用；可本地编辑，接手后再保存。')}{currentPreview?.blocking&&recipe&&currentPreview.suggestedOutput&&currentPreview.suggestedOutput.width<=4096&&currentPreview.suggestedOutput.height<=4096&&<button onClick={()=>commit({...recipe,slicing:{...recipe.slicing,output:{...recipe.slicing.output,...currentPreview.suggestedOutput!}}},modeRef.current)}>按区域补齐透明画布</button>}</div>}
    {propertiesHost&&createPortal(<SliceConfigPanel recipe={recipe} selected={selected} width={image.width} height={image.height} text={jsonText} external={state.external} error={error} busy={!!busy} disabled={disabled} onItem={editItem} onBox={editBox} onDelete={remove} onDuplicate={duplicate} onRecipe={next=>commit(next)} onText={editText} onSave={()=>void save(false)} onReload={()=>void reload()}/>,propertiesHost)}
  </div>;
}
