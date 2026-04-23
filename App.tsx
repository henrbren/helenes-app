import AsyncStorage from '@react-native-async-storage/async-storage';
import DateTimePicker from '@react-native-community/datetimepicker';
import Constants from 'expo-constants';
import { StatusBar } from 'expo-status-bar';
import * as ExpoHaptics from 'expo-haptics';

// Haptisk feedback er bevisst skrudd av i størsteparten av appen.
// Eneste sted vi faktisk vibrerer er ved vellykket lagring/oppretting av en
// økt – der kalles `ExpoHaptics.notificationAsync(...)` direkte.
// Alle andre eksisterende kall går via `Haptics`-stubben under, som er en
// no-op. Slik beholder vi koden ren uten å måtte fjerne hvert enkelt kall.
const Haptics = {
  selectionAsync: () => Promise.resolve(),
  notificationAsync: (_type?: ExpoHaptics.NotificationFeedbackType) => Promise.resolve(),
  impactAsync: (_style?: ExpoHaptics.ImpactFeedbackStyle) => Promise.resolve(),
  NotificationFeedbackType: ExpoHaptics.NotificationFeedbackType,
  ImpactFeedbackStyle: ExpoHaptics.ImpactFeedbackStyle,
};
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  ActivityIndicator,
  Animated,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Modal,
  Pressable,
  AppState,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  type ViewStyle,
} from 'react-native';
import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { GestureHandlerRootView, Swipeable } from 'react-native-gesture-handler';
import PagerHost, { type PagerHostHandle } from './PagerHost';
import Svg, { Line as SvgLine, Polygon as SvgPolygon, Polyline, Text as SvgText } from 'react-native-svg';
import { apiFetch, AuthGate, AuthProvider, useAuth, useUserId, userKey } from './auth';

const STORAGE_KEY = 'training-log-ios:sessions:v1';
const CHAT_STORAGE_KEY = 'training-log-ios:chat:v1';
const CHAT_CONFIG_KEY = 'training-log-ios:chat-config:v1';
const STRAVA_CACHE_KEY = 'training-log-ios:strava-recent:v1';
const STRAVA_STATS_CACHE_KEY = 'training-log-ios:strava-stats:v1';
const STRAVA_BEST_EFFORTS_CACHE_KEY = 'training-log-ios:strava-best-efforts:v1';
const STRAVA_CONNECTED_KEY = 'training-log-ios:strava-connected:v1';
const RUNNING_PROGRAMS_KEY = 'training-log-ios:running-programs:v1';
const COMPETITION_FOLLOWUP_KEY = 'training-log-ios:competition-followup-sent:v1';

const tabs = ['Chat', 'Løpeprogram', 'Økter', 'Statistikk'] as const;
type Tab = (typeof tabs)[number];

const tabIcons: Record<Tab, string> = {
  Chat: '💬',
  Økter: '➕',
  Statistikk: '📊',
  Løpeprogram: '🗓️',
};

const SERVER_PORT = 8787;

/** Metro, Expo dev client, Vite preview, osv. — aldri bruk dette som chat-API (backend er :8787 eller Vercel). */
const KNOWN_DEV_BUNDLER_PORTS = new Set(['8081', '8082', '19000', '19001', '19002', '19006', '4173']);

function isLikelyBundlerOrStaticDevUrl(url: string): boolean {
  try {
    const u = new URL(url.trim());
    const p = u.port || (u.protocol === 'https:' ? '443' : '80');
    return KNOWN_DEV_BUNDLER_PORTS.has(p);
  } catch {
    return false;
  }
}

/**
 * Fjerner vanlig copy-paste-feil: brukere limer inn test-URL …/health eller …/chat.
 * Da ville joinApiUrl(base, '/health') blitt …/health/health og test/chat feilet.
 */
function stripMistakenApiPathFromBase(url: string): string {
  const t = url.trim();
  try {
    const u = new URL(t);
    const path = (u.pathname || '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
    if (path === '/health' || path === '/chat' || path === '/chat/stream') {
      u.pathname = '/';
      return normalizeApiBase(u.href);
    }
  } catch {
    // ugyldig URL — returner uendret
  }
  return t;
}

/** Erstatter feilaktig lagret «Metro»-URL med standard API-adresse. */
function coerceChatServerUrl(url: string): string {
  const stripped = stripMistakenApiPathFromBase(url);
  const normalized = normalizeApiBase(stripped);
  return isLikelyBundlerOrStaticDevUrl(normalized) ? resolveDefaultServerUrl() : normalized;
}

/** Normaliser base-URL (trim, ingen trailing slash). */
function normalizeApiBase(url: string): string {
  return url.trim().replace(/\/$/, '');
}

/**
 * Bygger URL til fetch.
 * - HTTPS-web (Vercel m.fl.): alltid relative sti — API nås via rewrites på samme origin.
 *   Da ignoreres __DEV__, lagret feil host og EXPO_PUBLIC som peker andre veier (unngår «Failed to fetch»).
 * - HTTP-web (typisk lokal Expo): full URL mot chatApiBase / Mac:8787 som før.
 */
function joinApiUrl(base: string, pathWithQuery: string): string {
  const path = pathWithQuery.startsWith('/') ? pathWithQuery : `/${pathWithQuery}`;
  if (Platform.OS === 'web' && typeof window !== 'undefined' && window.location?.protocol === 'https:') {
    return path;
  }
  if (Platform.OS === 'web' && typeof window !== 'undefined' && window.location?.origin) {
    const origin = normalizeApiBase(window.location.origin);
    const b = base.trim();
    const pageHttps = window.location.protocol === 'https:';
    if (pageHttps && (!b || /^http:\/\//i.test(b) || normalizeApiBase(b) === origin)) {
      return path;
    }
    if (!__DEV__ && (!b || normalizeApiBase(b) === origin)) {
      return path;
    }
  }
  const prefix = base.trim() ? normalizeApiBase(base) : '';
  return prefix ? `${prefix}${path}` : path;
}

/** Absolutt https-URL for Linking.openURL (web trenger full URL, ikke /strava/... alene). */
function absoluteApiUrl(base: string, pathWithQuery: string): string {
  const path = pathWithQuery.startsWith('/') ? pathWithQuery : `/${pathWithQuery}`;
  if (Platform.OS === 'web' && typeof window !== 'undefined' && window.location?.protocol === 'https:') {
    return `${normalizeApiBase(window.location.origin)}${path}`;
  }
  if (Platform.OS === 'web' && typeof window !== 'undefined' && window.location?.origin) {
    const origin = normalizeApiBase(window.location.origin);
    const b = base.trim();
    const pageHttps = window.location.protocol === 'https:';
    if (pageHttps && (!b || /^http:\/\//i.test(b) || normalizeApiBase(b) === origin)) {
      return `${origin}${path}`;
    }
    if (!b || normalizeApiBase(b) === origin) {
      return `${origin}${path}`;
    }
  }
  const prefix = base.trim() ? normalizeApiBase(base) : '';
  return prefix ? `${prefix}${path}` : path;
}

/** Leser response body som tekst og parser JSON — gir tydelig feil ved HTML/feilside. */
async function parseFetchJsonBody(resp: Response): Promise<unknown> {
  const textBody = await resp.text();
  const trimmed = textBody.trim();
  if (!trimmed) {
    if (!resp.ok) throw new Error(`Tomt svar fra server (HTTP ${resp.status}).`);
    return {};
  }
  try {
    return JSON.parse(trimmed.replace(/^\uFEFF/, ''));
  } catch {
    const isHtml = /<\s*!DOCTYPE|<\s*html[\s>]/i.test(textBody);
    throw new Error(
      isHtml
        ? `Fikk HTML i stedet for JSON (HTTP ${resp.status}). Ofte Vercel-feil, feil rute, eller at API ikke kjørte.`
        : `Ugyldig JSON (HTTP ${resp.status}): ${trimmed.slice(0, 160)}`,
    );
  }
}

/**
 * Når satt ved build (f.eks. Vercel), brukes alltid denne mot backend.
 * Sett `EXPO_PUBLIC_API_URL=https://api.dittdomene.no` i Vercel → Environment Variables.
 */
function apiBaseFromEnv(): string | null {
  const v = process.env.EXPO_PUBLIC_API_URL?.trim();
  return v ? normalizeApiBase(v) : null;
}

/** Standard API fra app.json (også under lokal `expo start`). Overstyr med EXPO_PUBLIC_API_URL om nødvendig. */
function apiBaseFromAppExtra(): string | null {
  const u = (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl?.trim();
  return u ? normalizeApiBase(u) : null;
}

/**
 * Autoritativ API-base fra app-konfigurasjon (Vercel). Null dersom ingen er satt.
 * Brukes både for å tvinge chat mot Vercel selv lokalt og for å låse server-feltet
 * i innstillinger inntil «Overstyr (avansert)» er slått på.
 */
function configuredApiBase(): string | null {
  return apiBaseFromEnv() || apiBaseFromAppExtra();
}

function resolveDefaultServerUrl(): string {
  // Faktisk åpnet HTTPS-origin slår utdatert extra/env på Vercel/preview (unngår feil API-host).
  if (
    Platform.OS === 'web' &&
    typeof window !== 'undefined' &&
    window.location?.origin &&
    !__DEV__ &&
    window.location.protocol === 'https:'
  ) {
    const origin = normalizeApiBase(window.location.origin);
    const fromEnv = apiBaseFromEnv();
    if (fromEnv && normalizeApiBase(fromEnv) !== origin) {
      return normalizeApiBase(fromEnv);
    }
    return origin;
  }

  const fromEnv = apiBaseFromEnv();
  if (fromEnv) return fromEnv;
  const fromExtra = apiBaseFromAppExtra();
  if (fromExtra) return fromExtra;
  // Statisk web-export (f.eks. Vercel): API ligger på samme host som siden via rewrites.
  // Uten dette faller vi tilbake til localhost:8787 og får «Failed to fetch» i nettleseren.
  if (
    Platform.OS === 'web' &&
    typeof window !== 'undefined' &&
    window.location?.origin &&
    !__DEV__
  ) {
    const { protocol, hostname, port } = window.location;
    const effectivePort = port || (protocol === 'https:' ? '443' : '80');
    const loopback = hostname === 'localhost' || hostname === '127.0.0.1';
    const usePageAsApiBase =
      protocol === 'https:' ||
      !loopback ||
      effectivePort === String(SERVER_PORT);
    if (usePageAsApiBase) {
      return normalizeApiBase(window.location.origin);
    }
  }
  const hostUri =
    (Constants.expoConfig as any)?.hostUri ||
    (Constants as any)?.expoGoConfig?.debuggerHost ||
    (Constants as any)?.manifest?.debuggerHost ||
    (Constants as any)?.manifest2?.extra?.expoGo?.debuggerHost ||
    '';
  const host = typeof hostUri === 'string' ? hostUri.split(':')[0] : '';
  if (host && host !== 'localhost' && host !== '127.0.0.1') {
    return `http://${host}:${SERVER_PORT}`;
  }
  return `http://localhost:${SERVER_PORT}`;
}

type Exercise = {
  name: string;
  reps: string;
  weight: string;
};

type Session = {
  id: number;
  date: string;
  time: string;
  distance: string;
  feeling: string;
  workoutType: string;
  shoe: string;
  location: 'innendors' | 'utendors';
  weather: string;
  /** Gjennomsnittspuls (bpm), kun relevant for løping */
  averageHeartRate?: string;
  notes: string;
  exercises: Exercise[];
};

type SessionMode = '' | 'running' | 'strength';

type SessionForm = Omit<Session, 'id' | 'location'> & {
  mode: SessionMode;
  location: '' | 'innendors' | 'utendors';
};

type ToolCard = {
  kind: 'tool_card';
  title: string;
  bullets: string[];
};

type RunningProgramPayload = {
  kind: 'running_program';
  title: string;
  goalSummary: string;
  weeks: number;
  /** Hovedkonkurranse programmet bygger mot (valgfritt, fra chat eller redigering). */
  competitionName?: string;
  /** ISO YYYY-MM-DD */
  competitionDate?: string;
  sessions: Array<{
    week: number;
    dayLabel: string;
    title: string;
    description: string;
    /** Samme som manuell løpelogging; satt av server fra workout_type */
    workoutType?: string;
  }>;
};

type ChatToolResult = ToolCard | RunningProgramPayload;

type SavedProgramItem = {
  id: string;
  week: number;
  dayLabel: string;
  title: string;
  description: string;
  done: boolean;
  /** Planlagt dato (YYYY-MM-DD), valgfritt */
  date?: string;
  /** Løpeøkttype (samme verdier som manuell logging) */
  workoutType?: string;
};

type SavedRunningProgram = {
  id: string;
  title: string;
  goalSummary: string;
  weeks: number;
  /** Valgfritt: konkurranse programmet er rettet mot (vises for treneren i chat). */
  competitionName?: string;
  /** ISO YYYY-MM-DD */
  competitionDate?: string;
  createdAt: number;
  /** Sist oppdatert (redigering, lagring, avkryssing av økter osv.). */
  updatedAt?: number;
  items: SavedProgramItem[];
};

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: number;
  toolCard?: ToolCard;
  runningProgram?: RunningProgramPayload;
  /** Satt når brukeren har lagret programmet under Løpeprogram (persistert med chat). */
  runningProgramSaved?: boolean;
};

type ChatListItem =
  | { type: 'message'; id: string; message: ChatMessage }
  | { type: 'separator'; id: string; ts: number }
  | { type: 'typing'; id: string };

const feelingOptions = [
  { value: 'fantastisk', label: 'Fantastisk', emoji: '🤩' },
  { value: 'bra', label: 'Bra', emoji: '😊' },
  { value: 'ok', label: 'Ok', emoji: '🙂' },
  { value: 'tung', label: 'Tung', emoji: '😮‍💨' },
  { value: 'veldig_tung', label: 'Veldig tung', emoji: '🥵' },
] as const;

const runWorkoutTypeOptions = [
  { value: 'Rolig løpetur', label: 'Rolig løpetur', emoji: '🏃' },
  { value: 'Terkeløkt', label: 'Terkeløkt', emoji: '🔥' },
  { value: 'Intervaller', label: 'Intervaller', emoji: '⏱️' },
  { value: 'Konkurranse', label: 'Konkurranse', emoji: '🏁' },
] as const;

const runWorkoutTypeValues = runWorkoutTypeOptions.map((o) => o.value) as readonly string[];

const strengthWorkoutTypeOptions = [
  { value: 'Fullkropp', label: 'Fullkropp', emoji: '💪' },
  { value: 'Bein', label: 'Bein', emoji: '🦵' },
  { value: 'Overkropp', label: 'Overkropp', emoji: '🏋️' },
  { value: 'HIIT', label: 'HIIT', emoji: '⚡' },
  { value: 'Skadeforebyggende', label: 'Skadeforebyggende', emoji: '🩹' },
] as const;

const strengthWorkoutTypeValues = strengthWorkoutTypeOptions.map((o) => o.value) as readonly string[];

function runWorkoutTypeLabel(value: string | undefined): string {
  if (!value) return '';
  const o = runWorkoutTypeOptions.find((x) => x.value === value);
  return o?.label ?? value;
}

function isStrengthSession(session: Pick<Session, 'workoutType'>) {
  return session.workoutType === 'Styrketrening' || strengthWorkoutTypeValues.includes(session.workoutType);
}

/** Sum av km fra manuelt loggede løpeøkter (ikke styrke). */
function manualRunningDistanceKm(sessions: Session[]): number {
  return sessions.reduce((sum, s) => {
    if (isStrengthSession(s)) return sum;
    return sum + Number(s.distance || 0);
  }, 0);
}

/** Sum av minutter fra manuelt loggede løpeøkter (ikke styrke). */
function manualRunningTimeMinutes(sessions: Session[]): number {
  return sessions.reduce((sum, s) => {
    if (isStrengthSession(s)) return sum;
    const [h, m, sec] = (s.time || '').split(':').map((p) => Number(p));
    const hours = Number.isFinite(h) ? h : 0;
    const minutes = Number.isFinite(m) ? m : 0;
    const seconds = Number.isFinite(sec) ? sec : 0;
    return sum + hours * 60 + minutes + seconds / 60;
  }, 0);
}

const weatherOptions = [
  { value: 'Sol', label: 'Sol', emoji: '☀️' },
  { value: 'Skyet', label: 'Skyet', emoji: '☁️' },
  { value: 'Regn', label: 'Regn', emoji: '🌧️' },
  { value: 'Vind', label: 'Vind', emoji: '💨' },
  { value: 'Snø', label: 'Snø', emoji: '❄️' },
] as const;

const shoeOptions = [
  'Saucony Endorphin Azura',
  'Nike Vaporfly',
  'Saucony Guide 17',
  'Nike Zegama trail',
  'On Cloudboom Strike',
  'Nike Zoom Fly 6',
  'Saucony Endorphin Trainer',
  'Nike Vomero Plus',
] as const;

const motivationalQuotes = [
  'Små steg hver dag gir store resultater.',
  'Du angrer aldri på en gjennomført økt.',
  'Konsistens slår motivasjon.',
  'Det handler ikke om å være best, men å bli bedre.',
  'En økt nærmere målet ditt.',
  'Det er ingen snarveier til steder verdt å dra.',
  'Den eneste dårlige økten er den som ikke ble gjennomført.',
  'Disiplin er broen mellom mål og resultat.',
  'Sterk i dag, sterkere i morgen.',
  'Beina vil bære deg lenger enn hodet tror.',
  'Pust inn styrke, pust ut tvil.',
  'Hvile er en del av treningen, ikke en pause fra den.',
  'Du blir det du gjør gjentatte ganger.',
  'Treningen kan ikke kjøpes – bare fortjenes.',
  'Hver kilometer teller, også de tunge.',

  'The miracle isn\'t that I finished. The miracle is that I had the courage to start. — John Bingham',
  'Pain is temporary. Quitting lasts forever. — Lance Armstrong',
  'Run when you can, walk if you have to, crawl if you must — just never give up. — Dean Karnazes',
  'It\'s supposed to be hard. If it wasn\'t, everyone would do it. — Jimmy Dugan',
  'The body achieves what the mind believes.',
  'Don\'t limit your challenges. Challenge your limits.',
  'The only bad workout is the one that didn\'t happen.',
  'Strength does not come from winning. Your struggles develop your strengths. — Arnold Schwarzenegger',
  'A river cuts through rock not because of its power, but because of its persistence.',
  'You are stronger than you think.',
  'Discipline is choosing between what you want now and what you want most.',
  'Comfort is the enemy of progress.',
  'Train hard, rest harder.',
  'Slow progress is still progress.',
  'Sweat is just fat crying.',
] as const;

function sessionToForm(session: Session): SessionForm {
  const isStrength = isStrengthSession(session);
  return {
    date: session.date,
    time: session.time,
    distance: session.distance,
    feeling: session.feeling,
    mode: isStrength ? 'strength' : 'running',
    workoutType: session.workoutType,
    shoe: session.shoe,
    location: session.location,
    weather: session.weather,
    averageHeartRate: session.averageHeartRate ?? '',
    notes: session.notes,
    exercises: session.exercises ?? [],
  };
}

function createDefaultForm(): SessionForm {
  return {
    date: new Date().toISOString().slice(0, 10),
    time: '',
    distance: '',
    feeling: '',
    mode: '',
    workoutType: '',
    shoe: '',
    location: '',
    weather: '',
    averageHeartRate: '',
    notes: '',
    exercises: [],
  };
}

function calculateTotals(sessions: Session[]) {
  const totalDistance = sessions.reduce((sum, session) => sum + Number(session.distance || 0), 0);
  return { count: sessions.length, distance: totalDistance.toFixed(1) };
}

/**
 * Bygger en kort, leselig beskrivelse av en manuelt loggført økt som sendes
 * til treneren (LLM) for å generere tilbakemelding.
 */
function describeSessionForCoach(session: Session): string {
  const isStrength = isStrengthSession(session);
  const parts: string[] = [];
  parts.push(`Type: ${session.workoutType || (isStrength ? 'styrke' : 'løping')}`);
  if (session.date) parts.push(`Dato: ${session.date}`);
  if (session.time) parts.push(`Varighet: ${session.time}`);
  if (!isStrength && session.distance) parts.push(`Distanse: ${session.distance} km`);
  if (!isStrength && session.averageHeartRate) parts.push(`Snittpuls: ${session.averageHeartRate} bpm`);
  if (!isStrength && session.location) {
    parts.push(`Sted: ${session.location === 'innendors' ? 'innendørs' : 'utendørs'}`);
  }
  if (!isStrength && session.weather) parts.push(`Vær: ${session.weather}`);
  if (!isStrength && session.shoe) parts.push(`Sko: ${session.shoe}`);
  if (session.feeling) parts.push(`Følelse: ${session.feeling}`);
  if (session.notes?.trim()) parts.push(`Notater: ${session.notes.trim()}`);
  if (isStrength && session.exercises?.length) {
    const ex = session.exercises
      .filter((e) => (e.name || '').trim())
      .map((e) => {
        const reps = (e.reps || '').trim();
        const weight = (e.weight || '').trim();
        const meta = [reps, weight ? `${weight} kg` : ''].filter(Boolean).join(' × ');
        return meta ? `${e.name} (${meta})` : e.name;
      })
      .join('; ');
    if (ex) parts.push(`Øvelser: ${ex}`);
  }
  return parts.join('\n');
}

/**
 * Kort en-linje-oppsummering av en økt – brukes til å bygge historikk-tekst.
 */
function describeSessionShortLine(s: Session): string {
  const isStrength = isStrengthSession(s);
  const bits: string[] = [s.date];
  if (s.workoutType) bits.push(s.workoutType);
  if (!isStrength && s.distance) bits.push(`${s.distance} km`);
  if (s.time) bits.push(s.time);
  if (!isStrength && s.averageHeartRate) bits.push(`${s.averageHeartRate} bpm`);
  if (s.feeling) bits.push(`følelse: ${s.feeling}`);
  return bits.filter(Boolean).join(' · ');
}

function sessionSortTimestamp(s: { date?: string; time?: string }): number {
  const date = s.date || '1970-01-01';
  const time = s.time && /^\d{2}:\d{2}/.test(s.time) ? s.time.slice(0, 5) : '00:00';
  const t = Date.parse(`${date}T${time}:00`);
  return Number.isFinite(t) ? t : 0;
}

/** Bygger en kort historikkblokk (siste N økter, nyeste først). */
function buildSessionHistoryText(sessions: Session[], excludeId?: number, max = 8): string {
  const sorted = [...sessions]
    .filter((s) => excludeId == null || s.id !== excludeId)
    .sort((a, b) => sessionSortTimestamp(b) - sessionSortTimestamp(a));
  const top = sorted.slice(0, max);
  if (top.length === 0) return '';
  return top.map((s) => `• ${describeSessionShortLine(s)}`).join('\n');
}

function Card({
  title,
  headerRight,
  children,
  style,
}: {
  title?: string;
  headerRight?: React.ReactNode;
  children: React.ReactNode;
  style?: ViewStyle;
}) {
  return (
    <View style={[styles.card, style]}>
      {title || headerRight ? (
        <View style={styles.cardHeader}>
          {title ? <Text style={styles.cardHeaderTitle}>{title}</Text> : <View style={{ flex: 1 }} />}
          {headerRight ? <View style={styles.cardHeaderAction}>{headerRight}</View> : null}
        </View>
      ) : null}
      {children}
    </View>
  );
}

function Chip({
  label,
  active,
  onPress,
  style,
}: {
  label: string;
  active?: boolean;
  onPress?: () => void;
  style?: ViewStyle;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        active ? styles.chipActive : styles.chipInactive,
        pressed && { opacity: 0.75, transform: [{ scale: 0.97 }] },
        style,
      ]}
    >
      <Text style={[styles.chipText, active ? styles.chipTextActive : styles.chipTextInactive]}>{label}</Text>
    </Pressable>
  );
}

function PrimaryButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.pinkButtonFull, pressed && { opacity: 0.8, transform: [{ scale: 0.98 }] }]}
    >
      <Text style={styles.pinkButtonText}>{label}</Text>
    </Pressable>
  );
}

type StravaActivity = {
  id: number;
  name: string;
  type: string;
  startDate: string;
  distanceKm: number;
  movingMinutes: number;
  elevationMeters: number;
  averageHeartrate: number | null;
  maxHeartrate: number | null;
  averagePaceSecPerKm: number | null;
};

type StravaRecent = {
  days: number;
  totals: {
    count: number;
    distanceKm: number;
    movingMinutes: number;
    elevationMeters: number;
  };
  activities: StravaActivity[];
  fetchedAt?: number;
};

function formatPaceLabel(secPerKm: number | null): string {
  if (!secPerKm || !Number.isFinite(secPerKm)) return '–';
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60).toString().padStart(2, '0');
  return `${m}:${s}/km`;
}

function formatDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '0 min';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h} t ${m} min` : `${m} min`;
}

/**
 * Bygger en kort, leselig beskrivelse av en Strava-aktivitet som sendes
 * til treneren (LLM) for å generere tilbakemelding.
 */
function describeStravaActivityForCoach(a: StravaActivity): string {
  const parts: string[] = [];
  parts.push(`Type: ${a.type} (importert fra Strava)`);
  if (a.name) parts.push(`Navn: ${a.name}`);
  if (a.startDate) parts.push(`Dato: ${a.startDate.slice(0, 10)}`);
  if (a.distanceKm) parts.push(`Distanse: ${a.distanceKm.toFixed(2)} km`);
  if (a.movingMinutes) parts.push(`Varighet: ${formatDuration(a.movingMinutes)}`);
  if (a.averagePaceSecPerKm) parts.push(`Tempo: ${formatPaceLabel(a.averagePaceSecPerKm)}`);
  if (a.averageHeartrate) parts.push(`Snittpuls: ${Math.round(a.averageHeartrate)} bpm`);
  if (a.maxHeartrate) parts.push(`Makspuls: ${Math.round(a.maxHeartrate)} bpm`);
  if (a.elevationMeters) parts.push(`Stigning: ${a.elevationMeters} m`);
  return parts.join('\n');
}

/** Kort en-linje-oppsummering av en Strava-aktivitet, brukt i historikk. */
function describeStravaActivityShortLine(a: StravaActivity): string {
  const date = a.startDate ? a.startDate.slice(0, 10) : '';
  const bits: string[] = [date, `${a.type} (Strava)`];
  if (a.distanceKm) bits.push(`${a.distanceKm.toFixed(2)} km`);
  if (a.movingMinutes) bits.push(`${a.movingMinutes} min`);
  if (a.averagePaceSecPerKm) bits.push(formatPaceLabel(a.averagePaceSecPerKm));
  if (a.averageHeartrate) bits.push(`${Math.round(a.averageHeartrate)} bpm`);
  return bits.filter(Boolean).join(' · ');
}

async function getServerUrl(): Promise<string> {
  const configured = configuredApiBase();

  // Lagret "overstyring (avansert)" er eneste måte å peke mot lokal backend
  // når app-konfig har en autoritativ Vercel-URL. Uten flagget bruker vi alltid
  // Vercel-URL-en, også lokalt – slik at chat + Strava-state er konsistent.
  try {
    const raw = await AsyncStorage.getItem(CHAT_CONFIG_KEY);
    if (raw) {
      const cfg = JSON.parse(raw) as { serverUrl?: string; overrideEnabled?: boolean };
      if (cfg?.overrideEnabled && cfg?.serverUrl) {
        if (isLikelyBundlerOrStaticDevUrl(cfg.serverUrl)) {
          return configured || resolveDefaultServerUrl();
        }
        return coerceChatServerUrl(cfg.serverUrl);
      }
    }
  } catch {
    // ignore
  }

  if (configured) return configured;
  return resolveDefaultServerUrl();
}

const STRAVA_SEEN_IDS_KEY = 'training-log-ios:strava-seen-ids:v1';

function StravaCard({
  refreshSignal = 0,
  onNewActivity,
}: {
  refreshSignal?: number;
  onNewActivity?: (activity: StravaActivity) => void;
}) {
  const { user } = useAuth();
  const stravaAthleteId = user?.stravaAthleteId;
  const userId = useUserId();
  const stravaCacheKey = userKey(STRAVA_CACHE_KEY, userId);
  const stravaConnectedKey = userKey(STRAVA_CONNECTED_KEY, userId);
  const stravaSeenIdsKey = userKey(STRAVA_SEEN_IDS_KEY, userId);
  const [data, setData] = useState<StravaRecent | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [selectedActivity, setSelectedActivity] = useState<StravaActivity | null>(null);
  // Strava-kortet er kollapset som default — viser bare stats + siste økt.
  // Trykk på «Vis flere» nederst for å se de øvrige aktivitetene.
  const [expanded, setExpanded] = useState(false);
  const onNewActivityRef = useRef(onNewActivity);
  useEffect(() => {
    onNewActivityRef.current = onNewActivity;
  }, [onNewActivity]);

  useEffect(() => {
    (async () => {
      try {
        const [raw, rawConnected] = await Promise.all([
          AsyncStorage.getItem(stravaCacheKey),
          AsyncStorage.getItem(stravaConnectedKey),
        ]);
        if (raw) setData(JSON.parse(raw) as StravaRecent);
        setIsConnected(rawConnected === '1');
      } catch {
        // ignore
      }
    })();
  }, [stravaCacheKey, stravaConnectedKey]);

  /**
   * Sammenlign de hentede aktivitetene mot tidligere "sett"-IDer (i AsyncStorage).
   * Nye aktiviteter (som ikke er i listen) trigger trener-tilbakemelding.
   * Første gang vi har data (ingen sett-IDer enda) trigger vi IKKE — vi vil ikke
   * spamme chatten med kommentar på all gammel historikk.
   */
  const reportNewActivities = useCallback(async (activities: StravaActivity[]) => {
    if (!Array.isArray(activities) || activities.length === 0) return;
    let seen: Set<string> = new Set();
    let isFirstTime = false;
    try {
      const raw = await AsyncStorage.getItem(stravaSeenIdsKey);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
          seen = new Set(parsed.map((x) => String(x)));
        } else {
          isFirstTime = true;
        }
      } else {
        isFirstTime = true;
      }
    } catch {
      isFirstTime = true;
    }

    const currentIds = activities.map((a) => String(a.id));
    if (isFirstTime) {
      // Bare lagre det vi ser nå – ikke kommenter eldre økter på første sync.
      await AsyncStorage.setItem(stravaSeenIdsKey, JSON.stringify(currentIds)).catch(
        () => undefined,
      );
      return;
    }

    const newOnes = activities.filter((a) => !seen.has(String(a.id)));
    if (newOnes.length > 0 && onNewActivityRef.current) {
      // Sorter nyeste først, og kall callback for hver. For å ikke spamme:
      // bare den nyeste får trener-kommentar.
      const sorted = [...newOnes].sort(
        (a, b) => new Date(b.startDate).getTime() - new Date(a.startDate).getTime(),
      );
      onNewActivityRef.current(sorted[0]);
    }

    // Behold sett-listen avgrenset: union av forrige + nye, kuttet til rimelig størrelse.
    const merged = new Set<string>([...currentIds, ...Array.from(seen)]);
    const trimmed = Array.from(merged).slice(0, 500);
    await AsyncStorage.setItem(stravaSeenIdsKey, JSON.stringify(trimmed)).catch(
      () => undefined,
    );
  }, [stravaSeenIdsKey]);

  const refresh = useCallback(async (opts?: { quiet?: boolean }) => {
    setIsLoading(true);
    setError(null);
    setNeedsAuth(false);
    try {
      const resp = await apiFetch('/strava/recent?days=14', { ignoreAuthFailure: true });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const msg = String((body as any)?.error || `HTTP ${resp.status}`);
        if (msg.includes('401') || /authoriz/i.test(msg) || /missing/i.test(msg) || /STRAVA_NOT_CONNECTED/.test(msg)) {
          setNeedsAuth(true);
        }
        throw new Error(msg);
      }
      const fresh: StravaRecent = { ...(body as StravaRecent), fetchedAt: Date.now() };
      setData(fresh);
      await AsyncStorage.setItem(stravaCacheKey, JSON.stringify(fresh));
      setIsConnected(true);
      await AsyncStorage.setItem(stravaConnectedKey, '1');
      if (!opts?.quiet) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      // Detekter nye aktiviteter etter en vellykket sync.
      void reportNewActivities(fresh.activities || []);
    } catch (e: any) {
      if (!opts?.quiet) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
      setError(String(e?.message || e));
    } finally {
      setIsLoading(false);
    }
  }, [reportNewActivities, stravaCacheKey, stravaConnectedKey]);

  useEffect(() => {
    if (!stravaAthleteId) return;
    void refresh({ quiet: true });
  }, [stravaAthleteId, refresh]);

  useEffect(() => {
    if (refreshSignal <= 0) return;
    void refresh();
  }, [refreshSignal, refresh]);

  const t = data?.totals;
  const updatedLabel = data?.fetchedAt
    ? `Sist oppdatert ${new Date(data.fetchedAt).toLocaleTimeString('nb-NO', {
        hour: '2-digit',
        minute: '2-digit',
      })}`
    : 'Ikke synket ennå';

  const headerRefresh = (
    <Pressable
      onPress={() => {
        void Haptics.selectionAsync();
        void refresh();
      }}
      style={({ pressed }) => [
        styles.cardIconButton,
        pressed && { opacity: 0.6 },
        isLoading && { opacity: 0.6 },
      ]}
      disabled={isLoading}
      accessibilityLabel={data ? 'Synk på nytt' : 'Hent fra Strava'}
      accessibilityRole="button"
      hitSlop={8}
    >
      {isLoading ? (
        <ActivityIndicator size="small" color="#7A3C4A" />
      ) : (
        <Text style={styles.cardIconButtonText}>↻</Text>
      )}
    </Pressable>
  );

  return (
    <Card title="Strava" headerRight={headerRefresh}>
      <View style={{ gap: 10 }}>
        <Text style={styles.muted}>{updatedLabel}</Text>

        {data && t ? (
          <View style={styles.metricsRow}>
            <View style={styles.metricTile}>
              <Text style={styles.metricLabel}>Økter (14d)</Text>
              <Text style={styles.metricValue}>{t.count}</Text>
            </View>
            <View style={styles.metricTile}>
              <Text style={styles.metricLabel}>Distanse</Text>
              <Text style={styles.metricValue}>{t.distanceKm.toFixed(1)} km</Text>
            </View>
            <View style={styles.metricTile}>
              <Text style={styles.metricLabel}>Stigning</Text>
              <Text style={styles.metricValue}>{t.elevationMeters} m</Text>
            </View>
          </View>
        ) : null}

        {error ? (
          <View style={styles.stravaErrorBox}>
            <Text style={styles.stravaErrorText}>
              {isRateLimitError(error)
                ? 'Strava begrenser antall forespørsler. Vent ~15 min før du prøver igjen.'
                : error}
            </Text>
            {needsAuth ? (
              <Text style={[styles.muted, { marginTop: 6 }]}>
                Strava sier at tokenet ikke får lese økter. Vanlige årsaker: (1) Du fjernet kryss for aktiviteter da du godkjente appen på Strava — da må du koble til på nytt og la alle tilganger stå på. (2) Gamle nøkler i{' '}
                <Text style={{ fontWeight: '800' }}>backend/.env</Text> (STRAVA_ACCESS_TOKEN) uten aktivitet-tilgang — fjern dem og bruk «Koble til Strava» i appen. (3) På{' '}
                <Text style={{ fontWeight: '800' }}>strava.com → Innstillinger → Mine apper</Text> kan du fjerne appen og deretter gå til <Text style={{ fontWeight: '800' }}>Innstillinger → Strava</Text> her og koble til igjen.
              </Text>
            ) : null}
          </View>
        ) : null}

        {data?.activities?.length ? (() => {
          const sorted = [...data.activities].sort(
            (a, b) => new Date(b.startDate).getTime() - new Date(a.startDate).getTime(),
          );
          const visible = expanded ? sorted.slice(0, 6) : sorted.slice(0, 1);
          const hiddenCount = Math.min(sorted.length, 6) - visible.length;
          return (
            <View style={{ gap: 6 }}>
              {visible.map((a) => (
                <Pressable
                  key={a.id}
                  style={({ pressed }) => [styles.listRow, pressed && { opacity: 0.6 }]}
                  onPress={() => {
                    void Haptics.selectionAsync();
                    setSelectedActivity(a);
                  }}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.listRowTitle} numberOfLines={1}>
                      {a.name || a.type}
                    </Text>
                    <Text style={styles.muted}>
                      {formatNorwegianDate(a.startDate?.slice(0, 10) || '')} · {a.type} · {formatDuration(a.movingMinutes)}
                      {a.averageHeartrate ? ` · ${Math.round(a.averageHeartrate)} bpm` : ''}
                    </Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={styles.listRowValue}>{a.distanceKm.toFixed(2)} km</Text>
                    <Text style={styles.muted}>{formatPaceLabel(a.averagePaceSecPerKm)}</Text>
                  </View>
                  <Text style={styles.listRowChevron}>›</Text>
                </Pressable>
              ))}
              {sorted.length > 1 ? (
                <Pressable
                  onPress={() => {
                    void Haptics.selectionAsync();
                    setExpanded((v) => !v);
                  }}
                  style={({ pressed }) => [styles.stravaExpandToggle, pressed && { opacity: 0.6 }]}
                  accessibilityRole="button"
                  accessibilityLabel={expanded ? 'Skjul eldre Strava-økter' : 'Vis flere Strava-økter'}
                >
                  <Text style={styles.stravaExpandToggleText}>
                    {expanded
                      ? 'Skjul eldre økter ▴'
                      : `Vis flere økter${hiddenCount > 0 ? ` (+${hiddenCount})` : ''} ▾`}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          );
        })() : !isLoading && !error ? (
          <Text style={styles.muted}>
            Trykk ↻ øverst til høyre for å laste de siste 14 dagene.
            {isConnected ? '' : ' Første gang: gå til Innstillinger → Strava og koble til.'}
          </Text>
        ) : null}
      </View>
      <StravaActivityDetailModal
        activity={selectedActivity}
        onClose={() => setSelectedActivity(null)}
      />
    </Card>
  );
}

type StravaStreamSet = {
  heartrate?: { data: number[] };
  velocity_smooth?: { data: number[] };
  distance?: { data: number[] };
  time?: { data: number[] };
  altitude?: { data: number[] };
  cadence?: { data: number[] };
};

function downsample<T>(arr: T[], target: number): T[] {
  if (arr.length <= target) return arr;
  const step = arr.length / target;
  const out: T[] = [];
  for (let i = 0; i < target; i++) {
    out.push(arr[Math.min(arr.length - 1, Math.floor(i * step))]);
  }
  return out;
}

function smooth(values: number[], window: number): number[] {
  if (window <= 1 || values.length === 0) return values;
  const half = Math.floor(window / 2);
  const out: number[] = new Array(values.length).fill(0);
  for (let i = 0; i < values.length; i++) {
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(values.length - 1, i + half); j++) {
      sum += values[j];
      count += 1;
    }
    out[i] = count > 0 ? sum / count : values[i];
  }
  return out;
}

type LineChartProps = {
  values: number[];
  width: number;
  height: number;
  stroke: string;
  fillColor?: string;
  fillOpacity?: number;
  yInverted?: boolean;
  yTicks?: { value: number; label: string }[];
  yLabelFormatter?: (v: number) => string;
  xLabels?: { at: number; text: string }[];
  minOverride?: number;
  maxOverride?: number;
};

function LineChart({
  values,
  width,
  height,
  stroke,
  fillColor,
  fillOpacity = 0.35,
  yInverted = false,
  yTicks,
  yLabelFormatter,
  xLabels,
  minOverride,
  maxOverride,
}: LineChartProps) {
  if (!values || values.length < 2) {
    return (
      <View style={{ width, height, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={styles.muted}>Ikke nok data</Text>
      </View>
    );
  }
  const padL = 36;
  const padR = 10;
  const padT = 8;
  const padB = 20;
  const chartW = width - padL - padR;
  const chartH = height - padT - padB;
  const finiteVals = values.filter((v) => Number.isFinite(v));
  const dataMin = finiteVals.length ? Math.min(...finiteVals) : 0;
  const dataMax = finiteVals.length ? Math.max(...finiteVals) : 1;
  const min = minOverride ?? dataMin;
  const max = maxOverride ?? dataMax;
  const range = max - min || 1;

  const n = values.length;
  const coords = values.map((v, i) => {
    const x = padL + (i / (n - 1)) * chartW;
    const norm = (v - min) / range;
    const y = yInverted ? padT + norm * chartH : padT + chartH - norm * chartH;
    return { x, y };
  });
  const points = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
  // For fylt areal-graf: tegn fra første punkt langs linja, deretter ned til
  // baseline (bunnen for vanlig kurve, toppen for yInverted) og tilbake.
  const baselineY = yInverted ? padT + chartH : padT + chartH;
  const areaPoints = fillColor
    ? `${padL.toFixed(1)},${baselineY.toFixed(1)} ${points} ${(padL + chartW).toFixed(1)},${baselineY.toFixed(1)}`
    : '';

  const ticks = yTicks ?? [
    { value: min, label: yLabelFormatter ? yLabelFormatter(min) : String(Math.round(min)) },
    {
      value: (min + max) / 2,
      label: yLabelFormatter ? yLabelFormatter((min + max) / 2) : String(Math.round((min + max) / 2)),
    },
    { value: max, label: yLabelFormatter ? yLabelFormatter(max) : String(Math.round(max)) },
  ];

  return (
    <Svg width={width} height={height}>
      {ticks.map((t, idx) => {
        const norm = (t.value - min) / range;
        const y = yInverted ? padT + norm * chartH : padT + chartH - norm * chartH;
        return (
          <React.Fragment key={`yt-${idx}`}>
            <SvgLine
              x1={padL}
              x2={padL + chartW}
              y1={y}
              y2={y}
              stroke="#e2e8f0"
              strokeWidth={1}
            />
            <SvgText x={padL - 6} y={y + 4} fontSize={10} fill="#64748b" textAnchor="end">
              {t.label}
            </SvgText>
          </React.Fragment>
        );
      })}
      {fillColor ? (
        <SvgPolygon points={areaPoints} fill={fillColor} fillOpacity={fillOpacity} stroke="none" />
      ) : null}
      <Polyline
        points={points}
        stroke={stroke}
        strokeWidth={2}
        fill="none"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {xLabels?.map((xl, idx) => {
        const x = padL + xl.at * chartW;
        // Forankre ytterste etiketter mot kanten så de ikke stikker utenfor
        // diagrammet (f.eks. "6.4 km" til høyre).
        const anchor: 'start' | 'middle' | 'end' =
          xl.at <= 0.01 ? 'start' : xl.at >= 0.99 ? 'end' : 'middle';
        return (
          <SvgText
            key={`xl-${idx}`}
            x={x}
            y={height - 4}
            fontSize={10}
            fill="#64748b"
            textAnchor={anchor}
          >
            {xl.text}
          </SvgText>
        );
      })}
    </Svg>
  );
}

function StravaActivityDetailModal({
  activity,
  onClose,
}: {
  activity: StravaActivity | null;
  onClose: () => void;
}) {
  const [streams, setStreams] = useState<StravaStreamSet | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chartWidth, setChartWidth] = useState<number>(320);

  useEffect(() => {
    if (!activity) {
      setStreams(null);
      setError(null);
      return;
    }
    let cancelled = false;
    (async () => {
      setIsLoading(true);
      setError(null);
      setStreams(null);
      try {
        const resp = await apiFetch(
          `/strava/activity/${activity.id}/streams?keys=heartrate,velocity_smooth,distance,time`,
          { ignoreAuthFailure: true },
        );
        const body = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          throw new Error(String((body as any)?.error || `HTTP ${resp.status}`));
        }
        if (!cancelled) setStreams(body as StravaStreamSet);
      } catch (e: any) {
        if (!cancelled) setError(String(e?.message || e));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activity]);

  const processed = useMemo(() => {
    if (!streams) return null;
    const distance = streams.distance?.data ?? [];
    const hr = streams.heartrate?.data ?? [];
    const vel = streams.velocity_smooth?.data ?? [];
    const time = streams.time?.data ?? [];

    const target = 200;
    const hrSampled = hr.length ? downsample(smooth(hr, 5), target) : [];

    // Hastighet → pace (sek/km). Stopp/pauser (v ~ 0) settes til 900 sek/km
    // (15:00/km) slik at de vises som dypp helt nederst – à la Strava.
    const PACE_FLOOR = 900;
    const paceRaw = vel.map((v) => (v && v > 0.2 ? Math.min(1000 / v, PACE_FLOOR) : PACE_FLOOR));
    const paceSmoothed = smooth(paceRaw, 9);
    const paceSampled = paceSmoothed.length ? downsample(paceSmoothed, target) : [];

    // Reelle løpetempo (filtrer pause-flatlinje på 900) for å bestemme
    // hvor raskt y-aksen skal starte øverst.
    const running = paceSampled.filter((p) => Number.isFinite(p) && p < PACE_FLOOR - 1);

    let paceMin = 0;
    let paceMax = 0;
    if (running.length) {
      const fastest = Math.min(...running);
      const slowest = Math.max(...paceSampled.filter((p) => Number.isFinite(p)));
      // Rund nedover til nærmeste hele/halve minutt for et pent toppunkt,
      // og oppover for bunnpunktet. Bunnpunktet kan gå helt til 15:00/km
      // hvis aktiviteten har stopp.
      paceMin = Math.max(60, Math.floor(fastest / 30) * 30);
      paceMax = Math.min(PACE_FLOOR, Math.ceil(slowest / 60) * 60);
      if (paceMax - paceMin < 60) paceMax = paceMin + 60;
    }

    const distanceKmTotal = distance.length ? distance[distance.length - 1] / 1000 : 0;
    const durationMin = time.length ? time[time.length - 1] / 60 : 0;

    return {
      hr: hrSampled,
      pace: paceSampled,
      paceMin,
      paceMax,
      distanceKmTotal,
      durationMin,
      hasHr: hrSampled.some((v) => Number.isFinite(v) && v > 0),
      hasPace: running.length > 0,
    };
  }, [streams]);

  const chartHeight = 180;

  const paceTicks = useMemo(() => {
    if (!processed?.hasPace) return undefined;
    const { paceMin, paceMax } = processed;
    if (!paceMin || !paceMax || paceMax <= paceMin) return undefined;
    // Strava-stil: hele/halve minutter på y-aksen. Steg velges etter spenn
    // for å holde antall ticks rundt 4–6.
    const span = paceMax - paceMin;
    const step =
      span <= 90 ? 30 : span <= 180 ? 60 : span <= 300 ? 60 : span <= 600 ? 120 : 180;
    const start = Math.ceil(paceMin / step) * step;
    const end = Math.floor(paceMax / step) * step;
    const ticks: { value: number; label: string }[] = [];
    for (let v = start; v <= end; v += step) {
      // Vis bare "m:ss" på y-aksen (suffikset /km står som egen rad under).
      const m = Math.floor(v / 60);
      const s = Math.round(v % 60).toString().padStart(2, '0');
      ticks.push({ value: v, label: `${m}:${s}` });
    }
    if (ticks.length < 2) {
      const m1 = Math.floor(paceMin / 60);
      const s1 = Math.round(paceMin % 60).toString().padStart(2, '0');
      const m2 = Math.floor(paceMax / 60);
      const s2 = Math.round(paceMax % 60).toString().padStart(2, '0');
      return [
        { value: paceMin, label: `${m1}:${s1}` },
        { value: paceMax, label: `${m2}:${s2}` },
      ];
    }
    return ticks;
  }, [processed]);

  return (
    <Modal
      visible={!!activity}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView style={styles.modalSafe}>
        <View style={styles.programFormModalHeader}>
          <Text style={styles.programFormModalTitle} numberOfLines={1}>
            {activity?.name || activity?.type || 'Strava-aktivitet'}
          </Text>
          <Pressable onPress={onClose} style={styles.programFormModalClose}>
            <Text style={styles.programFormModalCloseText}>Lukk</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }}>
          {activity ? (
            <View style={styles.activityDetailMetaCard}>
              <Text style={styles.muted}>
                {formatNorwegianDate(activity.startDate?.slice(0, 10) || '')} · {activity.type}
              </Text>
              <View style={styles.metricsRow}>
                <View style={styles.metricTile}>
                  <Text style={styles.metricLabel}>Distanse</Text>
                  <Text style={styles.metricValue}>{activity.distanceKm.toFixed(2)} km</Text>
                </View>
                <View style={styles.metricTile}>
                  <Text style={styles.metricLabel}>Tid</Text>
                  <Text style={styles.metricValue}>{formatDuration(activity.movingMinutes)}</Text>
                </View>
                <View style={styles.metricTile}>
                  <Text style={styles.metricLabel}>Snittpuls</Text>
                  <Text style={styles.metricValue}>
                    {activity.averageHeartrate ? `${Math.round(activity.averageHeartrate)}` : '–'}
                  </Text>
                </View>
              </View>
            </View>
          ) : null}

          {isLoading ? (
            <View style={{ paddingVertical: 24, alignItems: 'center' }}>
              <ActivityIndicator />
              <Text style={[styles.muted, { marginTop: 8 }]}>Henter detaljer fra Strava…</Text>
            </View>
          ) : null}

          {error ? (
            <View style={styles.stravaErrorBox}>
              <Text style={styles.stravaErrorText}>Kunne ikke hente detaljer: {error}</Text>
            </View>
          ) : null}

          {processed && !isLoading ? (
            <View
              style={{ gap: 16 }}
              onLayout={(e) => setChartWidth(e.nativeEvent.layout.width)}
            >
              <View style={styles.chartCard}>
                <View style={styles.chartHeaderRow}>
                  <Text style={styles.chartTitle}>Puls</Text>
                  <Text style={styles.chartUnit}>bpm</Text>
                </View>
                {processed.hasHr ? (
                  <LineChart
                    values={processed.hr}
                    width={chartWidth - 24}
                    height={chartHeight}
                    stroke="#e11d48"
                    fillColor="#f43f5e"
                    fillOpacity={0.3}
                    xLabels={[
                      { at: 0, text: '0 km' },
                      { at: 1, text: `${processed.distanceKmTotal.toFixed(1)} km` },
                    ]}
                  />
                ) : (
                  <Text style={styles.muted}>Ingen pulsdata på denne økten.</Text>
                )}
              </View>

              <View style={styles.chartCard}>
                <View style={styles.chartHeaderRow}>
                  <Text style={styles.chartTitle}>Tempo</Text>
                  <Text style={styles.chartUnit}>/km</Text>
                </View>
                {processed.hasPace ? (
                  <LineChart
                    values={processed.pace}
                    width={chartWidth - 24}
                    height={chartHeight}
                    stroke="#1d4ed8"
                    fillColor="#3b82f6"
                    fillOpacity={0.35}
                    yInverted
                    yTicks={paceTicks}
                    minOverride={processed.paceMin || undefined}
                    maxOverride={processed.paceMax || undefined}
                    xLabels={[
                      { at: 0, text: '0 km' },
                      { at: 1, text: `${processed.distanceKmTotal.toFixed(1)} km` },
                    ]}
                  />
                ) : (
                  <Text style={styles.muted}>Ingen tempodata på denne økten.</Text>
                )}
              </View>
            </View>
          ) : null}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const NORWEGIAN_MONTHS = [
  'Januar',
  'Februar',
  'Mars',
  'April',
  'Mai',
  'Juni',
  'Juli',
  'August',
  'September',
  'Oktober',
  'November',
  'Desember',
] as const;

type SessionMonthGroup = {
  key: string;
  label: string;
  sessions: Session[];
};

function groupSessionsByMonth(sessions: Session[]): SessionMonthGroup[] {
  const groups = new Map<string, SessionMonthGroup>();
  for (const session of sessions) {
    const parts = (session.date || '').split('-');
    if (parts.length < 2) continue;
    const year = Number(parts[0]);
    const month = Number(parts[1]);
    if (!year || !month || month < 1 || month > 12) continue;
    const key = `${parts[0]}-${parts[1]}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        label: `${NORWEGIAN_MONTHS[month - 1]} ${year}`,
        sessions: [],
      };
      groups.set(key, group);
    }
    group.sessions.push(session);
  }
  const sortedGroups = Array.from(groups.values()).sort((a, b) => (a.key < b.key ? 1 : -1));
  for (const group of sortedGroups) {
    group.sessions.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
  }
  return sortedGroups;
}

