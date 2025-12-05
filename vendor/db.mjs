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

export async function get_all_roles() {
  const [rows] = await usr.query(
    'SELECT id, name FROM role_name ORDER BY name'
  );
  return rows;
}
