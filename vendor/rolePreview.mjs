import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const launchPath = '/internal/integrations/mainportal/v1/role-preview';
const cookieName = 'harmony.role-preview';
const maxAge = 10 * 60_000;
const digest = value => createHash('sha256').update(value).digest();
const random = bytes => randomBytes(bytes).toString('hex');
const validID = value => Number.isSafeInteger(value) && value > 0;
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);

const script = String.raw`
(() => {
  const status = document.querySelector('[data-role-preview-status]');
  const prefix = document.currentScript.dataset.prefix;
  if (!prefix) {
    const code = new URLSearchParams(location.hash.slice(1)).get('code');
    history.replaceState(history.state, '', location.pathname);
    if (!/^[a-f0-9]{64}$/.test(code || '')) return;
    status.textContent = 'Проверяем доступ…';
    fetch('/audit/exchange', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin', cache: 'no-store', body: JSON.stringify({ code }),
    }).then(async response => {
      if (!response.ok) throw new Error();
      const { location: target } = await response.json();
      if (!/^\/audit\/[a-f0-9]{32}\//.test(target)) throw new Error();
      location.replace(target);
    }).catch(() => { status.textContent = 'Просмотр недоступен. Откройте его заново из портала.'; });
    return;
  }

  const rawFetch = window.fetch.bind(window);
  const scopedURL = raw => {
    const url = new URL(raw, location.href);
    if (url.origin !== location.origin) return '';
    if (!url.pathname.startsWith(prefix + '/')) url.pathname = prefix + url.pathname;
    return url.href;
  };
  window.fetch = (input, options = {}) => {
    const request = input instanceof Request ? input : null;
    const target = scopedURL(request?.url || input);
    if (!target || String(options.method || request?.method || 'GET').toUpperCase() !== 'GET') {
      return Promise.resolve(new Response(JSON.stringify({ error: 'В режиме просмотра изменения недоступны.' }), {
        status: 403, headers: { 'Content-Type': 'application/json' },
      }));
    }
    return rawFetch(target, { ...options, headers: options.headers || request?.headers, credentials: 'same-origin' });
  };
  const xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    const target = scopedURL(url);
    return xhrOpen.call(this, method, target || prefix + '/blocked', ...rest);
  };

  let navigating = false;
  let ended = false;
  function finish(closeWindow) {
    if (!ended) {
      ended = true;
      rawFetch(prefix + '/close', { method: 'POST', credentials: 'same-origin', keepalive: true }).catch(() => {});
    }
    if (closeWindow) {
      const banner = document.querySelector('[data-role-preview-banner]');
      if (banner) banner.textContent = 'Просмотр завершён. Закройте вкладку.';
      document.querySelectorAll('body > :not([data-role-preview-banner])').forEach(node => { node.hidden = true; });
      window.close();
    }
  }

  function scopeLinks() {
    document.querySelectorAll('a[href]').forEach(link => {
      const href = link.getAttribute('href');
      if (!href || href.startsWith('#')) return;
      const url = new URL(href, location.href);
      if (url.origin !== location.origin || /(?:^|\/)(?:logout|login|cb)(?:\/|$)/i.test(url.pathname)) {
        link.removeAttribute('href');
        link.setAttribute('aria-disabled', 'true');
        return;
      }
      const target = scopedURL(url.href);
      if (target !== link.href) link.href = target;
      link.removeAttribute('target');
    });
  }
  document.addEventListener('DOMContentLoaded', () => {
    scopeLinks();
    new MutationObserver(scopeLinks).observe(document.body, { subtree: true, childList: true, attributeFilter: ['href', 'target'] });
    document.querySelector('[data-role-preview-close]')?.addEventListener('click', () => finish(true));
  });
  document.addEventListener('click', event => {
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (link && !String(link.getAttribute('href')).startsWith('#')) {
      const target = scopedURL(link.href);
      if (!target) {
        event.preventDefault();
        return;
      }
      if (link.href !== target) link.href = target;
      if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
        navigating = true;
        window.setTimeout(() => { if (event.defaultPrevented) navigating = false; }, 0);
      }
    }
  }, true);
  window.addEventListener('pagehide', () => {
    document.body.hidden = true;
    if (!navigating) finish(false);
  });
  window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    rawFetch(prefix + '/alive', { cache: 'no-store' }).then(response => {
      document.body.hidden = false;
      if (!response.ok) finish(true);
    }).catch(() => { document.body.hidden = false; finish(true); });
  });
  window.setTimeout(() => finish(true), Number(document.currentScript.dataset.remaining));
})();
`;

