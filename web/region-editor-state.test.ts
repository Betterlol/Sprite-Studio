import test from 'node:test';
import assert from 'node:assert/strict';
import {moveRegion,createRegionBox,sourcePoint,editedRegion,RegionHistory,hitRegion,reconcileRegionKeys,regionShortcutAllowed} from './region-editor-state.ts';
import type {RegionItem} from '../studio/sheet-schema.ts';
const item:RegionItem={name:'a',enabled:true,id:'00000000-0000-4000-8000-000000000001',box:[10,10,30,40],selection:'a'.repeat(64)};
test('region move and eight handles operate in source pixels, clamp and retain positive area',()=>{
  assert.deepEqual(moveRegion(item.box,'move',[-30,100],[100,80]),[0,50,20,80]);
  for(const h of ['n','ne','e','se','s','sw','w','nw'] as const){const b=moveRegion(item.box,h,[100,-100],[100,80]);assert.ok(b[0]>=0&&b[1]>=0&&b[2]<=100&&b[3]<=80&&b[2]>b[0]&&b[3]>b[1]);}
  assert.deepEqual(moveRegion(item.box,'nw',[-3,-4],[100,80]),[7,6,30,40]);
});
test('source coordinates are independent of view zoom and drag direction',()=>{
  assert.deepEqual(sourcePoint([40,55],{left:10,top:10,width:150,height:150},[100,100]),[20,30]);
  assert.deepEqual(createRegionBox([40,50],[5,10],[100,80]),[5,10,40,50]);
});
test('geometry editing keeps ID, clears only changed selection; selecting or cancelled geometry preserves it',()=>{
  assert.equal(editedRegion(item,[10,10,30,40]),item);
  const changed=editedRegion(item,[9,10,30,40]);assert.equal(changed.id,item.id);assert.equal(changed.selection,undefined);
  assert.deepEqual(hitRegion([item],0,[10,10],2),{index:0,handle:'nw'});
});
test('undo/redo restores geometry AND generator/manual mode; no-op drag creates no history',()=>{
  const h=new RegionHistory(),before={text:'grid',mode:'grid' as const,selected:0},after={text:'edited',mode:'manual' as const,selected:0};
  h.record(before,before);assert.equal(h.past.length,0);h.record(before,after);
  assert.deepEqual(h.undo(after),before);assert.deepEqual(h.redo(before),after);
  h.record(after,{...after,text:'new'});assert.equal(h.future.length,0);
});
test('JSON key reconciliation follows IDs and unchanged drafts through insertion, reordering and deletion',()=>{
  const {id,...draft}=item;
  const other:RegionItem={name:'new',enabled:true,box:[0,0,5,5]};let serial=0;
  const previous=[item,draft,draft],keys=['saved','draft-a','draft-b'];
  const next=[other,draft,{...item,name:'renamed',box:[1,1,20,20] as [number,number,number,number]},draft];
  const reconciled=reconcileRegionKeys(previous,keys,next,()=>`new-${++serial}`);
  assert.deepEqual(reconciled,['new-1','draft-a','saved','draft-b']);assert.equal(new Set(reconciled).size,4);
  assert.deepEqual(reconcileRegionKeys(next,reconciled,[next[3]!,next[0]!],()=>`new-${++serial}`),['draft-a','new-1']);
});
test('editing controls and dialogs retain keyboard ownership',()=>{
  assert.equal(regionShortcutAllowed({closest:()=>({})} as any),false);
  assert.equal(regionShortcutAllowed({closest:()=>null} as any),true);
});
