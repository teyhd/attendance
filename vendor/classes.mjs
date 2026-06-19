import { compareClassNames } from './analytics.mjs';

export function buildActiveClassList(rows = []) {
  return rows
    .map((row) => {
      const studentsCount = Number(row.students_count ?? row.studentsCount ?? 0);
      return {
        id: String(row.id ?? row.class_id ?? ''),
        name: String(row.name ?? row.class_name ?? ''),
        students_count: Number.isFinite(studentsCount) ? studentsCount : 0,
      };
    })
    .filter((item) => item.id && item.name && item.students_count > 0)
    .sort((left, right) => {
      const leftId = Number(left.id);
      const rightId = Number(right.id);
      const idOrder = Number.isFinite(leftId) && Number.isFinite(rightId) ? leftId - rightId : 0;
      return compareClassNames(left.name, right.name) || idOrder || left.id.localeCompare(right.id, 'ru');
    });
}

export function studentCountLabel(value) {
  const count = Number(value || 0);
  return `${count} ${studentWord(count)}`;
}

function studentWord(value) {
  const abs = Math.abs(Number(value || 0));
  const mod100 = abs % 100;
  const mod10 = abs % 10;
  if (mod100 >= 11 && mod100 <= 14) return 'учеников';
  if (mod10 === 1) return 'ученик';
  if (mod10 >= 2 && mod10 <= 4) return 'ученика';
  return 'учеников';
}
