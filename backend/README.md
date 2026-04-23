# Training Log Server

Backend som driver:

- Innlogging / registrering av brukere (`/auth/*`).
- Chat mot OpenAI (`POST /chat`, `POST /chat/stream`, `POST /chat/session-feedback`).
- Strava-integrasjon per bruker (`/strava/*`).

Brukere, sesjoner og Strava-tokens lagres i **Upstash Redis** (tidligere Vercel KV).
Lokalt uten KV-oppsett fungerer alt via en in-memory-fallback – nyttig under utvikling,
men husk at all state går tapt når prosessen restartes.

## Setup

1. Lag `backend/.env` basert på eksempel:

   ```bash
   cd backend
   cp .env.example .env
   ```

2. Sett `OPENAI_API_KEY` i `backend/.env`.

3. **Upstash Redis / Vercel KV** (valgfritt lokalt, påkrevd i produksjon):

   - På Vercel: legg til en Upstash-integrasjon (se
     [Vercel Marketplace](https://vercel.com/marketplace?category=storage&search=redis)).
     Det eksponerer enten `KV_REST_API_URL` + `KV_REST_API_TOKEN` eller
     `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` som env-vars – begge
     støttes av backenden.
   - Lokalt: kan hoppes over; vi faller tilbake til in-memory-lager.

4. **Strava**:

   - `STRAVA_CLIENT_ID` + `STRAVA_CLIENT_SECRET` må være satt for at OAuth skal fungere.
   - `STRAVA_REDIRECT_URI` bør settes eksplisitt (f.eks.
     `https://helenes-app.vercel.app/strava/callback`) slik at alle preview-deploys
     bruker samme callback. Uten dette vil hver preview få «redirect_uri invalid»
     fra Strava.

   **Migrasjon:** de gamle env-variablene `STRAVA_ACCESS_TOKEN`, `STRAVA_REFRESH_TOKEN`
   og `STRAVA_EXPIRES_AT` brukes ikke lenger. Slett dem for å unngå forvirring.
   Hver bruker kobler Strava på nytt via **Innstillinger → Strava → Koble til** i
   appen, eller via **Logg inn med Strava** på loginsiden.

## Kjør

```bash
cd backend
npm run dev
```

Serveren kjører på `http://localhost:8787` (default).

## Env-variabler (oppsummering)

| Navn                                                  | Beskrivelse                                                                 |
| ----------------------------------------------------- | --------------------------------------------------------------------------- |
| `OPENAI_API_KEY` (eller `OPENAI`)                     | OpenAI-nøkkel brukt for chat.                                               |
| `OPENAI_MODEL`                                        | (Valgfri) Hvilken OpenAI-modell å bruke. Default `gpt-4.1-mini`.            |
| `STRAVA_CLIENT_ID` / `STRAVA_CLIENT_SECRET`           | Strava API-credentials. Påkrevd for OAuth.                                  |
| `STRAVA_REDIRECT_URI`                                 | (Sterkt anbefalt) Absolutt URL til `/strava/callback`.                      |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN`               | Upstash Redis via Vercel KV-integrasjonen.                                  |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Alternative navn hvis Upstash er koblet direkte.                            |
| `AUTH_COOKIE_DOMAIN`                                  | (Valgfri) Domene for `__session`-cookien. La stå tom for same-origin-setup. |
| `AUTH_COOKIE_SECURE`                                  | Sett til `1` for å tvinge Secure-cookie lokalt (alltid på i prod/Vercel).   |

## Endepunkter

### Auth (ny)

- `POST /auth/register` `{ email, password }` → `{ sessionToken, user }`
- `POST /auth/login` `{ email, password }` → `{ sessionToken, user }`
- `POST /auth/logout` (krever Bearer) → 204
- `GET /auth/me` (krever Bearer) → `{ user }`
- `GET /auth/strava/start` → 302 til Strava (oppretter/kjenner igjen en konto
  basert på athleteId når tilbakemeldingen kommer).

### Chat

- `POST /chat` og `POST /chat/stream` – krever innlogget bruker (Bearer-token).
- `POST /chat/session-feedback` – krever innlogget bruker.

### Strava (per-bruker)

- `GET /strava/connect` – starter Strava OAuth for å koble til den innloggede
  kontoen.
- `GET /strava/callback` – ikke kall direkte; Strava redirecter hit.
- `GET /strava/status` – om brukeren har koblet til Strava.
- `GET /strava/athlete`, `/strava/activities`, `/strava/recent`,
  `/strava/stats`, `/strava/activity/:id/streams`, `/strava/best-efforts`,
  `POST /strava/best-efforts/reset` – alle krever innlogging.

## Innlogging fra appen

Frontenden (React Native + Expo Web) lagrer et opaque sesjonstoken i AsyncStorage
og sender det som `Authorization: Bearer <token>` ved hvert kall. Etter
logout ryddes både server-session (i KV) og lokal cache.

For Strava OAuth sendes tokenet også som `?token=` i URL-en fordi `Linking.openURL`
ikke støtter egendefinerte headers; backenden aksepterer det.
