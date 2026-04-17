# Helenes Treningsapp – Prosjektbeskrivelse

## Hvem er dette for?

Denne appen lages av og for **Helene** – en person som aldri har programmert før, men som bygger dette systemet sammen med en AI-assistent (deg). All kommunikasjon, kommentarer og dokumentasjon skal derfor være på **norsk** og skrevet i et klart, ikke-teknisk språk der det er mulig.

Når du foreslår endringer eller forklarer valg, husk:
- Forklar *hvorfor*, ikke bare *hva*
- Unngå unødvendig sjargong – eller forklar den kort
- Vis heller et konkret eksempel enn en abstrakt beskrivelse
- Spør heller én gang for mye enn én gang for lite

---

## Hva er appen?

En **personlig trenings- og helse-app** for iOS, med en innebygd AI-chat som fungerer som en personlig treningsrådgiver. Tenk ChatGPT, men spesialisert for Helenes treningshverdag.

### Kjerneverdier

1. **Chat i sentrum** – Chatten er hjertet i appen. Den skal føles like god å bruke som å snakke med en venn som har greie på trening. UI/UX i chatten er ekstremt viktig – den skal være vakker, responsiv og behagelig å bruke.

2. **Personlig treningsguide** – AI-en skal kjenne Helenes treningshistorikk, mål og preferanser. Over tid skal den kunne gi stadig bedre råd basert på data fra treningsøkter, Strava, Garmin og lignende.

3. **Enkel og pen** – Appen skal være visuelt tiltalende og føles "premium", men aldri overveldende. Hver skjerm skal ha ett tydelig formål.

---

## Teknisk oppsett (for AI-assistenten)

### Appen (frontend)
- **Expo** (React Native) med **TypeScript**
- Kjører på iOS via Expo Go eller Simulator
- All UI-kode ligger i `App.tsx` (ca. 1400 linjer – bør deles opp over tid)
- Data lagres lokalt med `AsyncStorage`
- Fem faner: Oversikt, Logg økt, Historikk, Statistikk, Chat

### Serveren (backend)
- Ligger i `server/`-mappen
- **Node.js** med **Express** og **OpenAI SDK**
- API-nøkkelen til OpenAI ligger i `server/.env` (aldri i appen)
- Endepunkter: `/chat` (synkron), `/chat/stream` (SSE-streaming)
- Tool-system: serveren kan kalle verktøy (f.eks. treningsoppsummering) og returnere strukturerte "tool cards" til appen

### Kjøre prosjektet
```
# Terminal 1 – Start serveren
cd server
npm run dev          # kjører på http://localhost:8787

# Terminal 2 – Start appen
npm run ios          # åpner i iOS Simulator
```

---

## Nåværende funksjoner

| Funksjon | Status | Beskrivelse |
|----------|--------|-------------|
| Logg treningsøkt | Fungerer | Løping og styrketrening med detaljer |
| Historikk | Fungerer | Liste over tidligere økter |
| Oversikt | Fungerer | Dashboard med siste økter og oppsummering |
| Statistikk | Enkel | Totalt antall økter og km |
| Chat med AI | Fungerer | Spør om trening, får svar fra OpenAI |
| Tool cards | Grunnlag | Serveren kan returnere strukturerte kort |

---

## Fremtidige mål og ønsker

### Kort sikt
- **Forbedre chat-UX** – Animasjoner, streaming av tekst (token for token), bedre layout, mørkt/lyst tema
- **Dele opp `App.tsx`** – Flytte hver fane og komponent til egne filer for ryddighet
- **Bedre statistikk** – Grafer, trender over tid, ukentlig oppsummering

### Mellomlang sikt
- **Strava-integrasjon** – Hente treningsdata automatisk via Strava API
- **Garmin-integrasjon** – Synkronisere data fra Garmin Connect
- **Kontekstbevisst AI** – La AI-en bruke treningshistorikk og API-data til å gi personlige anbefalinger ("Du har løpt 40 km denne uken, kanskje en hviledag?")
- **Treningsplaner** – AI-en lager ukes-/månedsplaner basert på mål

### Lang sikt
- **Helse-dashboard** – Samle data fra flere kilder (søvn, puls, vekt, trening)
- **Push-varsler** – Påminnelser og motivasjon
- **Offline-modus** – Chat-historikk og logg tilgjengelig uten nett

---

## API-integrasjoner (planlagt)

### Strava
- OAuth 2.0-autentisering
- Hente aktiviteter, distanser, tempo, hjertefrekvens
- Brukes av AI-en som kontekst for råd

### Garmin Connect
- Synkronisere treningsøkter, søvndata, stressnivå
- Rikere helsebilde for AI-en

### Eventuelt andre
- Apple Health / HealthKit
- Polar, COROS eller lignende

---

## Designprinsipper

### Chat-opplevelsen
- **Streaming** – Tekst skal komme ord for ord, ikke som en hel blokk
- **Tydelig visuelt skille** mellom bruker og AI
- **Markdown-støtte** i AI-svar (fett, lister, overskrifter)
- **Haptic feedback** på send-knapp og interaksjoner
- **Soft, moderne farger** – Ingen harde kanter eller skarpe kontraster
- **Emoji-bruk** der det passer naturlig

### Generell UX
- Minimalt antall trykk for vanlige handlinger
- Tydelig feedback når noe skjer (lagring, sending, lasting)
- Konsistent design på tvers av alle skjermer
- Appen skal føles som "min egen" – personlig og varm

---

## Viktige regler for AI-assistenten

1. **Aldri legg API-nøkler i app-koden** – Alle hemmeligheter skal kun ligge i `server/.env`
2. **Behold eksisterende data** – Ikke endre `STORAGE_KEY` uten migrering, ellers mister Helene treningsloggene sine
3. **Norsk UI** – All tekst som brukeren ser skal være på norsk
4. **Test på iOS** – Appen er primært for iPhone, test alltid at ting fungerer i Simulator
5. **Små steg** – Gjør én ting om gangen, forklar hva som skjedde, og vent på bekreftelse før neste steg
6. **Spør ved tvil** – Hvis noe er uklart om design, funksjonalitet eller prioritering – spør Helene

---

## Mappestruktur (nåværende)

```
helenes-app-main/
├── App.tsx              ← Hele appen (bør deles opp)
├── index.ts             ← Expo entry point
├── app.json             ← Expo-konfigurasjon
├── package.json         ← App-avhengigheter
├── tsconfig.json        ← TypeScript-konfigurasjon
├── prompt.md            ← Denne filen
├── README.md            ← Oppsett-instruksjoner
└── server/
    ├── index.js         ← Express-server med OpenAI
    ├── package.json     ← Server-avhengigheter
    └── README.md        ← Server-dokumentasjon
```

---

## Hvordan bruke denne filen

Denne filen (`prompt.md`) gir AI-assistenten kontekst om prosjektet. Når du starter en ny samtale, kan du referere til denne filen slik at AI-en forstår:
- Hva appen er og hvem den er for
- Hvilke teknologier som brukes
- Hva som finnes og hva som skal bygges
- Hvilke regler og prinsipper som gjelder

Oppdater denne filen etter hvert som prosjektet utvikler seg.
