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

- Gå til fanen **Chat**
- På **iOS Simulator** fungerer `http://localhost:8787` direkte
- På **fysisk iPhone** må du sette server-adressen til Mac-ens IP (samme Wi‑Fi), f.eks. `http://192.168.1.23:8787` (i Chat → Innst.)

## Data

Økter lagres lokalt på enheten i `AsyncStorage`.

