import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Linking, Platform, StyleSheet, View } from 'react-native';

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
  refreshUser: () => Promise<void>;
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

  // Globalt 401-håndtak: opprett ny anonym økt (ingen innloggingsskjerm).
  useEffect(() => {
    onUnauthenticated = () => {
      void (async () => {
        try {
          await bootstrapAnonymous();
        } catch {
          await applyAuth({ sessionToken: null, user: null });
        }
      })();
    };
    return () => {
      onUnauthenticated = null;
    };
  }, [applyAuth, bootstrapAnonymous]);

  // Første oppstart: valider lagret token, ellers anonym økt.
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

      try {
        await bootstrapAnonymous();
      } catch {
        await applyAuth({ sessionToken: null, user: null });
      }
    })();
  }, [applyAuth, bootstrapAnonymous]);

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
      refreshUser,
      serverUrl,
      setServerUrl,
      resetToDefaultServerUrl,
    }),
    [status, user, sessionToken, openStravaConnect, refreshUser, serverUrl, setServerUrl, resetToDefaultServerUrl],
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

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  if (status === 'loading') {
    return (
      <View style={authStyles.loadingContainer}>
        <ActivityIndicator size="large" color="#7A3C4A" />
      </View>
    );
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
});
