// Deliberately narrow historical coverage: direct, physical, unedited published
// schedules only. A missing observation never becomes a late/absent pupil.
const instant = value => Date.parse(`${String(value).replace(' ', 'T')}+03:00`);

export function buildWeeklyAttendance(arrivals, lessons, date) {
  const byDay = new Map();
  for (const lesson of lessons) {
    const key = `${lesson.student_id}|${lesson.lesson_date}`;
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(lesson);
  }
  const students = new Map();
  let covered = 0;
  for (const arrival of arrivals) {
    const key = `${arrival.student_id}|${arrival.attendance_date}`;
    const rows = byDay.get(key) || [];
    if (Number(arrival.excluded) || !rows.length || rows.some(row => Number(row.unsafe))) continue;
    const versions = new Set(rows.map(row => String(row.version_id)));
    if (versions.size !== 1) continue;
    const intervals = rows.map(row => {
      let start = instant(`${row.lesson_date} ${row.start_time}`);
      let end = instant(`${row.lesson_date} ${row.end_time}`);
      const half = (end - start) / 2;
      if (!['FULL','H1','H2'].includes(row.slot_part) || !(end > start)) return null;
      if (row.slot_part === 'H1') end = start + half;
      if (row.slot_part === 'H2') start += half;
      return { start, end };
    });
    if (intervals.some(row => !row)) continue;
    intervals.sort((a,b) => a.start-b.start);
    if (intervals.some((row,index) => index && row.start < intervals[index-1].end)) continue;
    const at = instant(arrival.arrival_at);
    if (!Number.isFinite(at)) continue;
    covered++;
    const id = String(arrival.student_id);
    if (!students.has(id)) students.set(id,{id,name:arrival.name,classId:arrival.class_id,days:0,late:0,minutes:0});
    const student = students.get(id);
    student.days++;
    if (at > intervals[0].start) { student.late++; student.minutes += Math.ceil((at-intervals[0].start)/60000); }
  }
  const rows = [...students.values()].filter(student => student.late >= 2).map(student => ({
    id:student.id,name:student.name,
    description:`Поздний приход отмечен в ${student.late} из ${student.days} проверенных дней · ${student.minutes} мин суммарно`,
    annotations:['Только дни с однозначным индивидуальным очным расписанием и отметкой прихода'],
    href:`https://stud.platoniks.ru/attendance?class=${student.classId}&student=${student.id}&analyticsMonth=${date.slice(0,7)}#lateness-analytics`,
  }));
  return { items: rows.length ? [{key:'attendance:weekly',kind:'weekly_attendance',
    title:'Повторные поздние приходы за последние 7 завершённых дней',
    subtitle:`Проверено ${covered} из ${arrivals.length} дней с отметками прихода у подопечных; остальные не оценивались`,rows,
    actions:[]}] : [], coverage:{complete:covered===arrivals.length,arrivalDays:arrivals.length,coveredDays:covered,
      basis:'direct_physical_unedited_published',periodEnd:date} };
}

