import { kvDel, kvGetJson, kvSetJson } from './lib/kv.js';

/**
 * Strava-klient. Fra og med auth-omleggingen er ALLE funksjoner per-bruker:
 * tokens og best-efforts-cache lagres i KV på formen
 *   user:<userId>:strava-tokens
 *   user:<userId>:strava-best-efforts
 * og kalles alltid med userId som første argument. Det gamle fil-/tmp-baserte
 * lageret er fjernet – /tmp er efemert på Vercel og delte tokens per
 * instans var kilde til mange av de gamle feilene.
 */

const STRAVA_OAUTH_URL = 'https://www.strava.com/oauth/token';
const STRAVA_AUTHORIZE_URL = 'https://www.strava.com/oauth/authorize';
const STRAVA_API_BASE = 'https://www.strava.com/api/v3';
export const DEFAULT_SCOPE = 'read,activity:read_all,profile:read_all';

// Fornye litt før faktisk expiry så vi ikke racer klokken.
const REFRESH_LEEWAY_SECONDS = 120;

function tokensKey(userId) {
  if (!userId) throw new Error('Strava: userId er påkrevd');
  return `user:${userId}:strava-tokens`;
}

function bestEffortsKey(userId) {
  if (!userId) throw new Error('Strava: userId er påkrevd');
  return `user:${userId}:strava-best-efforts`;
}

/** Først standard STRAVA_*, så f.eks. Vercel-camelCase (stravaClientId, …). */
function stravaEnv(...keys) {
  for (const k of keys) {
    const v = process.env[k];
    if (v != null && String(v).trim() !== '') return v;
  }
  return undefined;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

async function readTokens(userId) {
  const data = await kvGetJson(tokensKey(userId));
  if (!data || typeof data.access_token !== 'string' || typeof data.refresh_token !== 'string') {
    return null;
  }
  return data;
}

async function writeTokens(userId, tokens) {
  await kvSetJson(tokensKey(userId), tokens);
}

/** Slett Strava-tokens for en bruker (brukes ved unlink). */
export async function clearStravaTokens(userId) {
  await kvDel(tokensKey(userId));
}

/**
 * Promise-lock per bruker for refresh. Strava roterer refresh_token ved hver
 * refresh; parallelle refresh-forsøk ville kollidert og invalidere token-paret.
 */
const refreshLocks = new Map();

async function refreshAccessToken(userId) {
  const existing = refreshLocks.get(userId);
  if (existing) return existing;

  const clientId = stravaEnv('STRAVA_CLIENT_ID', 'stravaClientId');
  const clientSecret = stravaEnv('STRAVA_CLIENT_SECRET', 'stravaClientSecret');
  if (!clientId || !clientSecret) {
    throw new Error('Mangler STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET');
  }

  const promise = (async () => {
    const state = await readTokens(userId);
    if (!state) {
      const err = new Error('Strava er ikke koblet til for denne brukeren.');
      err.code = 'STRAVA_NOT_CONNECTED';
      err.status = 401;
      throw err;
    }
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: state.refresh_token,
    });
    const resp = await fetch(STRAVA_OAUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      const err = new Error(`Strava token refresh failed (${resp.status}): ${text}`);
      err.status = resp.status;
      throw err;
    }
    const data = await resp.json();
    const prevScope = state.granted_scope;
    const next = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at,
      granted_scope: prevScope ?? null,
    };
    await writeTokens(userId, next);
    return next;
  })().finally(() => {
    refreshLocks.delete(userId);
  });

  refreshLocks.set(userId, promise);
  return promise;
}

async function getValidAccessToken(userId) {
  const state = await readTokens(userId);
  if (!state) {
    const err = new Error('Strava er ikke koblet til for denne brukeren.');
    err.code = 'STRAVA_NOT_CONNECTED';
    err.status = 401;
    throw err;
  }
  if (!state.expires_at || state.expires_at - REFRESH_LEEWAY_SECONDS <= nowSeconds()) {
    const refreshed = await refreshAccessToken(userId);
    return refreshed.access_token;
  }
  return state.access_token;
}

