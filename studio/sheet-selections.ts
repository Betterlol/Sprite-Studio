import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { sha256, StudioError, type ProjectStore } from "./store.ts";

type SelectionRecord = { sourceContentHash: string; box: number[]; imageHash: string };
const validHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function objectPath(store: ProjectStore, pid: string, hash: string, extension: string) {
  if (!validHash(hash)) throw new StudioError("不可变选区引用无效", 409);
  return store.safePath(pid, `.studio/sheet-selections/${hash}.${extension}`);
}
function immutable(path: string, bytes: Buffer) {
  if (existsSync(path)) {
    if (!readFileSync(path).equals(bytes)) throw new StudioError("不可变选区对象已改变",409);
  } else writeFileSync(path,bytes,{flag:"wx"});
}
export function saveSelection(store: ProjectStore, pid: string, sourceContentHash: string, box: number[], bytes: Buffer) {
  const imageHash=sha256(bytes), record:SelectionRecord={sourceContentHash,box:[...box],imageHash};
  const text=JSON.stringify(record), hash=sha256(text);
  mkdirSync(store.safePath(pid,".studio/sheet-selections"),{recursive:true});
  immutable(objectPath(store,pid,imageHash,"png"),bytes);
  immutable(objectPath(store,pid,hash,"json"),Buffer.from(text));
  return hash;
}
export function readSelection(store: ProjectStore,pid:string,hash:string) {
  const recordPath=objectPath(store,pid,hash,"json");
  if (!existsSync(recordPath)) throw new StudioError("选区对象不存在，请重新生成区域或使用矩形",409);
  const text=readFileSync(recordPath,"utf8");
  if(sha256(text)!==hash) throw new StudioError("不可变选区记录已改变",409);
  let record:SelectionRecord;
  try { record=JSON.parse(text); } catch { throw new StudioError("选区记录无效",409); }
  if(!validHash(record.sourceContentHash)||!validHash(record.imageHash)||!Array.isArray(record.box)||record.box.length!==4||!record.box.every(Number.isInteger)) throw new StudioError("选区记录无效",409);
  const path=objectPath(store,pid,record.imageHash,"png");
  if(!existsSync(path)||sha256(readFileSync(path))!==record.imageHash) throw new StudioError("不可变选区图片已改变",409);
  return {...record,path,recordPath};
}
