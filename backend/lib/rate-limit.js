import { kvIncrWithTtl } from './kv.js';

/**
 * Enkel fixed-window rate limiter. Lagrer en teller per (prefix, id) i KV med
 * TTL som tilsvarer vinduet. Første forespørsel i vinduet får TTL satt.
 *
 * Dette er bevisst "god nok" (ikke sliding window / token bucket) – vi vil
 * bare gjøre brute force mot /auth/login upraktisk og beskytte mot accidentell
 * klientspam.
 */
export async function hitRateLimit({ prefix, id, limit, windowSeconds }) {
  if (!id) {
    // Ingen IP identifiserer forespørselen – ikke blokker (ellers kan vi bomme
    // ut legitime brukere bak proxy uten forwarded headers).
    return { allowed: true, count: 0, remaining: limit };
  }
  const key = `ratelimit:${prefix}:${id}`;
  const count = await kvIncrWithTtl(key, windowSeconds);
  const remaining = Math.max(0, limit - count);
  return {
    allowed: count <= limit,
    count,
    remaining,
    retryAfterSeconds: windowSeconds,
  };
}

export function clientIp(req) {
  const forwarded = req.get?.('x-forwarded-for') || req.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || '';
}
