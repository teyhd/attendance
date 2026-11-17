// The person lock is always acquired before the legacy camera day lock.
export async function acquireToggleLocks(conn, studentId, date) {
  const names = [`attendance:person:${studentId}`, `attendance:presence:${studentId}:${date}`];
  const acquired = [];
  try {
    for (const name of names) {
      const [rows] = await conn.query('SELECT GET_LOCK(?, 3) AS locked', [name]);
      if (Number(rows[0]?.locked) !== 1) return { acquired, locked: false };
      acquired.push(name);
    }
    return { acquired, locked: true };
  } catch (err) {
    err.presenceLocks = acquired;
    err.presenceLockUncertain = true;
    throw err;
  }
}

export async function releaseToggleLocks(conn, names, uncertain = false) {
  let clean = !uncertain;
  for (const name of [...names].reverse()) {
    try {
      const [rows] = await conn.query('SELECT RELEASE_LOCK(?) AS released', [name]);
      if (Number(rows[0]?.released) !== 1) clean = false;
    } catch { clean = false; }
  }
  if (clean) conn.release();
  else conn.destroy();
}
