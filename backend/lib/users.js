import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { kvDel, kvGetJson, kvGetString, kvSetJson, kvSetString } from './kv.js';

/**
 * Brukerlager.
 *
 * Nøkler i KV:
 *   user:<id>                       -> { id, email, passwordHash, createdAt, updatedAt, stravaAthleteId?, stravaAthleteName? }
 *   user:byEmail:<email-lower>      -> <id>
 *   user:byStrava:<athleteId>       -> <id>
 *
 * Vi lagrer aldri klartekst-passord. bcrypt med cost 12. `email` blir alltid
 * lowercased før oppslag, slik at "Helene@x" og "helene@x" regnes som samme
 * bruker.
 */

const BCRYPT_COST = 12;

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function isValidEmail(email) {
  const e = normalizeEmail(email);
  // Enkel regex – vi vil bare hindre openbart ugyldige input. Bekreftelse via
  // e-post er ikke en del av MVP-en.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

export function isAcceptablePassword(pw) {
  return typeof pw === 'string' && pw.length >= 8 && pw.length <= 200;
}

function userKey(id) {
  return `user:${id}`;
}
function userByEmailKey(emailLower) {
  return `user:byEmail:${emailLower}`;
}
function userByStravaKey(athleteId) {
  return `user:byStrava:${athleteId}`;
}

/** Strip bort sensitive felt før vi sender data til klienten. */
export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email || null,
    createdAt: u.createdAt || null,
    stravaAthleteId: u.stravaAthleteId || null,
    stravaAthleteName: u.stravaAthleteName || null,
    hasPassword: Boolean(u.passwordHash),
  };
}

export async function findUserById(id) {
  if (!id) return null;
  return (await kvGetJson(userKey(id))) || null;
}

export async function findUserByEmail(email) {
  const e = normalizeEmail(email);
  if (!e) return null;
  const id = await kvGetString(userByEmailKey(e));
  if (!id) return null;
  return findUserById(id);
}

export async function findUserByStravaAthlete(athleteId) {
  if (!athleteId) return null;
  const id = await kvGetString(userByStravaKey(String(athleteId)));
  if (!id) return null;
  return findUserById(id);
}

/** Oppretter bruker med epost + passord. Kaster hvis eposten finnes fra før. */
export async function createUserWithPassword({ email, password }) {
  if (!isValidEmail(email)) {
    const err = new Error('Ugyldig epost-adresse.');
    err.code = 'INVALID_EMAIL';
    throw err;
  }
  if (!isAcceptablePassword(password)) {
    const err = new Error('Passordet må ha minst 8 tegn.');
    err.code = 'WEAK_PASSWORD';
    throw err;
  }
  const emailLower = normalizeEmail(email);
  const existing = await kvGetString(userByEmailKey(emailLower));
  if (existing) {
    const err = new Error('En konto med denne eposten finnes allerede.');
    err.code = 'EMAIL_TAKEN';
    throw err;
  }
  const id = crypto.randomUUID();
  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  const now = Date.now();
  const user = {
    id,
    email: emailLower,
    passwordHash,
    createdAt: now,
    updatedAt: now,
  };
  await kvSetJson(userKey(id), user);
  await kvSetString(userByEmailKey(emailLower), id);
  return user;
}

/**
 * Opprett anonym enhetsbruker (ingen epost/passord). Brukes når appen kjører uten
 * eksplisitt innlogging – samme lagringsmodell som øvrige brukere.
 */
export async function createAnonymousUser() {
  const id = crypto.randomUUID();
  const now = Date.now();
  const user = {
    id,
    email: null,
    passwordHash: null,
    createdAt: now,
    updatedAt: now,
  };
  await kvSetJson(userKey(id), user);
  return user;
}

/** Opprett bruker ut fra en Strava-autentisering (athlete + tokens). */
export async function createUserFromStrava({ athleteId, athleteName }) {
  if (!athleteId) {
    const err = new Error('Mangler Strava athleteId.');
    err.code = 'INVALID_STRAVA_ATHLETE';
    throw err;
  }
  const id = crypto.randomUUID();
  const now = Date.now();
  const user = {
    id,
    email: null,
    passwordHash: null,
    createdAt: now,
    updatedAt: now,
    stravaAthleteId: String(athleteId),
    stravaAthleteName: athleteName || null,
  };
  await kvSetJson(userKey(id), user);
  await kvSetString(userByStravaKey(String(athleteId)), id);
  return user;
}

/** Verifiser et passord mot bruker. Returnerer brukeren ved suksess, ellers null. */
export async function verifyPassword(email, password) {
  if (!isValidEmail(email) || typeof password !== 'string' || !password) return null;
  const user = await findUserByEmail(email);
  if (!user || !user.passwordHash) return null;
  const ok = await bcrypt.compare(password, user.passwordHash);
  return ok ? user : null;
}

/** Koble Strava-athlete til en eksisterende bruker. Oppdaterer indeksen. */
export async function linkStravaToUser(userId, { athleteId, athleteName }) {
  if (!userId || !athleteId) return null;
  const user = await findUserById(userId);
  if (!user) return null;

  // Hvis samme athlete allerede peker på en annen konto: rydd opp i den gamle
  // indeksen slik at vi ikke får dublerte innlogginger.
  const existingOwner = await kvGetString(userByStravaKey(String(athleteId)));
  if (existingOwner && existingOwner !== userId) {
    const otherUser = await findUserById(existingOwner);
    if (otherUser) {
      otherUser.stravaAthleteId = null;
      otherUser.stravaAthleteName = null;
      otherUser.updatedAt = Date.now();
      await kvSetJson(userKey(otherUser.id), otherUser);
    }
  }

  // Hvis brukeren hadde en annen athlete før: fjern den gamle indeksen.
  if (user.stravaAthleteId && String(user.stravaAthleteId) !== String(athleteId)) {
    await kvDel(userByStravaKey(String(user.stravaAthleteId)));
  }

  user.stravaAthleteId = String(athleteId);
  if (athleteName) user.stravaAthleteName = athleteName;
  user.updatedAt = Date.now();
  await kvSetJson(userKey(userId), user);
  await kvSetString(userByStravaKey(String(athleteId)), userId);
  return user;
}

/** Fjern Strava-tilknytning (brukes ikke av auth-routes ennå, men greit å ha). */
export async function unlinkStravaFromUser(userId) {
  const user = await findUserById(userId);
  if (!user) return null;
  if (user.stravaAthleteId) {
    await kvDel(userByStravaKey(String(user.stravaAthleteId)));
  }
  user.stravaAthleteId = null;
  user.stravaAthleteName = null;
  user.updatedAt = Date.now();
  await kvSetJson(userKey(userId), user);
  return user;
}
