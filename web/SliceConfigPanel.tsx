import type { SheetRecipeV3, RegionItem } from '../studio/sheet-schema.ts';
import type { Box } from './region-editor-state.ts';
export type RegionProperties = {
  recipe: SheetRecipeV3|null; selected: number; width:number; height:number; text:string;
  external:boolean; error:string; busy:boolean; disabled:boolean;
  onItem:(item:RegionItem)=>void; onBox:(box:Box)=>void; onDelete:()=>void; onDuplicate:()=>void;
  onRecipe:(recipe:SheetRecipeV3)=>void; onText:(text:string)=>void; onSave:()=>void; onReload:()=>void;
};
/** The inspector describes ONE region. Generation and preview live in the workbench. */
export function SliceConfigPanel(p:RegionProperties) {
  const item=p.recipe?.slicing.items[p.selected];
  const number=(label:string,value:number,change:(n:number)=>void,min=0,max=16777216,step=1)=><label>{label}<input aria-label={label} type="number" min={min} max={max} step={step} value={value} onChange={e=>{if(e.target.value==='')return;const n=Number(e.target.value);if(Number.isFinite(n))change(Math.min(max,Math.max(min,step===1?Math.round(n):n)));}}/></label>;
  function output(patch:Partial<SheetRecipeV3['slicing']['output']>){if(p.recipe)p.onRecipe({...p.recipe,slicing:{...p.recipe.slicing,output:{...p.recipe.slicing.output,...patch}}});}
  return <div className="region-properties">
    <header><strong>{item?`区域 ${String(p.selected+1).padStart(2,'0')}`:'切割区域'}</strong><span className="muted">原图像素</span></header>
    {p.external&&<div className="region-error" role="alert">配置有新版本，当前编辑已保留。<button disabled={p.busy} onClick={p.onReload}>读取新版本</button><small>如需保留文字，请先在高级设置复制草稿。</small></div>}
    {p.error&&<p className="region-error" role="alert">{p.error}</p>}
    {!p.recipe&&<p>正在读取区域；若 JSON 无效，可在高级设置中修复。</p>}
    {item?<>
      <label>名称<input aria-label="所选区域名称" value={item.name} onChange={e=>p.onItem({...item,name:e.target.value})}/></label>
      <div className="region-coordinate-grid">
        {number('区域 X',item.box[0],n=>{const w=item.box[2]-item.box[0],x=Math.min(n,p.width-w);p.onBox([x,item.box[1],x+w,item.box[3]]);},0,p.width-1)}
        {number('区域 Y',item.box[1],n=>{const h=item.box[3]-item.box[1],y=Math.min(n,p.height-h);p.onBox([item.box[0],y,item.box[2],y+h]);},0,p.height-1)}
        {number('区域宽',item.box[2]-item.box[0],n=>p.onBox([item.box[0],item.box[1],item.box[0]+n,item.box[3]]),1,p.width-item.box[0])}
        {number('区域高',item.box[3]-item.box[1],n=>p.onBox([item.box[0],item.box[1],item.box[2],item.box[1]+n]),1,p.height-item.box[1])}
      </div>
      <label className="region-check"><input aria-label="启用所选区域" type="checkbox" checked={item.enabled} onChange={e=>p.onItem({...item,enabled:e.target.checked})}/>包含在切割结果中</label>
      <div className="region-property-actions"><button onClick={p.onDuplicate}>复制区域</button><button className="danger" onClick={p.onDelete}>删除区域</button></div>
      <p className="adjust-note">在画布上拖动或调整边角；方向键微移，Shift 加速，Esc 取消。{item.selection?' 当前保留自动识别的像素归属，改框后转为矩形取像。':''}</p>
    </>:p.recipe&&<p className="adjust-note">点击下方原帧选择区域，或在原图空白处拖拽新增。</p>}
    <details className="region-advanced"><summary>高级输出与配置</summary>
      {p.recipe&&<>
        <label>输出目录<input aria-label="切片输出目录" value={p.recipe.slicing.outputFolder} onChange={e=>p.onRecipe({...p.recipe!,slicing:{...p.recipe!.slicing,outputFolder:e.target.value}})}/></label>
        <fieldset><legend>统一输出画布</legend><div className="region-coordinate-grid">
          {number('输出宽',p.recipe.slicing.output.width,n=>output({width:n}),1,4096)}
          {number('输出高',p.recipe.slicing.output.height,n=>output({height:n}),1,4096)}
          {number('全局缩放',p.recipe.slicing.output.scale,n=>output({scale:n}),.05,4,.05)}
          <label>放置方式<select aria-label="输出放置" value={p.recipe.slicing.output.alignment} onChange={e=>output({alignment:e.target.value as 'center'|'bottom-center'|'top-left'})}><option value="center">居中</option><option value="bottom-center">底部居中</option><option value="top-left">左上（保留切片坐标）</option></select></label>
        </div><button onClick={()=>{const active=p.recipe!.slicing.items.filter(i=>i.enabled),s=p.recipe!.slicing.output.scale;output({width:Math.min(4096,Math.max(1,...active.map(i=>Math.floor((i.box[2]-i.box[0])*s+.5)))),height:Math.min(4096,Math.max(1,...active.map(i=>Math.floor((i.box[3]-i.box[1])*s+.5))))});}}>按区域建议画布</button><small>默认保留像素尺度，只补透明边；不会逐帧拉伸，超出画布会阻止执行。</small></fieldset>
        <label>期望帧数<input aria-label="期望帧数" type="number" min={1} max={128} value={p.recipe.slicing.expectedFrames??''} onChange={e=>{const next=structuredClone(p.recipe!);if(e.target.value)next.slicing.expectedFrames=Number(e.target.value);else delete next.slicing.expectedFrames;p.onRecipe(next);}}/></label>
      </>}
      <label>区域配置 JSON<textarea aria-label="切割配置正文" value={p.text} onChange={e=>p.onText(e.target.value)} spellCheck={false}/></label>
      <small>配置只保存最终区域。生成参数不参与重新切割；已有区域身份在改框时保持。</small>
      <button disabled={p.disabled||p.busy||p.external||!p.recipe} onClick={p.onSave}>仅保存配置</button>
    </details>
  </div>;
}
