import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
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
 * AsyncStorage. Ved første oppstart opprettes en anonym enhetsbruker via
 * `POST /auth/anonymous` slik at chat/Strava fortsatt kan kreve sesjon på serveren.
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
  openStravaConnect: () => Promise<void>;
  openStravaLogin: () => Promise<void>;
  refreshUser: () => Promise<void>;
  signInWithPassword: (email: string, password: string) => Promise<void>;
  registerWithPassword: (email: string, password: string) => Promise<void>;
  continueAsGuest: () => Promise<void>;
  signOut: () => Promise<void>;
  serverUrl: string;
  setServerUrl: (url: string) => void;
  resetToDefaultServerUrl: () => void;
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

/** Unngå at mange parallelle 401-respons starter hver sin /auth/anonymous (Vercel-støy). */
let authRecoveryBusy = false;
let authRecoveryCooldownUntil = 0;

export type ApiFetchOptions = RequestInit & {
  /** Pass en annen base URL (default: context-verdien). */
  base?: string;
  /** Inkluder `?token=…` i URL-en (brukes av OAuth-redirects via `Linking.openURL`). */
  includeTokenInQuery?: boolean;
  /** Timeout i ms, signalerer til en AbortController. */
  timeoutMs?: number;
  /** Ikke send Authorization-header selv om vi er innlogget. */
  skipAuth?: boolean;
  /** Ikke trigge global utlogging ved 401 (f.eks. under validering av lagret token). */
  ignoreAuthFailure?: boolean;
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
    if (
      resp.status === 401 &&
      !options.skipAuth &&
      !options.ignoreAuthFailure &&
      onUnauthenticated
    ) {
      try {
        const body = (await resp.clone().json()) as { code?: string };
        const code = body?.code;
        if (code === 'UNAUTHENTICATED' || code === 'SESSION_EXPIRED' || code === 'USER_GONE') {
          onUnauthenticated();
        }
      } catch {
        // Ukjent 401-format — ikke bytt bruker (unngå feil ved f.eks. Strava 401 med annen code).
      }
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

  const bootstrapAnonymous = useCallback(async () => {
    const resp = await apiFetch('/auth/anonymous', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      skipAuth: true,
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const msg =
        (body as { error?: string })?.error || `Kunne ikke starte app-økt (${resp.status}).`;
      throw new Error(msg);
    }
    const data = body as { sessionToken: string; user: AuthUser };
    await applyAuth({ sessionToken: data.sessionToken, user: data.user });
  }, [applyAuth]);

  // Globalt 401-håndtak: sesjon utløpt/ugyldig → tilbake til innlogging (Redis-sesjoner er server-sant).
  useEffect(() => {
    onUnauthenticated = () => {
      const now = Date.now();
      if (authRecoveryBusy || now < authRecoveryCooldownUntil) return;
      authRecoveryBusy = true;
      authRecoveryCooldownUntil = now + 2500;
      void (async () => {
        try {
          await applyAuth({ sessionToken: null, user: null });
        } finally {
          authRecoveryBusy = false;
        }
      })();
    };
    return () => {
      onUnauthenticated = null;
    };
  }, [applyAuth]);

  // Første oppstart: valider lagret token, ellers innloggingsskjerm (e-post/passord eller gjest).
  useEffect(() => {
    (async () => {
      const [{ sessionToken: storedToken, user: storedUser }, savedServer] = await Promise.all([
        loadStoredAuth(),
        readStoredServerUrl(),
      ]);
      setServerUrlState(savedServer);
      getServerBase = () => savedServer;

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

      const tryApplyValidSession = async (
        token: string,
      ): Promise<'ok' | 'invalid' | 'offline'> => {
        currentSessionToken = token;
        try {
          const resp = await apiFetch('/auth/me', { ignoreAuthFailure: true });
          if (resp.ok) {
            const data = (await resp.json()) as { user: AuthUser };
            await applyAuth({ sessionToken: token, user: data.user });
            return 'ok';
          }
          if (resp.status === 401) return 'invalid';
          return 'invalid';
        } catch {
          return 'offline';
        }
      };

      const effectiveToken = tokenFromQuery || storedToken;
      if (effectiveToken) {
        const outcome = await tryApplyValidSession(effectiveToken);
        if (outcome === 'ok') return;
        if (outcome === 'offline' && !tokenFromQuery && storedToken && storedUser) {
          setSessionTokenState(storedToken);
          setUser(storedUser);
          setStatus('signedIn');
          return;
        }
      }

      await applyAuth({ sessionToken: null, user: null });
    })();
  }, [applyAuth]);

  // Persistér server-url endringer.
  useEffect(() => {
    AsyncStorage.setItem(CHAT_CONFIG_KEY, JSON.stringify({ serverUrl })).catch(() => undefined);
    getServerBase = () => serverUrl;
  }, [serverUrl]);

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

  /** OAuth uten Bearer – samme callback som «koble til» men intent login (ny eller eksisterende Strava-bruker). */
  const openStravaLogin = useCallback(async () => {
    const url = absoluteApiUrl(serverUrl, '/strava/login');
    try {
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        window.location.href = url;
        return;
      }
      await Linking.openURL(url);
    } catch (e: any) {
      Alert.alert('Kunne ikke starte Strava-innlogging', String(e?.message || e));
    }
  }, [serverUrl]);

  const signInWithPassword = useCallback(
    async (email: string, password: string) => {
      const resp = await apiFetch('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
        skipAuth: true,
      });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const msg =
          (body as { error?: string })?.error || `Innlogging feilet (${resp.status}).`;
        throw new Error(msg);
      }
      const data = body as { sessionToken: string; user: AuthUser };
      await applyAuth({ sessionToken: data.sessionToken, user: data.user });
    },
    [applyAuth],
  );

  const registerWithPassword = useCallback(
    async (email: string, password: string) => {
      const resp = await apiFetch('/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
        skipAuth: true,
      });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const msg =
          (body as { error?: string })?.error || `Registrering feilet (${resp.status}).`;
        throw new Error(msg);
      }
      const data = body as { sessionToken: string; user: AuthUser };
      await applyAuth({ sessionToken: data.sessionToken, user: data.user });
    },
    [applyAuth],
  );

  const continueAsGuest = useCallback(async () => {
    await bootstrapAnonymous();
  }, [bootstrapAnonymous]);

  const signOut = useCallback(async () => {
    try {
      if (currentSessionToken) {
        await apiFetch('/auth/logout', { method: 'POST' });
      }
    } catch {
      // nettverk — vi nullstiller lokalt uansett
    }
    await applyAuth({ sessionToken: null, user: null });
  }, [applyAuth]);

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
      openStravaConnect,
      openStravaLogin,
      refreshUser,
      signInWithPassword,
      registerWithPassword,
      continueAsGuest,
      signOut,
      serverUrl,
      setServerUrl,
      resetToDefaultServerUrl,
    }),
    [
      status,
      user,
      sessionToken,
      openStravaConnect,
      openStravaLogin,
      refreshUser,
      signInWithPassword,
      registerWithPassword,
      continueAsGuest,
      signOut,
      serverUrl,
      setServerUrl,
      resetToDefaultServerUrl,
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

function AuthLoginScreen() {
  const {
    signInWithPassword,
    registerWithPassword,
    continueAsGuest,
    openStravaLogin,
    serverUrl,
  } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async () => {
    setError(null);
    if (!email.trim() || !password) {
      setError('Fyll inn e-post og passord.');
      return;
    }
    setBusy(true);
    try {
      if (mode === 'login') {
        await signInWithPassword(email, password);
      } else {
        await registerWithPassword(email, password);
      }
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const onGuest = async () => {
    setError(null);
    setBusy(true);
    try {
      await continueAsGuest();
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={authStyles.loginRoot}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={authStyles.loginScroll}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={authStyles.loginTitle}>Training Log</Text>
        <Text style={authStyles.loginSubtitle}>
          Logg inn med e-post og passord, med Strava, eller fortsett uten konto. Konto og økt lagres på
          serveren (Redis) slik at innlogging fungerer også etter omstart og på Vercel.
        </Text>
        <Text style={authStyles.loginHint} selectable>
          Server: {serverUrl}
        </Text>

        <Text style={authStyles.loginFieldLabel}>E-post</Text>
        <TextInput
          style={authStyles.loginInput}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          textContentType="username"
          placeholder="deg@eksempel.no"
          placeholderTextColor="#94a3b8"
          value={email}
          onChangeText={setEmail}
          editable={!busy}
        />

        <Text style={authStyles.loginFieldLabel}>Passord</Text>
        <TextInput
          style={authStyles.loginInput}
          secureTextEntry
          textContentType={mode === 'login' ? 'password' : 'newPassword'}
          placeholder={mode === 'register' ? 'Minst 8 tegn' : '••••••••'}
          placeholderTextColor="#94a3b8"
          value={password}
          onChangeText={setPassword}
          editable={!busy}
        />

        {error ? <Text style={authStyles.loginError}>{error}</Text> : null}

        <Pressable
          onPress={() => {
            void openStravaLogin();
          }}
          disabled={busy}
          style={({ pressed }) => [
            authStyles.loginStravaBtn,
            (busy || pressed) && { opacity: busy ? 0.6 : 0.92 },
          ]}
        >
          <Text style={authStyles.loginStravaBtnText}>Logg inn med Strava</Text>
        </Pressable>

        <Pressable
          onPress={onSubmit}
          disabled={busy}
          style={({ pressed }) => [
            authStyles.loginPrimaryBtn,
            (busy || pressed) && { opacity: busy ? 0.6 : 0.9 },
          ]}
        >
          <Text style={authStyles.loginPrimaryBtnText}>
            {busy ? '…' : mode === 'login' ? 'Logg inn' : 'Opprett konto'}
          </Text>
        </Pressable>

        <Pressable
          onPress={() => {
            setMode((m) => (m === 'login' ? 'register' : 'login'));
            setError(null);
          }}
          disabled={busy}
          style={authStyles.loginLinkWrap}
        >
          <Text style={authStyles.loginLink}>
            {mode === 'login' ? 'Har du ikke konto? Registrer deg' : 'Har du allerede konto? Logg inn'}
          </Text>
        </Pressable>

        <View style={authStyles.loginDivider} />

        <Pressable
          onPress={onGuest}
          disabled={busy}
          style={({ pressed }) => [
            authStyles.loginSecondaryBtn,
            pressed && { opacity: 0.9 },
          ]}
        >
          <Text style={authStyles.loginSecondaryBtnText}>Fortsett uten konto (anonym økt)</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  if (status === 'loading') {
    return (
      <View style={authStyles.loadingContainer}>
        <ActivityIndicator size="large" color="#7A3C4A" />
      </View>
    );
  }
  if (status === 'signedOut') {
    return <AuthLoginScreen />;
  }
  return <>{children}</>;
}

const authStyles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
  },
  loginRoot: {
    flex: 1,
    backgroundColor: '#fff',
  },
  loginScroll: {
    flexGrow: 1,
    paddingHorizontal: 24,
    paddingTop: 48,
    paddingBottom: 32,
    maxWidth: 480,
    width: '100%',
    alignSelf: 'center',
  },
  loginTitle: {
    fontSize: 28,
    fontWeight: '800',
    color: '#0f172a',
    marginBottom: 8,
  },
  loginSubtitle: {
    fontSize: 15,
    lineHeight: 22,
    color: '#475569',
    marginBottom: 8,
  },
  loginHint: {
    fontSize: 12,
    color: '#94a3b8',
    marginBottom: 20,
  },
  loginFieldLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#334155',
    marginBottom: 6,
  },
  loginInput: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: Platform.OS === 'ios' ? 12 : 10,
    fontSize: 16,
    color: '#0f172a',
    marginBottom: 14,
    backgroundColor: '#f8fafc',
  },
  loginError: {
    color: '#b91c1c',
    fontSize: 14,
    marginBottom: 12,
  },
  loginStravaBtn: {
    backgroundColor: '#fc4c02',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: 12,
  },
  loginStravaBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  loginPrimaryBtn: {
    backgroundColor: '#7A3C4A',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 4,
  },
  loginPrimaryBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  loginLinkWrap: {
    marginTop: 16,
    alignItems: 'center',
  },
  loginLink: {
    color: '#7A3C4A',
    fontSize: 15,
    fontWeight: '600',
  },
  loginDivider: {
    height: 1,
    backgroundColor: '#e2e8f0',
    marginVertical: 24,
  },
  loginSecondaryBtn: {
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    backgroundColor: '#fff',
  },
  loginSecondaryBtnText: {
    color: '#475569',
    fontSize: 15,
    fontWeight: '600',
  },
});
