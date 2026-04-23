import crypto from 'node:crypto';
import { kvDel, kvGetJson, kvSetJson } from './kv.js';
import { findUserById, publicUser } from './users.js';

/**
 * Sesjons-lag.
 *
 * Nøkkel:  session:<token>  ->  { userId, createdAt, lastSeenAt }
 * TTL:     30 dager (rullende – fornyes ved hvert oppslag).
 *
 * Tokenet er 32 tilfeldige bytes base64url-enkodet. Det sendes fra klient enten
 * som `Authorization: Bearer <token>` (primær), `__session`-cookie (web) eller
 * `?token=` query-param (kun for OAuth-redirects hvor vi ikke kan sette
 * headers).
 */

export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 dager
export const SESSION_COOKIE_NAME = '__session';

function sessionKey(token) {
  return `session:${token}`;
}

export function generateSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export async function createSession(userId) {
  if (!userId) throw new Error('createSession requires userId');
  const token = generateSessionToken();
  const now = Date.now();
  const data = { userId, createdAt: now, lastSeenAt: now };
  await kvSetJson(sessionKey(token), data, SESSION_TTL_SECONDS);
  return { token, data };
}

/**
 * Slår opp sesjonen og oppdaterer `lastSeenAt` + forlenger TTL. Returnerer
 * null hvis sesjonen er ukjent/utløpt.
 */
export async function getSession(token) {
  if (!token || typeof token !== 'string') return null;
  const data = await kvGetJson(sessionKey(token));
  if (!data || !data.userId) return null;
  // Rullende expiry: oppdatér lastSeenAt og fornyer TTL-en på hvert oppslag,
  // men bare hvis det har gått minst ett minutt siden forrige oppdatering for
  // å unngå unødig skriving på hver request.
  const now = Date.now();
  if (!data.lastSeenAt || now - Number(data.lastSeenAt) > 60_000) {
    data.lastSeenAt = now;
    await kvSetJson(sessionKey(token), data, SESSION_TTL_SECONDS);
  }
  return data;
}

export async function destroySession(token) {
  if (!token) return;
  await kvDel(sessionKey(token));
}

/** Parse `Cookie`-headeren og finn `__session` om den finnes. */
function readCookie(req, name) {
  const raw = req.headers?.cookie;
  if (!raw || typeof raw !== 'string') return null;
  const parts = raw.split(/;\s*/);
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    if (k !== name) continue;
    const v = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  }
  return null;
}

/**
 * Prøver å lese token fra (i prioritert rekkefølge):
 *   1. `Authorization: Bearer …`
 *   2. `__session`-cookie (brukes av web-OAuth-redirects)
 *   3. `?token=` query-param (brukes av Linking.openURL under Strava-kobling)
 */
function tokenFromUrlQueryString(urlish) {
  if (!urlish || typeof urlish !== 'string') return null;
  try {
    const i = urlish.indexOf('?');
    if (i < 0) return null;
    const params = new URLSearchParams(urlish.slice(i + 1));
    const t = params.get('token');
    return typeof t === 'string' && t.trim() ? t.trim() : null;
  } catch {
    return null;
  }
}

export function readSessionTokenFromRequest(req) {
  const auth = req.headers?.authorization || req.headers?.Authorization;
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    const token = auth.slice(7).trim();
    if (token) return token;
  }
  const cookie = readCookie(req, SESSION_COOKIE_NAME);
  if (cookie) return cookie;
  const q = req.query?.token;
  if (typeof q === 'string' && q.trim()) return q.trim();
  // Vercel/Express: req.query kan være tom etter intern rewrite — les token fra URL-streng.
  const fromOriginal = tokenFromUrlQueryString(req.originalUrl);
  if (fromOriginal) return fromOriginal;
  const fromUrl = tokenFromUrlQueryString(req.url);
  if (fromUrl) return fromUrl;
  return null;
}

/**
 * Express-middleware som krever at request har en gyldig sesjon. Setter
 * `req.session` og `req.user` hvis alt er OK.
 */
export async function requireAuth(req, res, next) {
  try {
    const token = readSessionTokenFromRequest(req);
    if (!token) {
      res.status(401).json({ error: 'Ikke innlogget.', code: 'UNAUTHENTICATED' });
      return;
    }
    const session = await getSession(token);
    if (!session) {
      res.status(401).json({ error: 'Sesjonen er ugyldig eller utløpt.', code: 'SESSION_EXPIRED' });
      return;
    }
    const user = await findUserById(session.userId);
    if (!user) {
      // Brukeren er slettet, men sesjonen henger igjen – ryd opp.
      await destroySession(token);
      res.status(401).json({ error: 'Brukeren finnes ikke lenger.', code: 'USER_GONE' });
      return;
    }
    req.sessionToken = token;
    req.session = session;
    req.user = user;
    req.publicUser = publicUser(user);
    next();
  } catch (err) {
    console.error('[auth] requireAuth failed:', err?.message || err);
    res.status(500).json({ error: 'Autentisering feilet.' });
  }
}

/**
 * Bygger `Set-Cookie`-headeren for speiling til httpOnly-cookie på web.
 * Secure-flagg når vi kjører på HTTPS (alltid på Vercel).
 */
export function buildSessionCookie(token, { maxAgeSeconds = SESSION_TTL_SECONDS, clear = false } = {}) {
  const parts = [
    `${SESSION_COOKIE_NAME}=${clear ? '' : encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (process.env.VERCEL || process.env.AUTH_COOKIE_SECURE === '1') parts.push('Secure');
  const domain = process.env.AUTH_COOKIE_DOMAIN?.trim();
  if (domain) parts.push(`Domain=${domain}`);
  if (clear) {
    parts.push('Max-Age=0');
    parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  } else {
    parts.push(`Max-Age=${Math.floor(maxAgeSeconds)}`);
  }
  return parts.join('; ');
}
