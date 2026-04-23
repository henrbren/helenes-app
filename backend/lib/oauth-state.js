import crypto from 'node:crypto';
import { kvDel, kvGetJson, kvSetJson } from './kv.js';

/**
 * One-time state tokens for OAuth-flyten mot Strava. Binder en forespørsel
 * (enten "connect Strava til eksisterende bruker" eller "logg inn med Strava")
 * til en tilfeldig nonce, slik at /strava/callback vet hvem/hva forespørselen
 * gjelder. Lagres i KV med TTL 10 min, og slettes ved bruk.
 */

const STATE_TTL_SECONDS = 60 * 10; // 10 min

function stateKey(state) {
  return `oauthState:${state}`;
}

export async function createOAuthState(payload) {
  const state = crypto.randomBytes(24).toString('base64url');
  await kvSetJson(
    stateKey(state),
    { ...payload, createdAt: Date.now() },
    STATE_TTL_SECONDS,
  );
  return state;
}

export async function consumeOAuthState(state) {
  if (!state || typeof state !== 'string') return null;
  const data = await kvGetJson(stateKey(state));
  if (!data) return null;
  // Engangsbruk: slett uansett, selv om den feiler videre nede i flyten –
  // det er tryggere å be brukeren gjøre prosessen om igjen enn å risikere
  // at noen fanger opp en brukt state og prøver om igjen.
  await kvDel(stateKey(state));
  return data;
}
