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

/**
 * Etter Strava-callback må SPA åpnes på samme origin som startet OAuth. Callback
 * kjører ofte på produksjonsdomenet mens brukeren kom fra en preview-URL — uten
 * dette lander de på prod med riktig token, men går tilbake til preview og får
 * en annen anonym bruker uten Strava-tokens (STRAVA_NOT_CONNECTED).
 *
 * Verdien kommer kun fra vår egen createOAuthState (Redis) — vi validerer som URL.
 */
function appRootAfterStravaOAuth(statePayload) {
  const raw = typeof statePayload.returnBaseUrl === 'string' ? statePayload.returnBaseUrl.trim() : '';
  if (!raw) return '/';
  try {
    const u = new URL(raw);
    if (u.username || u.password) return '/';
    const host = u.hostname.toLowerCase();
    if (!host || host.length > 253) return '/';
    const local = host === 'localhost' || host === '127.0.0.1';
    if (local && (u.protocol === 'http:' || u.protocol === 'https:')) {
      return `${u.origin}/`;
    }
    if (u.protocol === 'https:') {
      return `${u.origin}/`;
    }
    return '/';
  } catch {
    return '/';
  }
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
      returnBaseUrl: selfBaseUrl(req),
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
      returnBaseUrl: selfBaseUrl(req),
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
          'Lag et strukturert løpeprogram med én rad per planlagt økt. Bruk når brukeren ber om et program over flere uker (typisk 4–16 uker), oppløp mot konkurranse, eller konkrete mål (f.eks. 10 km under 50 min). Fyll sessions med alle økter sortert etter uke (uke 1 først). For hver økt velg én av de fire løpeøkttypene (samme som manuell logging i appen); workout_type blir tittel på økten i sjekklisten. Detaljer (varighet, intensitet, struktur) kun i description.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string', description: 'Kort navn, f.eks. "12 uker mot 10 km sub-50".' },
            goal_summary: { type: 'string', description: 'Brukerens mål i én–to setninger.' },
            weeks: { type: 'number', description: 'Antall uker programmet varer (1–52).' },
            sessions: {
              type: 'array',
              description:
                'Alle planlagte økter (typisk 3–6 økter per uke). Hver økt klassifiseres med workout_type; ingen egen fritekst-tittel.',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  week: { type: 'number', description: 'Ukenummer fra 1 til weeks.' },
                  day_label: {
                    type: 'string',
                    description: 'Ukedag eller merking, f.eks. "Mandag" eller "Uke 3 · onsdag".',
                  },
                  workout_type: {
                    type: 'string',
                    enum: ['Rolig løpetur', 'Terkeløkt', 'Intervaller', 'Konkurranse'],
                    description:
                      'Økttype (samme som ved manuell løpelogging). Dette blir tittel på økten; bruk beskrivelsesfeltet for innhold.',
                  },
                  description: {
                    type: 'string',
                    description:
                      'Konkret innhold: varighet, distanse, intensitet, pulssoner, intervallstruktur, pauser – ikke gjenta økttypen her som tittel.',
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
    const runWorkoutTypeEnum = z.enum(['Rolig løpetur', 'Terkeløkt', 'Intervaller', 'Konkurranse']);
    const schema = z.object({
      title: z.string().min(2).max(120),
      goal_summary: z.string().min(2).max(500),
      weeks: z.number().int().min(1).max(52),
      sessions: z
        .array(
          z.object({
            week: z.number().int().min(1).max(52),
            day_label: z.string().min(1).max(80),
            workout_type: runWorkoutTypeEnum,
            description: z.string().min(1).max(800),
          }),
        )
        .min(1)
        .max(250),
    });
    const parsed = schema.parse(args ?? {});
    for (const s of parsed.sessions) {
      if (s.week > parsed.weeks) {
        return {
          kind: 'tool_card',
          title: 'Kunne ikke lage program',
          bullets: [`Ukenummer ${s.week} er høyere enn antall uker (${parsed.weeks}).`],
        };
      }
    }
    return {
      kind: 'running_program',
      title: parsed.title,
      goalSummary: parsed.goal_summary,
      weeks: parsed.weeks,
      sessions: parsed.sessions.map((s) => {
        const wt = s.workout_type;
        return {
          week: s.week,
          dayLabel: s.day_label,
          title: wt,
          description: s.description,
          workoutType: wt,
        };
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

app.use((req, res) => {
  res.status(404).type('application/json').json({ error: 'Not found', path: req.path || req.url });
});

export default app;
