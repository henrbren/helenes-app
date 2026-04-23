import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_CACHE_PATH = path.join(__dirname, '.strava-tokens.json');
const BEST_EFFORTS_CACHE_PATH = path.join(__dirname, '.strava-best-efforts.json');

const STRAVA_OAUTH_URL = 'https://www.strava.com/oauth/token';
const STRAVA_AUTHORIZE_URL = 'https://www.strava.com/oauth/authorize';
const STRAVA_API_BASE = 'https://www.strava.com/api/v3';
export const DEFAULT_SCOPE = 'read,activity:read_all,profile:read_all';
// Refresh a little before actual expiry so we don't race the clock.
const REFRESH_LEEWAY_SECONDS = 120;

let tokenState = null;

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

async function readCachedTokens() {
  try {
    const raw = await fs.readFile(TOKEN_CACHE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.access_token === 'string' && typeof parsed.refresh_token === 'string') {
      return parsed;
    }
  } catch {
    // No cache yet; that's fine.
  }
  return null;
}

async function persistTokens(tokens) {
  try {
    await fs.writeFile(TOKEN_CACHE_PATH, JSON.stringify(tokens, null, 2), 'utf8');
  } catch (err) {
    console.warn('[strava] could not persist refreshed tokens:', err?.message || err);
  }
}

async function loadInitialState() {
  if (tokenState) return tokenState;

  const cached = await readCachedTokens();
  if (cached) {
    tokenState = cached;
    return tokenState;
  }

  const accessToken = process.env.STRAVA_ACCESS_TOKEN;
  const refreshToken = process.env.STRAVA_REFRESH_TOKEN;
  const expiresAt = Number(process.env.STRAVA_EXPIRES_AT || 0);

  if (!accessToken || !refreshToken) {
    throw new Error(
      'Missing Strava credentials. Set STRAVA_ACCESS_TOKEN and STRAVA_REFRESH_TOKEN in backend/.env'
    );
  }

  tokenState = {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : 0,
  };
  return tokenState;
}

async function refreshAccessToken() {
  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Missing STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET in backend/.env');
  }

  const state = await loadInitialState();
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
    throw new Error(`Strava token refresh failed (${resp.status}): ${text}`);
  }

  const data = await resp.json();
  const prevScope = state.granted_scope;
  tokenState = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at,
    granted_scope: prevScope ?? null,
  };
  await persistTokens(tokenState);
  return tokenState;
}

async function getValidAccessToken() {
  const state = await loadInitialState();
  if (!state.expires_at || state.expires_at - REFRESH_LEEWAY_SECONDS <= nowSeconds()) {
    const refreshed = await refreshAccessToken();
    return refreshed.access_token;
  }
  return state.access_token;
}

