export function buildAttendanceActions(canManage = false) {
  if (!canManage) return [];
  return [
    {
      id: 'reason',
      label: 'По причине',
      description: 'Выбрать причину отсутствия',
      target: 'reason',
    },
    {
      id: 'planned',
      label: 'Запланировать отсутствие',
      description: 'Выбрать дату или период',
      target: 'planned',
    },
  ];
}
