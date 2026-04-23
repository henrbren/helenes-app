import express from 'express';
import { z } from 'zod';
import { clientIp, hitRateLimit } from './rate-limit.js';
import {
  buildSessionCookie,
  createSession,
  destroySession,
  requireAuth,
} from './sessions.js';
import {
  createAnonymousUser,
  createUserWithPassword,
  isAcceptablePassword,
  isValidEmail,
  publicUser,
  verifyPassword,
} from './users.js';

const RegisterSchema = z.object({
  email: z.string().min(3).max(254),
  password: z.string().min(1).max(300),
});
const LoginSchema = RegisterSchema;

/**
 * Bygger et Express-router-objekt med alle /auth-endepunkter.
 */
export function createAuthRouter(_opts) {
  const router = express.Router();

  /** Enkel enhetsøkt uten epost/passord (app uten innloggingsskjerm). */
  router.post('/auth/anonymous', async (req, res) => {
    const ip = clientIp(req);
    const rl = await hitRateLimit({
      prefix: 'auth:anonymous',
      id: ip,
      limit: 30,
      windowSeconds: 15 * 60,
    });
    if (!rl.allowed) {
      res.status(429).json({ error: 'For mange forsøk. Prøv igjen om noen minutter.' });
      return;
    }
    try {
      const user = await createAnonymousUser();
      const { token } = await createSession(user.id);
      res.setHeader('Set-Cookie', buildSessionCookie(token));
      res.status(201).json({ sessionToken: token, user: publicUser(user) });
    } catch (err) {
      console.error('[/auth/anonymous] failed:', err?.message || err);
      res.status(500).json({ error: 'Kunne ikke opprette økt.' });
    }
  });

  router.post('/auth/register', async (req, res) => {
    const ip = clientIp(req);
    const rl = await hitRateLimit({
      prefix: 'auth:register',
      id: ip,
      limit: 10,
      windowSeconds: 15 * 60,
    });
    if (!rl.allowed) {
      res.status(429).json({ error: 'For mange forsøk. Prøv igjen om noen minutter.' });
      return;
    }

    const parse = RegisterSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: 'Ugyldig payload.', details: parse.error?.issues });
      return;
    }
    const { email, password } = parse.data;
    if (!isValidEmail(email)) {
      res.status(400).json({ error: 'Ugyldig epost-adresse.' });
      return;
    }
    if (!isAcceptablePassword(password)) {
      res.status(400).json({ error: 'Passordet må ha minst 8 tegn.' });
      return;
    }

    try {
      const user = await createUserWithPassword({ email, password });
      const { token } = await createSession(user.id);
      res.setHeader('Set-Cookie', buildSessionCookie(token));
      res.status(201).json({ sessionToken: token, user: publicUser(user) });
    } catch (err) {
      if (err?.code === 'EMAIL_TAKEN') {
        res.status(409).json({ error: 'En konto med denne eposten finnes allerede.' });
        return;
      }
      if (err?.code === 'WEAK_PASSWORD' || err?.code === 'INVALID_EMAIL') {
        res.status(400).json({ error: err.message });
        return;
      }
      console.error('[/auth/register] failed:', err?.message || err);
      res.status(500).json({ error: 'Kunne ikke opprette kontoen.' });
    }
  });

  router.post('/auth/login', async (req, res) => {
    const ip = clientIp(req);
    const rl = await hitRateLimit({
      prefix: 'auth:login',
      id: ip,
      limit: 10,
      windowSeconds: 15 * 60,
    });
    if (!rl.allowed) {
      res.status(429).json({ error: 'For mange forsøk. Prøv igjen om noen minutter.' });
      return;
    }

    const parse = LoginSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: 'Ugyldig payload.' });
      return;
    }
    const { email, password } = parse.data;

    try {
      const user = await verifyPassword(email, password);
      if (!user) {
        res.status(401).json({ error: 'Feil epost eller passord.' });
        return;
      }
      const { token } = await createSession(user.id);
      res.setHeader('Set-Cookie', buildSessionCookie(token));
      res.json({ sessionToken: token, user: publicUser(user) });
    } catch (err) {
      console.error('[/auth/login] failed:', err?.message || err);
      res.status(500).json({ error: 'Innlogging feilet.' });
    }
  });

  router.post('/auth/logout', requireAuth, async (req, res) => {
    try {
      await destroySession(req.sessionToken);
      res.setHeader('Set-Cookie', buildSessionCookie('', { clear: true }));
      res.status(204).end();
    } catch (err) {
      console.error('[/auth/logout] failed:', err?.message || err);
      res.status(500).json({ error: 'Utlogging feilet.' });
    }
  });

  router.get('/auth/me', requireAuth, (req, res) => {
    res.json({ user: req.publicUser });
  });

  return router;
}