async function stravaGet(pathname, query) {
  const token = await getValidAccessToken();
  const url = new URL(`${STRAVA_API_BASE}${pathname}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, String(v));
    }
  }

  let resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

  // Token might have been invalidated server-side (e.g. revoked); try one refresh.
  if (resp.status === 401) {
    const refreshed = await refreshAccessToken();
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

export function buildAuthorizeUrl({ redirectUri, scope = DEFAULT_SCOPE }) {
  const clientId = process.env.STRAVA_CLIENT_ID;
  if (!clientId) throw new Error('Missing STRAVA_CLIENT_ID');
  const url = new URL(STRAVA_AUTHORIZE_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('approval_prompt', 'force');
  url.searchParams.set('scope', scope);
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

export async function exchangeCodeForTokens(code, redirectUri, grantedScope = '') {
  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Missing STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET');
  }
  if (!redirectUri || typeof redirectUri !== 'string') {
    throw new Error('redirectUri is required and must match the authorize request exactly');
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
  tokenState = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at,
    granted_scope: scopeToStore,
  };
  await persistTokens(tokenState);
  return { tokens: tokenState, athlete: data.athlete, scope: data.scope };
}

export async function getAthlete() {
  return stravaGet('/athlete');
}

export async function getActivities({ perPage = 10, page = 1, after, before } = {}) {
  return stravaGet('/athlete/activities', { per_page: perPage, page, after, before });
}

export async function getAthleteStats(athleteId) {
  return stravaGet(`/athletes/${athleteId}/stats`);
}

export async function getActivity(id) {
  return stravaGet(`/activities/${id}`);
}

export async function getActivityStreams(
  id,
  keys = ['heartrate', 'velocity_smooth', 'time', 'distance', 'altitude', 'cadence']
) {
  return stravaGet(`/activities/${id}/streams`, {
    keys: keys.join(','),
    key_by_type: true,
  });
}

/**
 * Convenience: pull recent activities and shape them for the app/chat.
 */
export async function getRecentActivitiesSummary({ days = 7, perPage = 30 } = {}) {
  const after = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
  const raw = await getActivities({ perPage, after });
  // Strava returns ascending order when `after` is set; we want newest first.
  const activities = [...raw].sort(
    (a, b) => new Date(b.start_date).getTime() - new Date(a.start_date).getTime()
  );

  const totals = activities.reduce(
    (acc, a) => {
      acc.count += 1;
      acc.distanceMeters += a.distance || 0;
      acc.movingSeconds += a.moving_time || 0;
      acc.elevationMeters += a.total_elevation_gain || 0;
      return acc;
    },
    { count: 0, distanceMeters: 0, movingSeconds: 0, elevationMeters: 0 }
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

/**
 * Strava's built-in "best effort" distance names, in ascending order.
 * We use this list to sort results and to filter out any non-standard entries.
 */
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

async function loadBestEffortsDiskCache() {
  try {
    const raw = await fs.readFile(BEST_EFFORTS_CACHE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const scannedIds = Array.isArray(parsed.scannedIds)
        ? parsed.scannedIds.map(String).filter(Boolean)
        : [];
      const bestByName =
        parsed.bestByName && typeof parsed.bestByName === 'object' ? parsed.bestByName : {};
      return {
        scannedIds,
        bestByName,
        lastScanAt: Number(parsed.lastScanAt) || 0,
        totalRuns: Number(parsed.totalRuns) || 0,
      };
    }
  } catch {
    // no cache yet
  }
  return { scannedIds: [], bestByName: {}, lastScanAt: 0, totalRuns: 0 };
}

async function persistBestEffortsDiskCache(data) {
  try {
    await fs.writeFile(BEST_EFFORTS_CACHE_PATH, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.warn('[strava] could not persist best efforts cache:', err?.message || err);
  }
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

export async function readBestEffortsSnapshot() {
  const cache = await loadBestEffortsDiskCache();
  const bestByName = new Map(Object.entries(cache.bestByName));
  return {
    scannedRuns: cache.scannedIds.length,
    totalRuns: cache.totalRuns,
    pendingRuns: Math.max(0, cache.totalRuns - cache.scannedIds.length),
    lastScanAt: cache.lastScanAt,
    rateLimited: false,
    efforts: sortedEffortList(bestByName),
  };
}

export async function resetBestEffortsCache() {
  try {
    await fs.unlink(BEST_EFFORTS_CACHE_PATH);
  } catch {
    // ignore if it doesn't exist
  }
}

/**
 * Scan running activities and accumulate the fastest recorded `best_effort`
 * per standard distance across the entire Strava history.
 *
 * Because `/activities/{id}` costs one API call per run and Strava's rate
 * limit is 100 req / 15 min, each call only scans up to `batch` new
 * (previously un-scanned) runs. Results are persisted to disk and merged
 * with previous scans so calling this repeatedly eventually covers the
 * whole history and the returned `efforts` are true all-time bests.
 *
 * If `reset` is true, the on-disk cache is cleared first.
 */
export async function getRunningBestEfforts({ batch = 25, reset = false } = {}) {
  const safeBatch = Math.min(Math.max(Number(batch) || 25, 1), 200);

  if (reset) {
    await resetBestEffortsCache();
  }

  const diskCache = await loadBestEffortsDiskCache();
  const scannedSet = new Set(diskCache.scannedIds.map(String));
  const bestByName = new Map(Object.entries(diskCache.bestByName));

  // Fetch all run summaries (cheap: 100 per page). This lets us know the
  // total number of runs and identify which ones still need detailed scanning.
  const allRuns = [];
  let page = 1;
  const perPage = 100;
  let rateLimited = false;

  while (true) {
    let pageResp;
    try {
      pageResp = await getActivities({ perPage, page });
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

  // Newest first so the first few scans quickly surface recent PRs.
  const sortedRuns = [...allRuns].sort(
    (a, b) => new Date(b.start_date).getTime() - new Date(a.start_date).getTime()
  );
  const unscanned = sortedRuns.filter((a) => !scannedSet.has(String(a.id)));

  let scannedNew = 0;
  for (const a of unscanned) {
    if (scannedNew >= safeBatch) break;
    if (rateLimited) break;
    let detail;
    try {
      detail = await getActivity(a.id);
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
  };
  await persistBestEffortsDiskCache(updatedCache);

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
