import cors from 'cors';
import 'dotenv/config';
import express from 'express';
import OpenAI from 'openai';
import { z } from 'zod';
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
  readBestEffortsSnapshot,
  resetBestEffortsCache,
} from './strava.js';

const PORT = Number(process.env.PORT || 8787);
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

let openaiClient = null;
function getOpenAI() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error('Missing OPENAI_API_KEY (sett i Vercel Environment Variables eller backend/.env)');
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

app.get('/health', (_req, res) => res.json({ ok: true }));

// ---- Strava routes ---------------------------------------------------------
function selfBaseUrl(req) {
  const host = req.get('host');
  const proto = req.protocol || 'http';
  return `${proto}://${host}`;
}

/** Must be identical for /authorize and /token. Strava validates against «Authorization Callback Domain». */
function stravaRedirectUri(req) {
  const fixed = process.env.STRAVA_REDIRECT_URI?.trim();
  if (fixed) return fixed;
  return `${selfBaseUrl(req)}/strava/callback`;
}

app.get('/strava/connect', (req, res) => {
  try {
    const redirectUri = stravaRedirectUri(req);
    const url = buildAuthorizeUrl({ redirectUri });
    res.redirect(url);
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Could not build authorize url' });
  }
});

app.get('/strava/callback', async (req, res) => {
  const { code, error, scope } = req.query;
  if (error) {
    res.status(400).send(`Strava authorization failed: ${error}`);
    return;
  }
  if (!code || typeof code !== 'string') {
    res.status(400).send('Missing ?code from Strava');
    return;
  }

  try {
    const redirectUri = stravaRedirectUri(req);
    const scopeAccepted = typeof scope === 'string' ? scope : '';
    const actOk = hasActivityListScope(scopeAccepted);
    if (actOk === false) {
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.status(400).send(`<!doctype html><html><head><meta charset="utf-8"><title>Strava – mangler tilgang</title>
<style>body{font-family:-apple-system,Segoe UI,Inter,Arial,sans-serif;max-width:560px;margin:48px auto;padding:0 20px;color:#0f172a;line-height:1.5}</style></head>
<body><h1>Mangler tilgang til aktiviteter</h1>
<p>Strava rapporterer at du <strong>ikke</strong> godkjente lesetilgang til treningsøkter (scope mangler <code>activity:read</code> eller <code>activity:read_all</code>).</p>
<p>Du godkjente: <code>${scopeAccepted || '(ingen oppgitt)'}</code></p>
<p>Gå tilbake til appen → <strong>Innstillinger → Strava</strong> → koble til igjen. På Strava-siden: la <strong>alle</strong> forespurte tilganger være på (ikke fjern kryss for aktiviteter).</p>
<p><a href="https://www.strava.com/settings/apps">Åpne Strava → Mine apper</a> og fjern appen hvis den henger, deretter prøv på nytt.</p></body></html>`);
      return;
    }
    const result = await exchangeCodeForTokens(code, redirectUri, scopeAccepted);
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!doctype html><html><head><meta charset="utf-8"><title>Strava connected</title>
<style>body{font-family:-apple-system,Segoe UI,Inter,Arial,sans-serif;max-width:560px;margin:60px auto;padding:0 20px;color:#0f172a}
h1{font-size:22px;margin-bottom:8px}p{line-height:1.5}code{background:#f1f5f9;padding:2px 6px;border-radius:6px}</style></head>
<body><h1>✅ Strava er koblet til</h1>
<p>Hei ${result.athlete?.firstname ?? ''}! Tokenet er lagret på serveren med scope <code>${scope || result.scope || ''}</code>.</p>
<p>Du kan lukke dette vinduet og gå tilbake til appen.</p></body></html>`);
  } catch (err) {
    res.status(500).send(`Token exchange failed: ${err?.message || err}`);
  }
});

app.get('/strava/athlete', async (_req, res) => {
  try {
    const athlete = await getAthlete();
    res.json(athlete);
  } catch (err) {
    res.status(err?.status || 500).json({ error: err?.message || 'Strava error' });
  }
});

app.get('/strava/activities', async (req, res) => {
  try {
    const perPage = Math.min(Number(req.query.per_page) || 10, 100);
    const page = Number(req.query.page) || 1;
    const after = req.query.after ? Number(req.query.after) : undefined;
    const before = req.query.before ? Number(req.query.before) : undefined;
    const activities = await getActivities({ perPage, page, after, before });
    res.json(activities);
  } catch (err) {
    res.status(err?.status || 500).json({ error: err?.message || 'Strava error' });
  }
});

app.get('/strava/recent', async (req, res) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 14, 1), 90);
    const perPage = Math.min(Number(req.query.per_page) || 30, 100);
    const summary = await getRecentActivitiesSummary({ days, perPage });
    res.json(summary);
  } catch (err) {
    res.status(err?.status || 500).json({ error: err?.message || 'Strava error' });
  }
});

app.get('/strava/activity/:id/streams', async (req, res) => {
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
    const streams = await getActivityStreams(id, keys);
    res.json(streams);
  } catch (err) {
    res.status(err?.status || 500).json({ error: err?.message || 'Strava error' });
  }
});

app.get('/strava/stats', async (_req, res) => {
  try {
    const athlete = await getAthlete();
    const stats = await getAthleteStats(athlete.id);
    res.json({ athleteId: athlete.id, stats });
  } catch (err) {
    res.status(err?.status || 500).json({ error: err?.message || 'Strava error' });
  }
});

// Best efforts are persisted to disk (see backend/.strava-best-efforts.json).
// Scanning (fetching `best_efforts` per activity) can take 20–40s for a
// single batch, which is longer than most mobile HTTP clients will wait
// before giving up with a "Network request failed" error. We therefore
// run scans in the background on the server and let the client poll for
// progress via plain GETs (which return the on-disk snapshot instantly).
let bestEffortsInFlight = null;
let bestEffortsLastError = null;

function startBestEffortsScan({ batch, reset }) {
  if (bestEffortsInFlight) return bestEffortsInFlight;
  bestEffortsInFlight = (async () => {
    try {
      bestEffortsLastError = null;
      const data = await getRunningBestEfforts({ batch, reset });
      return { ...data, fetchedAt: Date.now() };
    } catch (err) {
      bestEffortsLastError = err?.message || String(err);
      throw err;
    } finally {
      bestEffortsInFlight = null;
    }
  })();
  // Prevent unhandled rejection warnings when nobody awaits the scan.
  bestEffortsInFlight.catch((err) => {
    console.warn('[strava] best-efforts scan failed:', err?.message || err);
  });
  return bestEffortsInFlight;
}

app.get('/strava/best-efforts', async (req, res) => {
  try {
    const batch = Math.min(
      Math.max(Number(req.query.batch ?? req.query.limit) || 25, 1),
      200
    );
    const force = req.query.force === '1' || req.query.force === 'true';
    const reset = req.query.reset === '1' || req.query.reset === 'true';

    if ((force || reset) && !bestEffortsInFlight) {
      startBestEffortsScan({ batch, reset });
    }

    const snapshot = await readBestEffortsSnapshot();
    res.json({
      ...snapshot,
      scanning: Boolean(bestEffortsInFlight),
      lastError: bestEffortsLastError,
      fetchedAt: Date.now(),
    });
  } catch (err) {
    res.status(err?.status || 500).json({ error: err?.message || 'Strava error' });
  }
});

app.post('/strava/best-efforts/reset', async (_req, res) => {
  try {
    if (bestEffortsInFlight) {
      res.status(409).json({ error: 'Scan pågår – vent til den er ferdig før du nullstiller.' });
      return;
    }
    await resetBestEffortsCache();
    bestEffortsLastError = null;
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

async function runToolCall(name, args) {
  if (name === 'get_training_summary') {
    const schema = z.object({ days: z.number().int().min(1).max(90).default(7) });
    const { days } = schema.parse(args ?? {});

    try {
      const summary = await getRecentActivitiesSummary({ days, perPage: 50 });
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
      return {
        kind: 'tool_card',
        title: `Treningsoppsummering (siste ${days} dager)`,
        bullets: [
          'Klarte ikke å hente data fra Strava.',
          String(err?.message || err),
          'Sjekk at STRAVA_* er satt i backend/.env.',
        ],
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

async function safeRunToolCall(name, args) {
  try {
    return await runToolCall(name, args);
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

// ---- Chat API (SSE streaming) ----------------------------------------------
const ChatRequestSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['system', 'user', 'assistant', 'tool']),
        content: z.string(),
      })
    )
    .min(1),
});

app.post('/chat/stream', async (req, res) => {
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

        const toolResult = await safeRunToolCall(toolCallName, parsedArgs);
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

app.post('/chat', async (req, res) => {
  const parse = ChatRequestSchema.safeParse(req.body);
  if (!parse.success) {
    console.error('[/chat] invalid payload', parse.error?.issues);
    res.status(400).json({ error: 'Invalid payload', details: parse.error?.issues });
    return;
  }

  try {
    const tools = getTools();

    console.log(`[/chat] calling OpenAI (${parse.data.messages.length} messages)`);
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
      const toolResult = await safeRunToolCall(name, args);
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

app.post('/chat/session-feedback', async (req, res) => {
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

export default app;
