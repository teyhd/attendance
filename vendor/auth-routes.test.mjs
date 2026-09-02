import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import {
  requireApiAuth,
  requireOwnAttendanceAuth,
  requirePageAuth,
  requirePermission,
  setupAuthRoutes,
} from './auth.mjs';

test('local logout clears Attendance cookies without redirecting to SSO', async () => {
  const { baseURL, close } = await startAuthTestServer();
  try {
    const response = await fetch(`${baseURL}/api/auth/local-logout`, {
      redirect: 'manual',
      headers: {
        cookie: 'atten.sid=old-session; atten.auth.state=old-state',
      },
    });

    assert.equal(response.status, 204);
    assert.equal(response.headers.get('location'), null);
    const cookies = setCookieHeaders(response);
    assert(cookies.some((cookie) => cookie.startsWith('atten.sid=;')));
    assert(cookies.some((cookie) => cookie.startsWith('atten.auth.state=;')));
  } finally {
    await close();
  }
});

test('local logout only redirects to local return paths', async () => {
  const { baseURL, close } = await startAuthTestServer();
  try {
    const localResponse = await fetch(`${baseURL}/api/auth/local-logout?return_to=/attendance`, {
      redirect: 'manual',
    });
    assert.equal(localResponse.status, 302);
    assert.equal(localResponse.headers.get('location'), '/attendance');

    const externalResponse = await fetch(`${baseURL}/api/auth/local-logout?return_to=https://example.com`, {
      redirect: 'manual',
    });
    assert.equal(externalResponse.status, 204);
    assert.equal(externalResponse.headers.get('location'), null);
  } finally {
    await close();
  }
});

test('starting SSO login clears any previous Attendance session cookie', async () => {
  const previousEnv = setAuthEnv({
    APP_ENV: 'local',
    SSO_CLIENT_SECRET: 'test-client-secret',
    JWT_SECRET: 'test-jwt-secret',
    AUTH_SESSION_SECRET: 'test-session-secret',
  });
  const { baseURL, close } = await startAuthTestServer();

  try {
    const response = await fetch(`${baseURL}/api/auth/login`, {
      redirect: 'manual',
      headers: {
        cookie: 'atten.sid=old-session',
      },
    });

    assert.equal(response.status, 302);
    assert.match(response.headers.get('location') || '', /^https:\/\/platoniks\.ru\/sso\/authorize\?/);
    assert(setCookieHeaders(response).some((cookie) => cookie.startsWith('atten.sid=;')));
  } finally {
    await close();
    restoreEnv(previousEnv);
  }
});

test('student session lands on own attendance and is blocked from staff routes', async () => {
  const previousEnv = setAuthEnv({
    APP_ENV: 'local',
    AUTH_SESSION_SECRET: 'test-session-secret',
  });
  const app = express();
  app.use(cookieParser());
  setupAuthRoutes(app);
  app.get('/student-only', requireOwnAttendanceAuth, (_req, res) => res.json({ ok: true }));
  app.get('/staff-page', requirePageAuth, (_req, res) => res.send('staff'));
  app.get('/staff-api', requireApiAuth, (_req, res) => res.json({ ok: true }));
  const { baseURL, close } = await startServer(app);
  const cookie = signedSessionCookie({
    auth_version: 2,
    uid: 10,
    name: 'Student',
    raw_role_id: 1,
    role: 'student',
    exp: Math.floor(Date.now() / 1000) + 60,
  }, process.env.AUTH_SESSION_SECRET);

  try {
    const me = await fetch(`${baseURL}/api/me`, { headers: { cookie } });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).routing.landing, '/attendance/me');

    const own = await fetch(`${baseURL}/student-only`, { headers: { cookie } });
    assert.equal(own.status, 200);

    const staffPage = await fetch(`${baseURL}/staff-page`, { redirect: 'manual', headers: { cookie } });
    assert.equal(staffPage.status, 403);

    const staffApi = await fetch(`${baseURL}/staff-api`, { headers: { cookie, accept: 'application/json' } });
    assert.equal(staffApi.status, 403);
  } finally {
    await close();
    restoreEnv(previousEnv);
  }
});

test('staff session is blocked from student-only route', async () => {
  const previousEnv = setAuthEnv({
    APP_ENV: 'local',
    AUTH_SESSION_SECRET: 'test-session-secret',
  });
  const app = express();
  app.use(cookieParser());
  app.get('/student-only', requireOwnAttendanceAuth, (_req, res) => res.json({ ok: true }));
  const { baseURL, close } = await startServer(app);
  const cookie = signedSessionCookie({
    auth_version: 2,
    uid: 20,
    name: 'Teacher',
    raw_role_id: 2,
    role: 'teacher',
    exp: Math.floor(Date.now() / 1000) + 60,
  }, process.env.AUTH_SESSION_SECRET);

  try {
    const response = await fetch(`${baseURL}/student-only`, {
      redirect: 'manual',
      headers: { cookie, accept: 'application/json' },
    });
    assert.equal(response.status, 403);
  } finally {
    await close();
    restoreEnv(previousEnv);
  }
});