function LogTab({
  sessions,
  onOpenLog,
  onEdit,
  onRemove,
  refreshSignal = 0,
  onNewStravaActivity,
}: {
  sessions: Session[];
  onOpenLog: () => void;
  onEdit: (session: Session) => void;
  onRemove: (id: number) => void;
  refreshSignal?: number;
  onNewStravaActivity?: (activity: StravaActivity) => void;
}) {
  const [expandedById, setExpandedById] = useState<Record<number, boolean>>({});
  const [openMonths, setOpenMonths] = useState<Record<string, boolean>>({});

  const monthGroups = useMemo(() => groupSessionsByMonth(sessions), [sessions]);

  function isMonthOpen(key: string) {
    return !!openMonths[key];
  }

  function toggleMonth(key: string) {
    void Haptics.selectionAsync();
    setOpenMonths((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  function toggleExpanded(id: number) {
    void Haptics.selectionAsync();
    setExpandedById((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  return (
    <View style={{ gap: 12 }}>
      <PrimaryButton label="Loggfør økt" onPress={onOpenLog} />

      <StravaCard refreshSignal={refreshSignal} onNewActivity={onNewStravaActivity} />

      <Card title="Manuelt loggførte økter">
        {sessions.length === 0 ? (
          <Text style={styles.muted}>Ingen økter ennå.</Text>
        ) : (
          <View style={{ gap: 4 }}>
            {monthGroups.map((group) => {
              const open = isMonthOpen(group.key);
              return (
                <View key={group.key} style={styles.monthGroup}>
                  <Pressable
                    onPress={() => toggleMonth(group.key)}
                    style={({ pressed }) => [
                      styles.monthGroupHeader,
                      pressed && { opacity: 0.6 },
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel={`${group.label}, ${group.sessions.length} økter, ${open ? 'skjul' : 'vis'}`}
                  >
                    <Text style={styles.monthGroupTitle}>{group.label}</Text>
                    <View style={styles.monthGroupMeta}>
                      <Text style={styles.monthGroupCount}>
                        {group.sessions.length} {group.sessions.length === 1 ? 'økt' : 'økter'}
                      </Text>
                      <Text style={styles.monthGroupChevron}>{open ? '▾' : '▸'}</Text>
                    </View>
                  </Pressable>

                  {open ? (
                    <View style={styles.monthGroupBody}>
                      {group.sessions.map((session) => {
                        const expanded = !!expandedById[session.id];
                        return (
                          <SwipeToDelete key={session.id} onDelete={() => onRemove(session.id)}>
                            <ExpandableManualSessionCard
                              session={session}
                              expanded={expanded}
                              onToggleExpand={() => toggleExpanded(session.id)}
                              onEdit={onEdit}
                            />
                          </SwipeToDelete>
                        );
                      })}
                    </View>
                  ) : null}
                </View>
              );
            })}
          </View>
        )}
      </Card>
    </View>
  );
}

function SwipeToDelete({
  onDelete,
  children,
  confirmTitle = 'Slett økt',
  confirmMessage = 'Vil du slette denne økten?',
}: {
  onDelete: () => void;
  children: React.ReactNode;
  confirmTitle?: string;
  confirmMessage?: string;
}) {
  const swipeRef = useRef<Swipeable | null>(null);

  function confirmDelete() {
    Alert.alert(confirmTitle, confirmMessage, [
      { text: 'Avbryt', style: 'cancel', onPress: () => swipeRef.current?.close() },
      {
        text: 'Slett',
        style: 'destructive',
        onPress: () => {
          swipeRef.current?.close();
          onDelete();
        },
      },
    ]);
  }

  function renderRightActions() {
    return (
      <Pressable onPress={confirmDelete} style={styles.swipeDeleteAction}>
        <Text style={styles.swipeDeleteText}>Slett</Text>
      </Pressable>
    );
  }

  return (
    <Swipeable
      ref={swipeRef}
      renderRightActions={renderRightActions}
      overshootRight={false}
      friction={2}
      rightThreshold={40}
    >
      {children}
    </Swipeable>
  );
}

function ExpandableManualSessionCard({
  session,
  expanded,
  onToggleExpand,
  onEdit,
}: {
  session: Session;
  expanded: boolean;
  onToggleExpand: () => void;
  onEdit: (s: Session) => void;
}) {
  return (
    <View style={styles.sessionCard}>
      <View style={styles.sessionCardHeaderRow}>
        <Pressable
          onPress={onToggleExpand}
          style={[styles.historySessionCompact, { flex: 1 }]}
          accessibilityRole="button"
          accessibilityLabel={
            expanded ? `Skjul detaljer for ${session.workoutType}` : `Vis detaljer for ${session.workoutType}`
          }
        >
          <Text style={styles.historySessionChevron}>{expanded ? '▼' : '▶'}</Text>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.muted}>{formatNorwegianDate(session.date)}</Text>
            <Text style={styles.historySessionCompactTitle} numberOfLines={2}>
              {session.workoutType}
            </Text>
          </View>
        </Pressable>
        <Pressable
          onPress={() => {
            void Haptics.selectionAsync();
            onEdit(session);
          }}
          style={({ pressed }) => [styles.sessionEditIconBtn, pressed && { opacity: 0.5 }]}
          accessibilityRole="button"
          accessibilityLabel={`Rediger ${session.workoutType}`}
          hitSlop={8}
        >
          <Text style={styles.sessionEditIconText}>✎</Text>
        </Pressable>
      </View>

      {expanded ? (
        <View style={styles.historySessionExpanded}>
          <View style={styles.detailGrid}>
            <Text style={styles.detailText}>
              <Text style={styles.detailLabel}>Tid:</Text> {session.time}
            </Text>
            <Text style={styles.detailText}>
              <Text style={styles.detailLabel}>Følelse:</Text> {session.feeling}
            </Text>

            {!isStrengthSession(session) ? (
              <>
                            <Text style={styles.detailText}>
                              <Text style={styles.detailLabel}>Distanse:</Text> {session.distance} km
                            </Text>
                            {session.averageHeartRate ? (
                              <Text style={styles.detailText}>
                                <Text style={styles.detailLabel}>Gjennomsnittspuls:</Text> {session.averageHeartRate}{' '}
                                bpm
                              </Text>
                            ) : null}
                            <Text style={styles.detailText}>
                              <Text style={styles.detailLabel}>Sko:</Text> {session.shoe}
                            </Text>
                <Text style={styles.detailText}>
                  <Text style={styles.detailLabel}>Sted:</Text>{' '}
                  {session.location === 'innendors' ? 'Innendørs' : 'Utendørs'}
                </Text>
                {session.location === 'utendors' ? (
                  <Text style={styles.detailText}>
                    <Text style={styles.detailLabel}>Vær:</Text> {session.weather}
                  </Text>
                ) : null}
              </>
            ) : null}
          </View>

          {isStrengthSession(session) && session.exercises.length > 0 ? (
            <View style={{ gap: 6 }}>
              <Text style={styles.detailLabel}>Øvelser</Text>
              {session.exercises.map((exercise, index) => (
                <View key={index} style={styles.exerciseRow}>
                  <Text style={styles.exerciseCell}>{exercise.name || '-'}</Text>
                  <Text style={styles.exerciseCell}>{exercise.weight ? `${exercise.weight} kg` : '-'}</Text>
                  <Text style={styles.exerciseCell}>{exercise.reps ? `${exercise.reps} reps` : '-'}</Text>
                </View>
              ))}
            </View>
          ) : null}

          {session.notes ? <Text style={styles.muted}>{session.notes}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

type StravaTotals = {
  count: number;
  distance: number;
  moving_time: number;
  elapsed_time: number;
  elevation_gain: number;
};

type StravaStats = {
  athleteId?: number;
  stats: {
    biggest_ride_distance?: number | null;
    biggest_climb_elevation_gain?: number | null;
    recent_run_totals?: StravaTotals;
    recent_ride_totals?: StravaTotals;
    recent_swim_totals?: StravaTotals;
    ytd_run_totals?: StravaTotals;
    ytd_ride_totals?: StravaTotals;
    ytd_swim_totals?: StravaTotals;
    all_run_totals?: StravaTotals;
    all_ride_totals?: StravaTotals;
    all_swim_totals?: StravaTotals;
  };
  fetchedAt?: number;
};

function stravaAllRunDistanceMetersFromStats(stats: StravaStats | null): number | null {
  const d = stats?.stats?.all_run_totals?.distance;
  return typeof d === 'number' && !Number.isNaN(d) ? d : null;
}

function stravaAllRunMovingSecondsFromStats(stats: StravaStats | null): number | null {
  const t = stats?.stats?.all_run_totals?.moving_time;
  return typeof t === 'number' && !Number.isNaN(t) ? t : null;
}

function StravaStatsRow({
  label,
  totals,
}: {
  label: string;
  totals?: StravaTotals;
}) {
  if (!totals || !totals.count) return null;
  const km = (totals.distance / 1000).toFixed(1);
  const minutes = Math.round(totals.moving_time / 60);
  const elev = Math.round(totals.elevation_gain);
  return (
    <View style={styles.listRow}>
      <View style={{ flex: 1 }}>
        <Text style={styles.listRowTitle}>{label}</Text>
        <Text style={styles.muted}>
          {totals.count} økter · {formatDuration(minutes)}
          {elev > 0 ? ` · ${elev} m` : ''}
        </Text>
      </View>
      <Text style={styles.listRowValue}>{km} km</Text>
    </View>
  );
}

function StravaStatsCard({
  onAllRunTotalsChange,
  refreshSignal = 0,
}: {
  onAllRunTotalsChange?: (totals: { distanceMeters: number | null; movingSeconds: number | null }) => void;
  refreshSignal?: number;
}) {
  const { user } = useAuth();
  const stravaAthleteId = user?.stravaAthleteId;
  const userId = useUserId();
  const statsCacheKey = userKey(STRAVA_STATS_CACHE_KEY, userId);
  const [data, setData] = useState<StravaStats | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(statsCacheKey);
        if (raw) setData(JSON.parse(raw) as StravaStats);
      } catch {
        // ignore
      }
    })();
  }, [statsCacheKey]);

  useEffect(() => {
    onAllRunTotalsChange?.({
      distanceMeters: stravaAllRunDistanceMetersFromStats(data),
      movingSeconds: stravaAllRunMovingSecondsFromStats(data),
    });
  }, [data, onAllRunTotalsChange]);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const resp = await apiFetch('/strava/stats', { ignoreAuthFailure: true });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(String((body as any)?.error || `HTTP ${resp.status}`));
      const fresh: StravaStats = { ...(body as StravaStats), fetchedAt: Date.now() };
      setData(fresh);
      await AsyncStorage.setItem(statsCacheKey, JSON.stringify(fresh));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(String(e?.message || e));
    } finally {
      setIsLoading(false);
    }
  }, [statsCacheKey]);

  useEffect(() => {
    if (!stravaAthleteId) return;
    void refresh();
  }, [stravaAthleteId, refresh]);

  useEffect(() => {
    if (refreshSignal <= 0) return;
    if (!stravaAthleteId) return;
    void refresh();
  }, [refreshSignal, stravaAthleteId, refresh]);

  const s = data?.stats;
  const updatedLabel = !stravaAthleteId
    ? 'Koble til Strava under Innstillinger for å hente statistikk.'
    : data?.fetchedAt
      ? `Sist oppdatert ${new Date(data.fetchedAt).toLocaleTimeString('nb-NO', {
          hour: '2-digit',
          minute: '2-digit',
        })}`
      : 'Henter…';

  const sections: { title: string; rows: { label: string; totals?: StravaTotals }[] }[] = s
    ? [
        {
          title: 'Siste 4 uker',
          rows: [
            { label: '🏃 Løp', totals: s.recent_run_totals },
            { label: '🚴 Sykkel', totals: s.recent_ride_totals },
            { label: '🏊 Svømming', totals: s.recent_swim_totals },
          ],
        },
        {
          title: 'Hittil i år',
          rows: [
            { label: '🏃 Løp', totals: s.ytd_run_totals },
            { label: '🚴 Sykkel', totals: s.ytd_ride_totals },
            { label: '🏊 Svømming', totals: s.ytd_swim_totals },
          ],
        },
        {
          title: 'All-time',
          rows: [
            { label: '🏃 Løp', totals: s.all_run_totals },
            { label: '🚴 Sykkel', totals: s.all_ride_totals },
            { label: '🏊 Svømming', totals: s.all_swim_totals },
          ],
        },
      ]
    : [];

  const headerRefresh = (
    <Pressable
      onPress={() => {
        void Haptics.selectionAsync();
        void refresh();
      }}
      style={({ pressed }) => [
        styles.cardIconButton,
        pressed && { opacity: 0.6 },
        isLoading && { opacity: 0.6 },
      ]}
      disabled={isLoading}
      accessibilityLabel="Synk Strava-statistikk"
      accessibilityRole="button"
      hitSlop={8}
    >
      {isLoading ? (
        <ActivityIndicator size="small" color="#7A3C4A" />
      ) : (
        <Text style={styles.cardIconButtonText}>↻</Text>
      )}
    </Pressable>
  );

  return (
    <Card title="Strava" headerRight={headerRefresh}>
      <View style={{ gap: 12 }}>
        <Text style={styles.muted}>{updatedLabel}</Text>

        {error ? (
          <View style={styles.stravaErrorBox}>
            <Text style={styles.stravaErrorText}>
              {isRateLimitError(error)
                ? 'Strava begrenser antall forespørsler. Vent ~15 min før du prøver igjen.'
                : error}
            </Text>
          </View>
        ) : null}

        {!data && isLoading ? <ActivityIndicator size="small" /> : null}

        {sections.map((section) => {
          const visible = section.rows.filter((r) => r.totals && r.totals.count);
          if (visible.length === 0) return null;
          return (
            <View key={section.title} style={{ gap: 6 }}>
              <Text style={styles.statsSectionTitle}>{section.title}</Text>
              {visible.map((r) => (
                <StravaStatsRow key={r.label} label={r.label} totals={r.totals} />
              ))}
            </View>
          );
        })}
      </View>
    </Card>
  );
}

type StravaBestEffort = {
  name: string;
  distanceMeters: number;
  elapsedTime: number;
  movingTime: number;
  activityId: number;
  activityName: string;
  startDate: string;
  prRank: number | null;
};

type StravaBestEfforts = {
  scannedRuns: number;
  scannedNew?: number;
  totalRuns?: number;
  pendingRuns?: number;
  batch?: number;
  rateLimited?: boolean;
  efforts: StravaBestEffort[];
  fetchedAt: number;
  lastScanAt?: number;
  scanning?: boolean;
  lastError?: string | null;
};

const STRAVA_BEST_EFFORT_LABELS: Record<string, string> = {
  '400m': '400 m',
  '1/2 mile': '½ mile',
  '1k': '1 km',
  '1 mile': '1 mile',
  '2 mile': '2 mile',
  '5k': '5 km',
  '10k': '10 km',
  '15k': '15 km',
  '10 mile': '10 mile',
  '20k': '20 km',
  'Half-Marathon': 'Halvmaraton',
  '30k': '30 km',
  Marathon: 'Maraton',
};

function bestEffortLabel(name: string): string {
  return STRAVA_BEST_EFFORT_LABELS[name] || name;
}

function formatElapsed(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '–';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}

function effortPaceLabel(distanceMeters: number, seconds: number): string {
  if (!distanceMeters || !seconds) return '';
  const secPerKm = seconds / (distanceMeters / 1000);
  return formatPaceLabel(Math.round(secPerKm));
}

function isRateLimitError(message: string): boolean {
  return /429|rate limit/i.test(message || '');
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = 15000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function StravaBestEffortsCard({
  defaultExpanded = false,
  refreshSignal = 0,
}: {
  defaultExpanded?: boolean;
  refreshSignal?: number;
} = {}) {
  const { user } = useAuth();
  const stravaAthleteId = user?.stravaAthleteId;
  const userId = useUserId();
  const bestEffortsCacheKey = userKey(STRAVA_BEST_EFFORTS_CACHE_KEY, userId);
  const [data, setData] = useState<StravaBestEfforts | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(defaultExpanded);

  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);
  const refreshRef = useRef<(opts?: { quiet?: boolean }) => Promise<void>>(async () => {});

  const parseResponse = useCallback((body: any): StravaBestEfforts => {
    return {
      scannedRuns: Number(body?.scannedRuns) || 0,
      scannedNew: Number.isFinite(Number(body?.scannedNew)) ? Number(body?.scannedNew) : undefined,
      totalRuns: Number.isFinite(Number(body?.totalRuns)) ? Number(body?.totalRuns) : undefined,
      pendingRuns: Number.isFinite(Number(body?.pendingRuns)) ? Number(body?.pendingRuns) : undefined,
      batch: Number.isFinite(Number(body?.batch)) ? Number(body?.batch) : undefined,
      rateLimited: Boolean(body?.rateLimited),
      efforts: Array.isArray(body?.efforts) ? (body.efforts as StravaBestEffort[]) : [],
      fetchedAt: Number(body?.fetchedAt) || Date.now(),
      lastScanAt: Number(body?.lastScanAt) || undefined,
      scanning: Boolean(body?.scanning),
      lastError: typeof body?.lastError === 'string' ? body.lastError : null,
    };
  }, []);

  const clearPoll = useCallback(() => {
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const persistSnapshot = useCallback(async (snapshot: StravaBestEfforts) => {
    if (snapshot.efforts.length === 0 && snapshot.scannedRuns === 0) return;
    try {
      await AsyncStorage.setItem(
        bestEffortsCacheKey,
        JSON.stringify(snapshot),
      );
    } catch {
      // ignore
    }
  }, [bestEffortsCacheKey]);

  const fetchSnapshot = useCallback(
    async (force: boolean): Promise<StravaBestEfforts> => {
      const suffix = force ? '?batch=25&force=1' : '';
      const resp = await apiFetch(`/strava/best-efforts${suffix}`, {
        timeoutMs: 15000,
        ignoreAuthFailure: true,
      });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        throw new Error(String((body as any)?.error || `HTTP ${resp.status}`));
      }
      return parseResponse(body);
    },
    [parseResponse],
  );

  const scheduleNextPoll = useCallback(
    (delayMs: number, startedAt: number, quietHaptics: boolean) => {
      clearPoll();
      pollRef.current = setTimeout(async () => {
        if (!isMountedRef.current) return;
        // Stop polling after 3 minutes regardless — bruker kan fortsatt trykke ↻.
        if (Date.now() - startedAt > 3 * 60 * 1000) {
          setIsLoading(false);
          return;
        }
        try {
          const snapshot = await fetchSnapshot(false);
          if (!isMountedRef.current) return;
          setData(snapshot);
          void persistSnapshot(snapshot);
          if (snapshot.lastError) {
            setError(snapshot.lastError);
            setIsLoading(false);
            if (!quietHaptics) {
              void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
            }
            return;
          }
          if (snapshot.scanning) {
            scheduleNextPoll(3000, startedAt, quietHaptics);
          } else {
            const pending = snapshot.pendingRuns ?? 0;
            if (pending > 0 && !snapshot.rateLimited) {
              clearPoll();
              pollRef.current = setTimeout(() => {
                void refreshRef.current({ quiet: true });
              }, 1500);
              return;
            }
            setIsLoading(false);
            if (!quietHaptics) {
              void Haptics.notificationAsync(
                snapshot.rateLimited
                  ? Haptics.NotificationFeedbackType.Warning
                  : Haptics.NotificationFeedbackType.Success,
              );
            }
          }
        } catch {
          scheduleNextPoll(5000, startedAt, quietHaptics);
        }
      }, delayMs);
    },
    [clearPoll, fetchSnapshot, persistSnapshot],
  );

  const refresh = useCallback(
    async (opts?: { quiet?: boolean }) => {
      setIsLoading(true);
      setError(null);
      try {
        const snapshot = await fetchSnapshot(true);
        if (!isMountedRef.current) return;
        setData(snapshot);
        void persistSnapshot(snapshot);
        if (snapshot.lastError) {
          setError(snapshot.lastError);
          setIsLoading(false);
          if (!opts?.quiet) {
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
          }
          return;
        }
        if (snapshot.scanning) {
          scheduleNextPoll(3000, Date.now(), !!opts?.quiet);
        } else {
          const pending = snapshot.pendingRuns ?? 0;
          if (pending > 0 && !snapshot.rateLimited) {
            clearPoll();
            pollRef.current = setTimeout(() => {
              void refreshRef.current({ quiet: true });
            }, 1500);
            return;
          }
          setIsLoading(false);
          if (!opts?.quiet) {
            void Haptics.notificationAsync(
              snapshot.rateLimited
                ? Haptics.NotificationFeedbackType.Warning
                : Haptics.NotificationFeedbackType.Success,
            );
          }
        }
      } catch (e: any) {
        if (!opts?.quiet) {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        }
        setError(String(e?.message || e));
        setIsLoading(false);
      }
    },
    [fetchSnapshot, persistSnapshot, scheduleNextPoll, clearPoll],
  );

  refreshRef.current = refresh;

  useEffect(() => {
    isMountedRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(bestEffortsCacheKey);
        if (raw && !cancelled) setData(JSON.parse(raw) as StravaBestEfforts);
      } catch {
        // ignore
      }
      if (!stravaAthleteId || cancelled) return;
      try {
        const snapshot = await fetchSnapshot(false);
        if (cancelled) return;
        setData(snapshot);
        void persistSnapshot(snapshot);
        if (snapshot.scanning) {
          setIsLoading(true);
          scheduleNextPoll(3000, Date.now(), true);
          return;
        }
        const pending = snapshot.pendingRuns ?? 0;
        const noScanYet =
          snapshot.scannedRuns === 0 &&
          (snapshot.efforts?.length ?? 0) === 0 &&
          !snapshot.rateLimited;
        if (pending > 0 || noScanYet) {
          void refreshRef.current({ quiet: true });
        }
      } catch (e: any) {
        if (!cancelled) setError(String(e?.message || e));
      }
    })();
    return () => {
      cancelled = true;
      isMountedRef.current = false;
      clearPoll();
    };
  }, [
    bestEffortsCacheKey,
    stravaAthleteId,
    clearPoll,
    fetchSnapshot,
    persistSnapshot,
    scheduleNextPoll,
  ]);

  useEffect(() => {
    if (refreshSignal <= 0) return;
    if (!stravaAthleteId) return;
    void refreshRef.current({ quiet: true });
  }, [refreshSignal, stravaAthleteId]);

  const updatedLabel = data?.lastScanAt || data?.fetchedAt
    ? `Sist oppdatert ${new Date((data.lastScanAt || data.fetchedAt) as number).toLocaleTimeString('nb-NO', {
        hour: '2-digit',
        minute: '2-digit',
      })}`
    : 'Ikke beregnet ennå';

  const headerToggle = (
    <Pressable
      onPress={() => {
        void Haptics.selectionAsync();
        setExpanded((v) => !v);
      }}
      style={({ pressed }) => [
        styles.cardIconButton,
        pressed && { opacity: 0.6 },
      ]}
      accessibilityLabel={expanded ? 'Skjul beste tider' : 'Vis beste tider'}
      accessibilityRole="button"
      hitSlop={8}
    >
      <Text style={styles.cardIconButtonText}>{expanded ? '▴' : '▾'}</Text>
    </Pressable>
  );

  const refreshButton = (
    <Pressable
      onPress={() => {
        void Haptics.selectionAsync();
        void refresh();
      }}
      style={({ pressed }) => [
        styles.cardIconButton,
        pressed && { opacity: 0.6 },
        isLoading && { opacity: 0.6 },
      ]}
      disabled={isLoading}
      accessibilityLabel="Beregn beste tider fra Strava"
      accessibilityRole="button"
      hitSlop={8}
    >
      {isLoading ? (
        <ActivityIndicator size="small" color="#7A3C4A" />
      ) : (
        <Text style={styles.cardIconButtonText}>↻</Text>
      )}
    </Pressable>
  );

  const efforts = data?.efforts ?? [];
  const showRateLimitNotice = data?.rateLimited || isRateLimitError(error || '');
  const scannedRuns = data?.scannedRuns ?? 0;
  const totalRuns = data?.totalRuns ?? 0;
  const pendingRuns =
    typeof data?.pendingRuns === 'number'
      ? data.pendingRuns
      : Math.max(0, totalRuns - scannedRuns);
  const hasPending = pendingRuns > 0;
  const progressLabel = totalRuns
    ? `${scannedRuns} av ${totalRuns} løpeøkter skannet`
    : scannedRuns
      ? `${scannedRuns} løpeøkter skannet`
      : '';

  return (
    <Card title="Beste tider (løp)" headerRight={headerToggle}>
      {!expanded ? null : (
      <View style={{ gap: 10 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <Text style={[styles.muted, { flex: 1 }]}>
            {updatedLabel}
            {progressLabel ? ` · ${progressLabel}` : ''}
          </Text>
          {refreshButton}
        </View>

        {showRateLimitNotice ? (
          <View style={styles.stravaErrorBox}>
            <Text style={styles.stravaErrorText}>
              Strava begrenser antall forespørsler. Vent ~15 min og trykk ↻ igjen for å fortsette å skanne.
            </Text>
          </View>
        ) : error ? (
          <View style={styles.stravaErrorBox}>
            <Text style={styles.stravaErrorText}>{error}</Text>
          </View>
        ) : null}

        {isLoading || data?.scanning ? (
          <View style={{ alignItems: 'center', paddingVertical: 8, gap: 8 }}>
            <ActivityIndicator size="small" color="#7A3C4A" />
            <Text style={styles.muted}>
              Skanner Strava-aktiviteter i bakgrunnen… du kan bli på denne siden, progresjonen oppdateres automatisk.
            </Text>
          </View>
        ) : null}

        {!data && !isLoading && !error ? (
          <Text style={styles.muted}>
            {stravaAthleteId
              ? 'Med Strava koblet til beregnes beste tider automatisk i puljer på 25 løpeøkter. Du kan også trykke ↻ for å tvinge en ny runde.'
              : 'Koble til Strava under Innstillinger for å beregne beste tider fra løpeøktene dine.'}
          </Text>
        ) : null}

        {data && efforts.length === 0 && !isLoading && !error && !showRateLimitNotice ? (
          <Text style={styles.muted}>
            Fant ingen registrerte best-efforts i de skannede løpeøktene ennå.
          </Text>
        ) : null}

        {data && !isLoading && !showRateLimitNotice && hasPending ? (
          <Text style={styles.muted}>
            {pendingRuns} økter gjenstår — neste pulj hentes automatisk (eller trykk ↻).
          </Text>
        ) : null}

        {data && !isLoading && !showRateLimitNotice && !hasPending && efforts.length > 0 ? (
          <Text style={styles.muted}>
            Alle løpeøkter er skannet — tidene viser dine beste gjennom tidene.
          </Text>
        ) : null}

        {efforts.length > 0 ? (
          <View style={{ gap: 6 }}>
            {efforts.map((eff) => (
              <View key={eff.name} style={styles.bestEffortRow}>
                <Text style={styles.bestEffortLabel}>{bestEffortLabel(eff.name)}</Text>
                <View style={styles.bestEffortMeta}>
                  <Text style={styles.bestEffortTime}>{formatElapsed(eff.elapsedTime)}</Text>
                  <Text style={styles.muted}>
                    {effortPaceLabel(eff.distanceMeters, eff.elapsedTime)}
                    {eff.startDate
                      ? ` · ${formatNorwegianDate(eff.startDate.slice(0, 10))}`
                      : ''}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        ) : null}
      </View>
      )}
    </Card>
  );
}

function StatisticsTab({
  totals,
  latestWeather,
  sessions,
  onStravaAllRunTotalsChange,
  onOpenSessions,
  refreshSignal = 0,
}: {
  totals: { count: number; distance: string };
  latestWeather: string;
  sessions: Session[];
  onStravaAllRunTotalsChange?: (totals: { distanceMeters: number | null; movingSeconds: number | null }) => void;
  onOpenSessions?: () => void;
  refreshSignal?: number;
}) {
  return (
    <View style={{ gap: 12 }}>
      <SessionBreakdownCard sessions={sessions} />

      <StravaStatsCard
        onAllRunTotalsChange={onStravaAllRunTotalsChange}
        refreshSignal={refreshSignal}
      />

      <Card title="Manuelt loggført">
        <View style={{ gap: 10 }}>
          <Pressable
            onPress={() => {
              if (!onOpenSessions) return;
              void Haptics.selectionAsync();
              onOpenSessions();
            }}
            style={({ pressed }) => [
              styles.statTile,
              onOpenSessions ? styles.statTilePressable : null,
              pressed && onOpenSessions ? { opacity: 0.7 } : null,
            ]}
            disabled={!onOpenSessions}
            accessibilityRole={onOpenSessions ? 'button' : undefined}
            accessibilityLabel={onOpenSessions ? 'Åpne Økter-fanen' : undefined}
          >
            <View style={{ flex: 1 }}>
              <Text style={styles.metricLabel}>Registrerte økter</Text>
              <Text style={styles.metricValue}>{totals.count}</Text>
            </View>
            {onOpenSessions ? <Text style={styles.statTileChevron}>›</Text> : null}
          </Pressable>
          <View style={styles.statTile}>
            <Text style={styles.metricLabel}>Løpte kilometer</Text>
            <Text style={styles.metricValue}>{totals.distance} km</Text>
          </View>
          <View style={styles.statTile}>
            <Text style={styles.metricLabel}>Siste vær</Text>
            <Text style={styles.metricValue} numberOfLines={2}>
              {latestWeather}
            </Text>
          </View>
        </View>
      </Card>
    </View>
  );
}

function SessionBreakdownCard({ sessions }: { sessions: Session[] }) {
  const breakdown = useMemo(() => {
    let runCount = 0;
    let strengthCount = 0;
    let runIndoor = 0;
    let runOutdoor = 0;
    const runByType = new Map<string, number>();
    const strengthByType = new Map<string, number>();
    let runUnknownType = 0;
    let strengthUnknownType = 0;

    sessions.forEach((s) => {
      if (isStrengthSession(s)) {
        strengthCount += 1;
        if (strengthWorkoutTypeValues.includes(s.workoutType)) {
          strengthByType.set(s.workoutType, (strengthByType.get(s.workoutType) || 0) + 1);
        } else {
          strengthUnknownType += 1;
        }
      } else {
        runCount += 1;
        if (s.location === 'innendors') runIndoor += 1;
        else if (s.location === 'utendors') runOutdoor += 1;
        if (runWorkoutTypeValues.includes(s.workoutType)) {
          runByType.set(s.workoutType, (runByType.get(s.workoutType) || 0) + 1);
        } else {
          runUnknownType += 1;
        }
      }
    });

    type BreakdownRow = { emoji: string; label: string; count: number };
    const runTypes: BreakdownRow[] = runWorkoutTypeOptions
      .map((o) => ({ emoji: o.emoji as string, label: o.label as string, count: runByType.get(o.value) || 0 }))
      .filter((row) => row.count > 0);
    if (runUnknownType > 0) {
      runTypes.push({ emoji: '🏃', label: 'Annet', count: runUnknownType });
    }

    const strengthTypes: BreakdownRow[] = strengthWorkoutTypeOptions
      .map((o) => ({ emoji: o.emoji as string, label: o.label as string, count: strengthByType.get(o.value) || 0 }))
      .filter((row) => row.count > 0);
    if (strengthUnknownType > 0) {
      strengthTypes.push({ emoji: '💪', label: 'Annet', count: strengthUnknownType });
    }

    return {
      total: sessions.length,
      runCount,
      strengthCount,
      runIndoor,
      runOutdoor,
      runTypes,
      strengthTypes,
    };
  }, [sessions]);

  if (breakdown.total === 0) {
    return (
      <Card title="Fordeling av manuelt loggede økter">
        <Text style={styles.muted}>Ingen loggførte økter ennå.</Text>
      </Card>
    );
  }

  function renderRow(emoji: string, label: string, count: number, total: number) {
    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
    return (
      <View key={`${emoji}-${label}`} style={styles.breakdownRow}>
        <Text style={styles.breakdownEmoji}>{emoji}</Text>
        <Text style={styles.breakdownLabel} numberOfLines={1}>
          {label}
        </Text>
        <Text style={styles.breakdownCount}>{count}</Text>
        <Text style={styles.breakdownPct}>{`${pct}%`}</Text>
      </View>
    );
  }

  return (
    <Card title="Fordeling av manuelt loggede økter">
      <View style={{ gap: 16 }}>
        <View style={{ gap: 6 }}>
          <Text style={styles.breakdownSectionTitle}>Type økt</Text>
          {renderRow('🏃', 'Løping', breakdown.runCount, breakdown.total)}
          {renderRow('💪', 'Styrke', breakdown.strengthCount, breakdown.total)}
        </View>

        {breakdown.runTypes.length > 0 ? (
          <View style={{ gap: 6 }}>
            <Text style={styles.breakdownSectionTitle}>Løpeøkter</Text>
            {breakdown.runTypes.map((row) =>
              renderRow(row.emoji, row.label, row.count, breakdown.runCount),
            )}
          </View>
        ) : null}

        {breakdown.runCount > 0 ? (
          <View style={{ gap: 6 }}>
            <Text style={styles.breakdownSectionTitle}>Sted (løp)</Text>
            {renderRow('🌤️', 'Utendørs', breakdown.runOutdoor, breakdown.runCount)}
            {renderRow('🏠', 'Innendørs', breakdown.runIndoor, breakdown.runCount)}
          </View>
        ) : null}

        {breakdown.strengthTypes.length > 0 ? (
          <View style={{ gap: 6 }}>
            <Text style={styles.breakdownSectionTitle}>Styrkeøkter</Text>
            {breakdown.strengthTypes.map((row) =>
              renderRow(row.emoji, row.label, row.count, breakdown.strengthCount),
            )}
          </View>
        ) : null}
      </View>
    </Card>
  );
}

function newProgramLineKey() {
  return `ln-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

type ProgramLineForm = {
  key: string;
  id?: string;
  week: string;
  dayLabel: string;
  title: string;
  description: string;
  date: string;
  done: boolean;
  workoutType: string;
};

type ProgramFormDraft = {
  mode: 'create' | 'edit';
  programId: string | null;
  title: string;
  goalSummary: string;
  competitionName: string;
  competitionDate: string;
  weeksStr: string;
  sessionsPerWeekStr: string;
  lines: ProgramLineForm[];
};

function emptyProgramLine(week: number, slot: number): ProgramLineForm {
  return {
    key: newProgramLineKey(),
    week: String(week),
    dayLabel: `Økt ${slot}`,
    title: '',
    description: '',
    date: '',
    done: false,
    workoutType: '',
  };
}

/**
 * Bygger en flat liste av økt-linjer basert på antall uker og økter per uke.
 * Bevarer eksisterende brukerinnhold der det matcher (week, slotInWeek):
 * eksisterende linjer grupperes etter sin `week`-verdi, og slot-rekkefølgen
 * innen hver uke beholdes.
 */
function buildProgramLines(
  weeks: number,
  sessionsPerWeek: number,
  existing: ProgramLineForm[],
): ProgramLineForm[] {
  const w = Math.max(1, Math.min(52, Math.floor(weeks) || 1));
  const s = Math.max(1, Math.min(20, Math.floor(sessionsPerWeek) || 1));

  const byWeek = new Map<number, ProgramLineForm[]>();
  existing.forEach((line) => {
    const lw = Math.max(1, parseInt((line.week || '1').replace(/\D/g, ''), 10) || 1);
    const arr = byWeek.get(lw) || [];
    arr.push(line);
    byWeek.set(lw, arr);
  });

  const result: ProgramLineForm[] = [];
  for (let week = 1; week <= w; week++) {
    const weekGroup = byWeek.get(week) || [];
    for (let slot = 1; slot <= s; slot++) {
      const existingLine = weekGroup[slot - 1];
      if (existingLine) {
        result.push({
          ...existingLine,
          week: String(week),
          dayLabel: existingLine.dayLabel || `Økt ${slot}`,
        });
      } else {
        result.push(emptyProgramLine(week, slot));
      }
    }
  }
  return result;
}

const DEFAULT_PROGRAM_WEEKS = 1;
const DEFAULT_PROGRAM_SESSIONS_PER_WEEK = 3;

function createEmptyCreateDraft(): ProgramFormDraft {
  return {
    mode: 'create',
    programId: null,
    title: '',
    goalSummary: '',
    competitionName: '',
    competitionDate: '',
    weeksStr: String(DEFAULT_PROGRAM_WEEKS),
    sessionsPerWeekStr: String(DEFAULT_PROGRAM_SESSIONS_PER_WEEK),
    lines: buildProgramLines(DEFAULT_PROGRAM_WEEKS, DEFAULT_PROGRAM_SESSIONS_PER_WEEK, []),
  };
}

function deriveSessionsPerWeek(items: SavedProgramItem[]): number {
  if (!items || items.length === 0) return DEFAULT_PROGRAM_SESSIONS_PER_WEEK;
  const counts = new Map<number, number>();
  items.forEach((it) => {
    const w = Math.max(1, Math.floor(it.week) || 1);
    counts.set(w, (counts.get(w) || 0) + 1);
  });
  let maxCount = 1;
  counts.forEach((v) => {
    if (v > maxCount) maxCount = v;
  });
  return Math.max(1, Math.min(20, maxCount));
}

function sortRunningProgramItems(items: SavedProgramItem[]): SavedProgramItem[] {
  return [...items].sort((a, b) => {
    if (a.date && b.date) return a.date.localeCompare(b.date);
    if (a.date) return -1;
    if (b.date) return 1;
    return a.week - b.week || a.dayLabel.localeCompare(b.dayLabel, 'nb');
  });
}

function RunningProgramTab({
  programs,
  onToggleItem,
  onDeleteProgram,
  onSaveProgram,
  onMoveRunningProgramInTab,
}: {
  programs: SavedRunningProgram[];
  onToggleItem: (programId: string, itemId: string) => void;
  onDeleteProgram: (programId: string) => void;
  onMoveRunningProgramInTab: (
    tab: 'active' | 'completed',
    programId: string,
    direction: 'up' | 'down',
  ) => void;
  onSaveProgram: (payload: {
    mode: 'create' | 'edit';
    programId?: string;
    title: string;
    goalSummary: string;
    competitionName?: string;
    competitionDate?: string;
    weeks: number;
    items: Array<{
      id?: string;
      week: number;
      dayLabel: string;
      title: string;
      description: string;
      date?: string;
      done: boolean;
      workoutType?: string;
    }>;
  }) => void;
}) {
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  const [expandedItemIds, setExpandedItemIds] = useState<Record<string, boolean>>({});
  const [programTab, setProgramTab] = useState<'active' | 'completed'>('active');
  const [reorderEditMode, setReorderEditMode] = useState(false);

  function toggleItemExpanded(itemId: string) {
    setExpandedItemIds((prev) => ({ ...prev, [itemId]: !prev[itemId] }));
  }
  const [formOpen, setFormOpen] = useState(false);
  const [formDraft, setFormDraft] = useState<ProgramFormDraft>(() => createEmptyCreateDraft());
  const [datePickerLineKey, setDatePickerLineKey] = useState<string | null>(null);
  const [competitionDatePickerOpen, setCompetitionDatePickerOpen] = useState(false);
  const [weekPickerLineKey, setWeekPickerLineKey] = useState<string | null>(null);
  const [showWeeksPicker, setShowWeeksPicker] = useState(false);
  const [showSessionsPerWeekPicker, setShowSessionsPerWeekPicker] = useState(false);
  const [expandedFormLines, setExpandedFormLines] = useState<Record<string, boolean>>({});
  const [expandedFormWeeks, setExpandedFormWeeks] = useState<Record<number, boolean>>({});

  function isFormLineOpen(key: string) {
    return !!expandedFormLines[key];
  }

  function toggleFormLineExpanded(key: string) {
    void Haptics.selectionAsync();
    setExpandedFormLines((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  function isFormWeekOpen(week: number) {
    if (Object.prototype.hasOwnProperty.call(expandedFormWeeks, week)) {
      return !!expandedFormWeeks[week];
    }
    return week === 1;
  }

  function toggleFormWeekExpanded(week: number) {
    void Haptics.selectionAsync();
    setExpandedFormWeeks((prev) => ({ ...prev, [week]: !isFormWeekOpen(week) }));
  }

  function parseWeeksMax(): number {
    const n = parseInt((formDraft.weeksStr || '').replace(/\D/g, ''), 10);
    if (!Number.isFinite(n) || n < 1) return 1;
    return Math.min(52, n);
  }

  function weekMaxForLine(lineWeek: string): number {
    const fromField = parseWeeksMax();
    const fromLine = parseInt((lineWeek || '').replace(/\D/g, ''), 10);
    const linePart = Number.isFinite(fromLine) && fromLine > 0 ? Math.min(52, fromLine) : 1;
    return Math.max(fromField, linePart, 1);
  }

  function updateLineWeek(key: string, weekNum: number) {
    setFormDraft((d) => ({
      ...d,
      lines: d.lines.map((l) => (l.key === key ? { ...l, week: String(weekNum) } : l)),
    }));
  }

  function toggleExpanded(programId: string) {
    void Haptics.selectionAsync();
    setExpandedIds((prev) => ({ ...prev, [programId]: !(prev[programId] ?? false) }));
  }

  const visiblePrograms = useMemo(() => {
    return programs.filter((p) => {
      const isCompleted = p.items.length > 0 && p.items.every((it) => it.done);
      return programTab === 'completed' ? isCompleted : !isCompleted;
    });
  }, [programs, programTab]);

  useEffect(() => {
    setReorderEditMode(false);
  }, [programTab]);

  useEffect(() => {
    if (visiblePrograms.length < 2) setReorderEditMode(false);
  }, [visiblePrograms.length]);

  function openCreateModal() {
    void Haptics.selectionAsync();
    setDatePickerLineKey(null);
    setCompetitionDatePickerOpen(false);
    setFormDraft(createEmptyCreateDraft());
    setFormOpen(true);
  }

  function openEditModal(p: SavedRunningProgram) {
    void Haptics.selectionAsync();
    setDatePickerLineKey(null);
    setFormDraft({
      mode: 'edit',
      programId: p.id,
      title: p.title,
      goalSummary: p.goalSummary,
      competitionName: p.competitionName || '',
      competitionDate: p.competitionDate || '',
      weeksStr: String(p.weeks),
      sessionsPerWeekStr: String(deriveSessionsPerWeek(p.items)),
      lines: p.items.map((it) => ({
        key: it.id,
        id: it.id,
        week: String(it.week),
        dayLabel: it.dayLabel,
        title: it.title,
        description: it.description,
        date: it.date || '',
        done: it.done,
        workoutType: it.workoutType || '',
      })),
    });
    setFormOpen(true);
  }

  function changeWeeksStr(t: string) {
    const cleaned = t.replace(/\D/g, '');
    setFormDraft((d) => {
      const n = parseInt(cleaned, 10);
      if (!Number.isFinite(n) || n < 1) {
        return { ...d, weeksStr: cleaned };
      }
      const sessions = Math.max(
        1,
        parseInt((d.sessionsPerWeekStr || '').replace(/\D/g, ''), 10) || DEFAULT_PROGRAM_SESSIONS_PER_WEEK,
      );
      return {
        ...d,
        weeksStr: cleaned,
        lines: buildProgramLines(n, sessions, d.lines),
      };
    });
  }

  function changeSessionsPerWeekStr(t: string) {
    const cleaned = t.replace(/\D/g, '');
    setFormDraft((d) => {
      const n = parseInt(cleaned, 10);
      if (!Number.isFinite(n) || n < 1) {
        return { ...d, sessionsPerWeekStr: cleaned };
      }
      const weeks = Math.max(
        1,
        parseInt((d.weeksStr || '').replace(/\D/g, ''), 10) || DEFAULT_PROGRAM_WEEKS,
      );
      return {
        ...d,
        sessionsPerWeekStr: cleaned,
        lines: buildProgramLines(weeks, n, d.lines),
      };
    });
  }

  function closeFormModal() {
    setFormOpen(false);
    setDatePickerLineKey(null);
    setCompetitionDatePickerOpen(false);
    setWeekPickerLineKey(null);
    setShowWeeksPicker(false);
    setShowSessionsPerWeekPicker(false);
    setExpandedFormLines({});
    setExpandedFormWeeks({});
    setFormDraft(createEmptyCreateDraft());
  }

  function updateLineDate(key: string, dateStr: string) {
    setFormDraft((d) => ({
      ...d,
      lines: d.lines.map((l) => (l.key === key ? { ...l, date: dateStr } : l)),
    }));
  }

  const datePickerLine = datePickerLineKey ? formDraft.lines.find((l) => l.key === datePickerLineKey) : undefined;
  const weekPickerLine = weekPickerLineKey ? formDraft.lines.find((l) => l.key === weekPickerLineKey) : undefined;

  function submitProgramForm() {
    const title = formDraft.title.trim();
    if (!title) {
      Alert.alert('Mangler tittel', 'Gi sjekklisten et navn.');
      return;
    }
    const parsedLines = formDraft.lines
      .map((l) => {
        const w = Math.max(1, Math.min(52, parseInt(String(l.week).replace(/\D/g, ''), 10) || 1));
        return {
          id: l.id,
          week: w,
          dayLabel: l.dayLabel.trim() || 'Økt',
          title: l.title.trim(),
          description: l.description.trim(),
          date: l.date.trim() || undefined,
          done: l.done,
          workoutType: l.workoutType.trim() || undefined,
        };
      })
      .filter((l) => l.title.length > 0);
    if (parsedLines.length === 0) {
      Alert.alert('Minst én økt', 'Fyll inn tittel på minst én økt.');
      return;
    }
    const w = Math.max(1, Math.min(52, parseInt(formDraft.weeksStr.replace(/\D/g, ''), 10) || 1));
    const competitionName = formDraft.competitionName.trim();
    const competitionDateRaw = formDraft.competitionDate.trim();
    const competitionDate =
      competitionDateRaw && /^\d{4}-\d{2}-\d{2}$/.test(competitionDateRaw)
        ? competitionDateRaw
        : undefined;
    if (formDraft.mode === 'create') {
      onSaveProgram({
        mode: 'create',
        title,
        goalSummary: formDraft.goalSummary.trim(),
        competitionName: competitionName || undefined,
        competitionDate,
        weeks: w,
        items: parsedLines.map((l) => ({ ...l, done: false })),
      });
    } else if (formDraft.programId) {
      onSaveProgram({
        mode: 'edit',
        programId: formDraft.programId,
        title,
        goalSummary: formDraft.goalSummary.trim(),
        competitionName: competitionName || undefined,
        competitionDate,
        weeks: w,
        items: parsedLines,
      });
    }
    closeFormModal();
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }

  return (
    <>
      <View style={{ gap: 14 }}>
        <View style={styles.programTabTopRow}>
          <Pressable
            onPress={openCreateModal}
            style={({ pressed }) => [styles.newChecklistButton, pressed && { opacity: 0.8, transform: [{ scale: 0.98 }] }]}
            accessibilityRole="button"
            accessibilityLabel="Nytt løpeprogram"
          >
            <Text style={styles.newChecklistButtonText}>Nytt løpeprogram</Text>
          </Pressable>
        </View>

        {programs.length > 0 ? (() => {
          const activeCount = programs.filter(
            (p) => p.items.length === 0 || p.items.some((it) => !it.done),
          ).length;
          const completedCount = programs.length - activeCount;
          return (
            <>
              <View style={styles.programSubTabBar}>
                {(
                  [
                    { id: 'active' as const, label: 'Aktive', count: activeCount },
                    { id: 'completed' as const, label: 'Fullførte', count: completedCount },
                  ]
                ).map((tab) => {
                  const active = programTab === tab.id;
                  return (
                    <Pressable
                      key={tab.id}
                      onPress={() => {
                        void Haptics.selectionAsync();
                        setProgramTab(tab.id);
                      }}
                      style={[styles.programSubTab, active && styles.programSubTabActive]}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                      accessibilityLabel={`${tab.label} løpeprogrammer`}
                    >
                      <Text
                        style={[styles.programSubTabText, active && styles.programSubTabTextActive]}
                      >
                        {tab.label} ({tab.count})
                      </Text>
                    </Pressable>
                  );
                })}
                {visiblePrograms.length > 1 ? (
                  <Pressable
                    onPress={() => {
                      void Haptics.selectionAsync();
                      setReorderEditMode((v) => !v);
                    }}
                    style={({ pressed }) => [
                      styles.programReorderModeIconButton,
                      reorderEditMode && styles.programReorderModeIconButtonOn,
                      pressed && { opacity: 0.82 },
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel={
                      reorderEditMode
                        ? 'Avslutt redigering av rekkefølge'
                        : 'Endre rekkefølge på løpeprogrammer'
                    }
                  >
                    <FontAwesome6
                      name="up-down"
                      solid
                      size={15}
                      color={reorderEditMode ? '#C45872' : '#7A3C4A'}
                    />
                  </Pressable>
                ) : null}
              </View>
              {reorderEditMode && visiblePrograms.length > 1 ? (
                <Text style={styles.programReorderHint}>
                  Bruk ↑ og ↓ til venstre på hvert kort for å flytte programmet.
                </Text>
              ) : null}
            </>
          );
        })() : null}

        {programs.length === 0 ? (
          <View style={styles.programTabEmptyCard}>
            <Text style={styles.programTabEmptyTitle}>Løpeprogram</Text>
            <Text style={styles.programTabBodyText}>
              Ingen lagrede programmer ennå. Opprett et program over, eller gå til Chat og be om et program – trykk deretter «Lagre som løpeprogram» på svaret.
            </Text>
          </View>
        ) : null}

        {programs.length > 0 && visiblePrograms.length === 0 ? (
          <View style={styles.programTabEmptyCard}>
            <Text style={styles.programTabBodyText}>
              {programTab === 'completed'
                ? 'Ingen fullførte løpeprogrammer ennå. Kryss av alle øktene i et program for å fullføre det.'
                : 'Ingen aktive løpeprogrammer akkurat nå. Opprett et nytt program over.'}
            </Text>
          </View>
        ) : null}

        {visiblePrograms.length > 0
          ? visiblePrograms.map((p, index) => {
              const doneCount = p.items.filter((i) => i.done).length;
              const total = p.items.length;
              const expanded = expandedIds[p.id] ?? false;
              const sorted = sortRunningProgramItems(p.items);
              const canMoveUp = visiblePrograms.length > 1 && index > 0;
              const canMoveDown = visiblePrograms.length > 1 && index < visiblePrograms.length - 1;
              return (
                <View key={p.id} style={{ marginTop: index === 0 ? 4 : 0, marginBottom: 14 }}>
                  <SwipeToDelete
                    onDelete={() => onDeleteProgram(p.id)}
                    confirmTitle="Slette program?"
                    confirmMessage={`"${p.title}" og alle avkrysninger fjernes.`}
                  >
                    <View style={styles.programCard}>
                      <View style={expanded ? styles.programCardHeaderExpanded : undefined}>
                        <View style={styles.programCardHeader}>
                          {reorderEditMode && visiblePrograms.length > 1 ? (
                            <View style={styles.programReorderStepper}>
                              <Pressable
                                onPress={() => {
                                  if (!canMoveUp) return;
                                  void Haptics.selectionAsync();
                                  onMoveRunningProgramInTab(programTab, p.id, 'up');
                                }}
                                disabled={!canMoveUp}
                                style={({ pressed }) => [
                                  styles.programReorderStepperBtn,
                                  pressed && canMoveUp && { opacity: 0.6 },
                                ]}
                                accessibilityRole="button"
                                accessibilityLabel={`Flytt ${p.title} opp`}
                                hitSlop={6}
                              >
                                <Text
                                  style={[
                                    styles.programReorderStepperText,
                                    !canMoveUp && styles.programReorderStepperTextDisabled,
                                  ]}
                                >
                                  ↑
                                </Text>
                              </Pressable>
                              <Pressable
                                onPress={() => {
                                  if (!canMoveDown) return;
                                  void Haptics.selectionAsync();
                                  onMoveRunningProgramInTab(programTab, p.id, 'down');
                                }}
                                disabled={!canMoveDown}
                                style={({ pressed }) => [
                                  styles.programReorderStepperBtn,
                                  pressed && canMoveDown && { opacity: 0.6 },
                                ]}
                                accessibilityRole="button"
                                accessibilityLabel={`Flytt ${p.title} ned`}
                                hitSlop={6}
                              >
                                <Text
                                  style={[
                                    styles.programReorderStepperText,
                                    !canMoveDown && styles.programReorderStepperTextDisabled,
                                  ]}
                                >
                                  ↓
                                </Text>
                              </Pressable>
                            </View>
                          ) : null}
                          <Pressable
                            onPress={() => toggleExpanded(p.id)}
                            style={styles.programHeaderTap}
                            accessibilityRole="button"
                            accessibilityLabel={
                              expanded ? `Skjul økter for ${p.title}` : `Vis økter for ${p.title}`
                            }
                          >
                            <View style={{ flex: 1, gap: 4 }}>
                              <View style={styles.programTitleRow}>
                                <Text
                                  style={styles.programCardTitle}
                                  numberOfLines={expanded ? undefined : 2}
                                >
                                  {p.title}
                                </Text>
                              </View>
                              <Text
                                style={styles.programTabMuted}
                                numberOfLines={expanded ? undefined : 2}
                              >
                                {p.goalSummary}
                              </Text>
                              {p.competitionName || p.competitionDate ? (
                                <Text style={styles.programCompetitionLine} numberOfLines={expanded ? undefined : 2}>
                                  🏁{' '}
                                  {[p.competitionName, p.competitionDate ? formatNorwegianDate(p.competitionDate) : null]
                                    .filter(Boolean)
                                    .join(' · ')}
                                </Text>
                              ) : null}
                            </View>
                          </Pressable>
                          <View style={styles.programHeaderActions}>
                            <Pressable
                              onPress={() => {
                                void Haptics.selectionAsync();
                                openEditModal(p);
                              }}
                              style={({ pressed }) => [styles.sessionEditIconBtn, pressed && { opacity: 0.5 }]}
                              accessibilityRole="button"
                              accessibilityLabel={`Rediger ${p.title}`}
                              hitSlop={8}
                            >
                              <Text style={styles.sessionEditIconText}>✎</Text>
                            </Pressable>
                            <Pressable
                              onPress={() => {
                                void Haptics.selectionAsync();
                                toggleExpanded(p.id);
                              }}
                              style={({ pressed }) => [styles.cardIconButton, pressed && { opacity: 0.6 }]}
                              accessibilityRole="button"
                              accessibilityLabel={
                                expanded ? `Skjul økter for ${p.title}` : `Vis økter for ${p.title}`
                              }
                              hitSlop={8}
                            >
                              <Text style={styles.cardIconButtonText}>{expanded ? '▴' : '▾'}</Text>
                            </Pressable>
                          </View>
                        </View>
                        <Pressable
                          onPress={() => toggleExpanded(p.id)}
                          style={styles.programMetaRow}
                          accessibilityRole="button"
                          accessibilityLabel={
                            expanded ? `Skjul økter for ${p.title}` : `Vis økter for ${p.title}`
                          }
                        >
                          <Text style={[styles.programMeta, { flex: 1 }]}>
                            {p.weeks} uker · {doneCount}/{total} økter fullført
                          </Text>
                          <Text style={styles.programUpdatedAt} numberOfLines={1}>
                            {`Sist oppdatert ${formatProgramUpdatedAt(p.updatedAt ?? p.createdAt)}`}
                          </Text>
                        </Pressable>
                      </View>
                      {expanded ? (
                        <View style={styles.programChecklist}>
                          {sorted.map((item) => {
                            const itemOpen = !!expandedItemIds[item.id];
                            const hasDescription = !!item.description?.trim();
                            return (
                              <View
                                key={item.id}
                                style={[styles.programCheckRow, item.done && styles.programCheckRowDone]}
                              >
                                <Pressable
                                  onPress={() => onToggleItem(p.id, item.id)}
                                  style={({ pressed }) => [
                                    styles.programCheckBoxBtn,
                                    pressed && { opacity: 0.6 },
                                  ]}
                                  hitSlop={8}
                                  accessibilityRole="checkbox"
                                  accessibilityState={{ checked: item.done }}
                                  accessibilityLabel={
                                    item.done
                                      ? 'Marker økten som ikke fullført'
                                      : 'Marker økten som fullført'
                                  }
                                >
                                  <Text style={styles.programCheckMark}>{item.done ? '☑' : '☐'}</Text>
                                </Pressable>
                                <Pressable
                                  onPress={() => toggleItemExpanded(item.id)}
                                  style={{ flex: 1, gap: 2 }}
                                  accessibilityRole="button"
                                  accessibilityLabel={
                                    itemOpen ? 'Skjul detaljer for økten' : 'Vis detaljer for økten'
                                  }
                                >
                                  <Text
                                    style={[styles.programItemDate, item.done && styles.programCheckDescDone]}
                                  >
                                    {[
                                      `Uke ${item.week}`,
                                      item.date ? formatNorwegianDate(item.date) : null,
                                      item.workoutType
                                        ? `${runWorkoutTypeOptions.find((o) => o.value === item.workoutType)?.emoji ?? '🏃'} ${runWorkoutTypeLabel(item.workoutType)}`
                                        : null,
                                    ]
                                      .filter(Boolean)
                                      .join(' – ')}
                                  </Text>
                                  {!(item.workoutType && item.title.trim() === item.workoutType.trim()) ? (
                                    <Text
                                      style={[styles.programCheckTitle, item.done && styles.programCheckTitleDone]}
                                    >
                                      {item.title}
                                    </Text>
                                  ) : null}
                                  {itemOpen && hasDescription ? (
                                    <Text
                                      style={[styles.programCheckDesc, item.done && styles.programCheckDescDone]}
                                    >
                                      {item.description}
                                    </Text>
                                  ) : null}
                                </Pressable>
                                {hasDescription ? (
                                  <Pressable
                                    onPress={() => toggleItemExpanded(item.id)}
                                    style={styles.programItemChevronBtn}
                                    hitSlop={8}
                                    accessibilityRole="button"
                                    accessibilityLabel={
                                      itemOpen ? 'Skjul detaljer for økten' : 'Vis detaljer for økten'
                                    }
                                  >
                                    <Text style={styles.programItemChevron}>{itemOpen ? '▾' : '▸'}</Text>
                                  </Pressable>
                                ) : null}
                              </View>
                            );
                          })}
                        </View>
                      ) : null}
                    </View>
                  </SwipeToDelete>
                </View>
              );
            })
          : null}
      </View>

      <Modal visible={formOpen} animationType="slide" onRequestClose={closeFormModal}>
        <SafeAreaView style={styles.programFormModalSafe}>
          <View style={styles.programFormModalHeader}>
            <Text style={styles.programFormModalTitle} numberOfLines={1}>
              {formDraft.mode === 'edit' ? 'Rediger sjekkliste' : 'Nytt løpeprogram'}
            </Text>
            <View style={styles.programFormModalHeaderActions}>
              <Pressable
                onPress={submitProgramForm}
                style={styles.programFormModalSave}
                accessibilityRole="button"
                accessibilityLabel={formDraft.mode === 'edit' ? 'Lagre løpeprogram' : 'Opprett løpeprogram'}
              >
                <Text style={styles.programFormModalSaveText}>
                  {formDraft.mode === 'edit' ? 'Lagre' : 'Opprett'}
                </Text>
              </Pressable>
              <Pressable onPress={closeFormModal} style={styles.programFormModalClose}>
                <Text style={styles.programFormModalCloseText}>Lukk</Text>
              </Pressable>
            </View>
          </View>
          <KeyboardAvoidingView
            style={{ flex: 1 }}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          >
            <ScrollView contentContainerStyle={styles.programFormModalScroll} keyboardShouldPersistTaps="handled">
              <Text style={styles.fieldLabel}>Navn</Text>
              <TextInput
                value={formDraft.title}
                onChangeText={(t) => setFormDraft((d) => ({ ...d, title: t }))}
                placeholder="F.eks. Ukeplan eller Oppkjøring til 10 km"
                style={styles.input}
              />

              <Text style={styles.fieldLabel}>Mål / notat (valgfritt)</Text>
              <TextInput
                value={formDraft.goalSummary}
                onChangeText={(t) => setFormDraft((d) => ({ ...d, goalSummary: t }))}
                placeholder="Kort beskrivelse"
                style={[styles.input, styles.textarea]}
                multiline
              />

              <Text style={styles.fieldLabel}>Konkurranse (valgfritt)</Text>
              <TextInput
                value={formDraft.competitionName}
                onChangeText={(t) => setFormDraft((d) => ({ ...d, competitionName: t }))}
                placeholder="F.eks. Oslo halvmaraton"
                style={styles.input}
              />
              <View style={styles.field}>
                <Text style={styles.fieldLabel}>Konkurranse-dato</Text>
                <Pressable
                  onPress={() => {
                    void Haptics.selectionAsync();
                    setDatePickerLineKey(null);
                    setCompetitionDatePickerOpen(true);
                  }}
                  style={styles.dropdownButton}
                  accessibilityRole="button"
                  accessibilityLabel="Velg konkurranse-dato"
                >
                  <Text
                    style={[
                      styles.dropdownButtonText,
                      !formDraft.competitionDate && styles.dropdownButtonPlaceholder,
                    ]}
                  >
                    {displayDate(formDraft.competitionDate)}
                  </Text>
                  <Text style={styles.dropdownChevron}>📅</Text>
                </Pressable>
                {formDraft.competitionDate ? (
                  <Pressable
                    onPress={() => {
                      void Haptics.selectionAsync();
                      setFormDraft((d) => ({ ...d, competitionDate: '' }));
                    }}
                    style={{ marginTop: 8 }}
                    accessibilityRole="button"
                    accessibilityLabel="Fjern konkurranse-dato"
                  >
                    <Text style={styles.muted}>Fjern dato</Text>
                  </Pressable>
                ) : null}
              </View>

              <View style={{ flexDirection: 'row', gap: 12 }}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.fieldLabel}>Antall uker</Text>
                  <Pressable
                    onPress={() => {
                      void Haptics.selectionAsync();
                      setShowWeeksPicker(true);
                    }}
                    style={styles.dropdownButton}
                    accessibilityRole="button"
                    accessibilityLabel="Velg antall uker"
                  >
                    <Text style={styles.dropdownButtonText}>
                      {`${Math.max(1, parseInt((formDraft.weeksStr || '1').replace(/\D/g, ''), 10) || 1)}`}
                    </Text>
                    <Text style={styles.dropdownChevron}>▾</Text>
                  </Pressable>
                </View>

                <View style={{ flex: 1 }}>
                  <Text style={styles.fieldLabel}>Antall økter i uken</Text>
                  <Pressable
                    onPress={() => {
                      void Haptics.selectionAsync();
                      setShowSessionsPerWeekPicker(true);
                    }}
                    style={styles.dropdownButton}
                    accessibilityRole="button"
                    accessibilityLabel="Velg antall økter per uke"
                  >
                    <Text style={styles.dropdownButtonText}>
                      {(() => {
                        const n = Math.max(
                          1,
                          parseInt((formDraft.sessionsPerWeekStr || '3').replace(/\D/g, ''), 10) || 3,
                        );
                        return `${n}`;
                      })()}
                    </Text>
                    <Text style={styles.dropdownChevron}>▾</Text>
                  </Pressable>
                </View>
              </View>

              <Text style={styles.programFormSessionsTitle}>Økter</Text>
              {(() => {
                const weekGroups = new Map<number, { line: typeof formDraft.lines[number]; index: number }[]>();
                formDraft.lines.forEach((line, index) => {
                  const w = Math.max(
                    1,
                    parseInt((line.week || '1').replace(/\D/g, ''), 10) || 1,
                  );
                  const arr = weekGroups.get(w);
                  if (arr) arr.push({ line, index });
                  else weekGroups.set(w, [{ line, index }]);
                });
                const sortedWeeks = Array.from(weekGroups.keys()).sort((a, b) => a - b);
                return sortedWeeks.map((weekNum) => {
                  const items = weekGroups.get(weekNum) ?? [];
                  const weekOpen = isFormWeekOpen(weekNum);
                  return (
                    <View key={`week-${weekNum}`} style={styles.programFormWeekGroup}>
                      <Pressable
                        onPress={() => toggleFormWeekExpanded(weekNum)}
                        style={[styles.programFormWeekHeader, { justifyContent: 'space-between' }]}
                        accessibilityRole="button"
                        accessibilityLabel={
                          weekOpen
                            ? `Skjul økter for uke ${weekNum}`
                            : `Vis økter for uke ${weekNum}`
                        }
                      >
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 }}>
                          <Text style={styles.programFormWeekTitle}>{`Uke ${weekNum}`}</Text>
                          <Text style={styles.programFormWeekCount}>
                            {`${items.length} ${items.length === 1 ? 'økt' : 'økter'}`}
                          </Text>
                        </View>
                        <Pressable
                          onPress={() => {
                            void Haptics.selectionAsync();
                            toggleFormWeekExpanded(weekNum);
                          }}
                          style={({ pressed }) => [styles.cardIconButton, pressed && { opacity: 0.6 }, { marginLeft: 'auto' }]}
                          accessibilityRole="button"
                          accessibilityLabel={
                            weekOpen
                              ? `Skjul økter for uke ${weekNum}`
                              : `Vis økter for uke ${weekNum}`
                          }
                          hitSlop={8}
                        >
                          <Text style={styles.cardIconButtonText}>{weekOpen ? '▴' : '▾'}</Text>
                        </Pressable>
                      </Pressable>
                      {weekOpen ? (
                        <View style={styles.programFormWeekBody}>
                          {items.map(({ line, index }) => {
                            const open = isFormLineOpen(line.key);
                            const lineWeekNum = Math.max(
                              1,
                              parseInt((line.week || '1').replace(/\D/g, ''), 10) || 1,
                            );
                            const workoutOption = runWorkoutTypeOptions.find(
                              (o) => o.value === line.workoutType,
                            );
                            const summaryParts: string[] = [`Uke ${lineWeekNum}`];
                            if (workoutOption) {
                              summaryParts.push(`${workoutOption.emoji} ${workoutOption.label}`);
                            } else if (line.title.trim()) {
                              summaryParts.push(line.title.trim());
                            }
                            const summary = summaryParts.join(' · ');
                            const canDeleteLine = formDraft.lines.length > 1;
                            const cardContent = (
                  <View style={styles.programFormLineCard}>
                    <Pressable
                      onPress={() => toggleFormLineExpanded(line.key)}
                      style={styles.programFormLineHeader}
                      accessibilityRole="button"
                      accessibilityLabel={
                        open
                          ? 'Skjul detaljer for økten'
                          : 'Vis detaljer for økten'
                      }
                    >
                      <View style={{ flex: 1, gap: 2 }}>
                        <Text style={styles.programFormLineHeadingInline}>Økt</Text>
                        <Text style={styles.programFormLineSummary} numberOfLines={1}>
                          {summary}
                        </Text>
                      </View>
                      <Text style={styles.programFormLineChevron}>{open ? '▼' : '▶'}</Text>
                    </Pressable>
                    {open ? (
                      <View style={styles.programFormLineBody}>
                        <Text style={styles.fieldLabel}>Tittel</Text>
                        <TextInput
                          value={line.title}
                          onChangeText={(t) => {
                            setFormDraft((d) => {
                              const next = [...d.lines];
                              next[index] = { ...next[index], title: t };
                              return { ...d, lines: next };
                            });
                          }}
                          placeholder="Tittel (påkrevd)"
                          style={styles.input}
                        />
                        <View style={styles.field}>
                          <Text style={styles.fieldLabel}>Dato (valgfritt)</Text>
                          <Pressable
                            onPress={() => {
                              void Haptics.selectionAsync();
                              setCompetitionDatePickerOpen(false);
                              setDatePickerLineKey(line.key);
                            }}
                            style={styles.dropdownButton}
                          >
                            <Text style={[styles.dropdownButtonText, !line.date && styles.dropdownButtonPlaceholder]}>
                              {displayDate(line.date)}
                            </Text>
                            <Text style={styles.dropdownChevron}>📅</Text>
                          </Pressable>
                        </View>
                        <View style={styles.field}>
                          <Text style={styles.fieldLabel}>Type økt</Text>
                          <View style={styles.optionGrid}>
                            {runWorkoutTypeOptions.map((option) => {
                              const active = line.workoutType === option.value;
                              return (
                                <Pressable
                                  key={option.value}
                                  onPress={() => {
                                    void Haptics.selectionAsync();
                                    setFormDraft((d) => {
                                      const next = [...d.lines];
                                      const prev = next[index];
                                      // Behold tittel hvis brukeren har skrevet noe eget;
                                      // bare auto-fyll når feltet er tomt eller er igjen
                                      // fra en tidligere type-valg.
                                      const prevWasAutoFilled =
                                        !prev.title.trim() ||
                                        runWorkoutTypeOptions.some(
                                          (o) => o.value === prev.title.trim(),
                                        );
                                      next[index] = {
                                        ...prev,
                                        workoutType: option.value,
                                        title: prevWasAutoFilled ? option.value : prev.title,
                                      };
                                      return { ...d, lines: next };
                                    });
                                  }}
                                  style={({ pressed }) => [
                                    styles.workoutTypeTile,
                                    active ? styles.chipActive : styles.chipInactive,
                                    pressed && { opacity: 0.75, transform: [{ scale: 0.97 }] },
                                  ]}
                                >
                                  <Text style={styles.workoutTypeEmoji}>{option.emoji}</Text>
                                  <Text
                                    style={[styles.workoutTypeLabel, active ? styles.chipTextActive : styles.chipTextInactive]}
                                    numberOfLines={1}
                                  >
                                    {option.label}
                                  </Text>
                                </Pressable>
                              );
                            })}
                          </View>
                        </View>
                        <Text style={styles.fieldLabel}>Uke</Text>
                        <Pressable
                          onPress={() => {
                            void Haptics.selectionAsync();
                            setWeekPickerLineKey(line.key);
                          }}
                          style={styles.dropdownButton}
                          accessibilityRole="button"
                          accessibilityLabel="Velg uke for økten"
                        >
                          <Text style={styles.dropdownButtonText}>{`Uke ${lineWeekNum}`}</Text>
                          <Text style={styles.dropdownChevron}>▾</Text>
                        </Pressable>
                        <Text style={styles.fieldLabel}>Beskrivelse (valgfritt)</Text>
                        <TextInput
                          value={line.description}
                          onChangeText={(t) => {
                            setFormDraft((d) => {
                              const next = [...d.lines];
                              next[index] = { ...next[index], description: t };
                              return { ...d, lines: next };
                            });
                          }}
                          placeholder="Innhold i økten"
                          style={[styles.input, styles.textarea]}
                          multiline
                        />
                      </View>
                    ) : null}
                  </View>
                );
                            return canDeleteLine ? (
                              <SwipeToDelete
                                key={line.key}
                                onDelete={() =>
                                  setFormDraft((d) => ({
                                    ...d,
                                    lines: d.lines.filter((_, i) => i !== index),
                                  }))
                                }
                                confirmTitle="Slett økt?"
                                confirmMessage={`"${
                                  line.title.trim() || 'Økt'
                                }" fjernes fra programmet.`}
                              >
                                {cardContent}
                              </SwipeToDelete>
                            ) : (
                              <View key={line.key}>{cardContent}</View>
                            );
                          })}
                          <Pressable
                            onPress={() => {
                              void Haptics.selectionAsync();
                              setFormDraft((d) => {
                                const sameWeekCount = d.lines.filter(
                                  (l) =>
                                    Math.max(1, parseInt((l.week || '1').replace(/\D/g, ''), 10) || 1) ===
                                    weekNum,
                                ).length;
                                return {
                                  ...d,
                                  lines: [
                                    ...d.lines,
                                    {
                                      key: newProgramLineKey(),
                                      week: String(weekNum),
                                      dayLabel: `Økt ${sameWeekCount + 1}`,
                                      title: '',
                                      description: '',
                                      date: '',
                                      done: false,
                                      workoutType: '',
                                    },
                                  ],
                                };
                              });
                            }}
                            style={styles.programFormAddLineBtn}
                            accessibilityRole="button"
                            accessibilityLabel={`Legg til økt i uke ${weekNum}`}
                          >
                            <Text style={styles.programFormAddLineBtnText}>+ Legg til økt</Text>
                          </Pressable>
                        </View>
                      ) : null}
                    </View>
                  );
                });
              })()}

              <Pressable onPress={submitProgramForm} style={[styles.primaryButtonFull, { marginTop: 16 }]}>
                <Text style={styles.primaryButtonText}>
                  {formDraft.mode === 'edit' ? 'Lagre' : 'Opprett løpeprogram'}
                </Text>
              </Pressable>
            </ScrollView>
          </KeyboardAvoidingView>

          {datePickerLineKey != null && Platform.OS === 'android' ? (
            <DateTimePicker
              value={parseDateStr(datePickerLine?.date || '')}
              mode="date"
              display="default"
              onChange={(event, selected) => {
                const key = datePickerLineKey;
                setDatePickerLineKey(null);
                if (key && event?.type === 'set' && selected) {
                  updateLineDate(key, toDateStr(selected));
                }
              }}
            />
          ) : null}

          <Modal
            visible={datePickerLineKey != null && Platform.OS !== 'android'}
            transparent
            animationType="fade"
            onRequestClose={() => setDatePickerLineKey(null)}
          >
            <Pressable style={styles.dropdownBackdrop} onPress={() => setDatePickerLineKey(null)}>
              <Pressable style={styles.dropdownSheet} onPress={(e) => e.stopPropagation()}>
                <Text style={styles.dropdownSheetTitle}>Velg dato</Text>
                <DateTimePicker
                  value={parseDateStr(datePickerLine?.date || '')}
                  mode="date"
                  display="inline"
                  locale="nb-NO"
                  onChange={(_event, selected) => {
                    if (datePickerLineKey && selected) {
                      updateLineDate(datePickerLineKey, toDateStr(selected));
                    }
                  }}
                />
                <Pressable
                  onPress={() => setDatePickerLineKey(null)}
                  style={[styles.pinkButtonFull, { marginTop: 8 }]}
                >
                  <Text style={styles.pinkButtonText}>Ferdig</Text>
                </Pressable>
              </Pressable>
            </Pressable>
          </Modal>

          {competitionDatePickerOpen && Platform.OS === 'android' ? (
            <DateTimePicker
              value={parseDateStr(formDraft.competitionDate || '')}
              mode="date"
              display="default"
              onChange={(event, selected) => {
                setCompetitionDatePickerOpen(false);
                if (event?.type === 'set' && selected) {
                  setFormDraft((d) => ({ ...d, competitionDate: toDateStr(selected) }));
                }
              }}
            />
          ) : null}

          <Modal
            visible={competitionDatePickerOpen && Platform.OS !== 'android'}
            transparent
            animationType="fade"
            onRequestClose={() => setCompetitionDatePickerOpen(false)}
          >
            <Pressable style={styles.dropdownBackdrop} onPress={() => setCompetitionDatePickerOpen(false)}>
              <Pressable style={styles.dropdownSheet} onPress={(e) => e.stopPropagation()}>
                <Text style={styles.dropdownSheetTitle}>Konkurranse-dato</Text>
                <DateTimePicker
                  value={parseDateStr(formDraft.competitionDate || '')}
                  mode="date"
                  display="inline"
                  locale="nb-NO"
                  onChange={(_event, selected) => {
                    if (selected) {
                      setFormDraft((d) => ({ ...d, competitionDate: toDateStr(selected) }));
                    }
                  }}
                />
                <Pressable
                  onPress={() => setCompetitionDatePickerOpen(false)}
                  style={[styles.pinkButtonFull, { marginTop: 8 }]}
                >
                  <Text style={styles.pinkButtonText}>Ferdig</Text>
                </Pressable>
              </Pressable>
            </Pressable>
          </Modal>

          <Modal
            visible={weekPickerLineKey != null}
            transparent
            animationType="fade"
            onRequestClose={() => setWeekPickerLineKey(null)}
          >
            <View style={styles.dropdownBackdrop}>
              <Pressable style={StyleSheet.absoluteFill} onPress={() => setWeekPickerLineKey(null)} />
              <View style={styles.dropdownSheet}>
                <Text style={styles.dropdownSheetTitle}>Velg uke</Text>
                {weekPickerLineKey != null ? (
                  (() => {
                    const max = weekMaxForLine(weekPickerLine?.week || '1');
                    const currentWeek = Math.max(
                      1,
                      Math.min(max, parseInt((weekPickerLine?.week || '1').replace(/\D/g, ''), 10) || 1),
                    );
                    const weekVisible = 3;
                    const weekSelectionBottom = (WHEEL_ITEM_HEIGHT * weekVisible) / 2 - WHEEL_ITEM_HEIGHT / 2;
                    return (
                      <View style={[styles.wheelContainer, { paddingVertical: 0 }]}>
                        <View
                          pointerEvents="none"
                          style={[styles.wheelSelectionBar, { bottom: weekSelectionBottom }]}
                        />
                        <View style={[styles.wheelColumn, { flex: 1 }]}>
                          <WheelPicker
                            count={max}
                            value={currentWeek - 1}
                            onChange={(idx) => {
                              if (weekPickerLineKey) updateLineWeek(weekPickerLineKey, idx + 1);
                            }}
                            formatItem={(i) => String(i + 1)}
                            visibleCount={weekVisible}
                          />
                        </View>
                      </View>
                    );
                  })()
                ) : null}
                <Pressable
                  onPress={() => setWeekPickerLineKey(null)}
                  style={[styles.pinkButtonFull, { marginTop: 12 }]}
                >
                  <Text style={styles.pinkButtonText}>Ferdig</Text>
                </Pressable>
              </View>
            </View>
          </Modal>

          <Modal
            visible={showWeeksPicker}
            transparent
            animationType="fade"
            onRequestClose={() => setShowWeeksPicker(false)}
          >
            <View style={styles.dropdownBackdrop}>
              <Pressable style={StyleSheet.absoluteFill} onPress={() => setShowWeeksPicker(false)} />
              <View style={styles.dropdownSheet}>
                <Text style={styles.dropdownSheetTitle}>Antall uker</Text>
                {showWeeksPicker ? (
                  (() => {
                    const maxWeeks = 52;
                    const currentWeeks = Math.max(
                      1,
                      Math.min(
                        maxWeeks,
                        parseInt((formDraft.weeksStr || '1').replace(/\D/g, ''), 10) || 1,
                      ),
                    );
                    const visible = 3;
                    const selectionBottom = (WHEEL_ITEM_HEIGHT * visible) / 2 - WHEEL_ITEM_HEIGHT / 2;
                    return (
                      <View style={[styles.wheelContainer, { paddingVertical: 0 }]}>
                        <View
                          pointerEvents="none"
                          style={[styles.wheelSelectionBar, { bottom: selectionBottom }]}
                        />
                        <View style={[styles.wheelColumn, { flex: 1 }]}>
                          <WheelPicker
                            count={maxWeeks}
                            value={currentWeeks - 1}
                            onChange={(idx) => changeWeeksStr(String(idx + 1))}
                            formatItem={(i) => String(i + 1)}
                            visibleCount={visible}
                          />
                        </View>
                      </View>
                    );
                  })()
                ) : null}
                <Pressable
                  onPress={() => setShowWeeksPicker(false)}
                  style={[styles.pinkButtonFull, { marginTop: 12 }]}
                >
                  <Text style={styles.pinkButtonText}>Ferdig</Text>
                </Pressable>
              </View>
            </View>
          </Modal>

          <Modal
            visible={showSessionsPerWeekPicker}
            transparent
            animationType="fade"
            onRequestClose={() => setShowSessionsPerWeekPicker(false)}
          >
            <View style={styles.dropdownBackdrop}>
              <Pressable
                style={StyleSheet.absoluteFill}
                onPress={() => setShowSessionsPerWeekPicker(false)}
              />
              <View style={styles.dropdownSheet}>
                <Text style={styles.dropdownSheetTitle}>Antall økter i uken</Text>
                {showSessionsPerWeekPicker ? (
                  (() => {
                    const maxSessions = 14;
                    const currentSessions = Math.max(
                      1,
                      Math.min(
                        maxSessions,
                        parseInt((formDraft.sessionsPerWeekStr || '3').replace(/\D/g, ''), 10) || 3,
                      ),
                    );
                    const visible = 3;
                    const selectionBottom = (WHEEL_ITEM_HEIGHT * visible) / 2 - WHEEL_ITEM_HEIGHT / 2;
                    return (
                      <View style={[styles.wheelContainer, { paddingVertical: 0 }]}>
                        <View
                          pointerEvents="none"
                          style={[styles.wheelSelectionBar, { bottom: selectionBottom }]}
                        />
                        <View style={[styles.wheelColumn, { flex: 1 }]}>
                          <WheelPicker
                            count={maxSessions}
                            value={currentSessions - 1}
                            onChange={(idx) => changeSessionsPerWeekStr(String(idx + 1))}
                            formatItem={(i) => String(i + 1)}
                            visibleCount={visible}
                          />
                        </View>
                      </View>
                    );
                  })()
                ) : null}
                <Pressable
                  onPress={() => setShowSessionsPerWeekPicker(false)}
                  style={[styles.pinkButtonFull, { marginTop: 12 }]}
                >
                  <Text style={styles.pinkButtonText}>Ferdig</Text>
                </Pressable>
              </View>
            </View>
          </Modal>
        </SafeAreaView>
      </Modal>
    </>
  );
}

