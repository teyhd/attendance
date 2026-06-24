import crypto from 'crypto';

const stateCookieName = 'atten.auth.state';

function env(name, fallback = '') {
  const value = process.env[name];
  return value == null || String(value).trim() === '' ? fallback : String(value).trim();
}

function parseDuration(value, fallbackMs) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d+)\s*(ms|s|m|h|d)?$/i);
  if (!match) return fallbackMs;
  const amount = Number(match[1]);
  const unit = (match[2] || 'ms').toLowerCase();
  const multipliers = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return amount * (multipliers[unit] || 1);
}

export function getAuthConfig() {
  return {
    ssoBaseURL: env('SSO_BASE_URL', 'https://platoniks.ru/sso').replace(/\/+$/, ''),
    clientID: env('SSO_CLIENT_ID', 'atten'),
    clientSecret: env('SSO_CLIENT_SECRET'),
    callbackURL: env('SSO_CALLBACK_URL', 'https://stud.platoniks.ru/api/cb'),
    serviceID: Number(env('SSO_SERVICE_ID', '13')),
    jwtSecret: env('JWT_SECRET'),
    sessionSecret: env('AUTH_SESSION_SECRET'),
    sessionCookieName: env('AUTH_SESSION_COOKIE_NAME', 'atten.sid'),
    sessionTTL: parseDuration(env('AUTH_SESSION_TTL', '8h'), 8 * 60 * 60 * 1000),
    appEnv: env('APP_ENV', 'production'),
    authDisabled: env('AUTH_DISABLED') === '1',
  };
}

export function authConfigured() {
  const cfg = getAuthConfig();
  return Boolean(cfg.ssoBaseURL && cfg.clientID && cfg.clientSecret && cfg.callbackURL && cfg.serviceID && cfg.jwtSecret && cfg.sessionSecret);
}

export function setupAuthRoutes(app) {
  app.get('/api/auth/login', authLoginHandler);
  app.get('/api/cb', authCallbackHandler);
  app.get('/api/auth/logout', authLogoutHandler);
  app.post('/api/auth/logout', authLogoutHandler);
  app.get('/api/auth/local-logout', authLocalLogoutHandler);
  app.post('/api/auth/local-logout', authLocalLogoutHandler);
  app.get('/api/me', currentUserHandler);
}

export function requirePageAuth(req, res, next) {
  const cfg = getAuthConfig();
  const user = getAuthUserFromRequest(req);
  if (user?.permissions?.use_attendance) {
    req.authUser = user;
    return next();
  }
  if (user && !user.permissions?.use_attendance) {
    return res.status(403).send('Нет доступа к сервису посещаемости');
  }
  if (!authConfigured() && !cfg.authDisabled) {
    return res.status(503).send('SSO не настроен');
  }
  return res.redirect('/api/auth/login');
}

