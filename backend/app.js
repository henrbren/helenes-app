import cors from 'cors';
import 'dotenv/config';
import express from 'express';
import OpenAI from 'openai';
import { z } from 'zod';
import { createAuthRouter } from './lib/auth-routes.js';
import { consumeOAuthState, createOAuthState } from './lib/oauth-state.js';
import {
  buildSessionCookie,
  createSession,
  requireAuth,
} from './lib/sessions.js';
import {
  createUserFromStrava,
  findUserByStravaAthlete,
  linkStravaToUser,
  publicUser,
} from './lib/users.js';
import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  formatPace,
  getActivities,
  getActivityStreams,
  getAthlete,
  getAthleteStats,
  getRecentActivitiesSummary,
  getRunningBestEfforts,
  hasActivityListScope,
  hasStravaConnection,
  readBestEffortsSnapshot,
  resetBestEffortsCache,
  saveStravaTokensForUser,
} from './strava.js';

const PORT = Number(process.env.PORT || 8787);
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
/** Gir modell nok plass til lange create_running_program-JSON (alle uker × økter). */
const _chatMaxTok = Number(process.env.CHAT_MAX_COMPLETION_TOKENS || 8192);
const CHAT_TOOL_MAX_COMPLETION_TOKENS = Number.isFinite(_chatMaxTok)
  ? Math.min(16384, Math.max(2048, _chatMaxTok))
  : 8192;

let openaiClient = null;
function getOpenAI() {
  const key = (process.env.OPENAI_API_KEY || process.env.OPENAI || '').trim();
  if (!key) {
    throw new Error(
      'Mangler OpenAI-nøkkel. Sett OPENAI_API_KEY eller OPENAI i Vercel → Environment Variables (eller backend/.env).',
    );
  }
  if (!openaiClient) openaiClient = new OpenAI({ apiKey: key });
  return openaiClient;
}

const app = express();
if (process.env.VERCEL) {
  app.set('trust proxy', 1);
  // vercel.json rewrites /chat → /api/server; innbakt path kan bli /api/server så Express matcher ikke /chat.
  app.use((req, _res, next) => {
    const internal = req.url || '';
    const original = req.originalUrl || internal;
    if (
      (internal === '/api/server' || internal.startsWith('/api/server?')) &&
      original !== internal &&
      !String(original).startsWith('/api/server')
    ) {
      req.url = original;
      // Uten dette kan req.query forbli tom etter url-justering → Strava-kobling får ikke ?token=.
      if (req._parsedUrl) delete req._parsedUrl;
    }
    next();
  });
}

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.use((req, _res, next) => {
  const ip = req.ip || req.socket?.remoteAddress || '?';
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} from ${ip}`);
  next();
});

app.get('/health', async (_req, res) => {
  const { isUsingRealKv } = await import('./lib/kv.js');
  const kvPersistent = isUsingRealKv();
  const payload = {
    ok: true,
    kvPersistent,
    vercel: Boolean(process.env.VERCEL),
  };
  if (process.env.VERCEL && !kvPersistent) {
    payload.warning =
      'Add Upstash Redis: set KV_REST_API_URL and KV_REST_API_TOKEN in Vercel project env (see /backend/lib/kv.js). Without this, auth and Strava break across instances.';
  }
  res.json(payload);
});

// ---- Strava helpers --------------------------------------------------------
/** På Vercel/serverless er req.protocol ofte "http" uten forwarded headers; Strava krever https + eksakt matchende host. */
function selfBaseUrl(req) {
  const forwardedProto = (req.get('x-forwarded-proto') || '').split(',')[0].trim();
  const forwardedHost = (req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
  const proto =
    forwardedProto || (process.env.VERCEL ? 'https' : (req.protocol === 'https' ? 'https' : 'http'));
  const host =
    forwardedHost ||
    (process.env.VERCEL && process.env.VERCEL_URL
      ? String(process.env.VERCEL_URL).replace(/^https?:\/\//i, '')
      : '');
  if (!host) {
    return `${proto}://localhost`;
  }
  return `${proto}://${host}`;
}

/**
 * Må være identisk for /authorize og /token. Strava validerer mot «Authorization Callback Domain».
 * På Vercel: hvis STRAVA_REDIRECT_URI peker til LAN/localhost (vanlig fra kopiert lokal .env), eller
 * mangler, bruk produksjonsdomenet slik at preview-deploy og feilkonfigurerte env ikke gir invalid redirect_uri.
 */
function stravaRedirectUri(req) {
  const fixedRaw = process.env.STRAVA_REDIRECT_URI?.trim() || '';
  const prodHost = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/$/, '');

  if (process.env.VERCEL && prodHost) {
    const prodCallback = `https://${prodHost}/strava/callback`;
    const looksLikeLocalDev = (u) =>
      /^https?:\/\/(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|127\.0\.0\.1|localhost)(:|\/|$)/i.test(
        u,
      );
    if (!fixedRaw || looksLikeLocalDev(fixedRaw)) {
      return prodCallback;
    }
  }

  if (fixedRaw) return fixedRaw;
  return `${selfBaseUrl(req)}/strava/callback`;
}

function isExpoGoStyleHost(host) {
  const h = String(host).toLowerCase();
  if (h === 'localhost' || h === '127.0.0.1') return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return /^(.*\.)?(exp\.direct|exp\.host|expo\.io|expo\.test|expo\.dev)$/i.test(h);
}