type ChatTabHandle = {
  /**
   * Be treneren kommentere en nettopp loggført økt. Lager en assistant-melding
   * i chatten basert på en kort beskrivelse av økten + en kort historikk-tekst.
   * Returnerer true hvis en ny melding faktisk ble lagt til (så caller kan vise
   * uleste-indikator), false ellers.
   */
  requestSessionFeedback: (params: {
    sessionDescription: string;
    historyDescription: string;
    source: 'manual' | 'strava';
  }) => Promise<boolean>;
  /** Dagen etter registrert konkurranse: én oppfølgingsmelding per program/dato (idempotent). */
  maybeSendCompetitionFollowups: (programs: SavedRunningProgram[]) => Promise<void>;
  /** Synkroniser chat-state etter at historikk er tømt fra lagring (innstillinger). */
  resetChatToWelcome: () => void;
};

const ChatTab = React.forwardRef<
  ChatTabHandle,
  {
    onSaveRunningProgram: (payload: RunningProgramPayload) => void;
    onAfterProgramSaved?: () => void;
    onCompetitionFollowupPosted?: () => void;
    runningPrograms: SavedRunningProgram[];
  }
>(function ChatTab({ onSaveRunningProgram, onAfterProgramSaved, onCompetitionFollowupPosted, runningPrograms }, ref) {
  const userId = useUserId();
  const chatStorageKey = userKey(CHAT_STORAGE_KEY, userId);
  const competitionFollowupKey = userKey(COMPETITION_FOLLOWUP_KEY, userId);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [isSending, setIsSending] = useState(false);

  const listRef = useRef<FlatList<ChatListItem> | null>(null);
  // Track whether the user is near the newest message. On an inverted list
  // offset 0 is the visual bottom (newest). We only auto-scroll when the user
  // is already near the bottom, so browsing history isn't interrupted.
  const isNearBottomRef = useRef(true);

  // Build interleaved list of day separators + messages. `messages` is
  // stored newest-first; the inverted FlatList renders data[0] at the visual
  // bottom, so we insert the day label AFTER the oldest message of each day
  // group in the data array (which places it visually ABOVE that day's group).
  const chatItems = useMemo<ChatListItem[]>(() => {
    const items: ChatListItem[] = [];
    if (isSending) {
      items.push({ type: 'typing', id: 'typing-indicator' });
    }
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      items.push({ type: 'message', id: m.id, message: m });
      const next = messages[i + 1];
      const currentDay = chatDayKey(m.createdAt);
      const nextDay = next ? chatDayKey(next.createdAt) : null;
      if (nextDay !== currentDay) {
        items.push({ type: 'separator', id: `sep-${currentDay}-${m.id}`, ts: m.createdAt });
      }
    }
    return items;
  }, [messages, isSending]);

  // Last inn lagret chat-historikk for den innloggede brukeren. Server-URL
  // håndteres av AuthProvider – ikke ChatTab – slik at alle API-kall (auth,
  // Strava og chat) deler samme base og ikke kan komme i utakt.
  useEffect(() => {
    (async () => {
      try {
        const rawMessages = await AsyncStorage.getItem(chatStorageKey);
        if (rawMessages) {
          const parsed = JSON.parse(rawMessages) as unknown;
          if (Array.isArray(parsed)) {
            setMessages(parsed as ChatMessage[]);
            return;
          }
        }
        setMessages([
          {
            id: String(Date.now()),
            role: 'assistant',
            text:
              'Hei! Jeg er din personlige trener. Jeg kan svare på spørsmål om løping og trening, lage løpeprogrammer du kan lagre som sjekkliste under fanen Løpeprogram, og hente oversikt fra Strava når det er koblet til. Hva lurer du på i dag?',
            createdAt: Date.now(),
          },
        ]);
      } catch {
        // ignore
      }
    })();
  }, [chatStorageKey]);

  useEffect(() => {
    AsyncStorage.setItem(chatStorageKey, JSON.stringify(messages)).catch(() => undefined);
    // Only auto-scroll to newest when the user is already near the bottom.
    // Otherwise they are browsing history and we must not yank the list.
    if (!isNearBottomRef.current) return;
    try {
      listRef.current?.scrollToOffset({ offset: 0, animated: true });
    } catch {
      // ignore
    }
  }, [messages, chatStorageKey]);

  React.useImperativeHandle(
    ref,
    () => ({
      resetChatToWelcome() {
        setMessages([
          {
            id: `${Date.now()}-welcome`,
            role: 'assistant',
            text:
              'Hei! Jeg er din personlige trener. Jeg kan svare på spørsmål om løping og trening, lage løpeprogrammer du kan lagre som sjekkliste under fanen Løpeprogram, og hente oversikt fra Strava når det er koblet til. Hva lurer du på i dag?',
            createdAt: Date.now(),
          },
        ]);
      },
      async requestSessionFeedback({ sessionDescription, historyDescription, source }) {
        if (!sessionDescription?.trim()) return false;
        setIsSending(true);
        try {
          const resp = await apiFetch('/chat/session-feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              session: sessionDescription,
              history: historyDescription || '',
              source,
            }),
            timeoutMs: 45000,
          });
          const raw = await parseFetchJsonBody(resp);
          if (!resp.ok) {
            const body = raw as { error?: string };
            throw new Error(body?.error || `Server feilet (${resp.status}).`);
          }
          const data = raw as { text?: string };
          const text = (data?.text || '').trim();
          if (!text) return false;
          const assistantMsg: ChatMessage = {
            id: `${Date.now()}-coach`,
            role: 'assistant',
            text,
            createdAt: Date.now(),
          };
          setMessages((prev) => [assistantMsg, ...prev]);
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          return true;
        } catch (e: any) {
          // Stille i loggen — vi vil ikke spamme chatten med tekniske feilmeldinger
          // hver gang en økt loggføres. Bruker ser bare at treneren ikke kommenterte.
          console.warn('[coach feedback] failed:', e?.message || e);
          return false;
        } finally {
          setIsSending(false);
        }
      },
      async maybeSendCompetitionFollowups(programs: SavedRunningProgram[]) {
        const y = yesterdayYyyyMmDd();
        const candidates = programs.filter(
          (p) => p.competitionName?.trim() && p.competitionDate?.trim() === y,
        );
        if (candidates.length === 0) return;

        let sent: Record<string, true> = {};
        try {
          const raw = await AsyncStorage.getItem(competitionFollowupKey);
          if (raw) {
            const parsed = JSON.parse(raw) as unknown;
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              sent = parsed as Record<string, true>;
            }
          }
        } catch {
          /* ignore */
        }

        for (const p of candidates) {
          const markKey = `${p.id}:${p.competitionDate}`;
          if (sent[markKey]) continue;

          try {
            const resp = await apiFetch('/chat/competition-followup', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                competitionName: p.competitionName!.trim(),
                competitionDate: p.competitionDate!,
                programTitle: p.title,
              }),
              timeoutMs: 45000,
            });
            const rawBody = await parseFetchJsonBody(resp);
            if (!resp.ok) {
              const body = rawBody as { error?: string };
              throw new Error(body?.error || `Server feilet (${resp.status}).`);
            }
            const data = rawBody as { text?: string };
            const text = (data?.text || '').trim();
            if (!text) continue;

            const assistantMsg: ChatMessage = {
              id: `${Date.now()}-comp-${p.id}`,
              role: 'assistant',
              text,
              createdAt: Date.now(),
            };
            setMessages((prev) => [assistantMsg, ...prev]);
            sent = { ...sent, [markKey]: true };
            await AsyncStorage.setItem(competitionFollowupKey, JSON.stringify(sent));
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            onCompetitionFollowupPosted?.();
          } catch (e: any) {
            console.warn('[competition followup] failed:', e?.message || e);
          }
        }
      },
    }),
    [competitionFollowupKey, onCompetitionFollowupPosted],
  );

  async function send() {
    const text = draft.trim();
    if (!text || isSending) return;

    void Haptics.selectionAsync();
    Keyboard.dismiss();
    setDraft('');

    const userMsg: ChatMessage = {
      id: `${Date.now()}-u`,
      role: 'user',
      text,
      createdAt: Date.now(),
    };

    setMessages((prev) => [userMsg, ...prev]);
    setIsSending(true);

    try {
      const baseCoachSystem =
        'Du er en personlig treningsrådgiver (PRT) for en løper som også driver med styrketrening. Brukeren driver KUN med løping og styrke – ikke triatlon, sykling eller svømming. Ikke foreslå sykkel-, svømme- eller triatlonøkter. Svar på spørsmål om trening, løping, styrke, restitusjon, pulssoner og planlegging. Når brukeren ber om et løpeprogram over flere uker (eller har et tydelig tidsbegrenset mål), kaller du verktøyet create_running_program slik at øktene kan lagres som sjekkliste i appen. Verktøyet create_running_program inneholder bare løpeøkter: for hver økt er workout_type allerede én av «Rolig løpetur», «Terkeløkt», «Intervaller», «Konkurranse», og feltet description skal kun beskrive selve løpeøkta (distanse, varighet, intensitet, puls, drag, terreng). Ikke skriv styrke, core, knebøy, gym, vekter eller «etter løpetur + styrke» i noen description — det hører ikke hjemme i løpesjekklisten. Vil du anbefale styrke ved siden av, gjør det i det vanlige chat-svaret, ikke i verktøyets sessions. Når brukeren i chatten oppgir konkurranse eller dato (f.eks. «10. juni»), skal main_race_date og main_race_name i create_running_program alltid bygge på det brukeren **sier i samtalen nå** — ikke på eldre konkurranser som bare står lagret i listen fra fanen Løpeprogram. Når brukeren har et hovedløp eller oppgitt konkurranse, fyll valgfrie feltene main_race_name og main_race_date (YYYY-MM-DD) i create_running_program slik at appen og du husker datoen. Når main_race_date er satt, skal feltet weeks og alle økters week aldri overskride antall uker frem til konkurransen (programmet skal ikke fortsette etter konkurranseuken). For create_running_program: klassifiser hver planlagte løpeøkt med nøyaktig én workout_type blant de fire som i appen ved manuell løpelogging: «Rolig løpetur», «Terkeløkt», «Intervaller», «Konkurranse». Velg typen ut fra øktens hovedformål (varig rolig grunnlag, terskel/tempo, intervaller, eller konkurranse/test). I create_running_program må sessions inneholde hele blokken: minst én økt per uke for hver uke fra 1 til weeks (vanligvis 3–6 økter per uke), ikke bare de første par ukene. workout_type blir øktens tittel i sjekklisten; skriv konkrete løpedetaljer kun i description. For korte ukeplaner (noen dager) kan create_workout_plan brukes. Strava-data kan hentes med get_training_summary når det er relevant. Etter et verktøykall: oppsummer resultatet kort og vennlig for brukeren (3–7 punkter ved plan), uten å sitere rå JSON eller interne feltnavn. Vær konkret og basert på treningslære. Bruk norsk, vær varm og motiverende, men hold svarene korte og presise.';
      const raceFromMessage = extractStatedCompetitionYmdFromText(text);
      const racePriorityBlock = raceFromMessage
        ? `\n\nPRIORITET (siste brukermelding): Konkurranse med dato ${raceFromMessage.human} — sett main_race_date=${raceFromMessage.ymd} i create_running_program når du lager program mot dette løpet (og passende main_race_name hvis brukeren nevnte navn). Bruk ikke en annen dato fra listen over lagrede løpeprogram.`
        : '';
      const coachSystem = `${baseCoachSystem}${buildCompetitionCoachContext(runningPrograms)}${racePriorityBlock}`;
      const payload = {
        messages: [
          {
            role: 'system',
            content: coachSystem,
          },
          ...[userMsg, ...messages]
            .slice(0, 20)
            .reverse()
            .filter((m) => (m.text ?? '').trim().length > 0)
            .map((m) => ({
              role: m.role,
              content: typeof m.text === 'string' ? m.text : String(m.text ?? ''),
            })),
        ],
      };

      const resp = await apiFetch('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        timeoutMs: 45000,
      });

      const raw = await parseFetchJsonBody(resp);

      if (!resp.ok) {
        const body = raw as { error?: string };
        throw new Error(body?.error || `Server feilet (${resp.status}). Sjekk at chat-serveren kjører.`);
      }

      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('Uventet svarformat fra server (forventet JSON-objekt).');
      }
      const data = raw as { text?: string; toolResult?: ChatToolResult };
      const tr = data?.toolResult;
      let replyText = (data?.text || '').trim();
      if (!replyText && tr?.kind === 'running_program') {
        replyText =
          'Her er løpeprogrammet. Trykk «Lagre som løpeprogram» for å bruke det under fanen Løpeprogram.';
      }
      if (!replyText && tr?.kind === 'tool_card') {
        replyText = 'Her er et kort svar (se boksen under).';
      }
      if (!replyText && !tr) {
        throw new Error('Tomt svar fra chat (JSON OK men ingen tekst eller verktøydata).');
      }

      const assistantMsg: ChatMessage = {
        id: `${Date.now()}-a`,
        role: 'assistant',
        text: replyText,
        createdAt: Date.now(),
        toolCard: tr?.kind === 'tool_card' ? tr : undefined,
        runningProgram: tr?.kind === 'running_program' ? tr : undefined,
      };

      setMessages((prev) => [assistantMsg, ...prev]);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      const hint =
        Platform.OS === 'web'
          ? typeof window !== 'undefined' && window.location?.protocol === 'https:'
            ? 'Nettverksfeil mot API (skal gå til samme domene). Prøv hard refresh, annen nettleser eller inkognito. Sjekk at /health og POST /chat fungerer fra Vercel.'
            : 'På https-sider kan ikke nettleseren kalle http:// (localhost/Mac) — da blir det «Failed to fetch». Bruk samme domene som siden eller sjekk /health.'
          : 'På iPhone: Chat → Innstillinger → sett server-URL til https://ditt-prosjekt.vercel.app (eller kjør backend på Mac og bruk Mac-ens IP:8787 på samme Wi‑Fi).';
      setMessages((prev) => [
        {
          id: `${Date.now()}-err`,
          role: 'assistant',
          text:
            `Jeg fikk ikke kontakt med chat-serveren.\n\n${hint}\n\n` +
            `Feil: ${String(e?.message || e)}`,
          createdAt: Date.now(),
        },
        ...prev,
      ]);
    } finally {
      setIsSending(false);
    }
  }

  function Bubble({ message }: { message: ChatMessage }) {
    const isUser = message.role === 'user';
    const rp = message.runningProgram;
    const rpSaved = message.runningProgramSaved;
    return (
      <View style={[styles.bubbleRow, isUser ? styles.bubbleRowRight : styles.bubbleRowLeft]}>
        <View style={styles.bubbleColumn}>
        <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAssistant]}>
          <Text style={[styles.bubbleText, isUser ? styles.bubbleTextUser : styles.bubbleTextAssistant]}>
            {message.text}
          </Text>
          {message.toolCard ? (
            <View style={styles.toolCard}>
              <Text style={styles.toolCardTitle}>{message.toolCard.title}</Text>
              {message.toolCard.bullets?.slice(0, 8).map((b, idx) => (
                <Text key={idx} style={styles.toolCardBullet}>
                  • {b}
                </Text>
              ))}
            </View>
          ) : null}
          {rp ? (
            <View style={styles.runningProgramPreview}>
              <Text style={styles.runningProgramPreviewTitle}>{rp.title}</Text>
              <Text style={styles.runningProgramPreviewGoal}>{rp.goalSummary}</Text>
              {rp.competitionName || rp.competitionDate ? (
                <Text style={styles.runningProgramPreviewCompetition}>
                  🏁{' '}
                  {[rp.competitionName, rp.competitionDate ? formatNorwegianDate(rp.competitionDate) : null]
                    .filter(Boolean)
                    .join(' · ')}
                </Text>
              ) : null}
              <Text style={styles.runningProgramPreviewMeta}>
                {rp.weeks} uker · {rp.sessions.length} økter i planen
              </Text>
              {rp.sessions.slice(0, 4).map((s, idx) => (
                <Text key={idx} style={styles.runningProgramPreviewLine}>
                  • Uke {s.week} ({s.dayLabel}): {s.title}
                </Text>
              ))}
              {rp.sessions.length > 4 ? (
                <Text style={styles.runningProgramPreviewMore}>+ {rp.sessions.length - 4} flere …</Text>
              ) : null}
              <Pressable
                onPress={() => {
                  if (rpSaved) return;
                  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                  onSaveRunningProgram(rp);
                  setMessages((prev) => {
                    const next = prev.map((m) =>
                      m.id === message.id ? { ...m, runningProgramSaved: true } : m,
                    );
                    // Persist synchronously so the flag survives even if the user
                    // switches tab right after (which would unmount ChatTab before
                    // the effect-based save runs).
                    AsyncStorage.setItem(chatStorageKey, JSON.stringify(next)).catch(
                      () => undefined,
                    );
                    return next;
                  });
                  onAfterProgramSaved?.();
                }}
                style={({ pressed }) => [
                  styles.saveProgramButton,
                  rpSaved && styles.saveProgramButtonDisabled,
                  pressed && !rpSaved && { opacity: 0.85 },
                ]}
                disabled={!!rpSaved}
              >
                <Text
                  style={[
                    styles.saveProgramButtonText,
                    rpSaved && styles.saveProgramButtonTextDisabled,
                  ]}
                >
                  {rpSaved ? '✓ Løpeprogram lagret' : 'Lagre som løpeprogram'}
                </Text>
              </Pressable>
            </View>
          ) : null}
        </View>
        <Text style={[styles.bubbleTime, isUser ? styles.bubbleTimeRight : styles.bubbleTimeLeft]}>
          {formatChatTime(message.createdAt)}
        </Text>
        </View>
      </View>
    );
  }

  function DaySeparator({ ts }: { ts: number }) {
    return (
      <View style={styles.dayDividerRow}>
        <View style={styles.dayDividerLine} />
        <Text style={styles.dayDividerLabel}>{formatChatDayLabel(ts)}</Text>
        <View style={styles.dayDividerLine} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, gap: 12 }}>
      <View style={styles.chatHeader}>
        <Text style={styles.chatTitle}>Din personlige trener</Text>
      </View>

      <View style={styles.chatSurface}>
        <View style={{ flex: 1, minHeight: 0 }}>
          <FlatList
            ref={(r) => {
              listRef.current = r;
            }}
            data={chatItems}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) =>
              item.type === 'separator' ? (
                <DaySeparator ts={item.ts} />
              ) : item.type === 'typing' ? (
                <View style={styles.bubbleRow}>
                  <View style={styles.typingBubble}>
                    <ActivityIndicator size="small" />
                    <Text style={styles.typingText}>Skriver…</Text>
                  </View>
                </View>
              ) : (
                <Bubble message={item.message} />
              )
            }
            inverted
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingHorizontal: 12, paddingTop: 12, paddingBottom: 16, gap: 10 }}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
            onScroll={(e) => {
              // On an inverted list, contentOffset.y grows as the user scrolls
              // up (towards older messages). Treat anything within ~80px of
              // offset 0 as "near bottom" (viewing newest).
              const y = e?.nativeEvent?.contentOffset?.y ?? 0;
              isNearBottomRef.current = y <= 80;
            }}
            scrollEventThrottle={64}
          />
        </View>

          <View style={styles.composerRow}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder="Spør treneren din… (f.eks. «Lag et 12 ukers program mot 10 km under 50 min»)"
              style={styles.composerInput}
              multiline
              returnKeyType="send"
              submitBehavior="blurAndSubmit"
              onSubmitEditing={() => {
                void send();
              }}
              onKeyPress={(e: any) => {
                if (Platform.OS === 'web' && e?.nativeEvent?.key === 'Enter' && !e?.nativeEvent?.shiftKey) {
                  e.preventDefault?.();
                  void send();
                }
              }}
            />
            <Pressable
              onPress={send}
              style={({ pressed }) => [
                styles.sendButton,
                !draft.trim() || isSending ? styles.sendButtonDisabled : null,
                pressed && draft.trim() && !isSending && { opacity: 0.85, transform: [{ scale: 0.96 }] },
              ]}
            >
              <Text style={styles.sendButtonText}>{isSending ? '...' : 'Send'}</Text>
            </Pressable>
          </View>
      </View>
    </View>
  );
});