export async function loadWeeklyAttendance(executor, studentIds, date) {
  const ph=studentIds.map(()=>'?').join(',');
  const [arrivals]=await executor.query(`SELECT p.student_id,DATE_FORMAT(p.attendance_date,'%Y-%m-%d') AS attendance_date,
    DATE_FORMAT(MIN(p.occurred_at),'%Y-%m-%d %H:%i:%s') AS arrival_at,u.name,u.kaf AS class_id,
    (EXISTS (SELECT 1 FROM attendance.absence_periods ap WHERE ap.student_id=p.student_id AND ap.deleted_at IS NULL
      AND ap.starts_at<DATE_ADD(p.attendance_date,INTERVAL 1 DAY) AND (ap.ends_at IS NULL OR ap.ends_at>p.attendance_date))
     OR EXISTS (SELECT 1 FROM attendance.presence_absence_conflicts c JOIN attendance.presence_events ce ON ce.id=c.presence_event_id
       WHERE c.student_id=p.student_id AND c.status='open' AND ce.attendance_date=p.attendance_date)) AS excluded
    FROM attendance.presence_events p JOIN sso.users u ON u.id=p.student_id AND u.status=1 AND u.type=1
    WHERE p.student_id IN (${ph}) AND p.event_type='arrival' AND p.cancelled_at IS NULL
    AND p.attendance_date>=DATE_SUB(?,INTERVAL 7 DAY) AND p.attendance_date<?
    AND DATE(p.occurred_at)=p.attendance_date
    GROUP BY p.student_id,p.attendance_date,u.name,u.kaf ORDER BY p.student_id,p.attendance_date LIMIT 10501`,[...studentIds,date,date]);
  if (arrivals.length>10500) throw new Error('weekly_scope_too_large');
  const day='DATE(DATE_ADD(w.week_start,INTERVAL (ts.day_of_week-1) DAY))';
  const [lessons]=await executor.query(`SELECT u.id AS student_id,e.id AS entry_id,v.id AS version_id,
    DATE_FORMAT(${day},'%Y-%m-%d') AS lesson_date,TIME_FORMAT(ts.start_time,'%H:%i:%s') AS start_time,
    TIME_FORMAT(ts.end_time,'%H:%i:%s') AS end_time,UPPER(COALESCE(at.slot_part,'FULL')) AS slot_part,
    (e.student_id IS NULL OR e.student_id<>u.id OR e.group_id IS NOT NULL OR COALESCE(e.is_online,0)<>0
     OR COALESCE(e.activity_type,'') NOT IN ('default_lesson','indiv') OR ts.is_active<>1 OR v.content_revision<>0
     OR p.published_at>=${day} OR e.updated_at>=${day}
     OR EXISTS (SELECT 1 FROM school_local.schedule_absence_assignments a WHERE a.student_id=u.id AND a.week_version_id=v.id
       AND a.status='assigned' AND a.release_state IN ('full','partial','return_conflict')
       AND a.starts_at<DATE_ADD(${day},INTERVAL 1 DAY) AND a.ends_at>${day})
     OR EXISTS (SELECT 1 FROM school_local.schedule_flex_assignments fa
       JOIN school_local.schedule_flex_sessions fs ON fs.id=fa.session_id
       JOIN school_local.schedule_time_slots ft ON ft.id=fs.slot_id
       WHERE fa.student_id=u.id AND fa.status='assigned' AND fs.week_id=w.id AND ft.day_of_week=ts.day_of_week
       AND fs.status NOT IN ('draft','cancelled'))) AS unsafe
    FROM sso.users u JOIN school_local.schedule_entries e ON (e.student_id=u.id
      OR (e.student_id IS NULL AND e.group_id IS NULL AND e.class_id=u.kaf)
      OR EXISTS (SELECT 1 FROM school_local.schedule_group_members gm WHERE gm.group_id=e.group_id AND gm.student_id=u.id))
    JOIN school_local.schedule_week_versions v ON v.id=e.week_version_id AND v.state='published'
    JOIN school_local.schedule_weeks w ON w.id=v.week_id
    JOIN school_local.schedule_publications p ON p.published_version_id=v.id AND p.week_id=w.id AND p.is_current=1
    JOIN school_local.schedule_time_slots ts ON ts.id=e.slot_id
    LEFT JOIN school_local.activity_types at ON at.code=e.activity_type
    WHERE u.id IN (${ph}) AND u.status=1 AND u.type=1 AND ${day}>=DATE_SUB(?,INTERVAL 7 DAY) AND ${day}<?
    ORDER BY u.id,lesson_date,ts.start_time,e.id LIMIT 30001`,[...studentIds,date,date]);
  if (lessons.length>30000) throw new Error('weekly_schedule_too_large');
  return buildWeeklyAttendance(arrivals,lessons,date);
}