test('teachers mentors and tutors can open the presence page and its board API', async () => {
  const previousEnv = setAuthEnv({
    APP_ENV: 'local',
    AUTH_SESSION_SECRET: 'test-session-secret',
  });
  const app = express();
  app.use(cookieParser());
  app.get('/attendance/presence', requirePageAuth, (_req, res) => res.send('presence'));
  app.get('/attendance/presence/manual', requirePageAuth, requirePermission('manage_presence'), (_req, res) => res.send('manual presence'));
  app.get('/api/attendance/presence/board', requireApiAuth, (_req, res) => res.json({ ok: true }));
  const { baseURL, close } = await startServer(app);

  try {
    for (const [roleID, role] of [[2, 'teacher'], [3, 'mentor'], [4, 'tutor']]) {
      const cookie = signedSessionCookie({
        auth_version: 2,
        uid: 20 + roleID,
        name: role,
        raw_role_id: roleID,
        role,
        exp: Math.floor(Date.now() / 1000) + 60,
      }, process.env.AUTH_SESSION_SECRET);

      const page = await fetch(`${baseURL}/attendance/presence`, { headers: { cookie } });
      assert.equal(page.status, 200, `${role} presence page`);

      const board = await fetch(`${baseURL}/api/attendance/presence/board`, {
        headers: { cookie, accept: 'application/json' },
      });
      assert.equal(board.status, 200, `${role} presence board`);

      const manual = await fetch(`${baseURL}/attendance/presence/manual`, {
        redirect: 'manual',
        headers: { cookie, accept: 'application/json' },
      });
      assert.equal(manual.status, role === 'mentor' ? 200 : 403, `${role} manual presence page`);
    }
  } finally {
    await close();
    restoreEnv(previousEnv);
  }
});

test('administrator can open the presence page and its board API', async () => {
  const previousEnv = setAuthEnv({
    APP_ENV: 'local',
    AUTH_SESSION_SECRET: 'test-session-secret',
  });
  const app = express();
  app.use(cookieParser());
  setupAuthRoutes(app);
  app.get('/attendance/presence', requirePageAuth, (_req, res) => res.send('presence'));
  app.get('/attendance/presence/manual', requirePageAuth, requirePermission('manage_presence'), (_req, res) => res.send('manual presence'));
  app.get('/api/attendance/presence/board', requireApiAuth, (_req, res) => res.json({ ok: true }));
  const { baseURL, close } = await startServer(app);
  const cookie = signedSessionCookie({
    auth_version: 2,
    uid: 50,
    name: 'Administrator',
    raw_role_id: 5,
    role: 'admin',
    exp: Math.floor(Date.now() / 1000) + 60,
  }, process.env.AUTH_SESSION_SECRET);

  try {
    const page = await fetch(`${baseURL}/attendance/presence`, { headers: { cookie } });
    assert.equal(page.status, 200);

    const board = await fetch(`${baseURL}/api/attendance/presence/board`, {
      headers: { cookie, accept: 'application/json' },
    });
    assert.equal(board.status, 200);

    const manual = await fetch(`${baseURL}/attendance/presence/manual`, { headers: { cookie } });
    assert.equal(manual.status, 200);

    const me = await fetch(`${baseURL}/api/me`, { headers: { cookie } });
    assert.equal(me.status, 200);
    const user = await me.json();
    assert.equal(user.permissions.view_adult_attendance, true);
    assert.equal(user.permissions.manage_presence, true);
  } finally {
    await close();
    restoreEnv(previousEnv);
  }
});

test('legacy Attendance sessions are invalidated so current SSO rights are requested', async () => {
  const previousEnv = setAuthEnv({
    APP_ENV: 'local',
    SSO_CLIENT_SECRET: 'test-client-secret',
    JWT_SECRET: 'test-jwt-secret',
    AUTH_SESSION_SECRET: 'test-session-secret',
  });
  const app = express();
  app.use(cookieParser());
  app.get('/staff-page', requirePageAuth, (_req, res) => res.send('staff'));
  const { baseURL, close } = await startServer(app);
  const legacyCookie = signedSessionCookie({
    uid: 30,
    name: 'Stale teacher session',
    raw_role_id: 0,
    role: 'guest',
    exp: Math.floor(Date.now() / 1000) + 60,
  }, process.env.AUTH_SESSION_SECRET);

  try {
    const response = await fetch(`${baseURL}/staff-page`, {
      redirect: 'manual',
      headers: { cookie: legacyCookie },
    });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/api/auth/login');
  } finally {
    await close();
    restoreEnv(previousEnv);
  }
});

async function startAuthTestServer() {
  const app = express();
  app.use(cookieParser());
  setupAuthRoutes(app);
  return startServer(app);
}

async function startServer(app) {
  const server = http.createServer(app);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  return {
    baseURL: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  };
}

function signedSessionCookie(payload, secret) {
  const payloadPart = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payloadPart).digest('base64url');
  return `atten.sid=${payloadPart}.${signature}`;
}

function setCookieHeaders(response) {
  if (typeof response.headers.getSetCookie === 'function') {
    return response.headers.getSetCookie();
  }
  const header = response.headers.get('set-cookie');
  return header ? [header] : [];
}

function setAuthEnv(values) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  return previous;
}

function restoreEnv(previous) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}