const WHEEL_ITEM_HEIGHT = 40;
const WHEEL_VISIBLE = 5;
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = Array.from({ length: 60 }, (_, i) => i);
const SECONDS = Array.from({ length: 60 }, (_, i) => i);

function WheelPicker({
  count,
  value,
  onChange,
  formatItem,
  visibleCount,
}: {
  count: number;
  value: number;
  onChange: (v: number) => void;
  /** Standard er to siffer; bruk f.eks. for puls 50–220 */
  formatItem?: (index: number) => string;
  /** Antall synlige rader (odde tall). Default 5. */
  visibleCount?: number;
}) {
  const scrollRef = useRef<ScrollView | null>(null);
  const initRef = useRef(false);
  const visible = visibleCount && visibleCount > 0 ? visibleCount : WHEEL_VISIBLE;
  const padding = ((visible - 1) / 2) * WHEEL_ITEM_HEIGHT;
  const scrollHeight = WHEEL_ITEM_HEIGHT * visible;
  const items = useMemo(() => Array.from({ length: count }, (_, i) => i), [count]);

  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    const idx = Math.max(0, Math.min(count - 1, value));
    const id = setTimeout(() => {
      scrollRef.current?.scrollTo({ y: idx * WHEEL_ITEM_HEIGHT, animated: false });
    }, 50);
    return () => clearTimeout(id);
  }, []);

  function labelFor(index: number) {
    if (formatItem) return formatItem(index);
    return String(index).padStart(2, '0');
  }

  return (
    <ScrollView
      ref={scrollRef}
      style={[styles.wheelScroll, { height: scrollHeight }]}
      showsVerticalScrollIndicator={false}
      snapToInterval={WHEEL_ITEM_HEIGHT}
      decelerationRate="fast"
      contentContainerStyle={{ paddingVertical: padding }}
      onMomentumScrollEnd={(e) => {
        const offsetY = e.nativeEvent.contentOffset.y;
        const idx = Math.round(offsetY / WHEEL_ITEM_HEIGHT);
        const clamped = Math.max(0, Math.min(count - 1, idx));
        if (clamped !== value) {
          void Haptics.selectionAsync();
          onChange(clamped);
        }
      }}
    >
      {items.map((v) => {
        const selected = v === value;
        return (
          <View key={v} style={styles.wheelItem}>
            <Text style={[styles.wheelItemText, selected ? styles.wheelItemTextActive : styles.wheelItemTextInactive]}>
              {labelFor(v)}
            </Text>
          </View>
        );
      })}
    </ScrollView>
  );
}

