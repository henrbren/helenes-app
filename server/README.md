# Training Log Server

Lokal backend som:
- Holder `OPENAI_API_KEY` (aldri i Expo-appen)
- Tilbyr `POST /chat/stream` som SSE-streamer tokens og tool-events
- Har en enkel tool-registry klar for fremtidige integrasjoner (Strava/Garmin)

## Setup

1) Lag `server/.env` basert på eksempel:

```bash
cd server
cp .env.example .env
```

2) Sett `OPENAI_API_KEY` i `server/.env`.

## Kjør

```bash
cd server
npm run dev
```

Serveren kjører på `http://localhost:8787` (default).