/** Sjekker om en bruker har koblet til Strava. */
export async function hasStravaConnection(userId) {
  if (!userId) return false;
  const tokens = await readTokens(userId);
  return Boolean(tokens);
}

async function stravaGet(userId, pathname, query) {
  const token = await getValidAccessToken(userId);
  const url = new URL(`${STRAVA_API_BASE}${pathname}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, String(v));
    }
  }

  let resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

  // Token kan ha blitt invalidert serverside (f.eks. revoked); prøv én refresh.
  if (resp.status === 401) {
    const refreshed = await refreshAccessToken(userId);
    resp = await fetch(url, { headers: { Authorization: `Bearer ${refreshed.access_token}` } });
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    const err = new Error(`Strava ${pathname} failed (${resp.status}): ${text}`);
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

export function buildAuthorizeUrl({ redirectUri, scope = DEFAULT_SCOPE, state }) {
  const clientId = stravaEnv('STRAVA_CLIENT_ID', 'stravaClientId');
  if (!clientId) throw new Error('Mangler STRAVA_CLIENT_ID');
  const url = new URL(STRAVA_AUTHORIZE_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('approval_prompt', 'force');
  url.searchParams.set('scope', scope);
  if (state) url.searchParams.set('state', state);
  return url.toString();
}

/** Strava sender komma- eller mellomrom-separerte scopes i redirect ?scope= */
export function hasActivityListScope(scopeString) {
  if (typeof scopeString !== 'string' || !scopeString.trim()) return null;
  const parts = scopeString
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  return parts.includes('activity:read_all') || parts.includes('activity:read');
}

/**
 * Bytter en autorisasjonskode mot tokens. Returnerer både tokens OG rå athlete-
 * respons, slik at auth-laget kan lage/koble til en bruker uten et ekstra API-
 * kall. For login-flyten (uten kjent userId) lagres IKKE tokens her – kallende
 * kode må selv bestemme hvor de skal høre hjemme.
 */
export async function exchangeCodeForTokens(code, redirectUri, grantedScope = '') {
  const clientId = stravaEnv('STRAVA_CLIENT_ID', 'stravaClientId');
  const clientSecret = stravaEnv('STRAVA_CLIENT_SECRET', 'stravaClientSecret');
  if (!clientId || !clientSecret) {
    throw new Error('Mangler STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET');
  }
  if (!redirectUri || typeof redirectUri !== 'string') {
    throw new Error('redirectUri er påkrevd og må matche authorize-kallet.');
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });

  const resp = await fetch(STRAVA_OAUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Strava code exchange failed (${resp.status}): ${text}`);
  }

  const data = await resp.json();
  const scopeToStore = (typeof grantedScope === 'string' && grantedScope.trim()) || data.scope || null;
  const tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at,
    granted_scope: scopeToStore,
  };
  return { tokens, athlete: data.athlete, scope: data.scope };
}

/** Lagre tokens fra exchangeCodeForTokens på en spesifikk bruker. */
export async function saveStravaTokensForUser(userId, tokens) {
  if (!userId) throw new Error('saveStravaTokensForUser: userId er påkrevd');
  await writeTokens(userId, tokens);
}

export async function getAthlete(userId) {
  return stravaGet(userId, '/athlete');
}

export async function getActivities(userId, { perPage = 10, page = 1, after, before } = {}) {
  return stravaGet(userId, '/athlete/activities', { per_page: perPage, page, after, before });
}

export async function getAthleteStats(userId, athleteId) {
  return stravaGet(userId, `/athletes/${athleteId}/stats`);
}

export async function getActivity(userId, id) {
  return stravaGet(userId, `/activities/${id}`);
}

export async function getActivityStreams(
  userId,
  id,
  keys = ['heartrate', 'velocity_smooth', 'time', 'distance', 'altitude', 'cadence'],
) {
  return stravaGet(userId, `/activities/${id}/streams`, {
    keys: keys.join(','),
    key_by_type: true,
  });
}

/**
 * Convenience: pull recent activities and shape them for the app/chat.
 */
