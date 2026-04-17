import cors from 'cors';
import 'dotenv/config';
import express from 'express';
import OpenAI from 'openai';
import { z } from 'zod';

const PORT = Number(process.env.PORT || 8787);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY. Create server/.env based on server/.env.example');
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => res.json({ ok: true }));

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
  ];
}

async function runToolCall(name, args) {
  if (name === 'get_training_summary') {
    const schema = z.object({ days: z.number().int().min(1).max(365).default(7) });
    const { days } = schema.parse(args ?? {});
    return {
      kind: 'tool_card',
      title: `Treningsoppsummering (siste ${days} dager)`,
      bullets: [
        'Kobling til Strava/Garmin kommer (placeholder).',
        'Når integrert kan vi hente distanse, puls, økter og trender automatisk.',
      ],
    };
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

  return { kind: 'tool_card', title: `Ukjent tool: ${name}`, bullets: ['Denne toolen finnes ikke på serveren.'] };
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

    const stream = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: parse.data.messages,
      tools,
      stream: true,
    });

    let toolCallName = null;
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

        const toolResult = await runToolCall(toolCallName, parsedArgs);
        send('tool_result', toolResult);

        // Follow-up: ask model to present tool result nicely.
        const followUp = await openai.chat.completions.create({
          model: OPENAI_MODEL,
          messages: [
            ...parse.data.messages,
            { role: 'assistant', content: `Jeg kjører tool: ${toolCallName}` },
            { role: 'tool', content: JSON.stringify(toolResult) },
            {
              role: 'assistant',
              content:
                'Presenter resultatet kort, vennlig og handlingsrettet. Hvis det er en plan, gi 3-7 punkter. Ikke nevn interne JSON-felter.',
            },
          ],
          stream: false,
        });

        const out = followUp.choices?.[0]?.message?.content || '';
        if (out) send('final', { text: out });
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
    res.status(400).json({ error: 'Invalid payload' });
    return;
  }

  try {
    const tools = getTools();

    const first = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: parse.data.messages,
      tools,
    });

    const msg = first.choices?.[0]?.message;
    if (!msg) {
      res.status(500).json({ error: 'No model output' });
      return;
    }

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      const tc = msg.tool_calls[0];
      const name = tc?.function?.name;
      const rawArgs = tc?.function?.arguments || '{}';
      let args = {};
      try {
        args = JSON.parse(rawArgs);
      } catch {
        args = {};
      }

      const toolResult = await runToolCall(name, args);

      const followUp = await openai.chat.completions.create({
        model: OPENAI_MODEL,
        messages: [
          ...parse.data.messages,
          { role: 'assistant', content: `Jeg kjører tool: ${name}` },
          { role: 'tool', content: JSON.stringify(toolResult) },
          {
            role: 'assistant',
            content:
              'Presenter resultatet kort, vennlig og handlingsrettet. Hvis det er en plan, gi 3-7 punkter. Ikke nevn interne JSON-felter.',
          },
        ],
      });

      res.json({
        text: followUp.choices?.[0]?.message?.content || '',
        toolCall: { name, args },
        toolResult,
      });
      return;
    }

    res.json({ text: msg.content || '' });
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Server error' });
  }
});

app.listen(PORT, () => {
  console.log(`training-log server listening on http://localhost:${PORT}`);
});

