import { Redis } from '@upstash/redis';

/**
 * KV-lag for backend.
 *
 * I produksjon (Vercel) bruker vi Upstash Redis (tidligere Vercel KV). Vi
 * støtter både `KV_REST_API_*`-navnene fra "gamle" Vercel KV og Upstash sine
 * egne `UPSTASH_REDIS_REST_*` for å være robuste mot begge integrasjonene.
 *
 * Lokalt (`npm run dev`) finnes ingen av variablene – da faller vi tilbake på
 * en enkel in-memory Map, slik at alt (auth + Strava) fungerer under utvikling
 * uten at utviklere må sette opp Redis først.
 */

function envFirst(...keys) {
  for (const k of keys) {
    const v = process.env[k];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return undefined;
}

const REDIS_URL = envFirst('KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL');
const REDIS_TOKEN = envFirst('KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN');

let realRedis = null;
if (REDIS_URL && REDIS_TOKEN) {
  try {
    realRedis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
  } catch (err) {
    console.warn('[kv] failed to initialize Upstash Redis, falling back to memory store:', err?.message || err);
    realRedis = null;
  }
} else if (process.env.VERCEL) {
  console.warn(
    '[kv] KV_REST_API_URL/KV_REST_API_TOKEN (eller UPSTASH_REDIS_REST_URL/TOKEN) mangler på Vercel – bruker in-memory fallback. Auth og Strava-tokens vil IKKE overleve funksjons-restart.',
  );
}

/**
 * In-memory fallback. Lagrer JSON-strenger slik at semantikken matcher det vi
 * lagrer mot Upstash (som også lagrer strings for SET/GET). Expiry beregnes
 * lazily ved hver get: vi sammenligner mot en `expiresAt`-timestamp i stedet
 * for å bruke `setTimeout` – sistnevnte overflower for TTL > ~24.8 dager
 * (maks for 32-bit signed int).
 */
const memoryStore = new Map(); // key -> { value, expiresAt }

function memoryGetFresh(key) {
  const entry = memoryStore.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt && entry.expiresAt <= Date.now()) {
    memoryStore.delete(key);
    return undefined;
  }
  return entry;
}

const memory = {
  async get(key) {
    const entry = memoryGetFresh(key);
    return entry ? entry.value : null;
  },
  async set(key, value, opts) {
    const expiresAt = opts?.ex ? Date.now() + Math.floor(Number(opts.ex)) * 1000 : 0;
    memoryStore.set(key, { value, expiresAt });
    return 'OK';
  },
  async del(key) {
    return memoryStore.delete(key) ? 1 : 0;
  },
  async incr(key) {
    const entry = memoryGetFresh(key);
    const current = entry ? Number(entry.value) || 0 : 0;
    const next = current + 1;
    memoryStore.set(key, { value: String(next), expiresAt: entry?.expiresAt || 0 });
    return next;
  },
  async expire(key, ttlSeconds) {
    const entry = memoryGetFresh(key);
    if (!entry) return 0;
    entry.expiresAt = Date.now() + Math.floor(Number(ttlSeconds)) * 1000;
    memoryStore.set(key, entry);
    return 1;
  },
};

function client() {
  return realRedis || memory;
}

export function isUsingRealKv() {
  return Boolean(realRedis);
}

/** Lagre JSON-objekt. `ttlSeconds` er valgfritt. */
export async function kvSetJson(key, value, ttlSeconds) {
  const payload = JSON.stringify(value);
  if (ttlSeconds && Number.isFinite(ttlSeconds) && ttlSeconds > 0) {
    await client().set(key, payload, { ex: Math.floor(ttlSeconds) });
  } else {
    await client().set(key, payload);
  }
}

/** Hent JSON-objekt (eller null). */
export async function kvGetJson(key) {
  const raw = await client().get(key);
  if (raw == null) return null;
  if (typeof raw === 'object') return raw; // Upstash dekoder automatisk når vi lagrer JSON
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Lagre streng med valgfri TTL. */
export async function kvSetString(key, value, ttlSeconds) {
  if (ttlSeconds && Number.isFinite(ttlSeconds) && ttlSeconds > 0) {
    await client().set(key, String(value), { ex: Math.floor(ttlSeconds) });
  } else {
    await client().set(key, String(value));
  }
}

/** Hent streng-verdi (eller null). */
export async function kvGetString(key) {
  const raw = await client().get(key);
  if (raw == null) return null;
  return typeof raw === 'string' ? raw : String(raw);
}

/** Slett en nøkkel. Ignorerer om den ikke finnes. */
export async function kvDel(key) {
  try {
    await client().del(key);
  } catch (err) {
    console.warn('[kv] del failed for', key, err?.message || err);
  }
}

/**
 * Øker telleren og setter TTL hvis den akkurat ble opprettet (verdi === 1).
 * Brukes til rate limiting.
 */
export async function kvIncrWithTtl(key, ttlSeconds) {
  const c = client();
  const n = await c.incr(key);
  if (n === 1 && ttlSeconds && ttlSeconds > 0) {
    try {
      await c.expire(key, Math.floor(ttlSeconds));
    } catch (err) {
      console.warn('[kv] expire failed for', key, err?.message || err);
    }
  }
  return Number(n) || 0;
}
