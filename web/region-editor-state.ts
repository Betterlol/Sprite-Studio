import type { RegionItem, SheetRecipeV3 } from '../studio/sheet-schema.ts';
export type Box = [number,number,number,number];
export type Handle = 'move'|'create'|'n'|'ne'|'e'|'se'|'s'|'sw'|'w'|'nw';
export type RegionMode = 'grid'|'components'|'manual';
const clamp=(n:number,lo:number,hi:number)=>Math.max(lo,Math.min(hi,Math.round(n)));
export function regionHandles([l,t,r,b]:Box):Record<string,[number,number]> {
  return {nw:[l,t],n:[(l+r)/2,t],ne:[r,t],e:[r,(t+b)/2],se:[r,b],s:[(l+r)/2,b],sw:[l,b],w:[l,(t+b)/2]};
}
export function moveRegion(box:Box,handle:Handle,delta:[number,number],size:[number,number]):Box {
  let [l,t,r,b]=box;const [dx,dy]=delta,[width,height]=size;
  if(handle==='move'){const x=clamp(dx,-l,width-r),y=clamp(dy,-t,height-b);return [l+x,t+y,r+x,b+y];}
  if(handle.includes('w'))l=clamp(l+dx,0,r-1);
  if(handle.includes('e'))r=clamp(r+dx,l+1,width);
  if(handle.includes('n'))t=clamp(t+dy,0,b-1);
  if(handle.includes('s'))b=clamp(b+dy,t+1,height);
  return [l,t,r,b];
}
export function createRegionBox(start:[number,number],end:[number,number],size:[number,number]):Box {
  return [clamp(Math.min(start[0],end[0]),0,size[0]),clamp(Math.min(start[1],end[1]),0,size[1]),clamp(Math.max(start[0],end[0]),0,size[0]),clamp(Math.max(start[1],end[1]),0,size[1])];
}
export function sourcePoint(client:[number,number],bounds:{left:number;top:number;width:number;height:number},size:[number,number]):[number,number] {
  return [clamp((client[0]-bounds.left)*size[0]/Math.max(1,bounds.width),0,size[0]),clamp((client[1]-bounds.top)*size[1]/Math.max(1,bounds.height),0,size[1])];
}
export function hitRegion(items:RegionItem[],selected:number,point:[number,number],tolerance:number):{index:number;handle:Handle}|null {
  const [x,y]=point,item=items[selected];
  if(item)for(const [handle,[hx,hy]]of Object.entries(regionHandles(item.box))){if(Math.abs(x-hx)<=tolerance&&Math.abs(y-hy)<=tolerance)return {index:selected,handle:handle as Handle};}
  for(const index of [selected,...items.map((_,i)=>i).reverse().filter(i=>i!==selected)]){
    const i=items[index];if(i&&x>=i.box[0]&&x<=i.box[2]&&y>=i.box[1]&&y<=i.box[3])return {index,handle:'move'};
  }
  return null;
}
export function editedRegion(item:RegionItem,box:Box):RegionItem {
  if(item.box.every((v,i)=>v===box[i]))return item;
  const {selection,...rest}=item;return {...rest,box};
}
export function regionSignature(item:RegionItem,output:SheetRecipeV3['slicing']['output']) {
  return JSON.stringify([item.box,item.selection??null,output]);
}
export function regionShortcutAllowed(target:EventTarget|null) {
  const element=target as Element|null;
  return !element?.closest?.('input,textarea,select,[contenteditable="true"],dialog,[role="dialog"]');
}
export type RegionSnapshot={text:string;mode:RegionMode;selected:number;keys?:string[]};
export class RegionHistory {
  past:RegionSnapshot[]=[];future:RegionSnapshot[]=[];
  record(before:RegionSnapshot,after:RegionSnapshot){if(before.text===after.text)return;this.past.push(before);if(this.past.length>100)this.past.shift();this.future=[];}
  undo(current:RegionSnapshot){const next=this.past.pop();if(next)this.future.push(current);return next;}
  redo(current:RegionSnapshot){const next=this.future.pop();if(next)this.past.push(current);return next;}
}
