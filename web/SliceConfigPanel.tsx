import { useEffect, useRef, useState } from "react";
import { Save, Scissors, RefreshCw } from "lucide-react";
import { assetUrl, type Asset, type ImageAsset } from "../studio/model.ts";
import type { SheetDocument, SheetRecipe } from "../studio/sheets.ts";
import type { SheetInspection } from "../studio/sheet-inspection.ts";
import type { SheetRect } from "../studio/sheet-schema.ts";
import { api } from "./api.ts";
import { parseSheet, SheetEditorState, switchSheetMethod } from "./sheet-state.ts";

export type SheetOverlay = { sourceId: string; sourceRevision: string; rectangles: (SheetRect & { selection: string })[]; selected: string; onSelect: (selection: string) => void };
export function SliceConfigPanel({ projectId, image, assets, refreshToken, onRefresh, onSelect, onOverlay, gridVisible, onGridVisible, disabled }: {
  projectId: string; image: ImageAsset; assets: Asset[]; refreshToken: string;
  onRefresh: () => Promise<void>; onSelect: (id: string) => void; onOverlay: (overlay: SheetOverlay | null) => void;
  gridVisible: boolean; onGridVisible: (visible: boolean) => void; disabled: boolean;
}) {
  const source = `${projectId}:${image.id}:${image.revision}`;
  const editor = useRef(new SheetEditorState(source));
  if (editor.current.source !== source) editor.current = new SheetEditorState(source);
  const state = editor.current;
  const [, render] = useState(0), redraw = () => render(n => n+1);
  const [error,setError] = useState(""), [busy,setBusy] = useState(false), [details,setDetails] = useState(false);
  const [detected,setDetected] = useState<SheetInspection | null>(null), [preview,setPreview] = useState<SheetInspection | null>(null);
  const [selection,setSelection] = useState(""), [members,setMembers] = useState<string[]>([]);
  const pending = useRef(0), documentRequest = useRef(0);
  const storageKey = `studio.recipe.${projectId}.${image.id}`;
  const recipe = parseSheet(state.text), document = state.document;
  function persist() { sessionStorage.setItem(storageKey, JSON.stringify({ text: state.text, base: state.base })); }
  function edit(text: string) { state.edit(text); persist(); setPreview(null); onOverlay(null); redraw(); }
  function change(mutator: (next: SheetRecipe) => void) {
    if (!recipe) return;
    const next = structuredClone(recipe); mutator(next); edit(JSON.stringify(next,null,2)+"\n");
  }
  useEffect(() => {
    let cancelled = false;
    const token = state.token(); documentRequest.current = token.serial;
    void api<SheetDocument>(`/api/projects/${projectId}/documents/${image.id}`).then(next => {
      if (cancelled || editor.current !== state || documentRequest.current !== token.serial) return;
      let draft: { text: string; base: string } | null = null;
      try { draft = JSON.parse(sessionStorage.getItem(storageKey) || "null"); } catch {}
      const previousText = state.text;
      if (state.loaded && !state.current(token)) {
        state.document = next;
        if (state.base !== next.documentRevision) state.conflict();
      } else state.read(next,draft);
      if (state.text !== previousText) setPreview(null);
      redraw();
    }).catch(e => { if (!cancelled && editor.current === state && documentRequest.current === token.serial) setError(e.message); });
    return () => { cancelled = true; };
  }, [source,refreshToken]);
  useEffect(() => {
    setDetected(null); setPreview(null); setMembers([]); setSelection(""); setBusy(false); setError(""); pending.current++;
    return () => onOverlay(null);
  }, [source]);
  useEffect(() => {
    const currentPreview = preview?.assetId === image.id && preview.sourceRevision === image.revision ? preview : null;
    const currentDetected = detected?.assetId === image.id && detected.sourceRevision === image.revision && recipe?.slicing.method === "components" && JSON.stringify(detected.detection) === JSON.stringify(recipe.slicing.detection) ? detected : null;
    const rectangles = currentPreview?.rectangles?.map(r => ({ ...r, selection: `item:${r.index}` })) ||
      currentDetected?.candidates?.map((c,index) => ({ box: c.box, index, key: c.key, selection: `candidate:${c.key}` })) || [];
    onOverlay(rectangles.length ? { sourceId: image.id, sourceRevision: image.revision, rectangles, selected: selection, onSelect: setSelection } : null);
  }, [preview,detected,selection,source,state.text]);
  async function inspect(action: "detect" | "preview", offset = 0) {
    if (!recipe) return;
    if (action === "detect" && recipe.slicing.method !== "components") return;
    const token = state.token(); pending.current = token.serial;
    setBusy(true); setError("");
    try {
      const result = await api<SheetInspection>(`/api/projects/${projectId}/sheet-inspections`, { method: "POST", body: JSON.stringify({ action, assetId: image.id, expectedSourceRevision: image.revision,
        ...(action === "detect" && recipe.slicing.method === "components" ? { detection: recipe.slicing.detection, offset, limit: 128 } : { text: state.text, start: offset, limit: 16 }) }) });
      if (editor.current !== state || !state.current(token) || pending.current !== token.serial) return;
      if (action === "detect") {
        if (!detected || detected.parameterHash !== result.parameterHash || detected.sourceContentHash !== result.sourceContentHash) setMembers([]);
        setDetected(result); setPreview(null);
      } else setPreview(result);
    } catch (e: any) { if (editor.current === state && state.current(token) && pending.current === token.serial) setError(e.message); }
    finally { if (editor.current === state && pending.current === token.serial) setBusy(false); }
  }
  async function reload() {
    const token = state.token(); documentRequest.current = token.serial; setBusy(true); setError("");
    try {
      const next = await api<SheetDocument>(`/api/projects/${projectId}/documents/${image.id}`);
      if (editor.current !== state || documentRequest.current !== token.serial) return;
      state.document = next;
      if (state.current(token)) { state.reload(); setPreview(null); }
      else state.conflict();
      persist(); redraw();
    } catch (e: any) { if (editor.current === state) setError(e.message); }
    finally { if (editor.current === state) setBusy(false); }
  }
  async function save() {
    if (!document) return;
    const token = state.token(); documentRequest.current = token.serial; setBusy(true); setError("");
    try {
      const [next] = await api<SheetDocument[]>(`/api/projects/${projectId}/documents`, { method: "POST", body: JSON.stringify({ documents: [{ documentId: image.id, expectedDocumentRevision: state.base, text: state.text }] }) });
      if (editor.current !== state) return;
      state.saved(next!,token); setPreview(null); persist(); redraw(); await onRefresh();
    } catch (e: any) {
      if (editor.current !== state) return;
      if (e.status === 409 || e.message.includes("VERSION_CONFLICT")) state.conflict();
      setError(e.message); persist(); redraw();
    } finally { if (editor.current === state) setBusy(false); }
  }
  async function execute() {
    if (!document) return;
    setBusy(true); setError("");
    try {
      await api(`/api/projects/${projectId}/assets/${image.id}/slice-config`, { method: "POST", body: JSON.stringify({ expectedDefinitionRevision: document.definitionRevision, requestId: crypto.randomUUID() }) });
      if (editor.current === state) await onRefresh();
    } catch (e: any) { if (editor.current === state) setError(e.message); }
    finally { if (editor.current === state) setBusy(false); }
  }
  function initialize() {
    change(next => {
      if (next.slicing.method !== "grid") return;
      const slicing = next.slicing, old = slicing.items;
      slicing.items = Array.from({length:slicing.grid.columns*slicing.grid.rows},(_,i) => {
        const x = i%slicing.grid.columns, y = Math.floor(i/slicing.grid.columns);
        return old.find(item => item.cell[0] === x && item.cell[1] === y) || { cell:[x,y], name:String(i+1).padStart(2,"0"), enabled:true };
      });
    });
  }
  function reorder(index: number, delta: number) {
    change(next => { const items = next.slicing.items; const target=index+delta; if (target<0 || target>=items.length) return; [items[index],items[target]]=[items[target]!,items[index]!]; });
  }
  const selectedIndex = selection.startsWith("item:") ? Number(selection.slice(5)) : -1;
  const dirty = !!document && state.text !== document.text;
  const output = recipe && "output" in recipe.slicing ? recipe.slicing.output : null;
  const detectionCurrent = !!detected && recipe?.slicing.method === "components" && detected.sourceContentHash === image.contentHash && JSON.stringify(detected.detection) === JSON.stringify(recipe.slicing.detection);
  const outputs = (document?.outputIds || []).flatMap(id => { const asset=assets.find(a=>a.id===id);return asset?.type === "image" ? [asset] : []; });
  const numberField = (label: string, value: number, update: (value:number)=>void, min=0,max=4096,step=1) => <label key={label}>{label}<input aria-label={label} type="number" min={min} max={max} step={step} value={value} onChange={e=>{const n=Number(e.target.value);if(Number.isFinite(n))update(Math.min(max,Math.max(min,step===1?Math.round(n):n)));}} /></label>;
  return <div className="slice-config-panel">
    <div className="tool-content">
      <label>切割方法<select aria-label="切割方法" disabled={!recipe || busy} value={recipe?.slicing.method || "grid"} onChange={e=>{
        switchSheetMethod(state,e.target.value as "grid"|"components"|"boxes",image.width,image.height,image.contentHash);
        persist(); setPreview(null); setDetected(null); setMembers([]); setSelection(""); onOverlay(null); redraw();
      }}><option value="grid">网格</option><option value="components">透明连通域</option><option value="boxes">显式矩形</option></select></label>
      <label className="grid-toggle"><input type="checkbox" checked={gridVisible} onChange={e=>onGridVisible(e.target.checked)} />原图叠框</label>
      <button className="secondary" disabled={!document || busy || disabled || state.external || !recipe} onClick={()=>void save()}><Save size={14}/>保存配置</button>
      <button className="secondary" disabled={!document?.exists || busy || disabled || state.external || dirty} onClick={()=>void execute()}><Scissors size={14}/>{busy?"处理中…":"执行切割"}</button>
      <button className="secondary" disabled={!recipe || busy} onClick={()=>void inspect("preview")}>预览未保存配方</button>
    </div>
    <div className="slice-config-summary"><span>{state.external?"配置有新版本，本地草稿已保留":dirty?"有未保存修改":document?.status==="ready"?"切片已更新":document?.exists?"配置未应用":"尚未保存配置"}</span>
      <span>{recipe?.slicing.items.filter(i=>i.enabled).length || 0} 帧 · 不自动创建动画</span><button onClick={()=>setDetails(!details)}>{details?"收起配置正文":"编辑配置正文"}</button></div>
    {state.external && <p className="slice-config-error" role="alert">请先复制草稿；保存期间的新输入不会被返回正文或ID覆盖。<button disabled={busy} onClick={()=>void reload()}><RefreshCw size={12}/>读取新版本</button></p>}
    {!recipe && <p className="slice-config-error" role="alert">JSON结构无效，表单暂停；请在正文中修复，草稿不会丢失。</p>}
    {recipe && <>
      {recipe.schemaVersion===1 && <p className="adjust-note">v1 网格保持旧像素规则。<button onClick={()=>change(next=>{
        if (next.schemaVersion!==1) return;
        const upgraded = { ...next, schemaVersion:2, slicing:{...next.slicing,output:{width:Math.min(4096,image.width),height:Math.min(4096,image.height),scale:1,alignment:"center"}} };
        Object.assign(next,upgraded);
      })}>显式升级为 v2 固定画布</button></p>}
      <div className="slice-fields">
        <label>输出目录<input aria-label="切片输出目录" value={recipe.slicing.outputFolder} onChange={e=>change(n=>{n.slicing.outputFolder=e.target.value;})}/></label>
        {recipe.slicing.method==="grid" && <>
          {numberField("切割列数",recipe.slicing.grid.columns,v=>change(n=>{if(n.slicing.method==="grid")n.slicing.grid.columns=v;}),1,32)}
          {numberField("切割行数",recipe.slicing.grid.rows,v=>change(n=>{if(n.slicing.method==="grid")n.slicing.grid.rows=v;}),1,32)}
          {recipe.slicing.grid.margin.map((v,i)=>numberField(`边距${["上","右","下","左"][i]}`,v,x=>change(n=>{if(n.slicing.method==="grid")n.slicing.grid.margin[i]=x;})))}
          {recipe.slicing.grid.spacing.map((v,i)=>numberField(`间距${i===0?"横":"纵"}`,v,x=>change(n=>{if(n.slicing.method==="grid")n.slicing.grid.spacing[i]=x;})))}
          <button className="secondary" disabled={recipe.slicing.grid.columns*recipe.slicing.grid.rows>128} onClick={initialize}>从全部网格初始化</button>
        </>}
        {recipe.slicing.method==="components" && <>
          {numberField("Alpha阈值",recipe.slicing.detection.alphaThreshold,v=>change(n=>{if(n.slicing.method==="components")n.slicing.detection.alphaThreshold=v;}),0,255)}
          {numberField("最小组件像素",recipe.slicing.detection.minComponentPixels,v=>change(n=>{if(n.slicing.method==="components")n.slicing.detection.minComponentPixels=v;}),1,16777216)}
          <button className="secondary" disabled={busy} onClick={()=>void inspect("detect")}>检测透明组件</button>
          <small>alpha &gt; 阈值，8邻域；不去背景、不自动合并/拆分。离体碎片需明确分组。</small>
        </>}
        {output && <>
          {numberField("统一画布宽",output.width,v=>change(n=>{if("output" in n.slicing)n.slicing.output.width=v;}),1)}
          {numberField("统一画布高",output.height,v=>change(n=>{if("output" in n.slicing)n.slicing.output.height=v;}),1)}
          {numberField("统一缩放",output.scale,v=>change(n=>{if("output" in n.slicing)n.slicing.output.scale=v;}),.05,4,.05)}
          <label>几何对齐<select aria-label="几何对齐" value={output.alignment} onChange={e=>change(n=>{if("output" in n.slicing)n.slicing.output.alignment=e.target.value as "center"|"bottom-center";})}><option value="center">居中</option><option value="bottom-center">底部居中</option></select></label>
          <label>期望帧数<input aria-label="期望帧数" type="number" min={1} max={128} value={"expectedFrames" in recipe.slicing?recipe.slicing.expectedFrames??"":""} onChange={e=>change(n=>{if(n.schemaVersion===2){if(e.target.value)n.slicing.expectedFrames=Number(e.target.value);else delete n.slicing.expectedFrames;}})}/></label>
          <small>scale=1不重采样；显式缩放用nearest。几何底部不是语义脚底；预览溢出可见，执行拒绝。</small>
        </>}
      </div>
      {recipe.slicing.method==="boxes" && <button className="secondary slice-add" disabled={recipe.slicing.items.length>=128} onClick={()=>change(n=>{if(n.slicing.method==="boxes")n.slicing.items.push({name:`${n.slicing.items.length+1}`,enabled:true,box:[0,0,image.width,image.height]});})}>添加矩形</button>}
      <ol className="slice-items" aria-label="切割条目">
        {recipe.slicing.items.map((item,index)=><li key={index} className={selectedIndex===index?"selected":""}>
          <button aria-label={`选择条目${index+1}`} onClick={()=>setSelection(`item:${index}`)}>#{index+1}</button>
          <input aria-label={`条目${index+1}名称`} value={item.name} onChange={e=>change(n=>{n.slicing.items[index]!.name=e.target.value;})}/>
          <label><input type="checkbox" aria-label={`启用条目${index+1}`} checked={item.enabled} onChange={e=>change(n=>{n.slicing.items[index]!.enabled=e.target.checked;})}/>启用</label>
          <label>帧身份<select aria-label={`条目${index+1}身份`} value={item.id || ""} onChange={e=>change(n=>{if(e.target.value)n.slicing.items[index]!.id=e.target.value;else delete n.slicing.items[index]!.id;})}><option value="">新帧（不继承ID）</option>{document?.recipe.slicing.items.filter(i=>i.id).map(i=><option key={i.id} value={i.id}>{i.name} · {i.id!.slice(0,8)}</option>)}</select></label>
          {"cell" in item && item.cell.map((v,i)=>numberField(`条目${index+1}${i===0?"列":"行"}`,v,x=>change(n=>{const it=n.slicing.items[index]!;if("cell" in it)it.cell[i]=x;}),0,31))}
          {"box" in item && item.box.map((v,i)=>numberField(`矩形${index+1}${["左","上","右","下"][i]}`,v,x=>change(n=>{const it=n.slicing.items[index]!;if("box" in it)it.box[i]=x;}),0,16777216))}
          {"componentKeys" in item && <div className="slice-members"><span>{item.componentKeys.length} 个成员</span>{item.componentKeys.map(key=><button key={key} title={key} disabled={item.componentKeys.length===1} onClick={()=>change(n=>{const it=n.slicing.items[index]!;if("componentKeys" in it)it.componentKeys=it.componentKeys.filter(k=>k!==key);})}>移除 {key.slice(0,8)}</button>)}</div>}
          <button aria-label={`上移条目${index+1}`} disabled={index===0} onClick={()=>reorder(index,-1)}>上移</button><button aria-label={`下移条目${index+1}`} disabled={index===recipe.slicing.items.length-1} onClick={()=>reorder(index,1)}>下移</button>
          <button aria-label={`删除条目${index+1}`} onClick={()=>change(n=>{n.slicing.items.splice(index,1);})}>删除</button>
        </li>)}
      </ol>
    </>}
    {detected && <section className="slice-evidence" aria-label="连通域候选">
      <p>{detected.total} 个候选 · 丢弃 {detected.discardedCount} 个 / {detected.discardedPixels} 像素 · 当前页 {(detected.offset||0)+1}–{Math.min((detected.offset||0)+(detected.candidates?.length||0),detected.total)}</p>
      {detected.diagnostics.map((d,i)=><p key={i}>{d.message}</p>)}
      {!detectionCurrent && <p role="alert">检测参数或来源已变化，请重新检测。</p>}
      <div className="slice-candidates">{detected.candidates?.map(c=><label key={c.key} className={selection===`candidate:${c.key}`?"selected":""}><input type="checkbox" aria-label={`组件${c.key.slice(0,8)}`} disabled={!detectionCurrent} checked={members.includes(c.key)} onChange={e=>setMembers(old=>e.target.checked?[...old,c.key]:old.filter(k=>k!==c.key))}/><button onClick={()=>setSelection(`candidate:${c.key}`)}>{c.key.slice(0,8)} · {c.pixelCount}px · [{c.box.join(",")}]</button></label>)}</div>
      <button disabled={busy || !detected.offset} onClick={()=>void inspect("detect",Math.max(0,(detected.offset||0)-128))}>上一候选页</button><button disabled={busy || (detected.offset||0)+128>=detected.total} onClick={()=>void inspect("detect",(detected.offset||0)+128)}>下一候选页</button>
      <button disabled={!detectionCurrent} onClick={()=>change(n=>{if(n.slicing.method==="components"){n.slicing.sourceContentHash=detected.sourceContentHash;n.slicing.algorithmVersion=detected.algorithmVersion!;}})}>采用此次检测身份（不替换成员）</button>
      <button disabled={!detectionCurrent || !members.length || (recipe?.slicing.items.length||0)>=128} onClick={()=>{change(n=>{if(n.slicing.method==="components"){n.slicing.sourceContentHash=detected.sourceContentHash;n.slicing.algorithmVersion=detected.algorithmVersion!;n.slicing.items.push({name:`${n.slicing.items.length+1}`,enabled:true,componentKeys:[...members]});}});setMembers([]);}}>将所选组件分为新帧</button>
      <button disabled={!detectionCurrent || !members.length || selectedIndex<0} onClick={()=>{change(n=>{if(n.slicing.method==="components" && n.slicing.items[selectedIndex]){n.slicing.sourceContentHash=detected.sourceContentHash;n.slicing.algorithmVersion=detected.algorithmVersion!;n.slicing.items[selectedIndex]!.componentKeys=[...members];}});setMembers([]);}}>替换所选帧成员（保留ID）</button>
      {detected.images.map(i=><img key={i.hash} src={i.url} alt="真实透明组件叠框证据"/>)}
    </section>}
    {preview && <section className="slice-evidence" aria-label="切割预览">
      <p>当前批次 {(preview.start||0)+1}–{preview.end} / {preview.total} 帧 · 统一画布 {preview.width}×{preview.height}{preview.blocking?" · 存在溢出，执行将拒绝":""}</p>
      {preview.diagnostics.map((d,i)=><p key={i} role={d.code==="frame-count"?"alert":undefined}>{d.message}</p>)}
      {preview.frames?.map(f=><p key={f.index}>#{f.index+1} [{f.box.join(",")}] → {f.scaledSize.join("×")} 偏移 {f.offset.join(",")} {f.blocking?`溢出 ${JSON.stringify(f.overflow)}`:""}</p>)}
      <button disabled={busy || !preview.start} onClick={()=>void inspect("preview",Math.max(0,(preview.start||0)-16))}>上一批帧</button><button disabled={busy || (preview.end||0)>=preview.total} onClick={()=>void inspect("preview",preview.end||0)}>下一批帧</button>
      {output && preview.suggestedOutput && <button disabled={preview.suggestedOutput.width>4096 || preview.suggestedOutput.height>4096} onClick={()=>change(n=>{if("output" in n.slicing)Object.assign(n.slicing.output,preview.suggestedOutput);})}>采用建议画布 {preview.suggestedOutput.width}×{preview.suggestedOutput.height} 到本地配方</button>}
      {preview.images.map(i=><img key={i.hash} src={i.url} alt="真实固定画布切割预览"/>)}
    </section>}
    {details && <label className="slice-config-document">切割配置 JSON<textarea aria-label="切割配置正文" value={state.text} onChange={e=>edit(e.target.value)} spellCheck={false}/><small>{document?.path} · boxes为原图半开矩形；保留ID表示明确编辑同一帧，切换方法不保存，各方法草稿可切回。</small></label>}
    {error && <p className="slice-config-error" role="alert">{error}</p>}
    {!!outputs.length && <div className="slice-output-list" aria-label="切割结果">{outputs.map(o=><button key={o.id} title={o.name} onClick={()=>onSelect(o.id)}><img src={assetUrl(projectId,o.id,o.revision)} alt={o.name}/><span>{o.name}</span></button>)}</div>}
  </div>;
}
