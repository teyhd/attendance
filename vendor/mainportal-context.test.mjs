import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import { buildPortalStudents, loadPortalContext, parsePortalRequest, permittedPortalStudents, registerMainportalContext } from './mainportal-context.mjs';
const now=new Date('2026-11-17T09:05:00+03:00');
const request={actorId:42,date:'2026-11-17',context:'personal',studentIds:[11]};
test('parent and guest cannot acquire attendance through submitted IDs',()=>{
 assert.deepEqual(permittedPortalStudents([6],[11],[],42),[]);
 assert.deepEqual(permittedPortalStudents([],[11],[],42),[]);
 assert.deepEqual(permittedPortalStudents([1],[11],[],42),[42]);
});
test('combined roles retain assigned scope without selecting a maximum role',()=>{
 assert.deepEqual(permittedPortalStudents([3],[999],[11],42),[11]);
 assert.deepEqual(permittedPortalStudents([2,3],[12],[11],42),[12,11]);
});
test('missing events remain unknown and late delivery is ordered by occurrence',()=>{
 const people=[{id:11,name:'Test'},{id:12,name:'Unknown'}];
 const rows=buildPortalStudents(people,[{id:20,student_id:11,event_type:'departure',occurred_at:'2026-11-17 12:00:00'},{id:30,student_id:11,event_type:'arrival',occurred_at:'2026-11-17 09:00:00'}],[],[]);
 assert.equal(rows[0].lastEvent.type,'departure');assert.equal(rows[1].lastEvent,null);
});
test('medical reasons and comments are excluded from the contract',()=>{
 const rows=buildPortalStudents([{id:11,name:'Test'}],[],[{id:1,student_id:11,starts_at:'2026-11-17 09:00:00',reason_code:'private',comment:'private',confirmation_status:'confirmed'}],[]);
 assert.doesNotMatch(JSON.stringify(rows),/private|reason_code|comment/);
});
test('invalid date, actor and unbounded input fail before DB work',()=>{
 for(const input of [{...request,date:'2026-11-16'},{...request,actorId:0},{...request,studentIds:Array(1501).fill(1)}])assert.throws(()=>parsePortalRequest(input,now),error=>error.status===400);
});
test('rights are rechecked and a parent cannot query school context',async()=>{
 const executor={query:async()=>[[{role_id:6,type:6}]]};
 await assert.rejects(loadPortalContext(executor,request,{now}),error=>error.status===403);
 const teacher={query:async()=>[[{role_id:2,type:2}]]};
 await assert.rejects(loadPortalContext(teacher,{...request,context:'school'},{now}),error=>error.status===403);
});

test('tutor assignments use the schedule scope without requiring an optional foreign table',async()=>{
 const queries=[];
 const executor={query:async sql=>{queries.push(sql);return [[{role_id:4,type:4}]];}};
 const data=await loadPortalContext(executor,{...request,studentIds:[]},{now});
 assert.deepEqual(data.assignedIds,[]);
 assert.equal(queries.length,1);
 assert.doesNotMatch(queries.join(' '),/info_student_tutor/);
});

test('dedicated signed requests return conditional responses without exposing extra fields',async()=>{
 let handler;const executor={query:async sql=>sql.includes('SELECT DISTINCT r.role_id')?[[{role_id:2,type:2}]]:[[]]};
 registerMainportalContext({post:(path,fn)=>handler=fn},executor,{serviceKey:'test-key',now});
 const body=JSON.stringify(request),timestamp=String(Date.now());
 const headers={'x-service-name':'mainportal','x-service-timestamp':timestamp,'x-service-signature':crypto.createHmac('sha256','test-key').update(`${timestamp}\n${body}`).digest('hex')};
 const invoke=async extra=>{const res={statusCode:200,headers:{},set(k,v){this.headers[k]=v;return this;},status(n){this.statusCode=n;return this;},json(body){this.body=body;return this;},end(){return this;}};await handler({headers:{...headers,...extra},rawJsonBody:body,body:request},res);return res;};
 const first=await invoke({});assert.equal(first.statusCode,200);assert.equal(first.body.schema,1);
 const second=await invoke({'if-none-match':first.headers.ETag});assert.equal(second.statusCode,304);
 const rejected=await invoke({'x-service-signature':'0'.repeat(64)});assert.equal(rejected.statusCode,401);
});
test('only the dedicated mainportal signature is accepted',async()=>{
 let handler;registerMainportalContext({post:(path,fn)=>handler=fn},{query:async()=>[[]]},{serviceKey:'test-key',now});
 const body=JSON.stringify(request);const timestamp=String(Date.now());
 const signature=crypto.createHmac('sha256','test-key').update(`${timestamp}\n${body}`).digest('hex');
 const response={statusCode:200,set(){return this;},status(value){this.statusCode=value;return this;},json(value){this.value=value;return this;}};
 await handler({headers:{'x-service-name':'diary','x-service-timestamp':timestamp,'x-service-signature':signature},rawJsonBody:body,body:request},response);
 assert.equal(response.statusCode,403);assert.equal(response.value.error,'service_forbidden');
});