const bannerStyle = '<style>.role-preview-banner{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.45rem 1rem;padding:.65rem 1rem;background:#fff1ce;color:#493010;border-bottom:1px solid #bb8332;font:inherit;position:relative;z-index:20}.role-preview-banner button{font:inherit;cursor:pointer;padding:.35rem .65rem;border:1px solid #936322;border-radius:.4rem;background:transparent;color:inherit}.role-preview-banner small{display:block}</style>';

export function registerRolePreview(app, { key, origin, resolve, entry, allowRead, audit = () => {}, assets = [], now = Date.now }) {
  const launches = new Map();
  const views = new Map();
  const deny = res => res.status(403).json({ error: 'role_preview_forbidden' });
  const expired = res => res.status(401).send('Просмотр завершён. Откройте его заново из портала.');
  const noStore = res => res.set('Cache-Control', 'private, no-store');
  const cleanup = () => {
    const at = now();
    for (const map of [launches, views]) {
      for (const [id, item] of map) if (item.until <= at) map.delete(id);
    }
  };

  app.post(launchPath, async (req, res) => {
    noStore(res);
    const authorization = req.get('Authorization') || '';
    if (!key || !timingSafeEqual(digest(authorization), digest('Bearer ' + key))) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const { actor_id: actorId, subject_id: subjectId, child_id: childId = null } = req.body || {};
    if (!validID(actorId) || !validID(subjectId) || (childId !== null && !validID(childId))) return deny(res);
    try {
      if (!await resolve(actorId, subjectId)) return deny(res);
      cleanup();
      if (launches.size >= 256) return res.sendStatus(503);
      const code = random(32);
      const hash = digest(code).toString('hex');
      launches.set(hash, { actorId, subjectId, childId, until: now() + 60_000 });
      audit({ actorId, subjectId });
      return res.json({ code });
    } catch {
      return res.status(503).json({ error: 'role_preview_unavailable' });
    }
  });

  app.get('/audit/client.js', (_req, res) => res.type('js').send(script));
  app.get('/audit/', (_req, res) => {
    noStore(res);
    res.set('Content-Security-Policy', `default-src 'none'; script-src 'self'; connect-src ${origin}/audit/; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
    res.set('Referrer-Policy', 'no-referrer');
    res.send('<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Просмотр сервиса</title><p data-role-preview-status>Откройте просмотр из портала.</p><script src="/audit/client.js"></script></html>');
  });

  app.post('/audit/exchange', async (req, res) => {
    noStore(res);
    if (req.get('Origin') !== origin) return deny(res);
    const code = req.body?.code;
    if (typeof code !== 'string' || !/^[a-f0-9]{64}$/.test(code)) return expired(res);
    const hash = digest(code).toString('hex');
    const grant = launches.get(hash);
    launches.delete(hash);
    cleanup();
    if (!grant || grant.until <= now()) return expired(res);
    try {
      const user = await resolve(grant.actorId, grant.subjectId);
      if (!user) return deny(res);
      if (views.size >= 256) return res.sendStatus(503);
      const id = random(16);
      const credential = random(32);
      const prefix = '/audit/' + id;
      views.set(id, { ...grant, credential: digest(credential), until: now() + maxAge });
      res.cookie(cookieName, credential, { path: prefix + '/', httpOnly: true, sameSite: 'strict', secure: origin.startsWith('https:'), maxAge });
      return res.json({ location: prefix + entry(user, grant.childId) });
    } catch {
      return res.status(503).json({ error: 'role_preview_unavailable' });
    }
  });

  app.use(async (req, res, next) => {
    const url = new URL(req.url, origin);
    if (!url.pathname.startsWith('/audit/')) return next();
    if (url.origin !== origin) return deny(res);
    noStore(res);
    const match = /^\/audit\/([a-f0-9]{32})(\/.*)$/.exec(url.pathname);
    if (!match) return expired(res);
    const [, id, path] = match;
    const grant = views.get(id);
    const prefix = '/audit/' + id;
    const credential = String(req.headers.cookie || '').split(';').map(part => part.trim())
      .find(part => part.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    if (!grant || grant.until <= now() || !credential || !timingSafeEqual(grant.credential, digest(credential))) return expired(res);
    if (req.method === 'POST' && path === '/close') {
      if (req.get('Origin') !== origin) return deny(res);
      views.delete(id);
      res.clearCookie(cookieName, { path: prefix + '/' });
      return res.sendStatus(204);
    }
    if (req.method !== 'GET' || (path !== '/alive' && !allowRead(path))) return deny(res);

    try {
      const user = await resolve(grant.actorId, grant.subjectId);
      if (!user) return expired(res);
      if (path === '/alive') return res.sendStatus(204);
      req.rolePreview = user;
      delete req.headers.cookie;
      req.cookies = Object.create(null);
      req.signedCookies = Object.create(null);
      req.url = path + url.search;
      const setHeader = res.setHeader.bind(res);
      res.setHeader = (name, value) => name.toLowerCase() === 'set-cookie' ? res : setHeader(name, value);
      res.set('Referrer-Policy', 'no-referrer');
      res.set('X-Robots-Tag', 'noindex');
      const scriptSources = ['/audit/client.js', '/assets/', '/js/', '/vendor/', ...assets].map(path => origin + path).join(' ');
      res.set('Content-Security-Policy', `default-src 'none'; script-src 'unsafe-inline' ${scriptSources}; style-src 'unsafe-inline' ${origin}/assets/ ${origin}/css/ ${origin}/vendor/; font-src ${origin}/assets/ ${origin}/css/ ${origin}/fonts/; img-src data: ${origin}/img/ ${origin}/images/ ${origin}/assets/ ${origin}/favicon.ico; connect-src ${origin}${prefix}/; form-action 'none'; base-uri 'none'; frame-src 'none'; frame-ancestors 'none'; object-src 'none'`);
      const redirect = res.redirect.bind(res);
      res.redirect = (status, value) => {
        const target = new URL(value || status, origin);
        if (target.origin !== origin || !allowRead(target.pathname)) return deny(res);
        return redirect(typeof status === 'number' ? status : 302, prefix + target.pathname + target.search + target.hash);
      };
      const banner = '<div class="role-preview-banner" data-role-preview-banner><div><strong>Вы смотрите от лица '
        + escapeHtml(user.name) + '</strong><small>Только просмотр</small></div><button type="button" data-role-preview-close>Завершить просмотр</button></div>';
      const send = res.send.bind(res);
      res.send = body => {
        if (typeof body === 'string' && /<html(?:\s|>)/i.test(body)) {
          body = body.replace(/(<head(?:\s[^>]*)?>)/i, '$1' + bannerStyle + '<script src="/audit/client.js" data-prefix="' + prefix + '" data-remaining="' + Math.max(0, grant.until - now()) + '"></script>')
            .replace(/(<body(?:\s[^>]*)?>)/i, (_, match) => match + banner);
        }
        return send(body);
      };
      return next();
    } catch {
      return res.status(503).json({ error: 'role_preview_unavailable' });
    }
  });
}

export async function approvedPreviewAccount(pool, actorId, subjectId, serviceId) {
  if (!validID(serviceId) || serviceId === 1) return null;
  const [rows] = await pool.query(`
    SELECT subject.id, subject.type, subject.name, subject.kaf
      FROM sso.users subject
      JOIN sso.users actor
        ON actor.id = ? AND actor.status = 1 AND actor.lifecycle_state = 'active' AND actor.type <> -1
     WHERE subject.id = ? AND subject.status = 1 AND subject.lifecycle_state = 'active'
       AND subject.type NOT IN (-1, 5, 7)
       AND 2 = (
         SELECT COUNT(DISTINCT r.srv_id) FROM sso.rights r
         JOIN sso.srvs_roles sr ON sr.srvs_id = r.srv_id AND sr.role_id = r.role_id
          WHERE r.usr_id = actor.id AND r.srv_id IN (1, ?) AND r.role_id = 5
       )
       AND NOT EXISTS (
         SELECT 1 FROM sso.rights r
          WHERE r.usr_id = subject.id AND r.srv_id IN (1, ?) AND r.role_id IN (5, 7)
       )
  `, [actorId, subjectId, serviceId, serviceId]);
  return rows[0] || null;
}
