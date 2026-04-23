# Training Log Server

Lokal backend som:
- Holder `OPENAI_API_KEY` (aldri i Expo-appen)
- Tilbyr `POST /chat/stream` som SSE-streamer tokens og tool-events
- Har en enkel tool-registry klar for fremtidige integrasjoner (Strava/Garmin)

## Setup

1) Lag `backend/.env` basert på eksempel:

```bash
cd backend
cp .env.example .env
```

2) Sett `OPENAI_API_KEY` i `backend/.env`.

## Kjør

```bash
cd backend
npm run dev
```

Serveren kjører på `http://localhost:8787` (default).

## Strava OAuth (`redirect_uri invalid`)

Strava krever at **Authorization Callback Domain** på [API-innstillingene](https://www.strava.com/settings/api) matcher domenet i `redirect_uri`.

- **Simulator / kun Mac:** callback `http://localhost:8787/strava/callback` — sett callback domain til `localhost`.
- **Fysisk iPhone (samme Wi‑Fi):** nettleseren bruker ofte `http://<Mac-ens-IP>:8787/...`. Da må du i Strava sette callback domain til den IP-en (f.eks. `192.168.1.23`), **eller** sette i `backend/.env`:

  `STRAVA_REDIRECT_URI="http://192.168.1.23:8787/strava/callback"`

  (bytt IP og port om nødvendig — nøyaktig samme verdi som i Strava.)

Token-utveksling sender nå `redirect_uri` til Strava slik dokumentasjonen krever.

### Feil: «activity:read_permission» / 401 på aktiviteter

Strava lar brukeren **fjerne kryss** for enkelte tilganger. Uten `activity:read` eller `activity:read_all` kan ikke appen hente økter.

1. [strava.com/settings/apps](https://www.strava.com/settings/apps) → fjern tilgang til appen din (valgfritt, men rydder opp).
2. Slett `backend/.strava-tokens.json` hvis den finnes.
3. I `backend/.env`: fjern eller tøm `STRAVA_ACCESS_TOKEN`, `STRAVA_REFRESH_TOKEN` og `STRAVA_EXPIRES_AT` hvis du har limt inn gamle nøkler uten aktivitet-tilgang (behold `STRAVA_CLIENT_ID` / `SECRET`).
4. Start backend på nytt, gå til **Innstillinger → Strava** i appen, koble til, og på Strava-siden: **ikke** fjern kryss for aktiviteter.
