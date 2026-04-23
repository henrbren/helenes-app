# Training Log (iOS)

Dette er en Expo (React Native) iOS-app portet fra `training_log_app.jsx`.

## Kjøre appen på iOS Simulator

### 1) Installer Xcode (kun første gang)
- Installer **Xcode** fra App Store
- Åpne Xcode én gang og la den fullføre installasjon av ekstra komponenter
- Kjør deretter:

```bash
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
sudo xcodebuild -license accept
```

### 2) Start appen

Denne maskinen har ikke `npm` globalt i PATH, så prosjektet bruker en lokal Node-installasjon under `Desktop/.local-node`.

```bash
export PATH="/Users/helenebergene/Desktop/.local-node/node-v22.22.0-darwin-arm64/bin:$PATH"
cd "/Users/helenebergene/Desktop/training-log-ios"
npm run ios
```

## Chat (OpenAI) – sikker nøkkelbruk + tooling-ready

⚠️ Ikke legg OpenAI-nøkkel i Expo-appen. Expo Go innebærer at klientkode kan inspiseres. Nøkkelen ligger derfor i en lokal server.

### Start server

```bash
export PATH="/Users/helenebergene/Desktop/.local-node/node-v22.22.0-darwin-arm64/bin:$PATH"
cd "/Users/helenebergene/Documents/projects/training-log-ios/backend"
cp .env.example .env
```

Rediger `backend/.env` og sett `OPENAI_API_KEY`.

Kjør så:

```bash
npm run dev
```

Serveren kjører på `http://localhost:8787`.

### Bruk chat i appen

- Appen peker som standard mot Vercel-deployet (`extra.apiUrl` i `app.json` eller `EXPO_PUBLIC_API_URL`), også når du kjører lokalt. Dermed er chat + Strava-state alltid på samme sted.
- I **Chat → Innstillinger** er server-adressen låst til denne URL-en. Skru på **«Overstyr (avansert)»** dersom du vil peke mot en lokal backend (f.eks. `http://localhost:8787` på iOS Simulator, eller Mac-ens IP på fysisk iPhone på samme Wi‑Fi).

## Strava på Vercel

Strava valideres mot et eksakt **Authorization Callback Domain**. For at OAuth-flyten skal fungere fra Vercel-domenet må følgende stemme:

- I Strava-appens innstillinger (`https://www.strava.com/settings/api`) må «Authorization Callback Domain» være satt til produksjonsdomenet, f.eks. `helenes-app.vercel.app`.
- I Vercel → **Environment Variables** settes:
  - `STRAVA_CLIENT_ID`
  - `STRAVA_CLIENT_SECRET`
  - (Anbefalt) `STRAVA_REDIRECT_URI=https://helenes-app.vercel.app/strava/callback` – tvinger redirect-URI til produksjonsdomenet uansett hvilken deployment som kjører.
  - `OPENAI_API_KEY`

Serveren bruker `x-forwarded-host` først, deretter `VERCEL_PROJECT_PRODUCTION_URL`, og til sist `VERCEL_URL`, for å bygge callback-URI. Det betyr at preview-deployments vil peke mot sitt eget preview-domene – enten whitelist dem i Strava, eller (enklere) sett `STRAVA_REDIRECT_URI` eksplisitt.

## Data

Økter lagres lokalt på enheten i `AsyncStorage`. Strava-tokens lagres på serveren i `backend/.strava-tokens.json` lokalt, og i `/tmp/training-log-backend/` på Vercel (ephemeral – må evt. re-kobles dersom tokens blir borte).

