export function buildAttendanceActions(canManage = false) {
  if (!canManage) return [];
  return [
    {
      id: 'planned',
      label: 'Запланировать отсутствие',
      description: 'Выбрать дату или период',
      target: 'planned',
    },
  ];
}
