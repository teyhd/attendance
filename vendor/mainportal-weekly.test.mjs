import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {buildWeeklyAttendance,loadWeeklyAttendance} from './mainportal-weekly.mjs';
import {verifyScheduleScope,loadPortalContext} from './mainportal-context.mjs';
const date='2026-11-17';
const arrivals=['2026-11-12','2026-11-13'].map(day=>({student_id:10,attendance_date:day,arrival_at:`${day} 09:10:00`,name:'Fixture',class_id:3,excluded:0}));
const lessons=arrivals.map(row=>({student_id:10,lesson_date:row.attendance_date,version_id:1,start_time:'09:00:00',end_time:'09:40:00',slot_part:'FULL',unsafe:0}));
test('weekly factual repeats retain explicit covered-day denominator',()=>{
 const result=buildWeeklyAttendance(arrivals,lessons,date);
 assert.equal(result.items.length,1);assert.equal(result.coverage.coveredDays,2);
 assert.match(result.items[0].rows[0].description,/2 из 2.*20 мин/);
});
test('unknown, edited, released, absent, conflicted and missing schedule days never count as lateness',()=>{
 for(const altered of [lessons.map(row=>({...row,unsafe:1})),[],lessons.map(row=>({...row,slot_part:'UNKNOWN'})),[...lessons,...lessons]]) {
  const result=buildWeeklyAttendance(arrivals,altered,date);
  assert.equal(result.coverage.coveredDays,0);assert.deepEqual(result.items,[]);
 }
 const result=buildWeeklyAttendance(arrivals.map(row=>({...row,excluded:1})),lessons,date);
 assert.equal(result.coverage.coveredDays,0);assert.deepEqual(result.items,[]);
});
test('H2 starts halfway through slot; missing arrivals never generate a fact',()=>{
 const result=buildWeeklyAttendance(arrivals,lessons.map(row=>({...row,slot_part:'H2'})),date);
 assert.equal(result.coverage.coveredDays,2);assert.deepEqual(result.items,[]);
 assert.deepEqual(buildWeeklyAttendance([],lessons,date).items,[]);
});
test('batch queries are scoped and explicitly exclude historical ambiguity',async()=>{
 const queries=[];
 const executor={query:async(sql,args)=>{queries.push({sql,args});return [queries.length===1?arrivals:lessons]}};
 await loadWeeklyAttendance(executor,[10],date);
 assert.equal(queries.length,2);
 assert.deepEqual(queries[0].args,[10,date,date]);assert.deepEqual(queries[1].args,[10,date,date]);
 for(const pattern of [/cancelled_at IS NULL/,/presence_absence_conflicts/,/absence_periods/])assert.match(queries[0].sql,pattern);
 for(const pattern of [/content_revision<>0/,/published_at>=/,/updated_at>=/,/return_conflict/,/schedule_flex_assignments/,/schedule_audit_log/,/'time_slot','activity_type'/,/e.is_online/])assert.match(queries[1].sql,pattern);
});
test('assigned grant is backwards compatible and cannot widen signed visible scope',()=>{
 const now=new Date('2026-11-17T10:00:00Z');const secret='test';
 const base={version:1,actorId:5,date,issuedAt:+now,expiresAt:+now+60000,studentIds:[10,11]};
 const sign=value=>{const body=Buffer.from(JSON.stringify(value)).toString('base64url');return `${body}.${crypto.createHmac('sha256',secret).update(body).digest('base64url')}`};
 const options={actorId:5,date,now,secret,includeAssignments:true};
 assert.deepEqual(verifyScheduleScope(sign(base),options),{studentIds:[10,11],assignedStudentIds:[]});
 assert.deepEqual(verifyScheduleScope(sign({...base,assignedStudentIds:[11]}),options).assignedStudentIds,[11]);
 assert.throws(()=>verifyScheduleScope(sign({...base,assignedStudentIds:[99]}),options),/invalid_schedule_scope/);
});
test('optional history failure does not fail current context and teacher-only cannot request weekly history',async()=>{
 const now=new Date('2026-11-17T10:00:00Z');
 let historyCalls=0;
 const executor={query:async sql=>{
  if(sql.includes('SELECT DISTINCT r.role_id'))return [[{role_id:3,type:2}]];
  if(sql.includes('info_student_nastavnik'))return [[{id:10}]];
  if(sql.includes('MIN(p.occurred_at)')){historyCalls++;throw new Error('optional unavailable')}
  return [[]];
 }};
 const request={actorId:5,date,context:'personal',studentIds:[],expanded:true};
 const result=await loadPortalContext(executor,request,{now});
 assert.equal(result.schema,1);assert.equal(result.weeklyCoverage.status,'unavailable');
 assert.ok(result.unavailableFeatures.includes('weekly_attendance'));assert.equal(historyCalls,1);
 const teacher={query:async sql=>{
  if(sql.includes('SELECT DISTINCT r.role_id'))return [[{role_id:2,type:2}]];
  if(sql.includes('MIN(p.occurred_at)'))assert.fail('teacher cannot access weekly assigned history');
  return [[]];
 }};
 const own=await loadPortalContext(teacher,request,{now});
 assert.equal(own.weeklyCoverage,undefined);
});