function parseTimeParts(s: string): [number, number, number] {
  const [h, m, sec] = (s || '').split(':').map((p) => Number(p));
  return [Number.isFinite(h) ? h : 0, Number.isFinite(m) ? m : 0, Number.isFinite(sec) ? sec : 0];
}

function joinTimeParts(h: number, m: number, s: number): string {
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

function displayTime(s: string): string {
  if (!s || s === '00:00:00') return 'Velg tid';
  const [h, m, sec] = parseTimeParts(s);
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}t`);
  if (m > 0) parts.push(`${m}min`);
  if (sec > 0 || parts.length === 0) parts.push(`${sec}sek`);
  return parts.join(' ');
}

const KM_INT = Array.from({ length: 100 }, (_, i) => i);
const KM_DEC = Array.from({ length: 10 }, (_, i) => i);

const HR_MIN_BPM = 50;
const HR_MAX_BPM = 220;
const HR_BPM_COUNT = HR_MAX_BPM - HR_MIN_BPM + 1;

function hrIndexFromStoredValue(s: string | undefined): number {
  const n = Number(s);
  if (!Number.isFinite(n) || n < HR_MIN_BPM) return 70;
  return Math.max(0, Math.min(HR_BPM_COUNT - 1, Math.round(n) - HR_MIN_BPM));
}

function displayAverageHrButton(s: string | undefined): string {
  if (!s) return 'Velg gjennomsnittspuls (valgfritt)';
  return `${s} bpm`;
}

function parseDistanceParts(s: string): [number, number] {
  if (!s) return [0, 0];
  const num = Number(s.replace(',', '.'));
  if (!Number.isFinite(num) || num < 0) return [0, 0];
  const whole = Math.floor(num);
  const tenth = Math.round((num - whole) * 10);
  if (tenth >= 10) return [Math.min(99, whole + 1), 0];
  return [Math.min(99, whole), tenth];
}

function joinDistanceParts(whole: number, tenth: number): string {
  return tenth === 0 ? String(whole) : `${whole}.${tenth}`;
}

function displayDistance(s: string): string {
  if (!s) return 'Velg distanse';
  const [w, t] = parseDistanceParts(s);
  if (w === 0 && t === 0) return 'Velg distanse';
  return `${joinDistanceParts(w, t)} km`;
}

function parseDateStr(s: string): Date {
  if (!s) return new Date();
  const [y, m, d] = s.split('-').map(Number);
  if (!y || !m || !d) return new Date();
  return new Date(y, m - 1, d);
}

function toDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Lokalt kalenderdato for «i går», YYYY-MM-DD (oppfølging etter konkurranse). */
function yesterdayYyyyMmDd(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return toDateStr(d);
}

function formatNorwegianDate(s: string): string {
  if (!s) return '';
  try {
    const d = parseDateStr(s);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${day}.${month}.${year}`;
  } catch {
    return s;
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Velg år slik at datoen ikke havner i fortiden (lokal kalender). */
function ymdFromDayMonthWithSmartYear(day: number, month: number): string {
  const now = new Date();
  let year = now.getFullYear();
  const candidate = new Date(year, month - 1, day);
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (candidate < todayStart) year += 1;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/**
 * Plukker ut konkurransedato fra brukerens melding (f.eks. «10. juni», ISO, 10.06.2026).
 * Gir modellen eksplisitt main_race_date så den ikke blander med eldre lagrede programmer.
 */
function extractStatedCompetitionYmdFromText(text: string): { ymd: string; human: string } | null {
  const t = text.trim();
  if (!t) return null;

  const iso = t.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) {
    const y = Number(iso[1]);
    const mo = Number(iso[2]);
    const d = Number(iso[3]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      const ymd = `${y}-${iso[2]}-${iso[3]}`;
      return { ymd, human: formatNorwegianDate(ymd) };
    }
  }

  const dmy = t.match(/\b(\d{1,2})\.(\d{1,2})\.(20\d{2})\b/);
  if (dmy) {
    const d = Number(dmy[1]);
    const mo = Number(dmy[2]);
    const y = Number(dmy[3]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      const ymd = `${y}-${pad2(mo)}-${pad2(d)}`;
      return { ymd, human: formatNorwegianDate(ymd) };
    }
  }

  const monthNameToNum: Record<string, number> = {
    januar: 1,
    jan: 1,
    februar: 2,
    feb: 2,
    mars: 3,
    mar: 3,
    april: 4,
    apr: 4,
    mai: 5,
    juni: 6,
    jun: 6,
    juli: 7,
    jul: 7,
    august: 8,
    aug: 8,
    september: 9,
    sep: 9,
    sept: 9,
    oktober: 10,
    okt: 10,
    november: 11,
    nov: 11,
    desember: 12,
    des: 12,
  };

  type Cand = { ymd: string; human: string; score: number; idx: number };
  const cands: Cand[] = [];
  const re = /\b(\d{1,2})\.?\s*([a-zA-ZæøåÆØÅ]+)\b/g;
  const lower = t.toLowerCase();
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) != null) {
    const day = Number(m[1]);
    const monStr = m[2].toLowerCase().replace(/\.$/, '');
    const month = monthNameToNum[monStr];
    if (!month || day < 1 || day > 31) continue;
    const idx = m.index;
    const win = lower.slice(Math.max(0, idx - 140), Math.min(lower.length, idx + 60));
    const score = /\bkonkurranse|hovedløp|løpet|løp\s+på|måløp|race|10\s*km|5\s*km|halvmaraton|maraton|oppløp|nm\b/i.test(
      win,
    )
      ? 80
      : 15;
    const ymd = ymdFromDayMonthWithSmartYear(day, month);
    cands.push({ ymd, human: formatNorwegianDate(ymd), score, idx });
  }
  if (cands.length === 0) return null;
  cands.sort((a, b) => b.score - a.score || b.idx - a.idx);
  const top = cands[0]!;
  if (top.score < 80 && cands.every((c) => c.score < 80)) {
    const withRaceWord = /\bkonkurranse|hovedløp|måløp|halvmaraton|maraton|race\b/i.test(t);
    if (!withRaceWord) return null;
  }
  return { ymd: top.ymd, human: top.human };
}

function buildCompetitionCoachContext(programs: SavedRunningProgram[]): string {
  const lines: string[] = [];
  for (const p of programs) {
    const name = p.competitionName?.trim();
    const date = p.competitionDate?.trim();
    if (!name && !date) continue;
    const dateFmt = date ? formatNorwegianDate(date) : 'dato ikke satt';
    const label = name || 'Konkurranse';
    lines.push(
      `• Program «${p.title}»: ${label}${date ? ` — ${dateFmt} (${date})` : ''}`,
    );
  }
  if (lines.length === 0) return '';
  return (
    '\n\nKun som referanse — allerede lagret under fanen Løpeprogram (kan være et annet løp enn det brukeren nettopp skriver om i chat):\n' +
    lines.join('\n') +
    '\nBruk **ikke** disse datoene i create_running_program når brukeren i samme samtale har sagt en ny konkurranse eller dato — da gjelder det brukeren sier nå. Ta hensyn til dato og navn ved oppfølging. Unngå å gjenta samme oppfølgingsspørsmål samme dag hvis det allerede er sendt en egen melding om konkurransen.'
  );
}

function displayDate(s: string): string {
  if (!s) return 'Velg dato';
  return formatNorwegianDate(s);
}

function formatChatTime(ts: number): string {
  try {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  } catch {
    return '';
  }
}

function showRunningProgramHelp() {
  Alert.alert(
    'Løpeprogram og Chat',
    'Du kan opprette et program her med «Nytt løpeprogram», eller få hjelp i fanen Chat: beskriv målet eller ønsket plan. Når du får et forslag til løpeprogram i chatten, trykk «Lagre som løpeprogram» på svaret – da legges programmet inn her. Under redigering kan du legge inn konkurranse og dato, så treneren i chatten ser det og kan følge opp dagen etter.',
    [{ text: 'OK' }],
  );
}

function formatProgramUpdatedAt(ts: number | undefined): string {
  if (!ts || !Number.isFinite(ts)) return '';
  try {
    const d = new Date(ts);
    const today = new Date();
    const sameDay =
      d.getFullYear() === today.getFullYear() &&
      d.getMonth() === today.getMonth() &&
      d.getDate() === today.getDate();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const isYesterday =
      d.getFullYear() === yesterday.getFullYear() &&
      d.getMonth() === yesterday.getMonth() &&
      d.getDate() === yesterday.getDate();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const time = `${hh}:${mm}`;
    if (sameDay) return `i dag ${time}`;
    if (isYesterday) return `i går ${time}`;
    const datePart = d.toLocaleDateString('nb-NO', {
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
    });
    return `${datePart} ${time}`;
  } catch {
    return '';
  }
}

function chatDayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatChatDayLabel(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (chatDayKey(ts) === chatDayKey(today.getTime())) return 'I dag';
  if (chatDayKey(ts) === chatDayKey(yesterday.getTime())) return 'I går';
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}.${month}.${year}`;
}

function SessionModal({
  isOpen,
  form,
  isEditing,
  onClose,
  onSubmit,
  onFieldChange,
}: {
  isOpen: boolean;
  form: SessionForm;
  isEditing: boolean;
  onClose: () => void;
  onSubmit: () => void;
  onFieldChange: <K extends keyof SessionForm>(field: K, value: SessionForm[K]) => void;
}) {
  const isStrength = form.mode === 'strength';
  const isRunning = form.mode === 'running';
  const [showShoePicker, setShowShoePicker] = useState(false);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTimePicker, setShowTimePicker] = useState(false);
  const [showDistancePicker, setShowDistancePicker] = useState(false);
  const [showHeartRatePicker, setShowHeartRatePicker] = useState(false);
  const [timeH, timeM, timeS] = parseTimeParts(form.time);
  const [distWhole, distTenth] = parseDistanceParts(form.distance);
  const hrWheelIndex = hrIndexFromStoredValue(form.averageHeartRate);

  function setTimePartValue(part: 'h' | 'm' | 's', value: number) {
    const next: [number, number, number] = [timeH, timeM, timeS];
    if (part === 'h') next[0] = value;
    else if (part === 'm') next[1] = value;
    else next[2] = value;
    onFieldChange('time', joinTimeParts(next[0], next[1], next[2]));
  }

  function setDistancePartValue(part: 'whole' | 'tenth', value: number) {
    const next: [number, number] = [distWhole, distTenth];
    if (part === 'whole') next[0] = value;
    else next[1] = value;
    onFieldChange('distance', joinDistanceParts(next[0], next[1]));
  }

  return (
    <Modal visible={isOpen} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.modalSafe}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>{isEditing ? 'Rediger økt' : 'Ny økt'}</Text>
          <Pressable onPress={onClose} style={styles.modalClose}>
            <Text style={styles.modalCloseText}>Lukk</Text>
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.modalContent} keyboardShouldPersistTaps="handled">
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Velg type økt</Text>
            <View style={styles.fieldRow}>
              <View style={styles.fieldHalf}>
                <Chip
                  label="🏃 Løping"
                  active={isRunning}
                onPress={() => {
                  onFieldChange('mode', 'running');
                  onFieldChange('workoutType', '');
                  onFieldChange('exercises', []);
                }}
                  style={styles.chipWide}
                />
              </View>
              <View style={styles.fieldHalf}>
                <Chip
                  label="🏋️ Styrke"
                  active={isStrength}
                onPress={() => {
                  onFieldChange('mode', 'strength');
                  onFieldChange('workoutType', '');
                  onFieldChange('averageHeartRate', '');
                  onFieldChange('exercises', []);
                }}
                  style={styles.chipWide}
                />
              </View>
            </View>
          </View>

          <View style={styles.fieldRow}>
            <View style={styles.fieldHalf}>
              <Text style={styles.fieldLabel}>Dato</Text>
              <Pressable onPress={() => setShowDatePicker(true)} style={({ pressed }) => [styles.dropdownButton, pressed && { opacity: 0.7 }]}>
                <Text style={[styles.dropdownButtonText, !form.date && styles.dropdownButtonPlaceholder]}>
                  {displayDate(form.date)}
                </Text>
                <Text style={styles.dropdownChevron}>📅</Text>
              </Pressable>
            </View>
            <View style={styles.fieldHalf}>
              <Text style={styles.fieldLabel}>Tid</Text>
              <Pressable onPress={() => setShowTimePicker(true)} style={({ pressed }) => [styles.dropdownButton, pressed && { opacity: 0.7 }]}>
                <Text style={[styles.dropdownButtonText, !form.time && styles.dropdownButtonPlaceholder]}>
                  {displayTime(form.time)}
                </Text>
                <Text style={styles.dropdownChevron}>⏱️</Text>
              </Pressable>
            </View>
          </View>

          {isRunning ? (
            <>
              <View style={styles.fieldRow}>
                <View style={styles.fieldHalf}>
                  <Text style={styles.fieldLabel}>Distanse</Text>
                  <Pressable onPress={() => setShowDistancePicker(true)} style={({ pressed }) => [styles.dropdownButton, pressed && { opacity: 0.7 }]}>
                    <Text style={[styles.dropdownButtonText, !form.distance && styles.dropdownButtonPlaceholder]}>
                      {displayDistance(form.distance)}
                    </Text>
                  </Pressable>
                </View>
                <View style={styles.fieldHalf}>
                  <Text style={styles.fieldLabel}>Gjennomsnittspuls</Text>
                  <Pressable onPress={() => setShowHeartRatePicker(true)} style={({ pressed }) => [styles.dropdownButton, pressed && { opacity: 0.7 }]}>
                    <Text
                      style={[
                        styles.dropdownButtonText,
                        !form.averageHeartRate && styles.dropdownButtonPlaceholder,
                      ]}
                      numberOfLines={1}
                    >
                      {displayAverageHrButton(form.averageHeartRate)}
                    </Text>
                    <Text style={styles.dropdownChevron}>❤️</Text>
                  </Pressable>
                  {form.averageHeartRate ? (
                    <Pressable
                      onPress={() => onFieldChange('averageHeartRate', '')}
                      style={{ alignSelf: 'flex-start', marginTop: 2 }}
                    >
                      <Text style={styles.linkButtonText}>Fjern puls</Text>
                    </Pressable>
                  ) : null}
                </View>
              </View>

              <View style={styles.field}>
                <Text style={styles.fieldLabel}>Skovalg</Text>
                <Pressable onPress={() => setShowShoePicker(true)} style={({ pressed }) => [styles.dropdownButton, pressed && { opacity: 0.7 }]}>
                  <Text style={[styles.dropdownButtonText, !form.shoe && styles.dropdownButtonPlaceholder]}>
                    {form.shoe || 'Velg sko'}
                  </Text>
                  <Text style={styles.dropdownChevron}>▾</Text>
                </Pressable>
              </View>

              <View style={styles.field}>
                <Text style={styles.fieldLabel}>Type økt</Text>
                <View style={styles.optionGrid}>
                  {runWorkoutTypeOptions.map((option) => {
                    const active = form.workoutType === option.value;
                    return (
                      <Pressable
                        key={option.value}
                        onPress={() => onFieldChange('workoutType', option.value)}
                        style={({ pressed }) => [
                          styles.workoutTypeTile,
                          active ? styles.chipActive : styles.chipInactive,
                          pressed && { opacity: 0.75, transform: [{ scale: 0.97 }] },
                        ]}
                      >
                        <Text style={styles.workoutTypeEmoji}>{option.emoji}</Text>
                        <Text
                          style={[styles.workoutTypeLabel, active ? styles.chipTextActive : styles.chipTextInactive]}
                          numberOfLines={1}
                        >
                          {option.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            </>
          ) : isStrength ? (
            <>
            <View style={styles.field}>
              <Text style={styles.fieldLabel}>Type økt</Text>
              <View style={styles.optionGrid}>
                {strengthWorkoutTypeOptions.map((option) => {
                  const active = form.workoutType === option.value;
                  return (
                    <Pressable
                      key={option.value}
                      onPress={() => onFieldChange('workoutType', option.value)}
                      style={({ pressed }) => [
                        styles.workoutTypeTile,
                        active ? styles.chipActive : styles.chipInactive,
                        pressed && { opacity: 0.75, transform: [{ scale: 0.97 }] },
                      ]}
                    >
                      <Text style={styles.workoutTypeEmoji}>{option.emoji}</Text>
                      <Text
                        style={[styles.workoutTypeLabel, active ? styles.chipTextActive : styles.chipTextInactive]}
                        numberOfLines={1}
                      >
                        {option.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
            </>
          ) : null}

          {form.mode ? (
          <>
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Følelse</Text>
            <View style={styles.chipGrid}>
              {feelingOptions.map((option) => (
                <Chip
                  key={option.value}
                  label={`${option.emoji} ${option.label}`}
                  active={form.feeling === option.value}
                  onPress={() => onFieldChange('feeling', option.value)}
                />
              ))}
            </View>
          </View>


          {isRunning ? (
            <>
              <View style={styles.field}>
                <Text style={styles.fieldLabel}>Sted</Text>
                <View style={styles.optionRow}>
                  {(
                    [
                      { value: 'innendors', label: 'Innendørs', emoji: '🏠' },
                      { value: 'utendors', label: 'Utendørs', emoji: '🌤️' },
                    ] as const
                  ).map((option) => {
                    const active = form.location === option.value;
                    return (
                      <Pressable
                        key={option.value}
                        onPress={() => {
                          onFieldChange('location', option.value);
                          if (option.value === 'innendors') onFieldChange('weather', '');
                        }}
                        style={({ pressed }) => [
                          styles.optionTile,
                          active ? styles.chipActive : styles.chipInactive,
                          pressed && { opacity: 0.75, transform: [{ scale: 0.97 }] },
                        ]}
                      >
                        <Text style={styles.optionTileEmoji}>{option.emoji}</Text>
                        <Text
                          style={[styles.optionTileLabel, active ? styles.chipTextActive : styles.chipTextInactive]}
                          numberOfLines={1}
                        >
                          {option.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>

              {form.location === 'utendors' ? (
                <View style={styles.field}>
                  <Text style={styles.fieldLabel}>Vær</Text>
                  <View style={styles.weatherRow}>
                    {weatherOptions.map((option) => {
                      const active = form.weather === option.value;
                      return (
                        <Pressable
                          key={option.value}
                          onPress={() => onFieldChange('weather', option.value)}
                          style={({ pressed }) => [
                            styles.weatherTile,
                            active ? styles.chipActive : styles.chipInactive,
                            pressed && { opacity: 0.75, transform: [{ scale: 0.95 }] },
                          ]}
                        >
                          <Text style={styles.weatherEmoji}>{option.emoji}</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
              ) : null}
            </>
          ) : null}
          </>
          ) : null}

          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Notater</Text>
            <TextInput
              value={form.notes}
              onChangeText={(t) => onFieldChange('notes', t)}
              placeholder="Skriv notater om økten"
              style={[styles.input, styles.textarea]}
              multiline
            />
          </View>

          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Pressable
              onPress={onClose}
              style={({ pressed }) => [styles.secondaryButtonFull, pressed && { opacity: 0.7 }]}
            >
              <Text style={styles.secondaryButtonText}>Avbryt</Text>
            </Pressable>
            <Pressable
              onPress={onSubmit}
              style={({ pressed }) => [styles.primaryButtonFull, pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] }]}
            >
              <Text style={styles.primaryButtonText}>{isEditing ? 'Lagre endringer' : 'Lagre'}</Text>
            </Pressable>
          </View>
        </ScrollView>

        {showDatePicker && Platform.OS === 'android' ? (
          <DateTimePicker
            value={parseDateStr(form.date)}
            mode="date"
            display="default"
            onChange={(event, selected) => {
              setShowDatePicker(false);
              if (event?.type === 'set' && selected) {
                onFieldChange('date', toDateStr(selected));
              }
            }}
          />
        ) : null}

        <Modal visible={showDatePicker && Platform.OS !== 'android'} transparent animationType="fade" onRequestClose={() => setShowDatePicker(false)}>
          <Pressable style={styles.dropdownBackdrop} onPress={() => setShowDatePicker(false)}>
            <Pressable style={styles.dropdownSheet} onPress={(e) => e.stopPropagation()}>
              <Text style={styles.dropdownSheetTitle}>Velg dato</Text>
              <DateTimePicker
                value={parseDateStr(form.date)}
                mode="date"
                display="inline"
                locale="nb-NO"
                onChange={(_event, selected) => {
                  if (selected) onFieldChange('date', toDateStr(selected));
                }}
              />
              <Pressable
                onPress={() => setShowDatePicker(false)}
                style={[styles.pinkButtonFull, { marginTop: 8 }]}
              >
                <Text style={styles.pinkButtonText}>Ferdig</Text>
              </Pressable>
            </Pressable>
          </Pressable>
        </Modal>

        <Modal visible={showTimePicker} transparent animationType="fade" onRequestClose={() => setShowTimePicker(false)}>
          <View style={styles.dropdownBackdrop}>
            <Pressable style={StyleSheet.absoluteFill} onPress={() => setShowTimePicker(false)} />
            <View style={styles.dropdownSheet}>
              <Text style={styles.dropdownSheetTitle}>Velg tid</Text>
              <View style={styles.wheelContainer}>
                <View pointerEvents="none" style={styles.wheelSelectionBar} />
                <View style={styles.wheelColumn}>
                  <Text style={styles.wheelHeader}>timer</Text>
                  <WheelPicker count={HOURS.length} value={timeH} onChange={(v) => setTimePartValue('h', v)} />
                </View>
                <View style={styles.wheelColumn}>
                  <Text style={styles.wheelHeader}>min</Text>
                  <WheelPicker count={MINUTES.length} value={timeM} onChange={(v) => setTimePartValue('m', v)} />
                </View>
                <View style={styles.wheelColumn}>
                  <Text style={styles.wheelHeader}>sek</Text>
                  <WheelPicker count={SECONDS.length} value={timeS} onChange={(v) => setTimePartValue('s', v)} />
                </View>
              </View>
              <Pressable
                onPress={() => setShowTimePicker(false)}
                style={[styles.pinkButtonFull, { marginTop: 12 }]}
              >
                <Text style={styles.pinkButtonText}>Ferdig</Text>
              </Pressable>
            </View>
          </View>
        </Modal>

        <Modal visible={showDistancePicker} transparent animationType="fade" onRequestClose={() => setShowDistancePicker(false)}>
          <View style={styles.dropdownBackdrop}>
            <Pressable style={StyleSheet.absoluteFill} onPress={() => setShowDistancePicker(false)} />
            <View style={styles.dropdownSheet}>
              <Text style={styles.dropdownSheetTitle}>Velg distanse</Text>
              <View style={styles.wheelContainer}>
                <View pointerEvents="none" style={styles.wheelSelectionBar} />
                <View style={styles.wheelColumn}>
                  <Text style={styles.wheelHeader}>km</Text>
                  <WheelPicker count={KM_INT.length} value={distWhole} onChange={(v) => setDistancePartValue('whole', v)} />
                </View>
                <View style={styles.wheelColumnSeparator}>
                  <Text style={styles.wheelDecimalDot}>.</Text>
                </View>
                <View style={styles.wheelColumn}>
                  <Text style={styles.wheelHeader}>tiendels</Text>
                  <WheelPicker count={KM_DEC.length} value={distTenth} onChange={(v) => setDistancePartValue('tenth', v)} />
                </View>
              </View>
              <Pressable
                onPress={() => setShowDistancePicker(false)}
                style={[styles.pinkButtonFull, { marginTop: 12 }]}
              >
                <Text style={styles.pinkButtonText}>Ferdig</Text>
              </Pressable>
            </View>
          </View>
        </Modal>

        <Modal visible={showHeartRatePicker} transparent animationType="fade" onRequestClose={() => setShowHeartRatePicker(false)}>
          <View style={styles.dropdownBackdrop}>
            <Pressable style={StyleSheet.absoluteFill} onPress={() => setShowHeartRatePicker(false)} />
            <View style={styles.dropdownSheet}>
              <Text style={styles.dropdownSheetTitle}>Gjennomsnittspuls (50–220)</Text>
              <View style={styles.wheelContainer}>
                <View pointerEvents="none" style={styles.wheelSelectionBar} />
                <View style={[styles.wheelColumn, { flex: 1 }]}>
                  <Text style={styles.wheelHeader}>slag/min</Text>
                  <WheelPicker
                    count={HR_BPM_COUNT}
                    value={hrWheelIndex}
                    onChange={(idx) => onFieldChange('averageHeartRate', String(HR_MIN_BPM + idx))}
                    formatItem={(i) => String(HR_MIN_BPM + i)}
                  />
                </View>
              </View>
              <Pressable
                onPress={() => setShowHeartRatePicker(false)}
                style={[styles.pinkButtonFull, { marginTop: 12 }]}
              >
                <Text style={styles.pinkButtonText}>Ferdig</Text>
              </Pressable>
            </View>
          </View>
        </Modal>

        <Modal visible={showShoePicker} transparent animationType="fade" onRequestClose={() => setShowShoePicker(false)}>
          <Pressable style={styles.dropdownBackdrop} onPress={() => setShowShoePicker(false)}>
            <Pressable style={styles.dropdownSheet} onPress={(e) => e.stopPropagation()}>
              <Text style={styles.dropdownSheetTitle}>Velg sko</Text>
              <ScrollView style={{ maxHeight: 360 }}>
                <Pressable
                  onPress={() => {
                    onFieldChange('shoe', '');
                    setShowShoePicker(false);
                  }}
                  style={[styles.dropdownItem, !form.shoe && styles.dropdownItemActive]}
                >
                  <Text style={[styles.dropdownItemText, styles.dropdownButtonPlaceholder]}>Ingen valgt</Text>
                </Pressable>
                {shoeOptions.map((shoe) => (
                  <Pressable
                    key={shoe}
                    onPress={() => {
                      onFieldChange('shoe', shoe);
                      setShowShoePicker(false);
                    }}
                    style={[styles.dropdownItem, form.shoe === shoe && styles.dropdownItemActive]}
                  >
                    <Text style={styles.dropdownItemText}>{shoe}</Text>
                    {form.shoe === shoe ? <Text style={styles.dropdownCheck}>✓</Text> : null}
                  </Pressable>
                ))}
              </ScrollView>
            </Pressable>
          </Pressable>
        </Modal>
      </SafeAreaView>
    </Modal>
  );
}

function AuthenticatedApp() {
  const userId = useUserId();
  const auth = useAuth();
  const { serverUrl, setServerUrl, resetToDefaultServerUrl, user: authUser, signOut } = auth;
  const chatApiBase = serverUrl;
  const chatStorageKey = userKey(CHAT_STORAGE_KEY, userId);
  const sessionsKey = userKey(STORAGE_KEY, userId);
  const runningProgramsKey = userKey(RUNNING_PROGRAMS_KEY, userId);
  const stravaCacheKeyForUser = userKey(STRAVA_CACHE_KEY, userId);

  const [activeTab, setActiveTab] = useState<Tab>('Chat');
  const [chatSettingsOpen, setChatSettingsOpen] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [hasUnreadChat, setHasUnreadChat] = useState(false);
  const [toast, setToast] = useState<{ id: number; message: string } | null>(null);
  const chatRef = useRef<ChatTabHandle>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((message: string) => {
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
    setToast({ id: Date.now(), message });
    toastTimerRef.current = setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, 2800);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);
  // Hold en alltid-fersk referanse til aktiv tab slik at async-callbacks
  // (f.eks. trenerens svar etter en logget økt) kan sjekke om brukeren ER på
  // chat-fanen i øyeblikket meldingen kommer.
  const activeTabRef = useRef<Tab>(activeTab);
  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvt, () => setKeyboardVisible(true));
    const hideSub = Keyboard.addListener(hideEvt, () => setKeyboardVisible(false));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  // I dev (`expo start --web`) injiseres favicon + apple-touch slik Safari får samme ikon som i produksjon.
  // Bygg (`apply-web-icons.mjs`) legger dette inn i dist/index.html for Vercel.
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined' || !__DEV__) return;
    if (document.querySelector('link[data-training-log-web-icon]')) return;
    const touch = document.createElement('link');
    touch.rel = 'apple-touch-icon';
    touch.href = '/favicon.png';
    touch.setAttribute('data-training-log-web-icon', '1');
    document.head.appendChild(touch);
    const iconPng = document.createElement('link');
    iconPng.rel = 'icon';
    iconPng.type = 'image/png';
    iconPng.href = '/favicon.png';
    iconPng.setAttribute('data-training-log-web-icon', '1');
    document.head.appendChild(iconPng);
    if (!document.querySelector('meta[name="apple-mobile-web-app-title"]')) {
      const title = document.createElement('meta');
      title.setAttribute('name', 'apple-mobile-web-app-title');
      title.setAttribute('content', 'Treningslogg');
      document.head.appendChild(title);
    }
  }, []);

  const [form, setForm] = useState<SessionForm>(createDefaultForm());
  const [sessions, setSessions] = useState<Session[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [runningPrograms, setRunningPrograms] = useState<SavedRunningProgram[]>([]);
  const [runningProgramsLoaded, setRunningProgramsLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshSignal, setRefreshSignal] = useState(0);

  const onPullToRefresh = useCallback(async () => {
    setRefreshing(true);
    void Haptics.selectionAsync();
    try {
      const [rawSessions, rawPrograms] = await Promise.all([
        AsyncStorage.getItem(sessionsKey),
        AsyncStorage.getItem(runningProgramsKey),
      ]);
      if (rawSessions) {
        const parsed = JSON.parse(rawSessions) as unknown;
        if (Array.isArray(parsed)) setSessions(parsed as Session[]);
      }
      if (rawPrograms) {
        const parsed = JSON.parse(rawPrograms) as unknown;
        if (Array.isArray(parsed)) setRunningPrograms(parsed as SavedRunningProgram[]);
      }
    } catch {
      // ignore
    }
    setRefreshSignal((n) => n + 1);
    // gi Strava-kortene litt tid til å vise spinner før vi skjuler pull-to-refresh
    await new Promise((resolve) => setTimeout(resolve, 700));
    setRefreshing(false);
  }, [sessionsKey, runningProgramsKey]);

  // Lukk innstillinger når brukeren bytter fane (unngå «hengende» modal).
  useEffect(() => {
    setChatSettingsOpen(false);
  }, [activeTab]);

  const openAppSettings = useCallback(() => {
    void Haptics.selectionAsync();
    setChatSettingsOpen(true);
  }, []);

  const closeAppSettings = useCallback(() => {
    setChatSettingsOpen(false);
  }, []);

  const dailyQuote = useMemo(() => {
    const index = new Date().getDate() % motivationalQuotes.length;
    return motivationalQuotes[index];
  }, []);

  const totals = useMemo(() => calculateTotals(sessions), [sessions]);
  const latestWeather = sessions.find((s) => !isStrengthSession(s))?.weather || '-';

  const [stravaAllRunDistanceM, setStravaAllRunDistanceM] = useState<number | null>(null);
  const [stravaAllRunMovingSec, setStravaAllRunMovingSec] = useState<number | null>(null);
  const combinedRunKm = useMemo(() => {
    const manual = manualRunningDistanceKm(sessions);
    const stravaKm = stravaAllRunDistanceM != null ? stravaAllRunDistanceM / 1000 : 0;
    return manual + stravaKm;
  }, [sessions, stravaAllRunDistanceM]);
  const combinedRunMinutes = useMemo(() => {
    const manual = manualRunningTimeMinutes(sessions);
    const stravaMin = stravaAllRunMovingSec != null ? stravaAllRunMovingSec / 60 : 0;
    return manual + stravaMin;
  }, [sessions, stravaAllRunMovingSec]);
  const handleStravaAllRunTotalsChange = useCallback(
    (totals: { distanceMeters: number | null; movingSeconds: number | null }) => {
      setStravaAllRunDistanceM(totals.distanceMeters);
      setStravaAllRunMovingSec(totals.movingSeconds);
    },
    [],
  );

  useEffect(() => {
    setHasLoaded(false);
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(sessionsKey);
        if (raw) {
          const parsed = JSON.parse(raw) as unknown;
          if (Array.isArray(parsed)) {
            setSessions(parsed as Session[]);
          } else {
            setSessions([]);
          }
        } else {
          setSessions([]);
        }
      } catch {
        // ignore; we can still run without persistence
      } finally {
        setHasLoaded(true);
      }
    })();
  }, [sessionsKey]);

  useEffect(() => {
    setRunningProgramsLoaded(false);
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(runningProgramsKey);
        if (raw) {
          const parsed = JSON.parse(raw) as unknown;
          if (Array.isArray(parsed)) {
            setRunningPrograms(parsed as SavedRunningProgram[]);
          } else {
            setRunningPrograms([]);
          }
        } else {
          setRunningPrograms([]);
        }
      } catch {
        // ignore
      } finally {
        setRunningProgramsLoaded(true);
      }
    })();
  }, [runningProgramsKey]);

  useEffect(() => {
    if (!hasLoaded) return;
    AsyncStorage.setItem(sessionsKey, JSON.stringify(sessions)).catch(() => undefined);
  }, [sessions, hasLoaded, sessionsKey]);

  useEffect(() => {
    if (!runningProgramsLoaded) return;
    AsyncStorage.setItem(runningProgramsKey, JSON.stringify(runningPrograms)).catch(() => undefined);
  }, [runningPrograms, runningProgramsLoaded, runningProgramsKey]);

  useEffect(() => {
    if (!runningProgramsLoaded) return;
    void chatRef.current?.maybeSendCompetitionFollowups(runningPrograms);
  }, [runningPrograms, runningProgramsLoaded]);

  useEffect(() => {
    if (!runningProgramsLoaded) return;
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') {
        void chatRef.current?.maybeSendCompetitionFollowups(runningPrograms);
      }
    });
    return () => sub.remove();
  }, [runningPrograms, runningProgramsLoaded]);

  function updateField<K extends keyof SessionForm>(field: K, value: SessionForm[K]) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function openModal() {
    setEditingId(null);
    setForm(createDefaultForm());
    setIsModalOpen(true);
  }

  function openEditModal(session: Session) {
    setEditingId(session.id);
    setForm(sessionToForm(session));
    setIsModalOpen(true);
  }

  function closeModal() {
    setIsModalOpen(false);
    setEditingId(null);
  }

  function handleSubmit() {
    if (!form.mode) {
      Alert.alert('Velg type økt', 'Velg om økten er løping eller styrke.');
      return;
    }

    const isStrength = form.mode === 'strength';
    const isRunning = form.mode === 'running';

    if (!form.time) {
      Alert.alert('Mangler tid', 'Fyll inn tid før du lagrer.');
      return;
    }

    if (!form.workoutType) {
      Alert.alert('Mangler type økt', isRunning ? 'Velg type løpetur før du lagrer.' : 'Velg type styrkeøkt før du lagrer.');
      return;
    }

    if (isRunning) {
      if (!form.distance) {
        Alert.alert('Mangler distanse', 'Fyll inn distanse før du lagrer.');
        return;
      }
      if (!form.shoe) {
        Alert.alert('Mangler sko', 'Velg sko før du lagrer.');
        return;
      }
      if (!form.location) {
        Alert.alert('Mangler sted', 'Velg om økten var innendørs eller utendørs.');
        return;
      }
      if (form.location === 'utendors' && !form.weather) {
        Alert.alert('Mangler vær', 'Velg vær før du lagrer.');
        return;
      }
    }

    if (!form.feeling) {
      Alert.alert('Mangler følelse', 'Velg hvordan økten føltes før du lagrer.');
      return;
    }

    const { mode: _mode, location, averageHeartRate: formHr, ...rest } = form;
    const loc = (location || 'utendors') as 'innendors' | 'utendors';
    const session: Session = {
      id: editingId ?? Date.now(),
      ...rest,
      location: loc,
      weather: isRunning && loc === 'innendors' ? '' : rest.weather,
      averageHeartRate: isRunning && formHr ? formHr : undefined,
      exercises: isStrength ? [] : rest.exercises,
    };

    const wasEditing = editingId != null;
    setSessions((prev) => {
      if (wasEditing) {
        return prev.map((s) => (s.id === editingId ? session : s));
      }
      return [session, ...prev];
    });
    closeModal();

    void ExpoHaptics.notificationAsync(ExpoHaptics.NotificationFeedbackType.Success);
    showToast(wasEditing ? 'Økt oppdatert' : 'Økt loggført – treneren ser på den…');

    // Be treneren kommentere økten – kun for nye økter, ikke ved redigering.
    if (!wasEditing) {
      void (async () => {
        const sessionDescription = describeSessionForCoach(session);
        // Kombiner manuelle økter og Strava-cache slik at treneren har et
        // mer komplett bilde av nylig aktivitet når kommentaren skrives.
        const historyDescription = await buildCombinedHistoryText(undefined, 10);
        const added = await chatRef.current?.requestSessionFeedback({
          sessionDescription,
          historyDescription,
          source: 'manual',
        });
        if (added && activeTabRef.current !== 'Chat') {
          setHasUnreadChat(true);
        }
      })();
    }
  }

  function removeSession(id: number) {
    setSessions((prev) => prev.filter((s) => s.id !== id));
  }

  /**
   * Bygger en samlet historikk-tekst med manuelle økter og Strava-aktiviteter
   * fra cache (uten den aktuelle Strava-aktiviteten), nyeste først.
   */
  const buildCombinedHistoryText = useCallback(
    async (excludeStravaId?: number, max = 10): Promise<string> => {
      let stravaActivities: StravaActivity[] = [];
      try {
        const raw = await AsyncStorage.getItem(stravaCacheKeyForUser);
        if (raw) {
          const parsed = JSON.parse(raw) as StravaRecent | null;
          stravaActivities = Array.isArray(parsed?.activities) ? parsed!.activities : [];
        }
      } catch {
        // ignore
      }

      const stravaItems = stravaActivities
        .filter((a) => excludeStravaId == null || a.id !== excludeStravaId)
        .map((a) => ({
          ts: new Date(a.startDate || 0).getTime(),
          line: describeStravaActivityShortLine(a),
        }));

      const manualItems = sessions.map((s) => ({
        ts: sessionSortTimestamp(s),
        line: describeSessionShortLine(s),
      }));

      const all = [...manualItems, ...stravaItems]
        .filter((x) => x.line.trim().length > 0)
        .sort((a, b) => b.ts - a.ts)
        .slice(0, max);

      if (all.length === 0) return '';
      return all.map((x) => `• ${x.line}`).join('\n');
    },
    [sessions, stravaCacheKeyForUser],
  );

  const handleNewStravaActivity = useCallback(
    (activity: StravaActivity) => {
      void (async () => {
        const sessionDescription = describeStravaActivityForCoach(activity);
        const historyDescription = await buildCombinedHistoryText(activity.id, 10);
        const added = await chatRef.current?.requestSessionFeedback({
          sessionDescription,
          historyDescription,
          source: 'strava',
        });
        if (added && activeTabRef.current !== 'Chat') {
          setHasUnreadChat(true);
        }
      })();
    },
    [buildCombinedHistoryText],
  );

  function saveRunningProgramFromChat(payload: RunningProgramPayload) {
    const id = `rp-${Date.now()}`;
    const items: SavedProgramItem[] = payload.sessions.map((s, i) => {
      const wt =
        s.workoutType ??
        (runWorkoutTypeValues.includes(s.title) ? s.title : undefined);
      return {
        id: `${id}-item-${i}`,
        week: s.week,
        dayLabel: s.dayLabel,
        title: s.title,
        description: s.description,
        done: false,
        date: undefined,
        workoutType: wt,
      };
    });
    const now = Date.now();
    const cn = payload.competitionName?.trim();
    const cd = payload.competitionDate?.trim();
    setRunningPrograms((prev) => [
      {
        id,
        title: payload.title,
        goalSummary: payload.goalSummary,
        weeks: payload.weeks,
        competitionName: cn || undefined,
        competitionDate:
          cd && /^\d{4}-\d{2}-\d{2}$/.test(cd) ? cd : undefined,
        createdAt: now,
        updatedAt: now,
        items,
      },
      ...prev,
    ]);
  }

  function toggleRunningProgramItem(programId: string, itemId: string) {
    setRunningPrograms((prev) =>
      prev.map((p) => {
        if (p.id !== programId) return p;
        return {
          ...p,
          updatedAt: Date.now(),
          items: p.items.map((it) => (it.id === itemId ? { ...it, done: !it.done } : it)),
        };
      }),
    );
  }

  function deleteRunningProgram(programId: string) {
    setRunningPrograms((prev) => prev.filter((p) => p.id !== programId));
  }

  function moveRunningProgramInTab(
    tab: 'active' | 'completed',
    programId: string,
    direction: 'up' | 'down',
  ) {
    setRunningPrograms((prev) => {
      const now = Date.now();
      const isCompleted = (p: SavedRunningProgram) =>
        p.items.length > 0 && p.items.every((it) => it.done);
      const isVisibleForTab = (p: SavedRunningProgram) =>
        tab === 'completed' ? isCompleted(p) : !isCompleted(p);
      const visible = prev.filter(isVisibleForTab);
      const idx = visible.findIndex((p) => p.id === programId);
      if (idx < 0) return prev;
      const j = direction === 'up' ? idx - 1 : idx + 1;
      if (j < 0 || j >= visible.length) return prev;
      const swapped = [...visible];
      const tmp = swapped[idx];
      swapped[idx] = swapped[j];
      swapped[j] = tmp;
      let i = 0;
      return prev.map((p) => {
        if (!isVisibleForTab(p)) return p;
        return { ...swapped[i++], updatedAt: now };
      });
    });
  }

  function saveProgramFromForm(payload: {
    mode: 'create' | 'edit';
    programId?: string;
    title: string;
    goalSummary: string;
    competitionName?: string;
    competitionDate?: string;
    weeks: number;
    items: Array<{
      id?: string;
      week: number;
      dayLabel: string;
      title: string;
      description: string;
      date?: string;
      done: boolean;
      workoutType?: string;
    }>;
  }) {
    const cn = payload.competitionName?.trim();
    const cd = payload.competitionDate?.trim();
    const competitionName = cn || undefined;
    const competitionDate =
      cd && /^\d{4}-\d{2}-\d{2}$/.test(cd) ? cd : undefined;

    if (payload.mode === 'create') {
      const id = `rp-${Date.now()}`;
      const items: SavedProgramItem[] = payload.items.map((it, i) => ({
        id: `${id}-item-${i}`,
        week: it.week,
        dayLabel: it.dayLabel,
        title: it.title,
        description: it.description,
        date: it.date,
        done: it.done,
        workoutType: it.workoutType,
      }));
      const now = Date.now();
      setRunningPrograms((prev) => [
        {
          id,
          title: payload.title,
          goalSummary: payload.goalSummary || 'Eget program',
          weeks: payload.weeks,
          competitionName,
          competitionDate,
          createdAt: now,
          updatedAt: now,
          items,
        },
        ...prev,
      ]);
      return;
    }
    const pid = payload.programId;
    if (!pid) return;
    setRunningPrograms((prev) =>
      prev.map((p) => {
        if (p.id !== pid) return p;
        const items: SavedProgramItem[] = payload.items.map((it, i) => ({
          id: it.id ?? `${pid}-n-${Date.now()}-${i}`,
          week: it.week,
          dayLabel: it.dayLabel,
          title: it.title,
          description: it.description,
          date: it.date,
          done: it.done,
          workoutType: it.workoutType,
        }));
        return {
          ...p,
          title: payload.title,
          goalSummary: payload.goalSummary,
          weeks: payload.weeks,
          competitionName,
          competitionDate,
          updatedAt: Date.now(),
          items,
        };
      }),
    );
  }

  const header = (
    <View style={{ gap: 10 }}>
      <Text style={styles.h1}>Hei Helene 🏃🏼‍♀️</Text>
      <Text style={styles.quoteText}>"{dailyQuote}"</Text>
    </View>
  );

  const programHeader = (
    <View style={styles.programHeaderRow}>
      <Text style={[styles.h1, { flex: 1, minWidth: 0 }]} numberOfLines={2}>
        Løpeprogram 🗓️
      </Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Pressable
          onPress={showRunningProgramHelp}
          style={styles.programHelpIcon}
          accessibilityRole="button"
          accessibilityLabel="Hjelp: løpeprogram og Chat"
          accessibilityHint="Forklarer hvordan du kan lage løpeprogram via Chat"
          hitSlop={8}
        >
          <Text style={styles.programHelpIconText}>?</Text>
        </Pressable>
        <Pressable
          onPress={openAppSettings}
          accessibilityRole="button"
          accessibilityLabel="Innstillinger"
          style={({ pressed }) => [styles.chatGearButton, pressed && { opacity: 0.6, transform: [{ scale: 0.94 }] }]}
        >
          <Text style={styles.chatGearIcon}>⚙️</Text>
        </Pressable>
      </View>
    </View>
  );

  const sessionsHeader = (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
      <View style={{ flex: 1, gap: 10 }}>
        <Text style={styles.h1}>Økter 💪</Text>
      </View>
      <Pressable
        onPress={openAppSettings}
        accessibilityRole="button"
        accessibilityLabel="Innstillinger"
        style={({ pressed }) => [styles.chatGearButton, pressed && { opacity: 0.6, transform: [{ scale: 0.94 }] }]}
      >
        <Text style={styles.chatGearIcon}>⚙️</Text>
      </Pressable>
    </View>
  );

  const statsHeader = (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
      <View style={{ flex: 1, gap: 10 }}>
        <Text style={styles.h1}>Statistikk 📊</Text>
      </View>
      <Pressable
        onPress={openAppSettings}
        accessibilityRole="button"
        accessibilityLabel="Innstillinger"
        style={({ pressed }) => [styles.chatGearButton, pressed && { opacity: 0.6, transform: [{ scale: 0.94 }] }]}
      >
        <Text style={styles.chatGearIcon}>⚙️</Text>
      </Pressable>
    </View>
  );

  const pagerRef = useRef<PagerHostHandle>(null);

  const handleTabPress = useCallback((tab: Tab) => {
    const idx = tabs.indexOf(tab);
    void Haptics.selectionAsync();
    setActiveTab(tab);
    if (tab === 'Chat') setHasUnreadChat(false);
    pagerRef.current?.setPage(idx);
  }, []);

  const handlePageSelected = useCallback(
    (e: { nativeEvent: { position: number } }) => {
      const idx = e.nativeEvent.position;
      const newTab = tabs[idx];
      setActiveTab((prev) => {
        if (prev !== newTab) {
          void Haptics.selectionAsync();
        }
        return newTab;
      });
      if (newTab === 'Chat') setHasUnreadChat(false);
    },
    [],
  );

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: '#ffffff' }}>
    <View style={styles.safe}>
      <StatusBar style="dark" />

      <KeyboardAvoidingView
        style={styles.contentArea}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <PagerHost
          ref={pagerRef}
          style={styles.contentArea}
          initialPage={tabs.indexOf(activeTab)}
          onPageSelected={handlePageSelected}
          offscreenPageLimit={tabs.length}
        >
          <View key="Chat" style={styles.contentArea} collapsable={false}>
            <View style={styles.chatLayout}>
              <View style={styles.chatPageTopRow}>
                <View style={{ flex: 1 }}>{header}</View>
                <Pressable
                  onPress={openAppSettings}
                  accessibilityRole="button"
                  accessibilityLabel="Innstillinger"
                  style={({ pressed }) => [styles.chatGearButton, pressed && { opacity: 0.6, transform: [{ scale: 0.94 }] }]}
                >
                  <Text style={styles.chatGearIcon}>⚙️</Text>
                </Pressable>
              </View>
              <View style={styles.chatLayoutBody}>
                <ChatTab
                  ref={chatRef}
                  runningPrograms={runningPrograms}
                  onSaveRunningProgram={saveRunningProgramFromChat}
                  onAfterProgramSaved={() => handleTabPress('Løpeprogram')}
                  onCompetitionFollowupPosted={() => {
                    if (activeTabRef.current !== 'Chat') setHasUnreadChat(true);
                  }}
                />
              </View>
            </View>
          </View>

          <View key="Løpeprogram" style={styles.contentArea} collapsable={false}>
            <ScrollView
              contentContainerStyle={styles.container}
              contentInsetAdjustmentBehavior="never"
              automaticallyAdjustContentInsets={false}
              refreshControl={
                <RefreshControl
                  refreshing={refreshing}
                  onRefresh={onPullToRefresh}
                  tintColor="#C45872"
                  colors={["#C45872"]}
                />
              }
            >
              {programHeader}
              <RunningProgramTab
                programs={runningPrograms}
                onToggleItem={toggleRunningProgramItem}
                onDeleteProgram={deleteRunningProgram}
                onSaveProgram={saveProgramFromForm}
                onMoveRunningProgramInTab={moveRunningProgramInTab}
              />
            </ScrollView>
          </View>

          <View key="Økter" style={styles.contentArea} collapsable={false}>
            <ScrollView
              contentContainerStyle={styles.container}
              contentInsetAdjustmentBehavior="never"
              automaticallyAdjustContentInsets={false}
              refreshControl={
                <RefreshControl
                  refreshing={refreshing}
                  onRefresh={onPullToRefresh}
                  tintColor="#C45872"
                  colors={["#C45872"]}
                />
              }
            >
              {sessionsHeader}
              <LogTab
                sessions={sessions}
                onOpenLog={openModal}
                onEdit={openEditModal}
                onRemove={removeSession}
                refreshSignal={refreshSignal}
                onNewStravaActivity={handleNewStravaActivity}
              />
            </ScrollView>
          </View>

          <View key="Statistikk" style={styles.contentArea} collapsable={false}>
            <ScrollView
              contentContainerStyle={styles.container}
              contentInsetAdjustmentBehavior="never"
              automaticallyAdjustContentInsets={false}
              refreshControl={
                <RefreshControl
                  refreshing={refreshing}
                  onRefresh={onPullToRefresh}
                  tintColor="#C45872"
                  colors={["#C45872"]}
                />
              }
            >
              {statsHeader}
              <View style={{ gap: 12 }}>
                <View style={{ flexDirection: 'row', gap: 12, alignItems: 'stretch' }}>
                  <Card title="Antall kilometer løpt" style={{ flex: 1 }}>
                    <Text style={styles.metricValue}>{combinedRunKm.toFixed(1)} km</Text>
                    <Text style={[styles.muted, { marginTop: 6 }]}>
                      Strava og manuelt loggførte løpeøkter.
                    </Text>
                  </Card>
                  <Card title="Total tid løpt" style={{ flex: 1 }}>
                    <Text style={styles.metricValue}>{formatDuration(Math.round(combinedRunMinutes))}</Text>
                    <Text style={[styles.muted, { marginTop: 6 }]}>
                      Strava og manuelt loggførte løpeøkter.
                    </Text>
                  </Card>
                </View>
                <StravaBestEffortsCard refreshSignal={refreshSignal} />
                <StatisticsTab
                  totals={totals}
                  latestWeather={latestWeather}
                  sessions={sessions}
                  onStravaAllRunTotalsChange={handleStravaAllRunTotalsChange}
                  onOpenSessions={() => handleTabPress('Økter')}
                  refreshSignal={refreshSignal}
                />
              </View>
            </ScrollView>
          </View>
        </PagerHost>
      </KeyboardAvoidingView>

      {keyboardVisible ? null : (
        <SafeAreaView style={styles.bottomSafeArea}>
          <View style={styles.bottomTabBar}>
            {tabs.map((tab) => {
              const active = activeTab === tab;
              const showUnread = tab === 'Chat' && hasUnreadChat;
              return (
                <Pressable
                  key={tab}
                  onPress={() => handleTabPress(tab)}
                  style={({ pressed }) => [
                    styles.bottomTabItem,
                    active && styles.bottomTabItemActive,
                    pressed && { opacity: 0.7, transform: [{ scale: 0.96 }] },
                  ]}
                >
                  <View style={styles.bottomTabIconWrap}>
                    <Text style={[styles.bottomTabIcon, active && styles.bottomTabIconActive]}>{tabIcons[tab]}</Text>
                    {showUnread ? (
                      <View
                        style={styles.bottomTabUnreadDot}
                        accessibilityLabel="Ulest melding fra treneren"
                      />
                    ) : null}
                  </View>
                  <Text style={[styles.bottomTabLabel, active && styles.bottomTabLabelActive]} numberOfLines={1}>
                    {tab}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </SafeAreaView>
      )}

      <SessionModal
        isOpen={isModalOpen}
        form={form}
        isEditing={editingId != null}
        onClose={closeModal}
        onSubmit={handleSubmit}
        onFieldChange={updateField}
      />

      <Modal visible={chatSettingsOpen} animationType="slide" onRequestClose={closeAppSettings}>
        <SafeAreaView style={styles.modalSafe}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Innstillinger</Text>
            <Pressable onPress={closeAppSettings} style={styles.modalClose}>
              <Text style={styles.modalCloseText}>Lukk</Text>
            </Pressable>
          </View>
          <ScrollView
            contentContainerStyle={[styles.modalContent, { flexGrow: 1 }]}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={styles.fieldLabel}>Konto</Text>
            <View style={{ gap: 4 }}>
              <Text style={styles.muted}>
                {authUser?.hasPassword || authUser?.email
                  ? `Innlogget med e-post: ${authUser.email || '(ukjent)'}. Økt og brukerdata ligger på serveren (Redis).`
                  : 'Du bruker en anonym økt (ingen e-post eller passord). Data knyttes til denne økten på serveren.'}
              </Text>
              {authUser?.stravaAthleteId ? (
                <Text style={styles.muted}>
                  Strava-konto koblet til (athlete #{authUser.stravaAthleteId}
                  {authUser.stravaAthleteName ? ` · ${authUser.stravaAthleteName}` : ''}).
                </Text>
              ) : (
                <Text style={styles.muted}>Ingen Strava-konto koblet til ennå.</Text>
              )}
            </View>

            <Text style={[styles.fieldLabel, { marginTop: 18 }]}>Strava</Text>
            <Text style={styles.muted}>
              Koble til din egen Strava-konto for å hente aktiviteter og statistikk. Vi lagrer tokenet ditt trygt
              knyttet til kontoen din på serveren.
            </Text>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Pressable
                onPress={async () => {
                  void Haptics.selectionAsync();
                  await auth.openStravaConnect();
                }}
                style={[styles.secondaryButtonFull, { flex: 1 }]}
              >
                <Text style={styles.secondaryButtonText}>
                  {authUser?.stravaAthleteId ? 'Koble på nytt' : 'Koble til Strava'}
                </Text>
              </Pressable>
              <Pressable
                onPress={async () => {
                  void Haptics.selectionAsync();
                  const keysToClear = [
                    userKey(STRAVA_CACHE_KEY, userId),
                    userKey(STRAVA_STATS_CACHE_KEY, userId),
                    userKey(STRAVA_BEST_EFFORTS_CACHE_KEY, userId),
                    userKey(STRAVA_CONNECTED_KEY, userId),
                    userKey(STRAVA_SEEN_IDS_KEY, userId),
                  ];
                  await Promise.all(keysToClear.map((k) => AsyncStorage.removeItem(k).catch(() => undefined)));
                  try {
                    await apiFetch('/strava/best-efforts/reset', { method: 'POST', ignoreAuthFailure: true });
                  } catch {
                    // ignore — local clear already happened
                  }
                  Alert.alert(
                    'Nullstilt',
                    'Strava-cachen for denne kontoen er slettet lokalt og på serveren. For å koble helt fra må du evt. revoke på strava.com/settings/apps.',
                  );
                }}
                style={[styles.dangerButton, { flex: 1 }]}
              >
                <Text style={styles.dangerButtonText}>Nullstill cache</Text>
              </Pressable>
            </View>

            <Text style={[styles.fieldLabel, { marginTop: 18 }]}>Chat-historikk</Text>
            <Pressable
              onPress={() => {
                void Haptics.selectionAsync();
                Alert.alert(
                  'Tøm chat-historikk?',
                  'Alle meldinger i chatten slettes. Lagrede løpeprogrammer under fanen Løpeprogram beholdes.',
                  [
                    { text: 'Avbryt', style: 'cancel' },
                    {
                      text: 'Tøm',
                      style: 'destructive',
                      onPress: async () => {
                        const welcome: ChatMessage = {
                          id: `${Date.now()}-welcome`,
                          role: 'assistant',
                          text:
                            'Hei! Jeg er din personlige trener. Jeg kan svare på spørsmål om løping og trening, lage løpeprogrammer du kan lagre som sjekkliste under fanen Løpeprogram, og hente oversikt fra Strava når det er koblet til. Hva lurer du på i dag?',
                          createdAt: Date.now(),
                        };
                        try {
                          await AsyncStorage.setItem(chatStorageKey, JSON.stringify([welcome]));
                        } catch {
                          // ignore
                        }
                        chatRef.current?.resetChatToWelcome();
                        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                        closeAppSettings();
                      },
                    },
                  ],
                );
              }}
              style={styles.dangerButton}
            >
              <Text style={styles.dangerButtonText}>Tøm chat-historikk</Text>
            </Pressable>

            <Text style={[styles.fieldLabel, { marginTop: 18 }]}>Avansert: server-adresse</Text>
            <Text style={styles.muted}>
              Brukes bare av utviklere. Standardverdi er fra app-konfigurasjonen (Vercel) eller{' '}
              <Text style={{ fontWeight: '800' }}>http://localhost:8787</Text> når du kjører backend lokalt.
            </Text>
            <TextInput
              value={serverUrl}
              onChangeText={setServerUrl}
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.input}
            />
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Pressable
                onPress={() => {
                  void Haptics.selectionAsync();
                  resetToDefaultServerUrl();
                }}
                style={[styles.secondaryButtonFull, { flex: 1 }]}
              >
                <Text style={styles.secondaryButtonText}>Auto-oppdag</Text>
              </Pressable>
              <Pressable
                onPress={async () => {
                  void Haptics.selectionAsync();
                  try {
                    const resp = await apiFetch('/health', { skipAuth: true });
                    if (resp.ok) {
                      Alert.alert('Tilkoblet', `Serveren svarer på ${chatApiBase}.`);
                    } else {
                      Alert.alert('Feil', `Serveren svarte med status ${resp.status}.`);
                    }
                  } catch (e: any) {
                    Alert.alert(
                      'Ingen kontakt',
                      `Kunne ikke nå ${chatApiBase}.\n\nFeil: ${String(e?.message || e)}`,
                    );
                  }
                }}
                style={[styles.primaryButtonFull, { flex: 1 }]}
              >
                <Text style={styles.primaryButtonText}>Test tilkobling</Text>
              </Pressable>
            </View>

            <View style={{ marginTop: 'auto', paddingTop: 28, alignSelf: 'stretch' }}>
              <Pressable
                onPress={() => {
                  void Haptics.selectionAsync();
                  Alert.alert(
                    'Logge ut?',
                    'Sesjonen avsluttes på serveren. Du må logge inn på nytt, bruke Strava eller velge anonym økt for å fortsette.',
                    [
                      { text: 'Avbryt', style: 'cancel' },
                      {
                        text: 'Logg ut',
                        style: 'destructive',
                        onPress: () => {
                          void signOut();
                          closeAppSettings();
                        },
                      },
                    ],
                  );
                }}
                style={[styles.dangerButton, { alignSelf: 'stretch' }]}
              >
                <Text style={[styles.dangerButtonText, { textAlign: 'center' }]}>Logg ut av appen</Text>
              </Pressable>
            </View>
          </ScrollView>
        </SafeAreaView>
      </Modal>

      {toast ? <Toast key={toast.id} message={toast.message} /> : null}
    </View>
    </GestureHandlerRootView>
  );
}

/**
 * Liten bekreftelses-banner som svever over innholdet i ~2.8s.
 * Fader inn og ut via Animated, og ignorerer berøring (pointerEvents: 'none').
 */
function Toast({ message }: { message: string }) {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(-8)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 180,
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: 0,
        duration: 220,
        useNativeDriver: true,
      }),
    ]).start();

    const fadeOutTimer = setTimeout(() => {
      Animated.parallel([
        Animated.timing(opacity, {
          toValue: 0,
          duration: 220,
          useNativeDriver: true,
        }),
        Animated.timing(translateY, {
          toValue: -8,
          duration: 220,
          useNativeDriver: true,
        }),
      ]).start();
    }, 2400);

    return () => clearTimeout(fadeOutTimer);
  }, [opacity, translateY]);

  return (
    <View pointerEvents="none" style={styles.toastWrap}>
      <Animated.View
        style={[
          styles.toastBubble,
          { opacity, transform: [{ translateY }] },
        ]}
      >
        <Text style={styles.toastCheck}>✓</Text>
        <Text style={styles.toastText}>{message}</Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  topSafeArea: {
    backgroundColor: '#FFF2EB',
    height: Math.max(Constants.statusBarHeight, Platform.OS === 'ios' ? 50 : 24),
  },
  bottomSafeArea: {
    backgroundColor: '#ffffff',
  },
  container: {
    padding: 16,
    paddingTop: Math.max(Constants.statusBarHeight, Platform.OS === 'ios' ? 50 : 24) + 16,
    gap: 16,
    paddingBottom: 40,
  },
  contentArea: {
    flex: 1,
    backgroundColor: '#FFF2EB',
  },
  chatLayout: {
    flex: 1,
    padding: 16,
    paddingTop: Math.max(Constants.statusBarHeight, Platform.OS === 'ios' ? 50 : 24) + 16,
    gap: 16,
  },
  chatPageTopRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  chatGearButton: {
    marginTop: 2,
    width: 44,
    height: 44,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  chatGearIcon: {
    fontSize: 22,
  },
  chatLayoutBody: {
    flex: 1,
  },
  bottomTabBar: {
    flexDirection: 'row',
    backgroundColor: '#ffffff',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e2e8f0',
    paddingTop: 6,
    paddingBottom: 6,
    paddingHorizontal: 6,
    shadowColor: '#0f172a',
    shadowOffset: { width: 0, height: -3 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 8,
  },
  bottomTabItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    gap: 3,
    borderRadius: 12,
  },
  bottomTabItemActive: {
    backgroundColor: '#FFF2EB',
  },
  bottomTabIcon: {
    fontSize: 22,
    opacity: 0.55,
  },
  bottomTabIconActive: {
    opacity: 1,
  },
  bottomTabIconWrap: {
    position: 'relative',
  },
  bottomTabUnreadDot: {
    position: 'absolute',
    top: -2,
    right: -8,
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#ef4444',
    borderWidth: 2,
    borderColor: '#ffffff',
  },
  toastWrap: {
    position: 'absolute',
    top: Math.max(Constants.statusBarHeight, Platform.OS === 'ios' ? 50 : 24) + 8,
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 1000,
  },
  toastBubble: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: '#0f172a',
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
    maxWidth: '92%',
  },
  toastCheck: {
    color: '#86efac',
    fontSize: 14,
    fontWeight: '800',
  },
  toastText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
    flexShrink: 1,
  },
  bottomTabLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: '#94a3b8',
  },
  bottomTabLabelActive: {
    color: '#C45872',
    fontWeight: '800',
  },
  h1: {
    fontSize: 30,
    fontWeight: '700',
    letterSpacing: -0.2,
    color: '#0f172a',
  },
  subtitle: {
    fontSize: 14,
    color: '#475569',
  },
  quoteText: {
    fontSize: 14,
    fontStyle: 'italic',
    color: '#334155',
  },
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    shadowColor: '#0f172a',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 1,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#0f172a',
    marginBottom: 10,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
    gap: 8,
  },
  cardHeaderTitle: {
    flex: 1,
    fontSize: 16,
    fontWeight: '700',
    color: '#0f172a',
  },
  cardHeaderAction: {
    flexShrink: 0,
  },
  cardIconButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#FFE8CD',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardIconButtonText: {
    color: '#7A3C4A',
    fontSize: 18,
    fontWeight: '700',
    lineHeight: 20,
  },
  monthGroup: {
    borderTopWidth: 1,
    borderTopColor: '#f1f5f9',
  },
  monthGroupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    gap: 8,
  },
  monthGroupTitle: {
    flex: 1,
    fontSize: 14,
    fontWeight: '700',
    color: '#0f172a',
  },
  monthGroupMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  monthGroupCount: {
    color: '#64748b',
    fontSize: 12,
    fontWeight: '600',
  },
  monthGroupChevron: {
    color: '#7A3C4A',
    fontSize: 14,
    fontWeight: '700',
    width: 14,
    textAlign: 'center',
  },
  monthGroupBody: {
    gap: 10,
    paddingBottom: 10,
  },
  muted: {
    color: '#64748b',
    fontSize: 13,
  },
  statsHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  statsSectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#475569',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  linkButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: '#FFE8CD',
  },
  linkButtonText: {
    color: '#7A3C4A',
    fontWeight: '700',
    fontSize: 12,
  },
  stravaErrorBox: {
    backgroundColor: '#fef2f2',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#fecaca',
    padding: 10,
  },
  stravaErrorText: {
    color: '#b91c1c',
    fontSize: 13,
    fontWeight: '600',
  },
  stravaExpandToggle: {
    alignSelf: 'center',
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginTop: 2,
  },
  stravaExpandToggleText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#7A3C4A',
  },
  chatHeader: {
    gap: 2,
  },
  chatTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#0f172a',
  },
  chatSurface: {
    flex: 1,
    backgroundColor: '#ffffff',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    overflow: 'hidden',
    shadowColor: '#0f172a',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 3,
  },
  bubbleRow: {
    flexDirection: 'row',
  },
  bubbleRowLeft: {
    justifyContent: 'flex-start',
  },
  bubbleRowRight: {
    justifyContent: 'flex-end',
  },
  bubbleColumn: {
    maxWidth: '82%',
  },
  bubble: {
    borderRadius: 18,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  bubbleTime: {
    fontSize: 10,
    fontWeight: '700',
    color: '#94a3b8',
    marginTop: 4,
    letterSpacing: 0.2,
  },
  bubbleTimeLeft: {
    textAlign: 'left',
    marginLeft: 6,
  },
  bubbleTimeRight: {
    textAlign: 'right',
    marginRight: 6,
  },
  dayDividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  dayDividerLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#cbd5e1',
  },
  dayDividerLabel: {
    fontSize: 11,
    fontWeight: '800',
    color: '#64748b',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  bubbleUser: {
    backgroundColor: '#007AFF',
    borderTopRightRadius: 6,
  },
  bubbleAssistant: {
    backgroundColor: '#E9E9EB',
    borderTopLeftRadius: 6,
  },
  bubbleText: {
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '600',
  },
  bubbleTextUser: {
    color: '#ffffff',
  },
  bubbleTextAssistant: {
    color: '#0f172a',
  },
  toolCard: {
    marginTop: 10,
    backgroundColor: '#ffffff',
    borderRadius: 14,
    padding: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  toolCardTitle: {
    fontSize: 13,
    fontWeight: '900',
    color: '#0f172a',
    marginBottom: 6,
  },
  toolCardBullet: {
    fontSize: 12,
    fontWeight: '600',
    color: '#334155',
    marginTop: 2,
  },
  runningProgramPreview: {
    marginTop: 10,
    backgroundColor: '#ffffff',
    borderRadius: 14,
    padding: 12,
    borderWidth: 1,
    borderColor: '#FFD6BA',
    gap: 6,
  },
  runningProgramPreviewTitle: {
    fontSize: 14,
    fontWeight: '900',
    color: '#0f172a',
  },
  runningProgramPreviewGoal: {
    fontSize: 12,
    fontWeight: '600',
    color: '#475569',
    lineHeight: 18,
  },
  runningProgramPreviewCompetition: {
    fontSize: 12,
    fontWeight: '700',
    color: '#9d174d',
    lineHeight: 18,
  },
  runningProgramPreviewMeta: {
    fontSize: 11,
    fontWeight: '800',
    color: '#0f172a',
    marginBottom: 4,
  },
  runningProgramPreviewLine: {
    fontSize: 11,
    fontWeight: '600',
    color: '#334155',
  },
  runningProgramPreviewMore: {
    fontSize: 11,
    fontWeight: '700',
    color: '#94a3b8',
  },
  saveProgramButton: {
    marginTop: 10,
    alignSelf: 'stretch',
    backgroundColor: '#FFDCDC',
    borderWidth: 1,
    borderColor: '#FFD6BA',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveProgramButtonDisabled: {
    backgroundColor: '#FFE8CD',
    borderColor: '#FFD6BA',
  },
  saveProgramButtonText: {
    color: '#0f172a',
    fontWeight: '800',
    fontSize: 14,
  },
  saveProgramButtonTextDisabled: {
    color: '#0f172a',
    opacity: 0.7,
  },
  programTabEmptyCard: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: '#FFDCDC',
    shadowColor: '#C45872',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 6,
    elevation: 2,
  },
  programTabEmptyTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#C45872',
    marginBottom: 10,
  },
  programTabBodyText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#0f172a',
    lineHeight: 20,
  },
  programTabMuted: {
    fontSize: 13,
    fontWeight: '600',
    color: '#0f172a',
    lineHeight: 18,
  },
  programCompetitionLine: {
    fontSize: 13,
    fontWeight: '700',
    color: '#9d174d',
    lineHeight: 18,
    marginTop: 4,
  },
  programCard: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: '#FFDCDC',
    shadowColor: '#C45872',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  programCardHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  programHeaderActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    alignItems: 'center',
    justifyContent: 'flex-end',
    flexShrink: 0,
  },
  programReorderHint: {
    fontSize: 12,
    fontWeight: '600',
    color: '#94a3b8',
    marginTop: 2,
    lineHeight: 17,
  },
  programReorderModeIconButton: {
    width: 40,
    minHeight: 42,
    marginLeft: 2,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    alignSelf: 'stretch',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#ffffff',
  },
  programReorderModeIconButtonOn: {
    borderColor: '#C45872',
    backgroundColor: '#fff5f5',
  },
  programReorderStepper: {
    flexDirection: 'column',
    justifyContent: 'flex-start',
    alignItems: 'center',
    gap: 0,
    flexShrink: 0,
    alignSelf: 'flex-start',
    paddingTop: 2,
  },
  programReorderStepperBtn: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    minWidth: 28,
    alignItems: 'center',
  },
  programReorderStepperText: {
    fontSize: 15,
    fontWeight: '900',
    color: '#C45872',
  },
  programReorderStepperTextDisabled: {
    color: '#e2e8f0',
  },
  programUpdatedAt: {
    fontSize: 10,
    fontWeight: '600',
    color: '#94a3b8',
    textAlign: 'right',
    lineHeight: 13,
    flexShrink: 0,
  },
  programMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 4,
  },
  programCardHeaderExpanded: {
    marginBottom: 12,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#FFDCDC',
  },
  programHeaderTap: {
    flex: 1,
    minWidth: 0,
  },
  programTitleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  programChevron: {
    fontSize: 14,
    fontWeight: '900',
    color: '#C45872',
    marginTop: 3,
    flexShrink: 0,
  },
  programCardTitle: {
    fontSize: 17,
    fontWeight: '800',
    color: '#0f172a',
    flex: 1,
    minWidth: 0,
  },
  programMeta: {
    fontSize: 12,
    fontWeight: '700',
    color: '#0f172a',
  },
  programItemDate: {
    fontSize: 12,
    fontWeight: '800',
    color: '#0f172a',
  },
  programItemWorkoutType: {
    fontSize: 12,
    fontWeight: '700',
    color: '#0f172a',
  },
  programChecklist: {
    gap: 8,
  },
  programCheckRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 12,
    backgroundColor: '#FFF2EB',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  programCheckRowDone: {
    backgroundColor: '#DCFCE7',
    borderColor: '#86EFAC',
  },
  programCheckMark: {
    fontSize: 26,
    lineHeight: 30,
    color: '#0f172a',
  },
  programCheckBoxBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    marginLeft: -4,
  },
  programItemChevronBtn: {
    width: 28,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  programItemChevron: {
    fontSize: 14,
    fontWeight: '700',
    color: '#94a3b8',
  },
  programCheckTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: '#0f172a',
  },
  programCheckTitleDone: {
    textDecorationLine: 'line-through',
    color: '#64748b',
  },
  programCheckDesc: {
    fontSize: 12,
    fontWeight: '600',
    color: '#0f172a',
    lineHeight: 17,
  },
  programCheckDescDone: {
    color: '#94a3b8',
    textDecorationLine: 'line-through',
  },
  programTabTopRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 10,
  },
  programSubTabBar: {
    flexDirection: 'row',
    backgroundColor: '#FFF1E6',
    borderRadius: 14,
    padding: 4,
    gap: 4,
  },
  programSubTab: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  programSubTabActive: {
    backgroundColor: '#ffffff',
    shadowColor: '#0f172a',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 2,
    elevation: 1,
  },
  programSubTabText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#7A3C4A',
    opacity: 0.65,
  },
  programSubTabTextActive: {
    opacity: 1,
  },
  programHelpIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#FFE8CD',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  programHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  programHelpIconText: {
    color: '#7A3C4A',
    fontSize: 18,
    fontWeight: '700',
    lineHeight: 20,
  },
  newChecklistButton: {
    flex: 1,
    backgroundColor: '#FFDCDC',
    borderWidth: 1,
    borderColor: '#FFD6BA',
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 16,
    alignItems: 'center',
  },
  newChecklistButtonText: {
    fontSize: 14,
    fontWeight: '800',
    color: '#7A3C4A',
  },
  programFormSessionsTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: '#C45872',
    textAlign: 'center',
    marginTop: 20,
    marginBottom: 6,
    letterSpacing: -0.3,
  },
  programFormWeekGroup: {
    marginBottom: 12,
    borderTopWidth: 1,
    borderTopColor: '#FFE8CD',
  },
  programFormWeekHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    gap: 10,
  },
  programFormWeekChevron: {
    color: '#7A3C4A',
    fontSize: 14,
    fontWeight: '700',
    width: 14,
    textAlign: 'center',
  },
  programFormWeekTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#0f172a',
  },
  programFormWeekCount: {
    color: '#64748b',
    fontSize: 13,
    fontWeight: '600',
  },
  programFormWeekBody: {
    gap: 0,
    paddingBottom: 4,
  },
  programFormAddLineBtn: {
    alignSelf: 'flex-start',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#ffffff',
    marginTop: 4,
    marginBottom: 8,
  },
  programFormAddLineBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#0f172a',
  },
  programFormLineCard: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 16,
    marginBottom: 12,
    gap: 8,
    shadowColor: '#0f172a',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  programFormLineHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  programFormLineChevron: {
    color: '#7A3C4A',
    fontSize: 14,
    fontWeight: '700',
    width: 14,
    textAlign: 'center',
  },
  programFormLineHeadingInline: {
    fontSize: 15,
    fontWeight: '800',
    color: '#C45872',
  },
  programFormLineSummary: {
    fontSize: 13,
    color: '#64748b',
    fontWeight: '500',
  },
  programFormLineBody: {
    gap: 8,
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#f1f5f9',
  },
  programFormLineHeading: {
    fontSize: 17,
    fontWeight: '800',
    color: '#C45872',
    textAlign: 'center',
    marginBottom: 4,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#FFE8CD',
  },
  typingBubble: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#E9E9EB',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 18,
    borderTopLeftRadius: 6,
  },
  typingText: {
    fontSize: 12,
    fontWeight: '800',
    color: '#0f172a',
  },
  composerRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 10,
    padding: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e2e8f0',
    backgroundColor: '#ffffff',
  },
  composerInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
    borderRadius: 20,
    paddingVertical: 10,
    paddingHorizontal: 14,
    fontSize: 14,
    fontWeight: '600',
    color: '#0f172a',
    maxHeight: 110,
  },
  sendButton: {
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 20,
    backgroundColor: '#C45872',
  },
  sendButtonDisabled: {
    opacity: 0.45,
  },
  sendButtonText: {
    color: '#ffffff',
    fontWeight: '900',
    fontSize: 12,
  },
  metricsRow: {
    flexDirection: 'row',
    gap: 10,
  },
  metricTile: {
    flex: 1,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 16,
    padding: 12,
    shadowColor: '#0f172a',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 1,
  },
  metricLabel: {
    fontSize: 12,
    color: '#64748b',
  },
  metricValue: {
    fontSize: 20,
    fontWeight: '800',
    color: '#0f172a',
    marginTop: 6,
  },
  primaryButton: {
    backgroundColor: '#C45872',
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  primaryButtonFull: {
    flex: 1,
    backgroundColor: '#C45872',
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  pinkButtonFull: {
    backgroundColor: '#FFDCDC',
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#FFD6BA',
  },
  pinkButtonText: {
    color: '#7A3C4A',
    fontWeight: '800',
    fontSize: 14,
  },
  primaryButtonText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 14,
  },
  secondaryButton: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#ffffff',
    borderRadius: 14,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  secondaryButtonFull: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#ffffff',
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  secondaryButtonText: {
    color: '#0f172a',
    fontWeight: '700',
    fontSize: 14,
  },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e2e8f0',
  },
  listRowTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0f172a',
  },
  listRowValue: {
    fontSize: 14,
    fontWeight: '800',
    color: '#0f172a',
  },
  listRowChevron: {
    fontSize: 20,
    fontWeight: '700',
    color: '#94a3b8',
    marginLeft: 6,
  },
  activityDetailMetaCard: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    gap: 10,
    shadowColor: '#0f172a',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 1,
  },
  chartCard: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    gap: 8,
    shadowColor: '#0f172a',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 1,
  },
  chartTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: '#0f172a',
  },
  chartHeaderRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
  },
  chartUnit: {
    fontSize: 12,
    fontWeight: '600',
    color: '#64748b',
  },
  sessionCard: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 16,
    padding: 12,
    backgroundColor: '#ffffff',
    shadowColor: '#0f172a',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 1,
  },
  historySessionCompact: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  historySessionChevron: {
    fontSize: 12,
    fontWeight: '900',
    color: '#C45872',
    width: 18,
    flexShrink: 0,
    marginTop: 4,
  },
  historySessionCompactTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#0f172a',
    marginTop: 2,
  },
  historySessionExpanded: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#FFE8CD',
    gap: 10,
  },
  sessionHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginBottom: 10,
  },
  sessionTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#0f172a',
    marginTop: 2,
  },
  dangerButton: {
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 12,
    backgroundColor: '#fee2e2',
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  dangerButtonText: {
    color: '#991b1b',
    fontWeight: '800',
    fontSize: 12,
  },
  sessionCardHeaderRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
  },
  sessionEditIconBtn: {
    paddingVertical: 4,
    paddingHorizontal: 8,
    marginTop: -2,
  },
  sessionEditIconText: {
    fontSize: 18,
    lineHeight: 20,
    color: '#94a3b8',
    fontWeight: '400',
  },
  swipeDeleteAction: {
    backgroundColor: '#dc2626',
    justifyContent: 'center',
    alignItems: 'center',
    width: 90,
    borderRadius: 14,
    marginLeft: 8,
  },
  swipeDeleteText: {
    color: '#ffffff',
    fontWeight: '800',
    fontSize: 14,
  },
  detailGrid: {
    gap: 6,
  },
  detailText: {
    fontSize: 13,
    color: '#334155',
  },
  detailLabel: {
    fontWeight: '800',
    color: '#0f172a',
  },
  exerciseRow: {
    flexDirection: 'row',
    gap: 8,
  },
  exerciseCell: {
    flex: 1,
    fontSize: 13,
    color: '#475569',
  },
  statTile: {
    backgroundColor: '#FFE8CD',
    borderRadius: 16,
    padding: 14,
    shadowColor: '#C45872',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
    elevation: 2,
  },
  statTilePressable: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  statTileChevron: {
    color: '#7A3C4A',
    fontSize: 22,
    fontWeight: '700',
    marginLeft: 'auto',
  },
  breakdownSectionTitle: {
    fontSize: 12,
    fontWeight: '800',
    color: '#7A3C4A',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 2,
  },
  breakdownRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 6,
  },
  breakdownEmoji: {
    fontSize: 18,
    width: 22,
    textAlign: 'center',
  },
  breakdownLabel: {
    flex: 1,
    fontSize: 14,
    color: '#0f172a',
    fontWeight: '600',
  },
  breakdownCount: {
    fontSize: 14,
    color: '#0f172a',
    fontWeight: '800',
    minWidth: 28,
    textAlign: 'right',
  },
  breakdownPct: {
    fontSize: 12,
    color: '#64748b',
    fontWeight: '600',
    minWidth: 40,
    textAlign: 'right',
  },
  bestEffortRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
    gap: 12,
    borderTopWidth: 1,
    borderTopColor: '#f1f5f9',
  },
  bestEffortLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0f172a',
    flexShrink: 0,
  },
  bestEffortMeta: {
    flex: 1,
    alignItems: 'flex-end',
  },
  bestEffortTime: {
    fontSize: 16,
    fontWeight: '800',
    color: '#0f172a',
    fontVariant: ['tabular-nums'],
  },
  chip: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 14,
    borderWidth: 1,
  },
  chipActive: {
    backgroundColor: '#FFDCDC',
    borderColor: '#FFD6BA',
  },
  chipInactive: {
    backgroundColor: '#ffffff',
    borderColor: '#e2e8f0',
  },
  chipText: {
    fontSize: 13,
    fontWeight: '700',
  },
  chipTextActive: {
    color: '#7A3C4A',
  },
  chipTextInactive: {
    color: '#0f172a',
  },
  chipGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  chipRow: {
    flexDirection: 'row',
    gap: 10,
    paddingVertical: 2,
  },
  weatherRow: {
    flexDirection: 'row',
    gap: 8,
  },
  weatherTile: {
    flex: 1,
    aspectRatio: 1,
    maxHeight: 60,
    borderWidth: 1,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  weatherEmoji: {
    fontSize: 26,
    lineHeight: 30,
    textAlign: 'center',
  },
  optionRow: {
    flexDirection: 'row',
    gap: 10,
  },
  optionGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  workoutTypeTile: {
    flexBasis: '47%',
    flexGrow: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 12,
  },
  workoutTypeEmoji: {
    fontSize: 18,
    lineHeight: 22,
  },
  workoutTypeLabel: {
    fontSize: 14,
    fontWeight: '700',
    textAlign: 'center',
  },
  optionTile: {
    flexBasis: '48%',
    flexGrow: 1,
    borderWidth: 1,
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 8,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  optionTileEmoji: {
    fontSize: 22,
    lineHeight: 26,
  },
  optionTileLabel: {
    fontSize: 13,
    fontWeight: '700',
    textAlign: 'center',
  },
  modalSafe: {
    flex: 1,
    backgroundColor: '#FFF2EB',
  },
  programFormModalSafe: {
    flex: 1,
    backgroundColor: '#FFF2EB',
  },
  programFormModalHeader: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e2e8f0',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#ffffff',
    shadowColor: '#0f172a',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 2,
    zIndex: 1,
  },
  programFormModalTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#C45872',
    flex: 1,
    minWidth: 0,
    marginRight: 8,
  },
  programFormModalHeaderActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexShrink: 0,
  },
  programFormModalSave: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: '#C45872',
  },
  programFormModalSaveText: {
    fontWeight: '800',
    color: '#ffffff',
    fontSize: 13,
  },
  programFormModalClose: {
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 12,
    backgroundColor: '#FFDCDC',
    borderWidth: 1,
    borderColor: '#FFD6BA',
  },
  programFormModalCloseText: {
    fontWeight: '800',
    color: '#0f172a',
    fontSize: 12,
  },
  programFormModalScroll: {
    padding: 16,
    gap: 14,
    paddingBottom: 30,
    backgroundColor: '#FFF2EB',
  },
  modalHeader: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e2e8f0',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#ffffff',
    shadowColor: '#0f172a',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 2,
    zIndex: 1,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#0f172a',
    letterSpacing: -0.2,
  },
  modalClose: {
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 12,
    backgroundColor: '#FFDCDC',
    borderWidth: 1,
    borderColor: '#FFD6BA',
  },
  modalCloseText: {
    fontWeight: '800',
    color: '#0f172a',
    fontSize: 12,
  },
  modalContent: {
    padding: 16,
    gap: 10,
    paddingBottom: 30,
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: '800',
    color: '#0f172a',
  },
  field: {
    gap: 8,
  },
  fieldRow: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'flex-start',
  },
  fieldHalf: {
    flex: 1,
    minWidth: 0,
    gap: 6,
  },
  chipWide: {
    alignSelf: 'stretch',
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: '800',
    color: '#0f172a',
  },
  input: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#ffffff',
    borderRadius: 14,
    paddingVertical: 13,
    paddingHorizontal: 14,
    fontSize: 14,
    color: '#0f172a',
  },
  textarea: {
    minHeight: 90,
    textAlignVertical: 'top',
  },
  pickerWrap: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#ffffff',
    borderRadius: 14,
    overflow: 'hidden',
  },
  dropdownButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#ffffff',
    borderRadius: 14,
    paddingVertical: 13,
    paddingHorizontal: 14,
    shadowColor: '#0f172a',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.03,
    shadowRadius: 2,
    elevation: 1,
  },
  dropdownButtonText: {
    fontSize: 14,
    color: '#0f172a',
    fontWeight: '600',
  },
  dropdownButtonPlaceholder: {
    color: '#94a3b8',
    fontWeight: '500',
  },
  dropdownChevron: {
    fontSize: 14,
    color: '#64748b',
    marginLeft: 8,
  },
  dropdownBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.45)',
    justifyContent: 'center',
    padding: 20,
  },
  dropdownSheet: {
    backgroundColor: '#ffffff',
    borderRadius: 20,
    paddingVertical: 14,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    shadowColor: '#0f172a',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.15,
    shadowRadius: 24,
    elevation: 12,
  },
  dropdownSheetTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: '#0f172a',
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  dropdownItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 12,
  },
  dropdownItemActive: {
    backgroundColor: '#FFE8CD',
  },
  dropdownItemText: {
    fontSize: 14,
    color: '#0f172a',
    fontWeight: '600',
  },
  dropdownCheck: {
    fontSize: 14,
    fontWeight: '900',
    color: '#0f172a',
  },
  wheelContainer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 4,
    position: 'relative',
  },
  wheelColumn: {
    flex: 1,
    alignItems: 'center',
  },
  wheelColumnSeparator: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
    paddingTop: 16,
  },
  wheelDecimalDot: {
    fontSize: 28,
    fontWeight: '900',
    color: '#C45872',
  },
  wheelHeader: {
    fontSize: 11,
    fontWeight: '700',
    color: '#64748b',
    marginBottom: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  wheelScroll: {
    width: '100%',
    height: WHEEL_ITEM_HEIGHT * WHEEL_VISIBLE,
  },
  wheelSelectionBar: {
    position: 'absolute',
    left: 8,
    right: 8,
    bottom: 12 + ((WHEEL_ITEM_HEIGHT * WHEEL_VISIBLE) / 2) - WHEEL_ITEM_HEIGHT / 2,
    height: WHEEL_ITEM_HEIGHT,
    backgroundColor: '#FFDCDC',
    borderRadius: 12,
    opacity: 0.45,
  },
  wheelItem: {
    height: WHEEL_ITEM_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  wheelItemText: {
    fontSize: 22,
    fontVariant: ['tabular-nums'],
  },
  wheelItemTextActive: {
    color: '#C45872',
    fontWeight: '800',
  },
  wheelItemTextInactive: {
    color: '#94a3b8',
    fontWeight: '500',
  },
});

export default function App() {
  return (
    <AuthProvider>
      <AuthGate>
        <AuthenticatedApp />
      </AuthGate>
    </AuthProvider>
  );
}
