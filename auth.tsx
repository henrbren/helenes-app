import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

/**
 * Global auth-state for appen.
 *
 * Vi lagrer et opaque `sessionToken` (+ brukerens id/epost/Strava-profil) i
 * AsyncStorage slik at innlogging overlever app-restart og F5 på web. Samme
 * token sendes som `Authorization: Bearer …` til backenden på hvert kall.
 *
 * Modul-scoped `currentSessionToken` speiler context-verdien slik at også
 * ikke-komponenter (f.eks. bakgrunnsjobber eller helperes som ikke har
 * tilgang til React-hooks) kan lese token via {@link getSessionToken}.
 */

export type AuthUser = {
  id: string;
  email: string | null;
  createdAt: number | null;
  stravaAthleteId: string | null;
  stravaAthleteName: string | null;
  hasPassword: boolean;
};

type AuthStatus = 'loading' | 'signedOut' | 'signedIn';

type AuthContextValue = {
  status: AuthStatus;
  user: AuthUser | null;
  sessionToken: string | null;
  signIn: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  startStravaLogin: () => Promise<void>;
  openStravaConnect: () => Promise<void>;
  refreshUser: () => Promise<void>;
  serverUrl: string;
  setServerUrl: (url: string) => void;
  resetToDefaultServerUrl: () => void;
  /** Applyes a session token that arrived via OAuth callback (?auth=ok&token=…). */
  completeExternalLogin: (token: string) => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

const AUTH_TOKEN_KEY = 'training-log-ios:auth-token:v1';
const AUTH_USER_KEY = 'training-log-ios:auth-user:v1';
const CHAT_CONFIG_KEY = 'training-log-ios:chat-config:v1';
const SERVER_PORT = 8787;
const KNOWN_DEV_BUNDLER_PORTS = new Set(['8081', '8082', '19000', '19001', '19002', '19006', '4173']);

/** Module-level mirror som `apiFetch` bruker for å injecte Authorization-headeren. */
let currentSessionToken: string | null = null;
let currentUserId: string | null = null;

export function getSessionToken(): string | null {
  return currentSessionToken;
}
export function getCurrentUserId(): string | null {
  return currentUserId;
}

/** Bruker-scopet AsyncStorage-nøkkel. Uten userId faller vi tilbake til basen. */
export function userKey(baseKey: string, userId: string | null | undefined): string {
  if (!userId) return baseKey;
  return `${baseKey}:u:${userId}`;
}

// ---- Server-URL-løsning ----------------------------------------------------

function normalizeApiBase(url: string): string {
  return url.trim().replace(/\/$/, '');
}

function isLikelyBundlerOrStaticDevUrl(url: string): boolean {
  try {
    const u = new URL(url.trim());
    const p = u.port || (u.protocol === 'https:' ? '443' : '80');
    return KNOWN_DEV_BUNDLER_PORTS.has(p);
  } catch {
    return false;
  }
}

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

function apiBaseFromEnv(): string | null {
  const v = (process.env as Record<string, string | undefined>).EXPO_PUBLIC_API_URL?.trim();
  return v ? normalizeApiBase(v) : null;
}

function apiBaseFromAppExtra(): string | null {
  const u = (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl?.trim();
  return u ? normalizeApiBase(u) : null;
}

function resolveDefaultServerUrl(): string {
  if (
    Platform.OS === 'web' &&
    typeof window !== 'undefined' &&
    window.location?.origin &&
    !(__DEV__ as boolean) &&
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
  if (
    Platform.OS === 'web' &&
    typeof window !== 'undefined' &&
    window.location?.origin &&
    !(__DEV__ as boolean)
  ) {
    const { protocol, hostname, port } = window.location;
    const effectivePort = port || (protocol === 'https:' ? '443' : '80');
    const loopback = hostname === 'localhost' || hostname === '127.0.0.1';
    const usePageAsApiBase =
      protocol === 'https:' || !loopback || effectivePort === String(SERVER_PORT);
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

function coerceChatServerUrl(url: string): string {
  const stripped = stripMistakenApiPathFromBase(url);
  const normalized = normalizeApiBase(stripped);
  return isLikelyBundlerOrStaticDevUrl(normalized) ? resolveDefaultServerUrl() : normalized;
}

export function joinApiUrl(base: string, pathWithQuery: string): string {
  const path = pathWithQuery.startsWith('/') ? pathWithQuery : `/${pathWithQuery}`;
  if (
    Platform.OS === 'web' &&
    typeof window !== 'undefined' &&
    window.location?.protocol === 'https:'
  ) {
    return path;
  }
  if (Platform.OS === 'web' && typeof window !== 'undefined' && window.location?.origin) {
    const origin = normalizeApiBase(window.location.origin);
    const b = base.trim();
    const pageHttps = window.location.protocol === 'https:';
    if (pageHttps && (!b || /^http:\/\//i.test(b) || normalizeApiBase(b) === origin)) {
      return path;
    }
    if (!(__DEV__ as boolean) && (!b || normalizeApiBase(b) === origin)) {
      return path;
    }
  }
  const prefix = base.trim() ? normalizeApiBase(base) : '';
  return prefix ? `${prefix}${path}` : path;
}

export function absoluteApiUrl(base: string, pathWithQuery: string): string {
  const path = pathWithQuery.startsWith('/') ? pathWithQuery : `/${pathWithQuery}`;
  if (
    Platform.OS === 'web' &&
    typeof window !== 'undefined' &&
    window.location?.protocol === 'https:'
  ) {
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

export { coerceChatServerUrl, isLikelyBundlerOrStaticDevUrl, normalizeApiBase, resolveDefaultServerUrl };

async function readStoredServerUrl(): Promise<string> {
  try {
    const raw = await AsyncStorage.getItem(CHAT_CONFIG_KEY);
    if (raw) {
      const cfg = JSON.parse(raw) as { serverUrl?: string };
      if (cfg?.serverUrl) {
        if (isLikelyBundlerOrStaticDevUrl(cfg.serverUrl)) return resolveDefaultServerUrl();
        const pageHttps =
          Platform.OS === 'web' &&
          !(__DEV__ as boolean) &&
          typeof window !== 'undefined' &&
          window.location?.protocol === 'https:';
        if (pageHttps && /^http:\/\//i.test(cfg.serverUrl)) {
          return normalizeApiBase(window.location.origin);
        }
        const savedIsLocalhost = /(localhost|127\.0\.0\.1)/.test(cfg.serverUrl);
        const detected = resolveDefaultServerUrl();
        const detectedIsLan = !/(localhost|127\.0\.0\.1)/.test(detected);
        return detectedIsLan || savedIsLocalhost
          ? detectedIsLan
            ? detected
            : savedIsLocalhost
              ? detected
              : coerceChatServerUrl(cfg.serverUrl)
          : coerceChatServerUrl(cfg.serverUrl);
      }
    }
  } catch {
    // ignore
  }
  return resolveDefaultServerUrl();
}

// ---- apiFetch --------------------------------------------------------------

let onUnauthenticated: (() => void) | null = null;
let getServerBase: () => string = () => resolveDefaultServerUrl();

export type ApiFetchOptions = RequestInit & {
  /** Pass en annen base URL (default: context-verdien). */
  base?: string;
  /** Inkluder `?token=…` i URL-en (brukes av OAuth-redirects via `Linking.openURL`). */
  includeTokenInQuery?: boolean;
  /** Timeout i ms, signalerer til en AbortController. */
  timeoutMs?: number;
  /** Ikke send Authorization-header selv om vi er innlogget. */
  skipAuth?: boolean;
};

export async function apiFetch(path: string, options: ApiFetchOptions = {}): Promise<Response> {
  const base = options.base ?? getServerBase();
  let url = joinApiUrl(base, path);
  if (options.includeTokenInQuery && currentSessionToken) {
    const sep = url.includes('?') ? '&' : '?';
    url = `${url}${sep}token=${encodeURIComponent(currentSessionToken)}`;
  }
  const headers = new Headers(options.headers as HeadersInit | undefined);
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');
  if (!options.skipAuth && currentSessionToken) {
    headers.set('Authorization', `Bearer ${currentSessionToken}`);
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (options.timeoutMs && options.timeoutMs > 0) {
    timer = setTimeout(() => controller.abort(), options.timeoutMs);
  }
  const signal = options.signal || controller.signal;

  try {
    const resp = await fetch(url, { ...options, headers, signal });
    if (resp.status === 401 && !options.skipAuth && onUnauthenticated) {
      onUnauthenticated();
    }
    return resp;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function absoluteUrlWithToken(base: string, path: string): string {
  const url = absoluteApiUrl(base, path);
  if (!currentSessionToken) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}token=${encodeURIComponent(currentSessionToken)}`;
}

// ---- Provider --------------------------------------------------------------

type AuthPersist = {
  sessionToken: string | null;
  user: AuthUser | null;
};

async function loadStoredAuth(): Promise<AuthPersist> {
  try {
    const [tok, u] = await Promise.all([
      AsyncStorage.getItem(AUTH_TOKEN_KEY),
      AsyncStorage.getItem(AUTH_USER_KEY),
    ]);
    return {
      sessionToken: tok || null,
      user: u ? (JSON.parse(u) as AuthUser) : null,
    };
  } catch {
    return { sessionToken: null, user: null };
  }
}

async function persistAuth(payload: AuthPersist): Promise<void> {
  try {
    if (payload.sessionToken) {
      await AsyncStorage.setItem(AUTH_TOKEN_KEY, payload.sessionToken);
    } else {
      await AsyncStorage.removeItem(AUTH_TOKEN_KEY);
    }
    if (payload.user) {
      await AsyncStorage.setItem(AUTH_USER_KEY, JSON.stringify(payload.user));
    } else {
      await AsyncStorage.removeItem(AUTH_USER_KEY);
    }
  } catch {
    // ignore
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [sessionToken, setSessionTokenState] = useState<string | null>(null);
  const [serverUrl, setServerUrlState] = useState<string>(() => resolveDefaultServerUrl());

  currentSessionToken = sessionToken;
  currentUserId = user?.id || null;
  getServerBase = () => serverUrl;

  const applyAuth = useCallback(async (next: AuthPersist) => {
    currentSessionToken = next.sessionToken;
    currentUserId = next.user?.id || null;
    setSessionTokenState(next.sessionToken);
    setUser(next.user);
    setStatus(next.sessionToken && next.user ? 'signedIn' : 'signedOut');
    await persistAuth(next);
  }, []);

  const signOut = useCallback(async () => {
    const token = currentSessionToken;
    if (token) {
      try {
        await apiFetch('/auth/logout', { method: 'POST' });
      } catch {
        // uansett – vi rydder lokalt
      }
    }
    await applyAuth({ sessionToken: null, user: null });
  }, [applyAuth]);

  // Globalt 401-håndtak: automatisk logg ut hvis server sier sesjonen er ugyldig.
  useEffect(() => {
    onUnauthenticated = () => {
      if (currentSessionToken) {
        void applyAuth({ sessionToken: null, user: null });
      }
    };
    return () => {
      onUnauthenticated = null;
    };
  }, [applyAuth]);

  // Første oppstart: last stored token + server-url, valider mot /auth/me.
  useEffect(() => {
    (async () => {
      const [{ sessionToken: storedToken, user: storedUser }, savedServer] = await Promise.all([
        loadStoredAuth(),
        readStoredServerUrl(),
      ]);
      setServerUrlState(savedServer);
      getServerBase = () => savedServer;

      // Ta imot token fra OAuth-redirect (web only): ?auth=ok&token=…
      let tokenFromQuery: string | null = null;
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        try {
          const u = new URL(window.location.href);
          const t = u.searchParams.get('token');
          const authOk = u.searchParams.get('auth') === 'ok';
          if (t && authOk) {
            tokenFromQuery = t;
          }
          if (u.searchParams.has('auth') || u.searchParams.has('token') || u.searchParams.has('strava')) {
            u.searchParams.delete('auth');
            u.searchParams.delete('token');
            u.searchParams.delete('strava');
            window.history.replaceState({}, '', `${u.pathname}${u.search ? `?${u.searchParams}` : ''}${u.hash}`);
          }
        } catch {
          // ignore
        }
      }

      const effectiveToken = tokenFromQuery || storedToken;
      if (!effectiveToken) {
        await applyAuth({ sessionToken: null, user: null });
        return;
      }
      currentSessionToken = effectiveToken;
      try {
        const resp = await apiFetch('/auth/me');
        if (resp.ok) {
          const data = (await resp.json()) as { user: AuthUser };
          await applyAuth({ sessionToken: effectiveToken, user: data.user });
          return;
        }
      } catch {
        // fall through
      }
      // Ugyldig / ikke-nåbar server – rens lokalt og vis login.
      currentSessionToken = storedToken; // gjenopprett så neste retry virker
      if (!tokenFromQuery && storedToken && storedUser) {
        // Nettverksfeil ved oppstart: behold sesjonen lokalt og gå videre.
        setSessionTokenState(storedToken);
        setUser(storedUser);
        setStatus('signedIn');
        return;
      }
      await applyAuth({ sessionToken: null, user: null });
    })();
  }, [applyAuth]);

  // Persistér server-url endringer.
  useEffect(() => {
    AsyncStorage.setItem(CHAT_CONFIG_KEY, JSON.stringify({ serverUrl })).catch(() => undefined);
    getServerBase = () => serverUrl;
  }, [serverUrl]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const resp = await apiFetch('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
        skipAuth: true,
      });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const msg = (body as { error?: string })?.error || `Innlogging feilet (${resp.status}).`;
        throw new Error(msg);
      }
      const data = body as { sessionToken: string; user: AuthUser };
      await applyAuth({ sessionToken: data.sessionToken, user: data.user });
    },
    [applyAuth],
  );

  const register = useCallback(
    async (email: string, password: string) => {
      const resp = await apiFetch('/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
        skipAuth: true,
      });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const msg = (body as { error?: string })?.error || `Registrering feilet (${resp.status}).`;
        throw new Error(msg);
      }
      const data = body as { sessionToken: string; user: AuthUser };
      await applyAuth({ sessionToken: data.sessionToken, user: data.user });
    },
    [applyAuth],
  );

  const refreshUser = useCallback(async () => {
    if (!currentSessionToken) return;
    try {
      const resp = await apiFetch('/auth/me');
      if (resp.ok) {
        const data = (await resp.json()) as { user: AuthUser };
        await applyAuth({ sessionToken: currentSessionToken, user: data.user });
      }
    } catch {
      // ignore
    }
  }, [applyAuth]);

  const completeExternalLogin = useCallback(
    async (token: string) => {
      if (!token) return;
      currentSessionToken = token;
      try {
        const resp = await apiFetch('/auth/me');
        if (resp.ok) {
          const data = (await resp.json()) as { user: AuthUser };
          await applyAuth({ sessionToken: token, user: data.user });
          return;
        }
      } catch {
        // fall through
      }
      await applyAuth({ sessionToken: null, user: null });
    },
    [applyAuth],
  );

  const startStravaLogin = useCallback(async () => {
    const url = absoluteApiUrl(serverUrl, '/auth/strava/start');
    try {
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        window.location.href = url;
        return;
      }
      await Linking.openURL(url);
    } catch (e: any) {
      Alert.alert('Kunne ikke åpne Strava', String(e?.message || e));
    }
  }, [serverUrl]);

  const openStravaConnect = useCallback(async () => {
    const url = absoluteUrlWithToken(serverUrl, '/strava/connect');
    try {
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        window.location.href = url;
        return;
      }
      await Linking.openURL(url);
    } catch (e: any) {
      Alert.alert('Kunne ikke åpne Strava', String(e?.message || e));
    }
  }, [serverUrl]);

  const setServerUrl = useCallback((url: string) => {
    setServerUrlState(coerceChatServerUrl(url));
  }, []);

  const resetToDefaultServerUrl = useCallback(() => {
    setServerUrlState(coerceChatServerUrl(resolveDefaultServerUrl()));
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      sessionToken,
      signIn,
      register,
      signOut,
      startStravaLogin,
      openStravaConnect,
      refreshUser,
      serverUrl,
      setServerUrl,
      resetToDefaultServerUrl,
      completeExternalLogin,
    }),
    [
      status,
      user,
      sessionToken,
      signIn,
      register,
      signOut,
      startStravaLogin,
      openStravaConnect,
      refreshUser,
      serverUrl,
      setServerUrl,
      resetToDefaultServerUrl,
      completeExternalLogin,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth må brukes innenfor <AuthProvider>.');
  return ctx;
}

/** Returnerer bare userId – nyttig for useMemo-avhengigheter og AsyncStorage-nøkler. */
export function useUserId(): string | null {
  const { user } = useAuth();
  return user?.id || null;
}

// ---- AuthScreen ------------------------------------------------------------

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  if (status === 'loading') {
    return (
      <View style={authStyles.loadingContainer}>
        <ActivityIndicator size="large" color="#7A3C4A" />
      </View>
    );
  }
  if (status === 'signedOut') return <AuthScreen />;
  return <>{children}</>;
}

function AuthScreen() {
  const { signIn, register, startStravaLogin, serverUrl, setServerUrl, resetToDefaultServerUrl } =
    useAuth();
  const [tab, setTab] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [showServerSettings, setShowServerSettings] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const passwordRef = useRef<TextInput>(null);
  const password2Ref = useRef<TextInput>(null);

  const isRegister = tab === 'register';

  const onSubmit = useCallback(async () => {
    if (pending) return;
    const e = email.trim();
    if (!e) {
      setError('Skriv inn epost-adressen din.');
      return;
    }
    if (!password) {
      setError('Skriv inn passord.');
      return;
    }
    if (isRegister) {
      if (password.length < 8) {
        setError('Passordet må ha minst 8 tegn.');
        return;
      }
      if (password !== password2) {
        setError('Passordene er ikke like.');
        return;
      }
    }
    Keyboard.dismiss();
    setPending(true);
    setError(null);
    try {
      if (isRegister) await register(e, password);
      else await signIn(e, password);
    } catch (err: any) {
      setError(String(err?.message || err));
    } finally {
      setPending(false);
    }
  }, [email, password, password2, isRegister, pending, register, signIn]);

  const onStrava = useCallback(async () => {
    setError(null);
    try {
      await startStravaLogin();
    } catch (err: any) {
      setError(String(err?.message || err));
    }
  }, [startStravaLogin]);

  return (
    <KeyboardAvoidingView
      style={authStyles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={authStyles.scroll}
        keyboardShouldPersistTaps="handled"
      >
        <View style={authStyles.brandBox}>
          <Text style={authStyles.brandTitle}>Treningslogg</Text>
          <Text style={authStyles.brandSubtitle}>
            Logg inn for å synke øktene dine, chatte med treneren, og få personlige løpeprogrammer.
          </Text>
        </View>

        <View style={authStyles.tabRow}>
          <Pressable
            onPress={() => {
              setTab('login');
              setError(null);
            }}
            style={[authStyles.tabButton, !isRegister && authStyles.tabButtonActive]}
          >
            <Text style={[authStyles.tabText, !isRegister && authStyles.tabTextActive]}>
              Logg inn
            </Text>
          </Pressable>
          <Pressable
            onPress={() => {
              setTab('register');
              setError(null);
            }}
            style={[authStyles.tabButton, isRegister && authStyles.tabButtonActive]}
          >
            <Text style={[authStyles.tabText, isRegister && authStyles.tabTextActive]}>
              Registrer
            </Text>
          </Pressable>
        </View>

        <View style={authStyles.formCard}>
          <Text style={authStyles.label}>Epost</Text>
          <TextInput
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            textContentType="emailAddress"
            placeholder="du@domenet.no"
            placeholderTextColor="#94a3b8"
            style={authStyles.input}
            returnKeyType="next"
            onSubmitEditing={() => passwordRef.current?.focus()}
          />

          <Text style={authStyles.label}>Passord</Text>
          <TextInput
            ref={passwordRef}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            textContentType={isRegister ? 'newPassword' : 'password'}
            placeholder={isRegister ? 'Minst 8 tegn' : 'Passord'}
            placeholderTextColor="#94a3b8"
            style={authStyles.input}
            returnKeyType={isRegister ? 'next' : 'go'}
            onSubmitEditing={() => {
              if (isRegister) password2Ref.current?.focus();
              else void onSubmit();
            }}
          />

          {isRegister ? (
            <>
              <Text style={authStyles.label}>Bekreft passord</Text>
              <TextInput
                ref={password2Ref}
                value={password2}
                onChangeText={setPassword2}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                textContentType="newPassword"
                placeholder="Gjenta passordet"
                placeholderTextColor="#94a3b8"
                style={authStyles.input}
                returnKeyType="go"
                onSubmitEditing={() => {
                  void onSubmit();
                }}
              />
            </>
          ) : null}

          {error ? <Text style={authStyles.errorText}>{error}</Text> : null}

          <Pressable
            onPress={onSubmit}
            disabled={pending}
            style={({ pressed }) => [
              authStyles.primaryButton,
              pending && authStyles.primaryButtonDisabled,
              pressed && !pending && { opacity: 0.85 },
            ]}
          >
            <Text style={authStyles.primaryButtonText}>
              {pending ? '...' : isRegister ? 'Opprett konto' : 'Logg inn'}
            </Text>
          </Pressable>

          <View style={authStyles.divider}>
            <View style={authStyles.dividerLine} />
            <Text style={authStyles.dividerText}>eller</Text>
            <View style={authStyles.dividerLine} />
          </View>

          <Pressable
            onPress={onStrava}
            style={({ pressed }) => [
              authStyles.stravaButton,
              pressed && { opacity: 0.9 },
            ]}
          >
            <Text style={authStyles.stravaButtonText}>Logg inn med Strava</Text>
          </Pressable>
          <Text style={authStyles.stravaHelp}>
            Første gang du logger inn med Strava oppretter vi automatisk en konto og kobler
            Strava-dataene dine til den.
          </Text>
        </View>

        <Pressable
          onPress={() => setShowServerSettings((v) => !v)}
          style={authStyles.serverToggle}
        >
          <Text style={authStyles.serverToggleText}>
            {showServerSettings ? 'Skjul server-instillinger' : 'Avansert: server-adresse'}
          </Text>
        </Pressable>

        {showServerSettings ? (
          <View style={authStyles.serverBox}>
            <Text style={authStyles.muted}>
              Denne appen snakker med en backend for innlogging, chat og Strava. Standardverdien er
              fra app-konfigurasjonen (Vercel) eller{' '}
              <Text style={{ fontWeight: '800' }}>http://localhost:8787</Text> når du kjører
              backend lokalt.
            </Text>
            <TextInput
              value={serverUrl}
              onChangeText={setServerUrl}
              autoCapitalize="none"
              autoCorrect={false}
              style={authStyles.input}
            />
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Pressable
                onPress={resetToDefaultServerUrl}
                style={[authStyles.secondaryButton, { flex: 1 }]}
              >
                <Text style={authStyles.secondaryButtonText}>Auto-oppdag</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const authStyles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
  },
  container: {
    flex: 1,
    backgroundColor: '#F8F5F1',
  },
  scroll: {
    flexGrow: 1,
    padding: 24,
    paddingTop: 48,
    gap: 20,
  },
  brandBox: {
    gap: 6,
    marginBottom: 8,
  },
  brandTitle: {
    fontSize: 28,
    fontWeight: '800',
    color: '#0f172a',
  },
  brandSubtitle: {
    fontSize: 15,
    color: '#475569',
    lineHeight: 22,
  },
  tabRow: {
    flexDirection: 'row',
    backgroundColor: '#EDE3DA',
    borderRadius: 12,
    padding: 4,
  },
  tabButton: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: 'center',
  },
  tabButtonActive: {
    backgroundColor: '#fff',
  },
  tabText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#7a6e64',
  },
  tabTextActive: {
    color: '#0f172a',
  },
  formCard: {
    backgroundColor: '#fff',
    borderRadius: 18,
    padding: 20,
    gap: 8,
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  label: {
    fontSize: 13,
    fontWeight: '700',
    color: '#334155',
    marginTop: 6,
  },
  input: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    color: '#0f172a',
    backgroundColor: '#f8fafc',
  },
  errorText: {
    color: '#b91c1c',
    fontSize: 14,
    marginTop: 6,
  },
  primaryButton: {
    marginTop: 14,
    backgroundColor: '#7A3C4A',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  primaryButtonDisabled: {
    opacity: 0.6,
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 18,
    marginBottom: 10,
    gap: 10,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: '#e2e8f0',
  },
  dividerText: {
    color: '#94a3b8',
    fontSize: 13,
  },
  stravaButton: {
    backgroundColor: '#FC4C02',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  stravaButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  stravaHelp: {
    marginTop: 10,
    fontSize: 13,
    color: '#64748b',
    textAlign: 'center',
    lineHeight: 19,
  },
  serverToggle: {
    alignSelf: 'center',
    padding: 8,
  },
  serverToggleText: {
    color: '#7A3C4A',
    fontSize: 13,
    fontWeight: '600',
  },
  serverBox: {
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 16,
    gap: 10,
  },
  secondaryButton: {
    backgroundColor: '#EDE3DA',
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
  },
  secondaryButtonText: {
    color: '#0f172a',
    fontWeight: '700',
    fontSize: 15,
  },
  muted: {
    color: '#64748b',
    fontSize: 13,
    lineHeight: 19,
  },
});
