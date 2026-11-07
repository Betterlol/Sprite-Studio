import test from "node:test";
import assert from "node:assert/strict";
import { defaultAgentModel, agentModels } from "../studio/model.ts";
import type { ProductionTask } from "../studio/workflow-model.ts";
import { messageContinuation } from "./workflow-state.ts";
import {
  sendMessageAttempt, postMessageInput, messageRecoveries, recoveryKey, clearSubmittedComposer,
  restoreMessageInput, messageRecoveryNotice, MessageAttemptError,
  type MessageInput, type MessageRecovery, type ComposerInput, type RecoveryStore,
} from "./message-recovery.ts";

class MemoryStore implements RecoveryStore {
  private data = new Map<string,string>();
  get length() { return this.data.size; }
  key(index: number) { return [...this.data.keys()][index] || null; }
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string,value: string) { this.data.set(key,value); }
  removeItem(key: string) { this.data.delete(key); }
}
function deferred<T>() {
  let resolve!: (value:T)=>void, reject!: (reason:unknown)=>void;
  const promise = new Promise<T>((done,fail)=>{resolve=done;reject=fail;});
  return {promise,resolve,reject};
}
const id = (n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const project=id(1), sessionA=id(2), sessionB=id(3);
function input(overrides:Partial<MessageInput>={}):MessageInput {
  return {
    text:"  preserve my complete message\n", assetIds:[id(4)],
    clipReferences:[{clipId:id(5),revision:"clip-ref-v3",startFrameId:id(6),endFrameId:id(7)}],
    context:{clipId:id(8),frameId:id(9),draftId:id(10),documentRevision:"draft-v1",mode:"draft"},
    taskId:id(11),feedbackKind:"local",model:defaultAgentModel,outputFolder:"原图素材/original",
    ...overrides,
  };
}
const empty = ():ComposerInput=>({text:"",assetIds:[],clipReferences:[]});
function task():ProductionTask {
  return {
    id:id(11),projectId:project,sessionId:sessionA,requestId:id(12),requestHash:"hash",revision:3,intentVersion:2,barrierVersion:2,
    title:"task",description:"description",phase:"delivery",status:"accepted",target:{clipId:id(8),revision:"old",mode:"saved"},referenceIds:[],
    contract:{roleReferenceIds:[],immutable:[],generationLimit:1,repairLimit:3,requiredChecks:["static"]},attempts:[],
    direction:{accept:true,intentVersion:2,contentHash:"pixels",createdAt:"now"},directionHistory:[],findings:[],checks:[],acceptanceHistory:[],createdAt:"now",updatedAt:"now",
  };
}
async function withFetch<T>(fetcher:typeof fetch, action:()=>Promise<T>) {
  const previous=globalThis.fetch;globalThis.fetch=fetcher;
  try{return await action();}finally{globalThis.fetch=previous;}
}
const json = (status:number,body:unknown)=>new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json"}});
async function rejectAttempt(store:RecoveryStore,requestId:string,value=input()) {
  await assert.rejects(sendMessageAttempt({store,projectId:project,sessionId:sessionA,requestId,input:value,
    prepare:async()=>({sessionId:sessionA,input:value}),onPrepared:()=>{},send:postMessageInput,
  }),MessageAttemptError);
  return messageRecoveries(store,project,sessionA).find(record=>record.requestId===requestId)!;
}

test("N1 real send path persists A before clear, late network failure in B restores all A input without touching B",async()=>{
  const store=new MemoryStore(), network=deferred<Response>(), posted=deferred<void>();
  const original=input(), frozen=input({context:{...original.context!,documentRevision:"draft-exact-v2"}});
  let currentView="A", composerA:ComposerInput=structuredClone(original), composerB:ComposerInput={text:"B later input",assetIds:[id(20)],clipReferences:[]};
  let posts=0;
  await withFetch(async(url,options)=>{
    posts++;assert.equal(String(url),`/api/sessions/${sessionA}/messages`);
    const payload=JSON.parse(String(options?.body));
    assert.deepEqual(payload,{...frozen,text:frozen.text.trim(),requestId:id(30)});
    posted.resolve();return network.promise;
  },async()=>{
    const pending=sendMessageAttempt({store,projectId:project,sessionId:sessionA,requestId:id(30),input:original,
      prepare:async()=>({sessionId:sessionA,input:{...frozen,feedbackKind:messageContinuation(task(),frozen.context,"local")}}),
      onPrepared:record=>{
        assert.equal(currentView,"A");
        assert.deepEqual(messageRecoveries(store,project,sessionA)[0]!.input,frozen);
        composerA=clearSubmittedComposer(composerA,record.input);
        store.setItem(`studio.draft.${project}.${sessionA}`,composerA.text);
      },send:postMessageInput,
    });
    await posted.promise;
    assert.equal(composerA.text,"");assert.equal(store.getItem(`studio.draft.${project}.${sessionA}`),"");
    currentView="B";const bBefore=structuredClone(composerB);
    network.reject(new TypeError("network disconnected after POST"));
    await assert.rejects(pending,(error:unknown)=>error instanceof MessageAttemptError&&error.recovery.status==="unknown");
    assert.deepEqual(composerB,bBefore);assert.deepEqual(messageRecoveries(store,project,sessionB),[]);
    currentView="A";
    const record=messageRecoveries(store,project,sessionA)[0]!;
    assert.equal(record.contextFrozen,true);assert.equal(record.postStarted,true);
    const restored=restoreMessageInput(record,composerA)!;
    assert.deepEqual(restored,frozen);composerA=restored;
    assert.equal(posts,1);assert.equal(currentView,"A");
    assert.deepEqual(composerA.assetIds,original.assetIds);assert.deepEqual(composerA.clipReferences,original.clipReferences);
    assert.equal(restored.feedbackKind,"local");assert.equal(restored.context?.documentRevision,"draft-exact-v2");
  });
});

test("N1 newer A text/references/context survive late failure and explicit restore refuses to overwrite",async()=>{
  const store=new MemoryStore(), network=deferred<Response>(), posted=deferred<void>(), original=input();
  let current:MessageInput|ComposerInput=structuredClone(original);
  await withFetch(async()=>{posted.resolve();return network.promise;},async()=>{
    const pending=sendMessageAttempt({store,projectId:project,sessionId:sessionA,requestId:id(31),input:original,
      prepare:async()=>({sessionId:sessionA,input:original}),onPrepared:record=>{current=clearSubmittedComposer(current,record.input);},send:postMessageInput,
    });
    await posted.promise;
    const later=input({text:"A typed something newer",assetIds:[id(21)],clipReferences:[],context:{assetId:id(22),revision:"new-view",mode:"saved"},feedbackKind:undefined});
    current=later;
    network.resolve(json(409,{error:"version conflict"}));
    await assert.rejects(pending,MessageAttemptError);
    const record=messageRecoveries(store,project,sessionA)[0]!;
    assert.equal(record.status,"failed");assert.deepEqual(record.input,original);
    assert.equal(restoreMessageInput(record,current),null);assert.deepEqual(current,later);
    assert.deepEqual(messageRecoveries(store,project,sessionB),[]);
  });
});

test("N1 edits made while context preparation waits are not cleared by onPrepared",async()=>{
  const store=new MemoryStore(), prepare=deferred<{sessionId:string;input:MessageInput}>();
  const original=input(), later=input({text:"newer while preparing",assetIds:[id(24)]});
  let current:ComposerInput=structuredClone(original),posts=0;
  await withFetch(async()=>{posts++;return json(400,{error:"bad input"});},async()=>{
    const pending=sendMessageAttempt({store,projectId:project,sessionId:sessionA,requestId:id(32),input:original,
      prepare:()=>prepare.promise,onPrepared:record=>{current=clearSubmittedComposer(current,record.input);},send:postMessageInput,
    });
    current=later;prepare.resolve({sessionId:sessionA,input:original});
    await assert.rejects(pending,MessageAttemptError);
    assert.deepEqual(current,later);assert.equal(posts,1);
    assert.deepEqual(messageRecoveries(store,project,sessionA)[0]!.input,original);
  });
});

test("N1 newer explicit context/continuation/model/folder is not cleared while preparation resolves",async()=>{
  const patches:Partial<ComposerInput>[]=[
    {context:{...input().context!,frameId:id(60)}}, {feedbackKind:"direction"},
    {model:agentModels[1]}, {outputFolder:"原图素材/new-choice"}, {recoverySourceId:undefined},
  ];
  let posts=0;
  await withFetch(async()=>{posts++;return json(409,{error:"rejected"});},async()=>{
    for(let index=0;index<patches.length;index++){
      const store=new MemoryStore(),original=input(),ready=deferred<{sessionId:string;input:MessageInput}>();
      const sourceId=id(61);
      let current:ComposerInput={...original,recoverySourceId:sourceId};
      const pending=sendMessageAttempt({store,projectId:project,sessionId:sessionA,requestId:id(70+index),input:original,
        prepare:()=>ready.promise,onPrepared:record=>{current=clearSubmittedComposer(current,{...record.input,recoverySourceId:sourceId});},send:postMessageInput,
      });
      const later={...current,...patches[index]};current=later;
      ready.resolve({sessionId:sessionA,input:{...original,context:{...original.context!,documentRevision:"ack-v2"}}});
      await assert.rejects(pending,MessageAttemptError);
      assert.deepEqual(current,later);
      assert.equal(messageRecoveries(store,project,sessionA).length,1);
    }
    assert.equal(posts,patches.length);
  });
});

test("N1 confirmed success clears its own and unchanged restored source slots, not unrelated newer recoveries",async()=>{
  const store=new MemoryStore();let calls=0;
  await withFetch(async()=>{calls++;return calls<3?json(409,{error:"reject"}):json(200,{id:sessionA});},async()=>{
    const source=await rejectAttempt(store,id(33));
    const newer=await rejectAttempt(store,id(34),input({text:"different later input"}));
    const restored=restoreMessageInput(source,empty())!;
    const result=await sendMessageAttempt({store,projectId:project,sessionId:sessionA,requestId:id(35),input:restored,recoveredFrom:source,initialContextFrozen:source.contextFrozen,
      prepare:async()=>({sessionId:sessionA,input:restored}),onPrepared:()=>{},send:postMessageInput,
    });
    assert.equal(result.id,sessionA);assert.equal(store.getItem(recoveryKey(source)),null);
    assert.equal(store.getItem(recoveryKey({projectId:project,sessionId:sessionA,requestId:id(35)})),null);
    assert.deepEqual(messageRecoveries(store,project,sessionA),[newer]);assert.equal(calls,3);
  });
});

test("N1 a successful edited message does not erase the different original recovery input",async()=>{
  const store=new MemoryStore();let calls=0;
  await withFetch(async()=>{calls++;return calls===1?json(409,{error:"reject"}):json(200,{id:sessionA});},async()=>{
    const source=await rejectAttempt(store,id(36));
    const edited={...restoreMessageInput(source,empty())!,feedbackKind:"direction" as const};
    await sendMessageAttempt({store,projectId:project,sessionId:sessionA,requestId:id(37),input:edited,recoveredFrom:source,
      prepare:async()=>({sessionId:sessionA,input:edited}),onPrepared:()=>{},send:postMessageInput,
    });
    assert.deepEqual(messageRecoveries(store,project,sessionA),[source]);assert.equal(calls,2);
  });
});

test("N1 5xx/unknown outcome survives reload and restore without any automatic retry",async()=>{
  const store=new MemoryStore();let posts=0;
  await withFetch(async()=>{posts++;return json(503,{error:"reply unavailable"});},async()=>{
    const record=await rejectAttempt(store,id(38));
    assert.equal(record.status,"unknown");assert.match(messageRecoveryNotice(record),/可能已经发送/);
    const reloaded=new MemoryStore();
    for(let index=0;index<store.length;index++){const key=store.key(index)!;reloaded.setItem(key,store.getItem(key)!);}
    const recovered=messageRecoveries(reloaded,project,sessionA)[0]!;
    assert.deepEqual(restoreMessageInput(recovered,empty()),input());
    messageRecoveries(reloaded,project,sessionA);await Promise.resolve();
    assert.equal(posts,1);assert.equal(messageRecoveries(reloaded,project,sessionA).length,1);
  });
});

test("N1 pre-POST failure keeps original full context/intent without clearing or posting",async()=>{
  const store=new MemoryStore(),original=input();let cleared=0,posts=0;
  await withFetch(async()=>{posts++;throw new Error("must not POST");},async()=>{
    await assert.rejects(sendMessageAttempt({store,projectId:project,sessionId:sessionA,requestId:id(39),input:original,
      prepare:async()=>{throw new Error("task/session changed before POST");},onPrepared:()=>{cleared++;},send:postMessageInput,
    }),MessageAttemptError);
    const record=messageRecoveries(store,project,sessionA)[0]!;
    assert.equal(record.postStarted,false);assert.equal(record.contextFrozen,false);assert.equal(record.status,"failed");
    assert.deepEqual(record.input,original);assert.match(messageRecoveryNotice(record),/尚未提交/);
    assert.equal(cleared,0);assert.equal(posts,0);
  });
});

test("N1 new-session preparation moves recovery to actual destination before composer clear and POST",async()=>{
  const store=new MemoryStore(),original=input({taskId:undefined,feedbackKind:undefined});let posts=0;
  await withFetch(async(url)=>{posts++;assert.equal(String(url),`/api/sessions/${sessionA}/messages`);throw new TypeError("lost response");},async()=>{
    await assert.rejects(sendMessageAttempt({store,projectId:project,sessionId:"",requestId:id(40),input:original,
      prepare:async()=>({sessionId:sessionA,input:original}),onPrepared:record=>{
        assert.equal(record.sessionId,sessionA);assert.equal(messageRecoveries(store,project,"").length,0);
        assert.deepEqual(messageRecoveries(store,project,sessionA)[0]!.input,JSON.parse(JSON.stringify(original)));
      },send:postMessageInput,
    }),MessageAttemptError);
    assert.equal(messageRecoveries(store,project,"").length,0);assert.equal(messageRecoveries(store,project,sessionA).length,1);assert.equal(posts,1);
  });
});

test("N1 explicit new-conversation recovery is cleared after its actual destination acknowledges success",async()=>{
  const store=new MemoryStore(),value=input({taskId:undefined,feedbackKind:undefined});
  await assert.rejects(sendMessageAttempt({store,projectId:project,sessionId:"",requestId:id(80),input:value,
    prepare:async()=>{throw new Error("session creation did not complete");},onPrepared:()=>{},send:postMessageInput,
  }),MessageAttemptError);
  const source=messageRecoveries(store,project,"")[0]!,restored=restoreMessageInput(source,empty())!;
  let posts=0;
  await withFetch(async()=>{posts++;return json(200,{id:sessionA});},async()=>{
    await sendMessageAttempt({store,projectId:project,sessionId:"",requestId:id(81),input:restored,recoveredFrom:source,
      prepare:async()=>({sessionId:sessionA,input:restored}),onPrepared:()=>{},send:postMessageInput,
    });
  });
  assert.equal(posts,1);assert.deepEqual(messageRecoveries(store,project,""),[]);assert.deepEqual(messageRecoveries(store,project,sessionA),[]);
});

test("ordinary task discussion sends context without implicitly adding trusted feedbackKind",async()=>{
  const store=new MemoryStore(),value=input({feedbackKind:undefined}),before=task();let posted:unknown;
  await withFetch(async(_url,options)=>{posted=JSON.parse(String(options?.body));return json(200,{id:sessionA});},async()=>{
    await sendMessageAttempt({store,projectId:project,sessionId:sessionA,requestId:id(41),input:value,
      prepare:async()=>({sessionId:sessionA,input:{...value,feedbackKind:messageContinuation(before,value.context,"none")}}),onPrepared:()=>{},send:postMessageInput,
    });
  });
  assert.ok(posted&&typeof posted==="object");assert.equal("feedbackKind" in posted,false);
  assert.deepEqual((posted as MessageInput).context,value.context);assert.deepEqual(before,task());
});

test("explicit same-clip local continuation sends exact stabilized draft and survives unknown outcome",async()=>{
  const store=new MemoryStore(),value=input();let payload:MessageInput|undefined;
  const stable={...value.context!,documentRevision:"exact-human-draft-v7"};
  await withFetch(async(_url,options)=>{payload=JSON.parse(String(options?.body));throw new TypeError("unknown after submit");},async()=>{
    await assert.rejects(sendMessageAttempt({store,projectId:project,sessionId:sessionA,requestId:id(42),input:value,
      prepare:async()=>({sessionId:sessionA,input:{...value,context:stable,feedbackKind:messageContinuation(task(),stable,"local")}}),onPrepared:()=>{},send:postMessageInput,
    }),MessageAttemptError);
  });
  assert.equal(payload?.feedbackKind,"local");assert.deepEqual(payload?.context,stable);
  const restored=restoreMessageInput(messageRecoveries(store,project,sessionA)[0]!,empty())!;
  assert.equal(restored.feedbackKind,"local");assert.deepEqual(restored.context,stable);
});

test("explicit direction continuation is retained, while paused/different-clip/invalid local are rejected",()=>{
  const value=input(),bound=task();
  assert.equal(messageContinuation(bound,value.context,"direction"),"direction");
  assert.equal(messageContinuation(undefined,undefined,"none"),undefined);
  assert.throws(()=>messageContinuation({...bound,status:"paused"},value.context,"local"),/先明确继续/);
  assert.throws(()=>messageContinuation(bound,{clipId:id(50),mode:"saved"},"direction"),/同一动画/);
  assert.throws(()=>messageContinuation(bound,undefined,"local"),/同一动画/);
  assert.throws(()=>messageContinuation({...bound,direction:undefined},value.context,"local"),/有效方向/);
});