export async function getRecentActivitiesSummary(userId, { days = 7, perPage = 30 } = {}) {
  const after = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
  const raw = await getActivities(userId, { perPage, after });
  const activities = [...raw].sort(
    (a, b) => new Date(b.start_date).getTime() - new Date(a.start_date).getTime(),
  );

  const totals = activities.reduce(
    (acc, a) => {
      acc.count += 1;
      acc.distanceMeters += a.distance || 0;
      acc.movingSeconds += a.moving_time || 0;
      acc.elevationMeters += a.total_elevation_gain || 0;
      return acc;
    },
    { count: 0, distanceMeters: 0, movingSeconds: 0, elevationMeters: 0 },
  );

  return {
    days,
    totals: {
      count: totals.count,
      distanceKm: +(totals.distanceMeters / 1000).toFixed(1),
      movingMinutes: Math.round(totals.movingSeconds / 60),
      elevationMeters: Math.round(totals.elevationMeters),
    },
    activities: activities.map((a) => ({
      id: a.id,
      name: a.name,
      type: a.sport_type || a.type,
      startDate: a.start_date_local,
      distanceKm: +((a.distance || 0) / 1000).toFixed(2),
      movingMinutes: Math.round((a.moving_time || 0) / 60),
      elevationMeters: Math.round(a.total_elevation_gain || 0),
      averageHeartrate: a.average_heartrate ?? null,
      maxHeartrate: a.max_heartrate ?? null,
      averagePaceSecPerKm:
        a.distance && a.moving_time ? Math.round(a.moving_time / (a.distance / 1000)) : null,
    })),
  };
}

export function formatPace(secPerKm) {
  if (!secPerKm || !Number.isFinite(secPerKm)) return '–';
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60).toString().padStart(2, '0');
  return `${m}:${s}/km`;
}

const RUN_SPORT_TYPES = new Set(['Run', 'TrailRun', 'VirtualRun']);

const STANDARD_RUN_EFFORT_ORDER = [
  '400m',
  '1/2 mile',
  '1k',
  '1 mile',
  '2 mile',
  '5k',
  '10k',
  '15k',
  '10 mile',
  '20k',
  'Half-Marathon',
  '30k',
  'Marathon',
];

async function loadBestEffortsCache(userId) {
  const parsed = await kvGetJson(bestEffortsKey(userId));
  if (!parsed || typeof parsed !== 'object') {
    return { scannedIds: [], bestByName: {}, lastScanAt: 0, totalRuns: 0, rateLimitedAt: 0 };
  }
  return {
    scannedIds: Array.isArray(parsed.scannedIds) ? parsed.scannedIds.map(String).filter(Boolean) : [],
    bestByName: parsed.bestByName && typeof parsed.bestByName === 'object' ? parsed.bestByName : {},
    lastScanAt: Number(parsed.lastScanAt) || 0,
    totalRuns: Number(parsed.totalRuns) || 0,
    rateLimitedAt: Number(parsed.rateLimitedAt) || 0,
  };
}

async function persistBestEffortsCache(userId, data) {
  await kvSetJson(bestEffortsKey(userId), data);
}

function sortedEffortList(bestByName) {
  const orderIndex = new Map(STANDARD_RUN_EFFORT_ORDER.map((n, i) => [n, i]));
  return Array.from(bestByName.values()).sort((a, b) => {
    const ai = orderIndex.has(a.name) ? orderIndex.get(a.name) : 999;
    const bi = orderIndex.has(b.name) ? orderIndex.get(b.name) : 999;
    if (ai !== bi) return ai - bi;
    return a.distanceMeters - b.distanceMeters;
  });
}

export async function readBestEffortsSnapshot(userId) {
  const cache = await loadBestEffortsCache(userId);
  const bestByName = new Map(Object.entries(cache.bestByName));
  // Vi regner en rate-limit som "fersk" i 15 min – Strava-vinduet.
  const rateLimited = cache.rateLimitedAt
    ? Date.now() - cache.rateLimitedAt < 15 * 60 * 1000
    : false;
  return {
    scannedRuns: cache.scannedIds.length,
    totalRuns: cache.totalRuns,
    pendingRuns: Math.max(0, cache.totalRuns - cache.scannedIds.length),
    lastScanAt: cache.lastScanAt,
    rateLimited,
    efforts: sortedEffortList(bestByName),
  };
}

