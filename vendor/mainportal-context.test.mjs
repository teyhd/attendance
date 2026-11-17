import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import { buildPortalStudents, loadPortalContext, parsePortalRequest, permittedPortalStudents, registerMainportalContext, verifyScheduleScope } from './mainportal-context.mjs';
const now=new Date('2026-11-17T09:05:00+03:00');
const request={actorId:42,date:'2026-11-17',context:'personal',studentIds:[11]};
const scopeSecret = 'scope-test-only';
function grant(overrides = {}) {
 const payload = { version: 1, actorId: 42, date: request.date, studentIds: [11], issuedAt: now.getTime(), expiresAt: now.getTime() + 90000, ...overrides };
 const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
 return `${body}.${crypto.createHmac('sha256', scopeSecret).update(body).digest('base64url')}`;
}
test('schedule grants bind actor, date, lifetime and signature', () => {
 const options = { actorId: 42, date: request.date, now, secret: scopeSecret };
 assert.deepEqual(verifyScheduleScope(grant(), options), [11]);
 for (const token of [grant({actorId:43}), grant({date:'2026-11-18'}), grant({expiresAt:now.getTime()}), grant({expiresAt:now.getTime()+90001}), grant({studentIds:['11']}), `${grant()}x`, 'broken']) {
  assert.throws(() => verifyScheduleScope(token, options), error => error.status === 403);
 }
 assert.throws(() => verifyScheduleScope(grant(), {...options, secret:''}), error => error.status === 403);
});
test('expanded scope rejects arbitrary IDs before database access and preserves local fallback', async () => {
 let calls = 0;
 const executor = { query:async () => { calls++; return [[{role_id:2,type:2}]]; } };
 for (const input of [{...request,expanded:true}, {...request,expanded:true,studentIds:[12],scheduleScope:grant()}]) {
  await assert.rejects(loadPortalContext(executor,input,{now,scopeSecret}), error=>error.status===403);
 }
 assert.equal(calls,0);
 const result = await loadPortalContext(executor,{...request,expanded:true,studentIds:[]},{now,scopeSecret});
 assert.deepEqual(result.students,[]);
 assert.equal(calls,1);
});
test('expanded grants add verified teaching pupils to mentor scope, never parent access', async () => {
 const queries=[];
 const executor={query:async (sql,params)=>{queries.push({sql,params});
  if(sql.includes('SELECT DISTINCT r.role_id'))return [[{role_id:3,type:2}]];
  if(sql.includes('info_class_tutor'))return [[{id:12}]];
  if(sql.includes('SELECT u.id, u.name'))return [[{id:11,name:'First'},{id:12,name:'Second'}]];
  return [[]];
 }};
 const data=await loadPortalContext(executor,{...request,expanded:true,scheduleScope:grant()},{now,scopeSecret});
 assert.deepEqual(data.students.map(person=>person.id),['11','12']);
 assert.deepEqual(queries.find(item=>item.sql.includes('SELECT u.id, u.name')).params,[11,12]);
 assert.deepEqual(data.recentReturns,[]);
 await assert.rejects(loadPortalContext({query:async()=>[[{role_id:6,type:6}]]},{...request,expanded:true,scheduleScope:grant()},{now,scopeSecret}),error=>error.status===403);
});
test('dated workday crosses week boundary without draft or child scope',async()=>{
 const sunday=new Date('2026-11-22T10:00:00+03:00');
 const executor={query:async sql=>{
  if(sql.includes('SELECT DISTINCT r.role_id'))return [[{role_id:3,type:3}]];
  if(sql.includes('mentor_work_weeks'))return [[{week_start:'2026-11-16',published_json:JSON.stringify({'42':[]})},{week_start:'2026-11-23',published_json:JSON.stringify({'42':[['08:00','16:00']]})}]];
  return [[]];
 }};
 const data=await loadPortalContext(executor,{...request,date:'2026-11-22',studentIds:[],expanded:true},{now:sunday});
 assert.equal(data.workday[0].date,'2026-11-22');assert.equal(data.workday[0].status,'unassigned');
 assert.equal(data.workday[1].date,'2026-11-23');assert.equal(data.workday[1].start,'2026-11-23T08:00:00+03:00');
 assert.equal(data.shift.status,'unassigned');
});
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