/** https (prod/preview), http localhost, og exp:// for Expo Go — annet avvises (unngår åpen redirect). */
function tryNormalizeStravaReturnUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.username || u.password) return null;
    const host = u.hostname.toLowerCase();
    if (!host || host.length > 253) return null;

    if (u.protocol === 'exp:' || u.protocol === 'exps:') {
      if (!isExpoGoStyleHost(host)) return null;
      let path = u.pathname || '';
      if (!path || path === '/') {
        path = '/--/';
      } else if (!path.endsWith('/')) {
        path = `${path}/`;
      }
      return `${u.protocol}//${u.host}${path}`;
    }

    const local = host === 'localhost' || host === '127.0.0.1';
    if (local && (u.protocol === 'http:' || u.protocol === 'https:')) {
      return `${u.origin}/`;
    }
    if (u.protocol === 'https:') {
      return `${u.origin}/`;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Etter Strava-callback: redirect tilbake til riktig klient.
 * - Web: vanligvis prod/preview-https (return_to utelatt → selfBaseUrl).
 * - Expo Go: klient sender ?return_to=exp://… som valideres og lagres i OAuth-state.
 */
function stravaOAuthReturnBase(req) {
  const q = req.query?.return_to;
  const raw = Array.isArray(q) ? q[0] : q;
  if (typeof raw === 'string' && raw.trim()) {
    const n = tryNormalizeStravaReturnUrl(raw.trim());
    if (n) return n;
  }
  return `${selfBaseUrl(req)}/`;
}

function appRootAfterStravaOAuth(statePayload) {
  const raw = typeof statePayload.returnBaseUrl === 'string' ? statePayload.returnBaseUrl.trim() : '';
  if (!raw) return '/';
  const n = tryNormalizeStravaReturnUrl(raw);
  if (n) return n;
  return '/';
}

// ---- Auth routes -----------------------------------------------------------
app.use(createAuthRouter({ stravaRedirectUri }));

// ---- Strava login (ingen sesjon – finn/opprette bruker via athleteId) -------
app.get('/strava/login', async (req, res) => {
  try {
    const redirectUri = stravaRedirectUri(req);
    const state = await createOAuthState({
      intent: 'login',
      redirectUri,
      returnBaseUrl: stravaOAuthReturnBase(req),
    });
    const url = buildAuthorizeUrl({ redirectUri, state });
    res.redirect(url);
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Kunne ikke bygge authorize-url.' });
  }
});

// ---- Strava connect (krever innlogget bruker) ------------------------------
app.get('/strava/connect', requireAuth, async (req, res) => {
  try {
    const redirectUri = stravaRedirectUri(req);
    const state = await createOAuthState({
      intent: 'connect',
      userId: req.user.id,
      redirectUri,
      returnBaseUrl: stravaOAuthReturnBase(req),
    });
    const url = buildAuthorizeUrl({ redirectUri, state });
    res.redirect(url);
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Kunne ikke bygge authorize-url.' });
  }
});

/**
 * Hjelper for å generere HTML-siden som vises brukeren etter callback. På web
 * sender vi dem tilbake til app-frontenden med query-parametere som App.tsx
 * leser og rensker bort. For login-flyten inkluderer vi sessionToken i URL-en
 * fordi dette er en tvers-av-origin redirect og vi ikke kan stole på at
 * httpOnly-cookien er satt for frontenden (kan f.eks. være native-app som
 * åpner via Linking).
 */
function successRedirectHtml({ webBase, queryParams, message }) {
  const qs = new URLSearchParams(queryParams).toString();
  const href = `${webBase || '/'}${qs ? `?${qs}` : ''}`;
  const safeHref = href.replace(/"/g, '&quot;');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Strava</title>
<meta http-equiv="refresh" content="1;url=${safeHref}">
<style>body{font-family:-apple-system,Segoe UI,Inter,Arial,sans-serif;max-width:560px;margin:60px auto;padding:0 20px;color:#0f172a}
h1{font-size:22px;margin-bottom:8px}p{line-height:1.5}code{background:#f1f5f9;padding:2px 6px;border-radius:6px}
a.btn{display:inline-block;margin-top:12px;padding:10px 16px;background:#7A3C4A;color:#fff;border-radius:10px;text-decoration:none}</style></head>
<body><h1>${message}</h1>
<p>Du blir sendt tilbake til appen automatisk. Hvis ingenting skjer:</p>
<p><a class="btn" href="${safeHref}">Tilbake til appen</a></p></body></html>`;
}

app.get('/strava/callback', async (req, res) => {
  const { code, error, scope, state } = req.query;
  if (error) {
    res.status(400).send(`Strava authorization failed: ${error}`);
    return;
  }
  if (!code || typeof code !== 'string') {
    res.status(400).send('Missing ?code from Strava');
    return;
  }
  if (!state || typeof state !== 'string') {
    res.status(400).send('Missing state. Start OAuth-flyten på nytt fra appen.');
    return;
  }

  const statePayload = await consumeOAuthState(state);
  if (!statePayload) {
    res.status(400).send('OAuth state er ugyldig eller utløpt. Start på nytt fra appen.');
    return;
  }

  try {
    const redirectUri = statePayload.redirectUri || stravaRedirectUri(req);
    const scopeAccepted = typeof scope === 'string' ? scope : '';
    const actOk = hasActivityListScope(scopeAccepted);
    if (actOk === false) {
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.status(400).send(`<!doctype html><html><head><meta charset="utf-8"><title>Strava – mangler tilgang</title>
<style>body{font-family:-apple-system,Segoe UI,Inter,Arial,sans-serif;max-width:560px;margin:48px auto;padding:0 20px;color:#0f172a;line-height:1.5}</style></head>
<body><h1>Mangler tilgang til aktiviteter</h1>
<p>Strava rapporterer at du <strong>ikke</strong> godkjente lesetilgang til treningsøkter (scope mangler <code>activity:read</code> eller <code>activity:read_all</code>).</p>
<p>Du godkjente: <code>${scopeAccepted || '(ingen oppgitt)'}</code></p>
<p>Gå tilbake til appen og koble til på nytt. På Strava-siden: la <strong>alle</strong> forespurte tilganger være på (ikke fjern kryss for aktiviteter).</p>
<p><a href="https://www.strava.com/settings/apps">Åpne Strava → Mine apper</a> og fjern appen hvis den henger, deretter prøv på nytt.</p></body></html>`);
      return;
    }

    const { tokens, athlete } = await exchangeCodeForTokens(code, redirectUri, scopeAccepted);
    const athleteId = athlete?.id ? String(athlete.id) : null;
    const athleteName = [athlete?.firstname, athlete?.lastname].filter(Boolean).join(' ').trim() || null;

    res.set('Content-Type', 'text/html; charset=utf-8');
    const webBaseForApp = appRootAfterStravaOAuth(statePayload);

    if (statePayload.intent === 'login') {
      // Finn eksisterende konto eller opprett ny basert på Strava athleteId.
      if (!athleteId) {
        res.status(500).send('Strava returnerte ingen athlete-id. Prøv igjen.');
        return;
      }
      let user = await findUserByStravaAthlete(athleteId);
      if (!user) {
        user = await createUserFromStrava({ athleteId, athleteName });
      } else if (athleteName && user.stravaAthleteName !== athleteName) {
        user = await linkStravaToUser(user.id, { athleteId, athleteName });
      }
      await saveStravaTokensForUser(user.id, tokens);
      const { token: sessionToken } = await createSession(user.id);
      res.setHeader('Set-Cookie', buildSessionCookie(sessionToken));
      res.send(
        successRedirectHtml({
          webBase: webBaseForApp,
          queryParams: { auth: 'ok', token: sessionToken, strava: 'connected' },
          message: `Velkommen${athlete?.firstname ? ', ' + athlete.firstname : ''}!`,
        }),
      );
      return;
    }

    if (statePayload.intent === 'connect') {
      if (!statePayload.userId) {
        res.status(400).send('Ugyldig state: mangler bruker.');
        return;
      }
      await saveStravaTokensForUser(statePayload.userId, tokens);
      if (athleteId) {
        await linkStravaToUser(statePayload.userId, { athleteId, athleteName });
      }
      // Ny sesjon + token i URL slik at web-klienten (etter full redirect) er synket med
      // server-KV – samme mønster som Strava-login. Uten dette kan gammelt Bearer-token
      // i AsyncStorage peke på en utløpt/ukjent sesjon etter OAuth.
      const { token: sessionToken } = await createSession(statePayload.userId);
      res.setHeader('Set-Cookie', buildSessionCookie(sessionToken));
      res.send(
        successRedirectHtml({
          webBase: webBaseForApp,
          queryParams: { auth: 'ok', token: sessionToken, strava: 'connected' },
          message: 'Strava er koblet til kontoen din',
        }),
      );
      return;
    }

    res.status(400).send('Ukjent OAuth-intent.');
  } catch (err) {
    res.status(500).send(`Token exchange failed: ${err?.message || err}`);
  }
});

// ---- Strava data routes (per-user, Bearer required) ------------------------
app.get('/strava/status', requireAuth, async (req, res) => {
  try {
    const connected = await hasStravaConnection(req.user.id);
    res.json({ connected, user: req.publicUser });
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Strava status error' });
  }
});

app.get('/strava/athlete', requireAuth, async (req, res) => {
  try {
    const athlete = await getAthlete(req.user.id);
    res.json(athlete);
  } catch (err) {
    res.status(err?.status || 500).json({ error: err?.message || 'Strava error', code: err?.code });
  }
});

app.get('/strava/activities', requireAuth, async (req, res) => {
  try {
    const perPage = Math.min(Number(req.query.per_page) || 10, 100);
    const page = Number(req.query.page) || 1;
    const after = req.query.after ? Number(req.query.after) : undefined;
    const before = req.query.before ? Number(req.query.before) : undefined;
    const activities = await getActivities(req.user.id, { perPage, page, after, before });
    res.json(activities);
  } catch (err) {
    res.status(err?.status || 500).json({ error: err?.message || 'Strava error', code: err?.code });
  }
});

app.get('/strava/recent', requireAuth, async (req, res) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 14, 1), 90);
    const perPage = Math.min(Number(req.query.per_page) || 30, 100);
    const summary = await getRecentActivitiesSummary(req.user.id, { days, perPage });
    res.json(summary);
  } catch (err) {
    res.status(err?.status || 500).json({ error: err?.message || 'Strava error', code: err?.code });
  }
});

app.get('/strava/activity/:id/streams', requireAuth, async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) {
      res.status(400).json({ error: 'Missing activity id' });
      return;
    }
    const keysParam = typeof req.query.keys === 'string' ? req.query.keys : '';
    const keys = keysParam
      ? keysParam.split(',').map((s) => s.trim()).filter(Boolean)
      : ['heartrate', 'velocity_smooth', 'time', 'distance', 'altitude', 'cadence'];
    const streams = await getActivityStreams(req.user.id, id, keys);
    res.json(streams);
  } catch (err) {
    res.status(err?.status || 500).json({ error: err?.message || 'Strava error', code: err?.code });
  }
});

app.get('/strava/stats', requireAuth, async (req, res) => {
  try {
    const athlete = await getAthlete(req.user.id);
    const stats = await getAthleteStats(req.user.id, athlete.id);
    res.json({ athleteId: athlete.id, stats });
  } catch (err) {
    res.status(err?.status || 500).json({ error: err?.message || 'Strava error', code: err?.code });
  }
});

// Best efforts: KV-basert per-user cache + in-flight-lock per userId.
const bestEffortsInFlight = new Map();
const bestEffortsLastError = new Map();

function startBestEffortsScan(userId, { batch, reset }) {
  if (bestEffortsInFlight.has(userId)) return bestEffortsInFlight.get(userId);
  const p = (async () => {
    try {
      bestEffortsLastError.delete(userId);
      const data = await getRunningBestEfforts(userId, { batch, reset });
      return { ...data, fetchedAt: Date.now() };
    } catch (err) {
      bestEffortsLastError.set(userId, err?.message || String(err));
      throw err;
    } finally {
      bestEffortsInFlight.delete(userId);
    }
  })();
  p.catch((err) => {
    console.warn('[strava] best-efforts scan failed:', err?.message || err);
  });
  bestEffortsInFlight.set(userId, p);
  return p;
}

app.get('/strava/best-efforts', requireAuth, async (req, res) => {
  try {
    const batch = Math.min(
      Math.max(Number(req.query.batch ?? req.query.limit) || 25, 1),
      200,
    );
    const force = req.query.force === '1' || req.query.force === 'true';
    const reset = req.query.reset === '1' || req.query.reset === 'true';

    if ((force || reset) && !bestEffortsInFlight.has(req.user.id)) {
      startBestEffortsScan(req.user.id, { batch, reset });
    }

    const snapshot = await readBestEffortsSnapshot(req.user.id);
    res.json({
      ...snapshot,
      scanning: bestEffortsInFlight.has(req.user.id),
      lastError: bestEffortsLastError.get(req.user.id) || null,
      fetchedAt: Date.now(),
    });
  } catch (err) {
    res.status(err?.status || 500).json({ error: err?.message || 'Strava error', code: err?.code });
  }
});

app.post('/strava/best-efforts/reset', requireAuth, async (req, res) => {
  try {
    if (bestEffortsInFlight.has(req.user.id)) {
      res.status(409).json({ error: 'Scan pågår – vent til den er ferdig før du nullstiller.' });
      return;
    }
    await resetBestEffortsCache(req.user.id);
    bestEffortsLastError.delete(req.user.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Reset failed' });
  }
});

// ---- Tooling (extensible registry) -----------------------------------------
function getTools() {
  return [
    {
      type: 'function',
      function: {
        name: 'get_training_summary',
        description: 'Summarize recent training sessions (stub for future Strava/Garmin).',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            days: { type: 'number', description: 'How many days back to look.', default: 7 },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'create_workout_plan',
        description: 'Create a short workout plan based on goal (local stub).',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            goal: { type: 'string', description: 'User goal, e.g. 10K PB, marathon, consistency.' },
            days: { type: 'number', description: 'Number of days in plan.', default: 7 },
          },
          required: ['goal'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'create_running_program',
        description:
          'Lag et strukturert løpeprogram med én rad per planlagt økt. Kun løpeøkter i sessions — hver rad er én løpeøkt med workout_type som tittel. Ikke legg styrke, core, gym eller «etter løpetur: styrke» inn i noen økts description; det tilhører ikke løpesjekklisten. Eventuell styrkeanbefaling kan du skrive i det vanlige chat-svaret, ikke i verktøydata. Fyll sessions sortert etter uke (uke 1 først). Detaljer (varighet, distanse, intensitet, puls, struktur) kun i description. Når brukeren nettopp har oppgitt konkurranse/dato i chat, skal main_race_date følge det — ikke en eldre dato fra lagrede programmer i systemkontekst. Viktig: når main_race_date er satt, skal weeks aldri være større enn antall uker fra i dag til konkurransen (ca. ceil(dager/7) fra nåværende dato i Norge); programmet skal ikke fortsette etter konkurranseuken.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string', description: 'Kort navn, f.eks. "12 uker mot 10 km sub-50".' },
            goal_summary: { type: 'string', description: 'Brukerens mål i én–to setninger.' },
            weeks: {
              type: 'number',
              description:
                'Antall uker programmet varer (1–52). Hvis main_race_date er satt: maks antall uker til og med uken med konkurransen (teller fra i dag, Norge-tid); ikke lengre.',
            },
            main_race_name: {
              type: 'string',
              description:
                'Valgfritt: navn på hovedkonkurransen programmet bygger mot (f.eks. Oslo maraton). Bruk når brukeren har sagt hvilket løp det gjelder.',
            },
            main_race_date: {
              type: 'string',
              description:
                'Valgfritt: konkurransedato YYYY-MM-DD. Når satt, må weeks og alle session.week være innenfor tidsrommet frem til denne datoen. Sett session_date på hver økt (kalender); konkurranseøkta skal ha session_date lik denne datoen.',
            },
            sessions: {
              type: 'array',
              description:
                'Kun løpeøkter (typisk 3–6 per uke). Du MÅ fylle inn alle uker 1..weeks: minst én økt per uke (hele blokken, ikke bare første par uker). Hver økt har workout_type som tittel. Når main_race_date er satt: fyll session_date (YYYY-MM-DD) for hver økt slik at datoene følger ekte kalender og day_label; siste konkurranseøkt (workout_type «Konkurranse») skal ha session_date lik main_race_date. Ingen styrke-/core-/gym-notater i description — bare innhold for selve løpeøkta.',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  week: { type: 'number', description: 'Ukenummer fra 1 til weeks.' },
                  day_label: {
                    type: 'string',
                    description: 'Ukedag eller merking, f.eks. "Mandag" eller "Uke 3 · onsdag".',
                  },
                  session_date: {
                    type: 'string',
                    description:
                      'Valgfritt men anbefalt når main_race_date finnes: planlagt dato YYYY-MM-DD for denne økta, i tråd med norsk kalender og ukedag i day_label. Konkurranseøkta skal ha samme dato som main_race_date.',
                  },
                  workout_type: {
                    type: 'string',
                    enum: ['Rolig løpetur', 'Terkeløkt', 'Intervaller', 'Konkurranse'],
                    description:
                      'Økttype — bruk nøyaktig én av enum-verdiene (samme som manuell løpelogging). Det står «Terkeløkt» med e, ikke «Terskeløkt». Dette blir tittel på økten; detaljer kun i description.',
                  },
                  description: {
                    type: 'string',
                    description:
                      'Kun løping: varighet, distanse, tempo/soner, puls, intervallstruktur, terreng, pauser. Ikke styrke, knebøy, core, utfall, vekter, styrkerom eller «supplér med styrke» — økta er allerede klassifisert som løpetype i workout_type.',
                  },
                },
                required: ['week', 'day_label', 'workout_type', 'description'],
              },
            },
          },
          required: ['title', 'goal_summary', 'weeks', 'sessions'],
        },
      },
    },
  ];
}

/** Må være identisk med enum i OpenAI-tool og App.tsx (unngå valideringsfeil når modellen varierer litt). */
const RUN_WORKOUT_TYPES = ['Rolig løpetur', 'Terkeløkt', 'Intervaller', 'Konkurranse'];

function normalizeRunWorkoutTypeString(raw) {
  if (raw == null) return '';
  const first = Array.isArray(raw) ? raw[0] : raw;
  let s = String(first);
  s = s.replace(/[\u200B-\u200D\uFEFF]/g, '');
  s = s.replace(/\u00a0/g, ' ');
  s = s.trim().replace(/\s+/g, ' ');
  s = s.replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"');
  return s;
}

/**
 * Mapper nesten-riktige strenger fra LLM til eksakt enum.
 * Mange modeller skriver «Terskeløkt»; i appen er det «Terkeløkt» (bevisst stavemåte i tool).
 */
function coerceRunWorkoutType(raw) {
  const s = normalizeRunWorkoutTypeString(raw);
  if (!s) return null;
  const lower = s.toLowerCase();
  for (const canon of RUN_WORKOUT_TYPES) {
    if (canon.toLowerCase() === lower) return canon;
  }
  if (/terskel|terkel|threshold|tempoøkt|tempo(?!\s*intervall)/i.test(s)) return 'Terkeløkt';
  if (/intervall|fartlek|sprint|drag/i.test(lower)) return 'Intervaller';
  if (/konkurranse|ritt\b|testøkt|^race$/i.test(lower)) return 'Konkurranse';
  if (/rolig|lett\s*løp|easy|langtur|nedjogg|recovery|hvile.*løp|jogg/i.test(lower)) return 'Rolig løpetur';
  return null;
}

function normalizeCreateRunningProgramArgs(args) {
  if (!args || typeof args !== 'object') return args;
  const out = { ...args };
  if (out.main_race_name != null && String(out.main_race_name).trim() === '') delete out.main_race_name;
  if (out.main_race_date != null && String(out.main_race_date).trim() === '') delete out.main_race_date;
  if (Array.isArray(out.sessions)) {
    out.sessions = out.sessions.map((sess) => {
      if (!sess || typeof sess !== 'object') return sess;
      const fixed = coerceRunWorkoutType(sess.workout_type) || 'Rolig løpetur';
      const next = { ...sess, workout_type: fixed };
      if (next.session_date != null && String(next.session_date).trim() === '') delete next.session_date;
      return next;
    });
  }
  return out;
}

const OSLO_TZ = 'Europe/Oslo';

function todayYmdOslo() {
  return new Date().toLocaleDateString('en-CA', { timeZone: OSLO_TZ });
}

/** Kalenderdager mellom to YYYY-MM-DD (to - fra). */
function calendarDaysBetweenYmd(fromYmd, toYmd) {
  const [fy, fm, fd] = fromYmd.split('-').map(Number);
  const [ty, tm, td] = toYmd.split('-').map(Number);
  const from = Date.UTC(fy, fm - 1, fd);
  const to = Date.UTC(ty, tm - 1, td);
  return Math.round((to - from) / 86400000);
}

/**
 * Maks antall uker programmet kan ha når det skal nå main_race_date (ikke lenger).
 * Basert på dagens dato i Oslo og ceil(dager/7). Konkurranse i fortiden: ingen begrensning (null).
 */
function maxProgramWeeksThroughRaceDate(raceYmd) {
  const today = todayYmdOslo();
  const daysUntil = calendarDaysBetweenYmd(today, raceYmd);
  if (daysUntil < 0) return null;
  return Math.max(1, Math.ceil(daysUntil / 7));
}

/**
 * Klipp weeks + økter slik at ingenting strekker seg utover uken som inneholder konkurransedato.
 */
function capRunningProgramToRaceDate(weeks, sessions, raceYmd) {
  const cap = maxProgramWeeksThroughRaceDate(raceYmd);
  if (cap == null || weeks <= cap) {
    return { weeks, sessions, wasCapped: false };
  }
  const nextSessions = sessions.filter((s) => s.week <= cap);
  return { weeks: cap, sessions: nextSessions, wasCapped: true };
}

/** Minst én økt per uke 1..weeks (full sjekkliste, ikke bare et utdrag). */
function findMissingProgramWeeks(weeks, sessions) {
  if (weeks < 1) return [];
  const present = new Set(sessions.map((s) => s.week));
  const missing = [];
  for (let w = 1; w <= weeks; w++) {
    if (!present.has(w)) missing.push(w);
  }
  return missing;
}

function normalizeOptionalYmd(raw) {
  if (raw == null) return undefined;
  const s = String(raw).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return undefined;
  return s;
}

/** Konkurranse uten dato får main_race_date; ingen økt etter konkurransedato. */
function enrichRunningProgramSessionDates(sessions, mainRaceDate) {
  const race = normalizeOptionalYmd(mainRaceDate);
  return sessions.map((s) => {
    let d = normalizeOptionalYmd(s.session_date);
    if (s.workout_type === 'Konkurranse' && race && !d) d = race;
    if (d && race && d > race) d = race;
    const out = { ...s };
    if (d) out.session_date = d;
    else delete out.session_date;
    return out;
  });
}

/** Fjerner hele linjer som tydelig bare er styrke/core/gym — løpe-sjekklisten skal ikke blande inn det. */
function stripStrengthLinesFromRunDescription(description) {
  if (!description || typeof description !== 'string') return description;
  const strengthLead =
    /^(?:\+|•|-|\*)?\s*(?:evt\.?\s*)?(?:kort\s+)?(?:styrke|styrketrening|styrkeøkt|core|magetrening|gym|knebøy|markløft|utfall|vekttrening|styrkerom|pull[\s-]?ups?|push[\s-]?ups?|roing\s+maskin)\b/i;
  const lines = description.split(/\r?\n/);
  const kept = lines.filter((line) => {
    const t = line.trim();
    if (!t) return true;
    if (strengthLead.test(t)) return false;
    if (/^\s*(?:\+|eller|og\/eller)\s+styrke\b/i.test(t)) return false;
    if (/etter\s+(?:løp|løpetur|økt|økta)\b[^.]{0,60}\bstyrke/i.test(t)) return false;
    if (/supplér\s+(?:med\s+)?styrke/i.test(t)) return false;
    return true;
  });
  let out = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!out) return description.trim();
  return out;
}

async function runToolCall(name, args, ctx) {
  if (name === 'get_training_summary') {
    const schema = z.object({ days: z.number().int().min(1).max(90).default(7) });
    const { days } = schema.parse(args ?? {});

    try {
      const summary = await getRecentActivitiesSummary(ctx.userId, { days, perPage: 50 });
      const t = summary.totals;

      const bullets = [
        `Antall økter: ${t.count}`,
        `Total distanse: ${t.distanceKm} km`,
        `Total tid: ${Math.floor(t.movingMinutes / 60)} t ${t.movingMinutes % 60} min`,
        `Stigning: ${t.elevationMeters} m`,
      ];

      const recent = summary.activities.slice(0, 5).map((a) => {
        const date = a.startDate ? a.startDate.slice(0, 10) : '–';
        const pace = formatPace(a.averagePaceSecPerKm);
        const hr = a.averageHeartrate ? ` · snittpuls ${Math.round(a.averageHeartrate)}` : '';
        return `${date} · ${a.type} · ${a.distanceKm} km · ${a.movingMinutes} min · ${pace}${hr}`;
      });

      return {
        kind: 'tool_card',
        title: `Strava: siste ${days} dager`,
        bullets: [...bullets, ...(recent.length ? ['', 'Siste økter:'] : []), ...recent],
      };
    } catch (err) {
      const isNotConnected = err?.code === 'STRAVA_NOT_CONNECTED';
      return {
        kind: 'tool_card',
        title: `Treningsoppsummering (siste ${days} dager)`,
        bullets: isNotConnected
          ? [
              'Du har ikke koblet til Strava enda.',
              'Gå til Innstillinger → Strava og trykk «Koble til Strava».',
            ]
          : ['Klarte ikke å hente data fra Strava.', String(err?.message || err)],
      };
    }
  }

  if (name === 'create_workout_plan') {
    const schema = z.object({
      goal: z.string().min(2).max(200),
      days: z.number().int().min(3).max(21).default(7),
    });
    const { goal, days } = schema.parse(args ?? {});
    return {
      kind: 'tool_card',
      title: `Forslag: ${days}-dagers plan`,
      bullets: [
        `Mål: ${goal}`,
        'Dag 1: Rolig 30–45 min',
        'Dag 2: Lett styrke + mobilitet',
        'Dag 3: Intervall (kort) + nedjogg',
        'Dag 4: Hvile / gåtur',
        'Dag 5: Terskel (kontrollert) 20–30 min',
        'Dag 6: Rolig 40–60 min',
        'Dag 7: Langtur rolig',
      ].slice(0, Math.max(2, Math.min(8, days + 1))),
    };
  }

  if (name === 'create_running_program') {
    const runWorkoutTypeEnum = z.enum(RUN_WORKOUT_TYPES);
    const schema = z.object({
      title: z.string().min(2).max(120),
      goal_summary: z.string().min(2).max(500),
      weeks: z.number().int().min(1).max(52),
      main_race_name: z.string().min(1).max(120).optional(),
      main_race_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      sessions: z
        .array(
          z.object({
            week: z.number().int().min(1).max(52),
            day_label: z.string().min(1).max(80),
            session_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
            workout_type: runWorkoutTypeEnum,
            description: z.string().min(1).max(800),
          }),
        )
        .min(1)
        .max(250),
    });
    const parsed = schema.parse(normalizeCreateRunningProgramArgs(args ?? {}));

    let programWeeks = parsed.weeks;
    let programSessions = parsed.sessions;
    if (parsed.main_race_date) {
      const { weeks: w, sessions: sess, wasCapped } = capRunningProgramToRaceDate(
        programWeeks,
        programSessions,
        parsed.main_race_date,
      );
      programWeeks = w;
      programSessions = sess;
      if (wasCapped) {
        console.log(
          `[create_running_program] capped weeks to ${programWeeks} (race ${parsed.main_race_date}, today Oslo ${todayYmdOslo()})`,
        );
      }
    }

    programSessions = enrichRunningProgramSessionDates(programSessions, parsed.main_race_date);

    if (programSessions.length === 0) {
      return {
        kind: 'tool_card',
        title: 'Kunne ikke lage program',
        bullets: [
          'Etter at programmet ble begrenset til ikke å gå utover konkurransedato, ble det ingen økter igjen.',
          'Lag færre uker eller sørg for at øktene ligger i ukene før konkurransen.',
        ],
      };
    }

    for (const s of programSessions) {
      if (s.week > programWeeks) {
        return {
          kind: 'tool_card',
          title: 'Kunne ikke lage program',
          bullets: [`Ukenummer ${s.week} er høyere enn antall uker (${programWeeks}).`],
        };
      }
    }

    const missingWeeks = findMissingProgramWeeks(programWeeks, programSessions);
    if (missingWeeks.length > 0) {
      const preview =
        missingWeeks.length <= 12
          ? missingWeeks.join(', ')
          : `${missingWeeks.slice(0, 12).join(', ')} … (+${missingWeeks.length - 12} til)`;
      return {
        kind: 'tool_card',
        title: 'Ufullstendig løpeprogram',
        bullets: [
          `Du satte weeks til ${programWeeks}, men det mangler planlagte økter for hele perioden.`,
          `Mangler minst én økt i uke: ${preview}.`,
          'Kall create_running_program på nytt med komplett sessions: for hver uke fra 1 til weeks (vanligvis 3–6 løpeøkter per uke). Ikke send bare et kort utdrag — verktøyargumentene må romme hele programmet.',
        ],
      };
    }

    return {
      kind: 'running_program',
      title: parsed.title,
      goalSummary: parsed.goal_summary,
      weeks: programWeeks,
      ...(parsed.main_race_name?.trim()
        ? { competitionName: parsed.main_race_name.trim() }
        : {}),
      ...(parsed.main_race_date ? { competitionDate: parsed.main_race_date } : {}),
      sessions: programSessions.map((s) => {
        const wt = s.workout_type;
        const description = stripStrengthLinesFromRunDescription(s.description);
        const row = {
          week: s.week,
          dayLabel: s.day_label,
          title: wt,
          description,
          workoutType: wt,
        };
        if (s.session_date) row.date = s.session_date;
        return row;
      }),
    };
  }

  return { kind: 'tool_card', title: `Ukjent tool: ${name}`, bullets: ['Denne toolen finnes ikke på serveren.'] };
}

async function safeRunToolCall(name, args, ctx) {
  try {
    return await runToolCall(name, args, ctx);
  } catch (err) {
    return {
      kind: 'tool_card',
      title: 'Kunne ikke bruke verktøyet',
      bullets: [
        'Modellen ga ugyldig data (eller validering feilet). Prøv å sende meldingen på nytt, eller omformulere kortere.',
        String(err?.message || err),
      ],
    };
  }
}

// ---- Chat API --------------------------------------------------------------
const ChatRequestSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['system', 'user', 'assistant']),
        content: z.string(),
      }),
    )
    .min(1),
});

app.post('/chat/stream', requireAuth, async (req, res) => {
  const parse = ChatRequestSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'Invalid payload' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  const tools = getTools();

  function send(event, data) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  try {
    send('meta', { model: OPENAI_MODEL });

    const stream = await getOpenAI().chat.completions.create({
      model: OPENAI_MODEL,
      messages: parse.data.messages,
      tools,
      max_completion_tokens: CHAT_TOOL_MAX_COMPLETION_TOKENS,
      stream: true,
    });

    let toolCallName = null;
    let toolCallId = null;
    let toolCallArgs = '';

    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      const delta = choice?.delta;

      if (delta?.content) {
        send('token', { t: delta.content });
      }

      const toolCalls = delta?.tool_calls;
      if (toolCalls && toolCalls.length > 0) {
        const tc = toolCalls[0];
        if (tc?.id) toolCallId = tc.id;
        if (tc?.function?.name) toolCallName = tc.function.name;
        if (tc?.function?.arguments) toolCallArgs += tc.function.arguments;
      }

      if (choice?.finish_reason === 'tool_calls' && toolCallName) {
        let parsedArgs = {};
        try {
          parsedArgs = toolCallArgs ? JSON.parse(toolCallArgs) : {};
        } catch {
          parsedArgs = {};
        }
        send('tool_call', { name: toolCallName, args: parsedArgs });

        const toolResult = await safeRunToolCall(toolCallName, parsedArgs, { userId: req.user.id });
        send('tool_result', toolResult);

        const followUp = await getOpenAI().chat.completions.create({
          model: OPENAI_MODEL,
          messages: [
            ...parse.data.messages,
            {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: toolCallId,
                  type: 'function',
                  function: {
                    name: toolCallName,
                    arguments: toolCallArgs || '{}',
                  },
                },
              ],
            },
            {
              role: 'tool',
              tool_call_id: toolCallId,
              content: JSON.stringify(toolResult),
            },
          ],
          stream: false,
        });

        let outText = followUp.choices?.[0]?.message?.content || '';
        if (!outText.trim() && toolResult?.kind === 'running_program') {
          outText =
            'Her er løpeprogrammet ditt. Trykk «Lagre som løpeprogram» under forslaget for å bruke det under fanen Løpeprogram.';
        }
        if (!outText.trim() && toolResult?.kind === 'tool_card') {
          outText = 'Her er et kort svar fra verktøyet (se boksen under).';
        }
        if (outText.trim()) send('final', { text: outText });
        send('done', { ok: true });
        res.end();
        return;
      }
    }

    send('done', { ok: true });
    res.end();
  } catch (err) {
    send('error', { message: err?.message || 'Server error' });
    res.end();
  }
});

app.post('/chat', requireAuth, async (req, res) => {
  const parse = ChatRequestSchema.safeParse(req.body);
  if (!parse.success) {
    console.error('[/chat] invalid payload', parse.error?.issues);
    res.status(400).json({ error: 'Invalid payload', details: parse.error?.issues });
    return;
  }

  try {
    const tools = getTools();

    console.log(`[/chat] user=${req.user.id} calling OpenAI (${parse.data.messages.length} messages)`);
    const first = await getOpenAI().chat.completions.create({
      model: OPENAI_MODEL,
      messages: parse.data.messages,
      tools,
      max_completion_tokens: CHAT_TOOL_MAX_COMPLETION_TOKENS,
    });
    console.log(`[/chat] OpenAI returned (finish_reason=${first.choices?.[0]?.finish_reason})`);

    const msg = first.choices?.[0]?.message;
    if (!msg) {
      res.status(500).json({ error: 'No model output' });
      return;
    }

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      const tc = msg.tool_calls[0];
      const name = tc?.function?.name;
      const toolCallId = tc?.id;
      const rawArgs = tc?.function?.arguments || '{}';
      let args = {};
      try {
        args = JSON.parse(rawArgs);
      } catch {
        args = {};
      }

      console.log(`[/chat] tool_call name=${name} args=${rawArgs.slice(0, 200)}`);
      const toolResult = await safeRunToolCall(name, args, { userId: req.user.id });
      console.log(`[/chat] tool_call result kind=${toolResult?.kind || 'unknown'}`);

      console.log('[/chat] calling OpenAI follow-up');
      const followUp = await getOpenAI().chat.completions.create({
        model: OPENAI_MODEL,
        messages: [
          ...parse.data.messages,
          {
            role: 'assistant',
            content: msg.content ?? null,
            tool_calls: msg.tool_calls,
          },
          {
            role: 'tool',
            tool_call_id: toolCallId,
            content: JSON.stringify(toolResult),
          },
        ],
      });

      console.log(`[/chat] follow-up completed (text length=${(followUp.choices?.[0]?.message?.content || '').length})`);
      let outText = followUp.choices?.[0]?.message?.content || '';
      if (!outText.trim() && toolResult?.kind === 'running_program') {
        outText =
          'Her er løpeprogrammet ditt. Trykk «Lagre som løpeprogram» under forslaget for å bruke det under fanen Løpeprogram.';
      }
      if (!outText.trim() && toolResult?.kind === 'tool_card') {
        outText = 'Her er et kort svar fra verktøyet (se boksen under).';
      }
      res.json({
        text: outText,
        toolCall: { name, args },
        toolResult,
      });
      return;
    }

    res.json({ text: msg.content || '' });
  } catch (err) {
    console.error('[/chat] error:', err?.message || err, err?.stack);
    res.status(500).json({ error: err?.message || 'Server error' });
  }
});

// ---- Coach feedback on a completed workout --------------------------------
const SessionFeedbackSchema = z.object({
  session: z.string().min(1).max(2000),
  history: z.string().max(8000).optional().default(''),
  source: z.enum(['manual', 'strava']).optional().default('manual'),
});

app.post('/chat/session-feedback', requireAuth, async (req, res) => {
  const parse = SessionFeedbackSchema.safeParse(req.body);
  if (!parse.success) {
    console.error('[/chat/session-feedback] invalid payload', parse.error?.issues);
    res.status(400).json({ error: 'Invalid payload', details: parse.error?.issues });
    return;
  }

  const { session, history, source } = parse.data;

  const systemPrompt = [
    'Du er Helenes personlige løpe- og styrketrener i appen hennes.',
    'Hun har akkurat fullført en økt (logget ' + (source === 'strava' ? 'automatisk fra Strava' : 'manuelt') + ').',
    'Skriv en kort, varm og personlig melding på norsk (3–6 setninger) som om du var treneren hennes som sender en chatmelding rett etter økten.',
    'Meldingen skal:',
    '• Anerkjenne den konkrete økten kort (nevn type og 1–2 nøkkeltall som distanse, tid, tempo eller puls — ikke gjenta alt).',
    '• Gi en tydelig faglig mening om prestasjonen sett opp mot tidligere historikk: sammenlign med nylige økter, kommenter trender (f.eks. raskere/saktere tempo, høyere/lavere puls, økt volum, hvileintervall), restitusjon og intensitetsfordeling.',
    '• Avslutte med en kort, motiverende observasjon eller et lite, konkret tips fremover.',
    'Skriv naturlig og direkte til Helene (du-form). Ikke bruk overskrifter, punktlister, emojis eller markdown. Unngå generiske fraser som «bra jobba!» uten kontekst — vær spesifikk.',
    'Hvis historikken er tom eller tynn, si det rolig og hold deg til økten i seg selv.',
  ].join('\n');

  const userPrompt = `Akkurat fullført økt:\n${session}\n\n${
    history && history.trim()
      ? `Nylig treningshistorikk (siste økter, nyeste først):\n${history}`
      : '(Ingen tidligere historikk tilgjengelig.)'
  }`;

  try {
    console.log(`[/chat/session-feedback] calling OpenAI (source=${source}, history chars=${history?.length || 0})`);
    const completion = await getOpenAI().chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });
    const text = (completion.choices?.[0]?.message?.content || '').trim();
    if (!text) {
      res.status(500).json({ error: 'Tomt svar fra modellen' });
      return;
    }
    res.json({ text });
  } catch (err) {
    console.error('[/chat/session-feedback] error:', err?.message || err);
    res.status(500).json({ error: err?.message || 'Server error' });
  }
});

// ---- Oppfølging dagen etter konkurranse (lagret i løpeprogram) --------------
const CompetitionFollowupSchema = z.object({
  competitionName: z.string().min(1).max(120),
  competitionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  programTitle: z.string().min(1).max(200),
});

app.post('/chat/competition-followup', requireAuth, async (req, res) => {
  const parse = CompetitionFollowupSchema.safeParse(req.body);
  if (!parse.success) {
    console.error('[/chat/competition-followup] invalid payload', parse.error?.issues);
    res.status(400).json({ error: 'Invalid payload', details: parse.error?.issues });
    return;
  }

  const { competitionName, competitionDate, programTitle } = parse.data;

  const systemPrompt = [
    'Du er Helenes personlige løpe- og styrketrener i appen hennes.',
    'I går (eller det brukeren opplever som konkurransedagen som nettopp var) hadde hun en planlagt konkurranse som er registrert i løpeprogrammet sitt.',
    'Skriv en kort, varm melding på norsk (3–6 setninger) som i en chat: spør hvordan det gikk, vis at du bryr deg, og åpne for at hun kan dele tid, følelse eller det som var viktigst.',
    'Ikke moraliser. Ikke anta resultat (verken PB eller skuffelse). Ikke bruk overskrifter, punktlister, emojis eller markdown.',
    'Du-form til Helene. Vær konkret om hvilken konkurranse det gjelder (navn) og at dette er oppfølging dagen etter.',
  ].join('\n');

  const userPrompt = `Program i appen: «${programTitle}»\nKonkurranse: ${competitionName}\nDato (registrert): ${competitionDate}`;

  try {
    console.log(
      `[/chat/competition-followup] user=${req.user.id} race=${competitionName} date=${competitionDate}`,
    );
    const completion = await getOpenAI().chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });
    const text = (completion.choices?.[0]?.message?.content || '').trim();
    if (!text) {
      res.status(500).json({ error: 'Tomt svar fra modellen' });
      return;
    }
    res.json({ text });
  } catch (err) {
    console.error('[/chat/competition-followup] error:', err?.message || err);
    res.status(500).json({ error: err?.message || 'Server error' });
  }
});

app.use((req, res) => {
  res.status(404).type('application/json').json({ error: 'Not found', path: req.path || req.url });
});

export default app;