export async function resetBestEffortsCache(userId) {
  await kvDel(bestEffortsKey(userId));
}

/**
 * Scan running activities and accumulate the fastest recorded `best_effort`
 * per standard distance across the entire Strava history for a given user.
 *
 * Each call scans up to `batch` new (previously un-scanned) runs. Results are
 * persisted to KV and merged with previous scans so calling this repeatedly
 * eventually covers the whole history.
 */
export async function getRunningBestEfforts(userId, { batch = 25, reset = false } = {}) {
  const safeBatch = Math.min(Math.max(Number(batch) || 25, 1), 200);

  if (reset) {
    await resetBestEffortsCache(userId);
  }

  const diskCache = await loadBestEffortsCache(userId);
  const scannedSet = new Set(diskCache.scannedIds.map(String));
  const bestByName = new Map(Object.entries(diskCache.bestByName));

  const allRuns = [];
  let page = 1;
  const perPage = 100;
  let rateLimited = false;

  while (true) {
    let pageResp;
    try {
      pageResp = await getActivities(userId, { perPage, page });
    } catch (err) {
      if (err?.status === 429) {
        rateLimited = true;
        if (page === 1 && scannedSet.size === 0) throw err;
        break;
      }
      if (page === 1) throw err;
      break;
    }
    if (!Array.isArray(pageResp) || pageResp.length === 0) break;
    for (const a of pageResp) {
      const kind = a?.sport_type || a?.type || '';
      if (RUN_SPORT_TYPES.has(kind)) allRuns.push(a);
    }
    if (pageResp.length < perPage) break;
    page += 1;
  }

  const sortedRuns = [...allRuns].sort(
    (a, b) => new Date(b.start_date).getTime() - new Date(a.start_date).getTime(),
  );
  const unscanned = sortedRuns.filter((a) => !scannedSet.has(String(a.id)));

  let scannedNew = 0;
  for (const a of unscanned) {
    if (scannedNew >= safeBatch) break;
    if (rateLimited) break;
    let detail;
    try {
      detail = await getActivity(userId, a.id);
    } catch (err) {
      if (err?.status === 429) {
        rateLimited = true;
        break;
      }
      continue;
    }
    scannedNew += 1;
    scannedSet.add(String(a.id));
    const efforts = Array.isArray(detail?.best_efforts) ? detail.best_efforts : [];
    for (const eff of efforts) {
      const name = eff?.name;
      const elapsed = Number(eff?.elapsed_time);
      if (!name || !Number.isFinite(elapsed) || elapsed <= 0) continue;
      const existing = bestByName.get(name);
      if (!existing || elapsed < existing.elapsedTime) {
        bestByName.set(name, {
          name,
          distanceMeters: Number(eff.distance) || 0,
          elapsedTime: elapsed,
          movingTime: Number(eff.moving_time) || elapsed,
          activityId: detail.id,
          activityName: detail.name,
          startDate: detail.start_date_local || detail.start_date,
          prRank: eff.pr_rank ?? null,
        });
      }
    }
  }

  const totalRuns = allRuns.length > 0 ? allRuns.length : diskCache.totalRuns;
  const updatedCache = {
    scannedIds: Array.from(scannedSet),
    bestByName: Object.fromEntries(bestByName),
    lastScanAt: Date.now(),
    totalRuns,
    rateLimitedAt: rateLimited ? Date.now() : 0,
  };
  await persistBestEffortsCache(userId, updatedCache);

  return {
    scannedRuns: scannedSet.size,
    scannedNew,
    totalRuns,
    pendingRuns: Math.max(0, totalRuns - scannedSet.size),
    batch: safeBatch,
    rateLimited,
    efforts: sortedEffortList(bestByName),
    lastScanAt: updatedCache.lastScanAt,
  };
}