export function requireOwnAttendanceAuth(req, res, next) {
  const cfg = getAuthConfig();
  const user = getAuthUserFromRequest(req);
  if (user?.permissions?.view_own_attendance) {
    req.authUser = user;
    return next();
  }
  if (user && !user.permissions?.view_own_attendance) {
    if (wantsJson(req)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    return res.status(403).send('Нет доступа к личной посещаемости');
  }
  if (!authConfigured() && !cfg.authDisabled) {
    if (wantsJson(req)) {
      return res.status(503).json({ error: 'auth_not_configured' });
    }
    return res.status(503).send('SSO не настроен');
  }
  if (wantsJson(req)) {
    return res.status(401).json({ authenticated: false, login_url: '/api/auth/login' });
  }
  return res.redirect('/api/auth/login');
}

export function requireApiAuth(req, res, next) {
  const cfg = getAuthConfig();
  const user = getAuthUserFromRequest(req);
  if (user?.permissions?.use_attendance) {
    req.authUser = user;
    return next();
  }
  if (user && !user.permissions?.use_attendance) {
    return res.status(403).json({ error: 'forbidden' });
  }
  if (!authConfigured() && !cfg.authDisabled) {
    return res.status(503).json({ error: 'auth_not_configured' });
  }
  return res.status(401).json({ authenticated: false, login_url: '/api/auth/login' });
}

export function requirePermission(permission) {
  return (req, res, next) => {
    const user = req.authUser || getAuthUserFromRequest(req);
    if (!user) {
      if (wantsJson(req)) {
        return res.status(401).json({ authenticated: false, login_url: '/api/auth/login' });
      }
      return res.redirect('/api/auth/login');
    }
    req.authUser = user;
    if (!user.permissions?.[permission]) {
      if (wantsJson(req)) {
        return res.status(403).json({ error: 'forbidden' });
      }
      return res.status(403).send('Нет доступа к действию');
    }
    return next();
  };
}

export function getAuthUserFromRequest(req) {
  const cfg = getAuthConfig();
  if (cfg.authDisabled) {
    return buildUserContext({ sub: 0, name: 'Local Dev', right: [{ srv_id: cfg.serviceID, role_id: 5 }] }, cfg);
  }

  const rawCookie = req.cookies?.[cfg.sessionCookieName];
  if (!rawCookie || !cfg.sessionSecret) return null;

  const payload = verifySignedValue(rawCookie, cfg.sessionSecret);
  if (!payload || Number(payload.exp || 0) <= Math.floor(Date.now() / 1000)) return null;
  const rawRoleId = Number(payload.raw_role_id || 0);

  return {
    id: Number(payload.uid),
    name: payload.name || `uid:${payload.uid}`,
    rawRoleId,
    role: payload.role || roleName(rawRoleId),
    permissions: attendancePermissions(rawRoleId),
    landing: payload.landing || landingPath(rawRoleId),
  };
}

async function authLoginHandler(req, res) {
  if (!authConfigured()) {
    return res.status(503).json({ error: 'auth_not_configured' });
  }

  const cfg = getAuthConfig();
  const state = crypto.randomBytes(16).toString('hex');
  clearAuthCookies(req, res);
  res.cookie(stateCookieName, state, cookieOptions(req, { maxAge: 10 * 60 * 1000 }));

  const url = new URL(`${cfg.ssoBaseURL}/authorize`);
  url.searchParams.set('client_id', cfg.clientID);
  url.searchParams.set('redirect_uri', cfg.callbackURL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  url.searchParams.set('audience', cfg.clientID);
  res.redirect(url.toString());
}

async function authCallbackHandler(req, res) {
  if (!authConfigured()) {
    return res.status(503).json({ error: 'auth_not_configured' });
  }

  const cfg = getAuthConfig();
  const code = String(req.query.code || '').trim();
  const state = String(req.query.state || '').trim();
  const cookieState = String(req.cookies?.[stateCookieName] || '').trim();
  if (!code || !state || !cookieState || state !== cookieState) {
    return res.status(400).json({ error: 'state_mismatch' });
  }

  try {
    const token = await exchangeCodeForToken(code, cfg);
    const claims = verifyHS256JWT(token, cfg.jwtSecret);
    if (claims.aud && String(claims.aud) !== cfg.clientID) {
      throw new Error('jwt audience mismatch');
    }
    const user = buildUserContext(claims, cfg);
    const sessionValue = createSessionValue(user, cfg);

    clearAuthCookies(req, res);
    res.cookie(cfg.sessionCookieName, sessionValue, cookieOptions(req, { maxAge: cfg.sessionTTL }));
    res.clearCookie(stateCookieName, cookieOptions(req));
    res.redirect(user.landing || '/attendance');
  } catch (err) {
    res.status(401).json({ error: 'auth_failed', detail: err?.message || 'unknown' });
  }
}

function authLogoutHandler(req, res) {
  const cfg = getAuthConfig();
  clearAuthCookies(req, res);

  const url = new URL(`${cfg.ssoBaseURL}/logout`);
  url.searchParams.set('client_id', cfg.clientID);
  url.searchParams.set('post_logout_redirect_uri', appBaseURL(cfg.callbackURL) || 'https://stud.platoniks.ru');
  res.redirect(url.toString());
}

function authLocalLogoutHandler(req, res) {
  clearAuthCookies(req, res);

  const returnTo = localReturnPath(req.query.return_to || req.query.next || req.query.redirect);
  if (returnTo) return res.redirect(returnTo);
  return res.status(204).end();
}

function currentUserHandler(req, res) {
  const user = getAuthUserFromRequest(req);
  if (!user) {
    return res.status(401).json({ authenticated: false, login_url: '/api/auth/login' });
  }
  res.json({
    authenticated: true,
    user: {
      id: user.id,
      name: user.name,
      raw_role_id: user.rawRoleId,
      role: user.role,
    },
    permissions: user.permissions,
    routing: { landing: user.landing },
  });
}

async function exchangeCodeForToken(code, cfg) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: cfg.clientID,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.callbackURL,
  });

  const response = await fetch(`${cfg.ssoBaseURL}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`token endpoint status=${response.status}`);
  }
  const parsed = JSON.parse(text);
  if (!parsed.access_token) throw new Error('empty access_token');
  return parsed.access_token;
}

function buildUserContext(claims, cfg) {
  const userID = Number(claims.sub || 0);
  const rawRoleId = extractServiceRoleID(claims.right, cfg.serviceID);
  const role = roleName(rawRoleId);
  const permissions = attendancePermissions(rawRoleId);
  return {
    id: userID,
    name: String(claims.name || `uid:${userID}`),
    rawRoleId,
    role,
    landing: landingPath(rawRoleId),
    permissions,
  };
}

export function attendancePermissions(roleID) {
  const role = Number(roleID);
  const canUse = [2, 3, 4, 5].includes(role);
  const canManage = [3, 4, 5].includes(role);
  return {
    use_attendance: canUse,
    view_own_attendance: role === 1,
    view_adult_attendance: role === 5,
    mark_absence: canManage,
    manage_presence: role === 5,
  };
}

function roleName(roleID) {
  switch (Number(roleID)) {
    case 1: return 'student';
    case 2: return 'teacher';
    case 3: return 'mentor';
    case 4: return 'tutor';
    case 5: return 'admin';
    case 6: return 'parent';
    default: return Number(roleID) > 0 ? 'staff' : 'guest';
  }
}

function landingPath(roleID) {
  return Number(roleID) === 1 ? '/attendance/me' : '/attendance';
}

function extractServiceRoleID(rightClaim, serviceID) {
  if (!Array.isArray(rightClaim)) return 0;
  return rightClaim.reduce((maxRole, row) => {
    const srvID = Number(row?.srv_id || 0);
    const roleID = Number(row?.role_id || 0);
    return srvID === Number(serviceID) && roleID > maxRole ? roleID : maxRole;
  }, 0);
}

function createSessionValue(user, cfg) {
  const payload = {
    uid: user.id,
    name: user.name,
    raw_role_id: user.rawRoleId,
    role: user.role,
    permissions: user.permissions,
    landing: user.landing,
    exp: Math.floor((Date.now() + cfg.sessionTTL) / 1000),
  };
  return signValue(payload, cfg.sessionSecret);
}

function signValue(payload, secret) {
  const payloadPart = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payloadPart).digest('base64url');
  return `${payloadPart}.${signature}`;
}

function verifySignedValue(value, secret) {
  const [payloadPart, signature] = String(value || '').split('.');
  if (!payloadPart || !signature) return null;
  const expected = crypto.createHmac('sha256', secret).update(payloadPart).digest('base64url');
  if (!safeEqual(signature, expected)) return null;
  try {
    return JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function verifyHS256JWT(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('invalid jwt format');
  const [headerPart, payloadPart, signaturePart] = parts;
  const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8'));
  if (String(header.alg || '').toUpperCase() !== 'HS256') {
    throw new Error('unsupported jwt alg');
  }
  const expected = crypto.createHmac('sha256', secret).update(`${headerPart}.${payloadPart}`).digest('base64url');
  if (!safeEqual(signaturePart, expected)) {
    throw new Error('jwt signature mismatch');
  }
  const claims = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
  if (claims.exp && Number(claims.exp) <= Math.floor(Date.now() / 1000)) {
    throw new Error('jwt expired');
  }
  return claims;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function cookieOptions(req, extra = {}) {
  const cfg = getAuthConfig();
  return {
    path: '/',
    httpOnly: true,
    secure: cfg.appEnv !== 'local',
    sameSite: 'lax',
    ...extra,
  };
}

function clearAuthCookies(req, res) {
  const cfg = getAuthConfig();
  res.clearCookie(cfg.sessionCookieName, cookieOptions(req));
  res.clearCookie(stateCookieName, cookieOptions(req));
}

function localReturnPath(value) {
  const raw = String(value || '').trim();
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '';
  return raw;
}

function appBaseURL(callbackURL) {
  try {
    const parsed = new URL(callbackURL);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '';
  }
}

function wantsJson(req) {
  return req.path?.startsWith('/api/') || String(req.get?.('accept') || '').includes('application/json');
}
