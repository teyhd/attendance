import mysql from 'mysql2'
let sets = {
    host: process.env.MDBHOST,
    user: process.env.DBUSER,
    password : process.env.DBPASS,
    database: process.env.DBNAMESUSR,
    charset : 'utf8mb4_general_ci',
    waitForConnections: true,
    connectionLimit: 100,
    maxIdle: 100, // max idle connections, the default value is the same as `connectionLimit`
    idleTimeout: 200, // idle connections timeout, in milliseconds, the default value 60000
    queueLimit: 0,
    enableKeepAlive: false,
    keepAliveInitialDelay: 0
}

const usr = mysql.createPool(sets).promise()

export async function getClasses() {
  const [rows] = await usr.query(
    `SELECT CAST(id AS CHAR) AS id, name
       FROM kaf_name
      WHERE type = 1 AND id > 0
      ORDER BY id`
  );
  return rows;
}

export async function getStudentsByClass(classId) {
  const [rows] = await usr.query(
    `SELECT
        CAST(id AS CHAR) AS id,
        COALESCE(NULLIF(nickname, ''), NULLIF(msgnickname, ''), name) AS name,
        CAST(kaf AS CHAR) AS classId
       FROM users
      WHERE type = 1 AND status = 1 AND kaf = ?
      ORDER BY name`,
    [classId]
  );
  return rows;
}

export async function getStudentById(id) {
  const [rows] = await usr.query(
    `SELECT
        CAST(id AS CHAR) AS id,
        COALESCE(NULLIF(nickname, ''), NULLIF(msgnickname, ''), name) AS name,
        CAST(kaf AS CHAR) AS classId
       FROM users
      WHERE type = 1 AND status = 1 AND id = ?
      LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}
