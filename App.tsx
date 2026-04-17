import AsyncStorage from '@react-native-async-storage/async-storage';
import { Picker } from '@react-native-picker/picker';
import { StatusBar } from 'expo-status-bar';
import * as Haptics from 'expo-haptics';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

const STORAGE_KEY = 'training-log-ios:sessions:v1';
const CHAT_STORAGE_KEY = 'training-log-ios:chat:v1';
const CHAT_CONFIG_KEY = 'training-log-ios:chat-config:v1';

const tabs = ['Oversikt', 'Logg økt', 'Historikk', 'Statistikk', 'Chat'] as const;
type Tab = (typeof tabs)[number];

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
  notes: string;
  exercises: Exercise[];
};

type SessionForm = Omit<Session, 'id'>;

type ToolCard = {
  kind: 'tool_card';
  title: string;
  bullets: string[];
};

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: number;
  toolCard?: ToolCard;
};

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
] as const;

function createDefaultForm(): SessionForm {
  return {
    date: new Date().toISOString().slice(0, 10),
    time: '',
    distance: '',
    feeling: 'ok',
    workoutType: 'Rolig løpetur',
    shoe: '',
    location: 'utendors',
    weather: 'Sol',
    notes: '',
    exercises: [{ name: '', reps: '', weight: '' }],
  };
}

function calculateTotals(sessions: Session[]) {
  const totalDistance = sessions.reduce((sum, session) => sum + Number(session.distance || 0), 0);
  return { count: sessions.length, distance: totalDistance.toFixed(1) };
}

function Card({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <View style={styles.card}>
      {title ? <Text style={styles.cardTitle}>{title}</Text> : null}
      {children}
    </View>
  );
}

function Chip({
  label,
  active,
  onPress,
}: {
  label: string;
  active?: boolean;
  onPress?: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, active ? styles.chipActive : styles.chipInactive]}>
      <Text style={[styles.chipText, active ? styles.chipTextActive : styles.chipTextInactive]}>{label}</Text>
    </Pressable>
  );
}

function PrimaryButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.primaryButton}>
      <Text style={styles.primaryButtonText}>{label}</Text>
    </Pressable>
  );
}

function OverviewTab({
  totals,
  latestWeather,
  sessions,
  onOpenLog,
}: {
  totals: { count: number; distance: string };
  latestWeather: string;
  sessions: Session[];
  onOpenLog: () => void;
}) {
  return (
    <View style={{ gap: 12 }}>
      <View style={styles.metricsRow}>
        <View style={[styles.metricTile, styles.metricTileFirst]}>
          <Text style={styles.metricLabel}>Antall økter</Text>
          <Text style={styles.metricValue}>{totals.count}</Text>
        </View>
        <View style={styles.metricTile}>
          <Text style={styles.metricLabel}>Total distanse</Text>
          <Text style={styles.metricValue}>{totals.distance} km</Text>
        </View>
        <View style={[styles.metricTile, styles.metricTileLast]}>
          <Text style={styles.metricLabel}>Siste vær</Text>
          <Text style={styles.metricValue}>{latestWeather}</Text>
        </View>
      </View>

      <PrimaryButton label="Loggfør økt" onPress={onOpenLog} />

      <Card title="Siste 5 loggføringer">
        {sessions.length === 0 ? (
          <Text style={styles.muted}>Ingen økter ennå.</Text>
        ) : (
          sessions.slice(0, 5).map((session) => (
            <View key={session.id} style={styles.listRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.listRowTitle}>{session.workoutType}</Text>
                <Text style={styles.muted}>{session.date}</Text>
              </View>
              <Text style={styles.listRowValue}>
                {session.workoutType === 'Styrketrening' ? session.time || '-' : `${session.distance} km`}
              </Text>
            </View>
          ))
        )}
      </Card>
    </View>
  );
}

function HistoryTab({ sessions, onRemove }: { sessions: Session[]; onRemove: (id: number) => void }) {
  return (
    <Card title="Historikk">
      {sessions.length === 0 ? (
        <Text style={styles.muted}>Ingen økter ennå.</Text>
      ) : (
        <View style={{ gap: 10 }}>
          {sessions.map((session) => (
            <View key={session.id} style={styles.sessionCard}>
              <View style={styles.sessionHeader}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.muted}>{session.date}</Text>
                  <Text style={styles.sessionTitle}>{session.workoutType}</Text>
                </View>
                <Pressable
                  onPress={() =>
                    Alert.alert('Slett økt', 'Vil du slette denne økten?', [
                      { text: 'Avbryt', style: 'cancel' },
                      { text: 'Slett', style: 'destructive', onPress: () => onRemove(session.id) },
                    ])
                  }
                  style={styles.dangerButton}
                >
                  <Text style={styles.dangerButtonText}>Slett</Text>
                </Pressable>
              </View>

              <View style={styles.detailGrid}>
                <Text style={styles.detailText}>
                  <Text style={styles.detailLabel}>Tid:</Text> {session.time}
                </Text>
                <Text style={styles.detailText}>
                  <Text style={styles.detailLabel}>Følelse:</Text> {session.feeling}
                </Text>

                {session.workoutType !== 'Styrketrening' ? (
                  <>
                    <Text style={styles.detailText}>
                      <Text style={styles.detailLabel}>Distanse:</Text> {session.distance} km
                    </Text>
                    <Text style={styles.detailText}>
                      <Text style={styles.detailLabel}>Sko:</Text> {session.shoe}
                    </Text>
                    <Text style={styles.detailText}>
                      <Text style={styles.detailLabel}>Sted:</Text>{' '}
                      {session.location === 'innendors' ? 'Innendørs' : 'Utendørs'}
                    </Text>
                    <Text style={styles.detailText}>
                      <Text style={styles.detailLabel}>Vær:</Text> {session.weather}
                    </Text>
                  </>
                ) : null}
              </View>

              {session.workoutType === 'Styrketrening' && session.exercises.length > 0 ? (
                <View style={{ marginTop: 10, gap: 6 }}>
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

              {session.notes ? <Text style={[styles.muted, { marginTop: 10 }]}>{session.notes}</Text> : null}
            </View>
          ))}
        </View>
      )}
    </Card>
  );
}

function StatisticsTab({ totals }: { totals: { count: number; distance: string } }) {
  return (
    <Card title="Statistikk">
      <View style={{ gap: 10 }}>
        <View style={styles.statTile}>
          <Text style={styles.metricLabel}>Registrerte økter</Text>
          <Text style={styles.metricValue}>{totals.count}</Text>
        </View>
        <View style={styles.statTile}>
          <Text style={styles.metricLabel}>Løpte kilometer</Text>
          <Text style={styles.metricValue}>{totals.distance} km</Text>
        </View>
      </View>
    </Card>
  );
}

function ChatTab() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [serverUrl, setServerUrl] = useState('http://localhost:8787');
  const [showSettings, setShowSettings] = useState(false);
  const listRef = useRef<FlatList<ChatMessage> | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [rawMessages, rawCfg] = await Promise.all([
          AsyncStorage.getItem(CHAT_STORAGE_KEY),
          AsyncStorage.getItem(CHAT_CONFIG_KEY),
        ]);

        if (rawCfg) {
          const cfg = JSON.parse(rawCfg) as { serverUrl?: string };
          if (cfg?.serverUrl) setServerUrl(cfg.serverUrl);
        }

        if (rawMessages) {
          const parsed = JSON.parse(rawMessages) as unknown;
          if (Array.isArray(parsed)) setMessages(parsed as ChatMessage[]);
        } else {
          setMessages([
            {
              id: String(Date.now()),
              role: 'assistant',
              text:
                'Hei! Jeg kan hjelpe deg å planlegge økter, forklare treningsvalg og (senere) koble på Strava/Garmin via tools. Hva vil du gjøre i dag?',
              createdAt: Date.now(),
            },
          ]);
        }
      } catch {
        // ignore
      }
    })();
  }, []);

  useEffect(() => {
    AsyncStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(messages)).catch(() => undefined);
  }, [messages]);

  useEffect(() => {
    AsyncStorage.setItem(CHAT_CONFIG_KEY, JSON.stringify({ serverUrl })).catch(() => undefined);
  }, [serverUrl]);

  async function send() {
    const text = draft.trim();
    if (!text || isSending) return;

    void Haptics.selectionAsync();
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
      const payload = {
        messages: [
          {
            role: 'system',
            content:
              'Du er en moderne, vennlig trening-assistent. Vær kort, konkret og handlingsrettet. Bruk norsk.',
          },
          ...[userMsg, ...messages]
            .slice(0, 20)
            .reverse()
            .map((m) => ({
              role: m.role,
              content: m.text,
            })),
        ],
      };

      const resp = await fetch(`${serverUrl}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!resp.ok) throw new Error('Kunne ikke nå chat-serveren.');
      const data = (await resp.json()) as { text?: string; toolResult?: ToolCard };

      const assistantMsg: ChatMessage = {
        id: `${Date.now()}-a`,
        role: 'assistant',
        text: data?.text || '',
        createdAt: Date.now(),
        toolCard: data?.toolResult?.kind === 'tool_card' ? data.toolResult : undefined,
      };

      setMessages((prev) => [assistantMsg, ...prev]);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setMessages((prev) => [
        {
          id: `${Date.now()}-err`,
          role: 'assistant',
          text:
            `Jeg fikk ikke kontakt med chat-serveren.\n\n` +
            `Sjekk at serveren kjører på Mac-en (port 8787) og at adressen stemmer.\n\n` +
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
    return (
      <View style={[styles.bubbleRow, isUser ? styles.bubbleRowRight : styles.bubbleRowLeft]}>
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
        </View>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, gap: 12 }}>
      <View style={styles.chatHeader}>
        <View style={{ flex: 1 }}>
          <Text style={styles.chatTitle}>Chat</Text>
          <Text style={styles.chatSubtitle} numberOfLines={1}>
            Tool-ready (Strava/Garmin senere) • {serverUrl.replace('http://', '')}
          </Text>
        </View>
        <Pressable onPress={() => setShowSettings(true)} style={styles.chatHeaderButton}>
          <Text style={styles.chatHeaderButtonText}>Innst.</Text>
        </Pressable>
      </View>

      <View style={styles.chatSurface}>
        <FlatList
          ref={(r) => {
            listRef.current = r;
          }}
          data={messages}
          keyExtractor={(m) => m.id}
          renderItem={({ item }) => <Bubble message={item} />}
          inverted
          contentContainerStyle={{ padding: 12, gap: 10 }}
        />

        {isSending ? (
          <View style={styles.typingRow}>
            <ActivityIndicator size="small" />
            <Text style={styles.typingText}>Skriver…</Text>
          </View>
        ) : null}

        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.composerRow}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder="Skriv en melding… (prøv: “Lag en 7-dagers plan for 10K”)"
              style={styles.composerInput}
              multiline
            />
            <Pressable onPress={send} style={[styles.sendButton, !draft.trim() || isSending ? styles.sendButtonDisabled : null]}>
              <Text style={styles.sendButtonText}>{isSending ? '...' : 'Send'}</Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </View>

      <Modal visible={showSettings} animationType="slide" onRequestClose={() => setShowSettings(false)}>
        <SafeAreaView style={styles.modalSafe}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Chat-innstillinger</Text>
            <Pressable onPress={() => setShowSettings(false)} style={styles.modalClose}>
              <Text style={styles.modalCloseText}>Lukk</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.modalContent} keyboardShouldPersistTaps="handled">
            <Text style={styles.fieldLabel}>Server-adresse</Text>
            <Text style={styles.muted}>
              På iOS Simulator kan du bruke <Text style={{ fontWeight: '800' }}>http://localhost:8787</Text>. På fysisk iPhone må dette være
              IP-adressen til Mac-en din (samme Wi‑Fi), f.eks. <Text style={{ fontWeight: '800' }}>http://192.168.1.23:8787</Text>.
            </Text>
            <TextInput value={serverUrl} onChangeText={setServerUrl} autoCapitalize="none" autoCorrect={false} style={styles.input} />

            <Pressable
              onPress={() => {
                void Haptics.selectionAsync();
                setMessages((prev) => prev.filter((m) => m.id.endsWith('-u') || m.id.endsWith('-a') || m.role));
                AsyncStorage.removeItem(CHAT_STORAGE_KEY).catch(() => undefined);
                setMessages([]);
              }}
              style={styles.dangerButton}
            >
              <Text style={styles.dangerButtonText}>Slett chat-historikk</Text>
            </Pressable>
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </View>
  );
}

function SessionModal({
  isOpen,
  form,
  onClose,
  onSubmit,
  onFieldChange,
}: {
  isOpen: boolean;
  form: SessionForm;
  onClose: () => void;
  onSubmit: () => void;
  onFieldChange: <K extends keyof SessionForm>(field: K, value: SessionForm[K]) => void;
}) {
  const isStrength = form.workoutType === 'Styrketrening';

  function getTimePart(index: number) {
    return form.time.split(':')[index] || '';
  }

  function setTimePart(index: number, value: string) {
    const parts = [getTimePart(0), getTimePart(1), getTimePart(2)];
    parts[index] = value.replace(/[^\d]/g, '').slice(0, 2);
    onFieldChange('time', parts.join(':'));
  }

  function updateExercise(index: number, field: keyof Exercise, value: string) {
    const next = [...form.exercises];
    next[index] = { ...next[index], [field]: value };
    onFieldChange('exercises', next);
  }

  function addExerciseRow() {
    onFieldChange('exercises', [...form.exercises, { name: '', reps: '', weight: '' }]);
  }

  function removeExerciseRow(index: number) {
    const next = form.exercises.filter((_, i) => i !== index);
    onFieldChange('exercises', next.length > 0 ? next : [{ name: '', reps: '', weight: '' }]);
  }

  return (
    <Modal visible={isOpen} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.modalSafe}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>Ny økt</Text>
          <Pressable onPress={onClose} style={styles.modalClose}>
            <Text style={styles.modalCloseText}>Lukk</Text>
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.modalContent} keyboardShouldPersistTaps="handled">
          <Text style={styles.sectionLabel}>Velg type økt</Text>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Chip label="🏃 Løping" active={!isStrength} onPress={() => onFieldChange('workoutType', 'Rolig løpetur')} />
            <Chip label="🏋️ Styrke" active={isStrength} onPress={() => onFieldChange('workoutType', 'Styrketrening')} />
          </View>

          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Dato</Text>
            <TextInput
              value={form.date}
              onChangeText={(t) => onFieldChange('date', t)}
              placeholder="YYYY-MM-DD"
              style={styles.input}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Tid (tt:mm:ss)</Text>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <TextInput
                value={getTimePart(0)}
                onChangeText={(t) => setTimePart(0, t)}
                placeholder="tt"
                keyboardType="number-pad"
                style={[styles.input, { flex: 1 }]}
              />
              <TextInput
                value={getTimePart(1)}
                onChangeText={(t) => setTimePart(1, t)}
                placeholder="mm"
                keyboardType="number-pad"
                style={[styles.input, { flex: 1 }]}
              />
              <TextInput
                value={getTimePart(2)}
                onChangeText={(t) => setTimePart(2, t)}
                placeholder="ss"
                keyboardType="number-pad"
                style={[styles.input, { flex: 1 }]}
              />
            </View>
          </View>

          {!isStrength ? (
            <>
              <View style={styles.field}>
                <Text style={styles.fieldLabel}>Distanse (km)</Text>
                <TextInput
                  value={form.distance}
                  onChangeText={(t) => onFieldChange('distance', t)}
                  placeholder="f.eks. 10"
                  keyboardType="decimal-pad"
                  style={styles.input}
                />
              </View>

              <View style={styles.field}>
                <Text style={styles.fieldLabel}>Skovalg</Text>
                <View style={styles.pickerWrap}>
                  <Picker selectedValue={form.shoe} onValueChange={(v) => onFieldChange('shoe', String(v))}>
                    <Picker.Item label="Velg sko" value="" />
                    {shoeOptions.map((shoe) => (
                      <Picker.Item key={shoe} label={shoe} value={shoe} />
                    ))}
                  </Picker>
                </View>
              </View>

              <View style={styles.field}>
                <Text style={styles.fieldLabel}>Type økt</Text>
                <View style={styles.chipGrid}>
                  {runWorkoutTypeOptions.map((option) => (
                    <Chip
                      key={option.value}
                      label={`${option.emoji} ${option.label}`}
                      active={form.workoutType === option.value}
                      onPress={() => onFieldChange('workoutType', option.value)}
                    />
                  ))}
                </View>
              </View>
            </>
          ) : (
            <View style={styles.field}>
              <View style={styles.exerciseHeader}>
                <Text style={styles.fieldLabel}>Øvelser</Text>
                <Pressable onPress={addExerciseRow} style={styles.secondaryButton}>
                  <Text style={styles.secondaryButtonText}>+ Legg til øvelse</Text>
                </Pressable>
              </View>

              <View style={{ gap: 10 }}>
                {form.exercises.map((exercise, index) => (
                  <View key={index} style={{ gap: 8 }}>
                    <TextInput
                      value={exercise.name}
                      onChangeText={(t) => updateExercise(index, 'name', t)}
                      placeholder="Navn på øvelse"
                      style={styles.input}
                    />
                    <View style={{ flexDirection: 'row', gap: 10 }}>
                      <TextInput
                        value={exercise.weight}
                        onChangeText={(t) => updateExercise(index, 'weight', t)}
                        placeholder="Antall kg"
                        keyboardType="decimal-pad"
                        style={[styles.input, { flex: 1 }]}
                      />
                      <TextInput
                        value={exercise.reps}
                        onChangeText={(t) => updateExercise(index, 'reps', t)}
                        placeholder="Antall reps"
                        keyboardType="number-pad"
                        style={[styles.input, { flex: 1 }]}
                      />
                      <Pressable onPress={() => removeExerciseRow(index)} style={styles.iconButton}>
                        <Text style={styles.iconButtonText}>🗑️</Text>
                      </Pressable>
                    </View>
                  </View>
                ))}
              </View>
            </View>
          )}

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

          {!isStrength ? (
            <>
              <View style={styles.field}>
                <Text style={styles.fieldLabel}>Sted</Text>
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <Chip
                    label="🏠 Innendørs"
                    active={form.location === 'innendors'}
                    onPress={() => onFieldChange('location', 'innendors')}
                  />
                  <Chip
                    label="🌤️ Utendørs"
                    active={form.location === 'utendors'}
                    onPress={() => onFieldChange('location', 'utendors')}
                  />
                </View>
              </View>

              <View style={styles.field}>
                <Text style={styles.fieldLabel}>Vær</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
                  {weatherOptions.map((option) => (
                    <Chip
                      key={option.value}
                      label={`${option.emoji} ${option.label}`}
                      active={form.weather === option.value}
                      onPress={() => onFieldChange('weather', option.value)}
                    />
                  ))}
                </ScrollView>
              </View>
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
            <Pressable onPress={onClose} style={styles.secondaryButtonFull}>
              <Text style={styles.secondaryButtonText}>Avbryt</Text>
            </Pressable>
            <Pressable onPress={onSubmit} style={styles.primaryButtonFull}>
              <Text style={styles.primaryButtonText}>Lagre</Text>
            </Pressable>
          </View>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('Oversikt');
  const [form, setForm] = useState<SessionForm>(createDefaultForm());
  const [sessions, setSessions] = useState<Session[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);

  const dailyQuote = useMemo(() => {
    const index = new Date().getDate() % motivationalQuotes.length;
    return motivationalQuotes[index];
  }, []);

  const totals = useMemo(() => calculateTotals(sessions), [sessions]);
  const latestWeather = sessions.find((s) => s.workoutType !== 'Styrketrening')?.weather || '-';

  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as unknown;
          if (Array.isArray(parsed)) {
            setSessions(parsed as Session[]);
          }
        }
      } catch {
        // ignore; we can still run without persistence
      } finally {
        setHasLoaded(true);
      }
    })();
  }, []);

  useEffect(() => {
    if (!hasLoaded) return;
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(sessions)).catch(() => undefined);
  }, [sessions, hasLoaded]);

  function updateField<K extends keyof SessionForm>(field: K, value: SessionForm[K]) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function openModal() {
    setForm(createDefaultForm());
    setIsModalOpen(true);
  }

  function handleSubmit() {
    const isStrength = form.workoutType === 'Styrketrening';

    if (!form.time) {
      Alert.alert('Mangler tid', 'Fyll inn tid før du lagrer.');
      return;
    }

    if (!isStrength && (!form.distance || !form.shoe)) {
      Alert.alert('Mangler info', 'For løping må du fylle inn distanse og velge sko.');
      return;
    }

    setSessions((prev) => [{ id: Date.now(), ...form }, ...prev]);
    setIsModalOpen(false);
  }

  function removeSession(id: number) {
    setSessions((prev) => prev.filter((s) => s.id !== id));
  }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.container}>
        <View style={{ gap: 10 }}>
          <Text style={styles.h1}>Treningslogg</Text>
          <Text style={styles.subtitle}>Loggfør øktene dine med tid, distanse, følelse, skovalg og forhold.</Text>
          <View style={styles.quoteBox}>
            <Text style={styles.quoteText}>"{dailyQuote}"</Text>
          </View>
        </View>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabsRow}>
          {tabs.map((tab) => (
            <Pressable
              key={tab}
              onPress={() => setActiveTab(tab)}
              style={[styles.tabButton, activeTab === tab ? styles.tabButtonActive : styles.tabButtonInactive]}
            >
              <Text style={[styles.tabButtonText, activeTab === tab ? styles.tabButtonTextActive : styles.tabButtonTextInactive]}>
                {tab}
              </Text>
            </Pressable>
          ))}
        </ScrollView>

        {activeTab === 'Oversikt' ? (
          <OverviewTab totals={totals} latestWeather={latestWeather} sessions={sessions} onOpenLog={openModal} />
        ) : null}

        {activeTab === 'Logg økt' ? (
          <View style={{ alignItems: 'flex-end' }}>
            <PrimaryButton label="Legg til økt" onPress={openModal} />
          </View>
        ) : null}

        {activeTab === 'Historikk' ? <HistoryTab sessions={sessions} onRemove={removeSession} /> : null}
        {activeTab === 'Statistikk' ? <StatisticsTab totals={totals} /> : null}
        {activeTab === 'Chat' ? <ChatTab /> : null}

        <SessionModal
          isOpen={isModalOpen}
          form={form}
          onClose={() => setIsModalOpen(false)}
          onSubmit={handleSubmit}
          onFieldChange={updateField}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  container: {
    padding: 16,
    gap: 16,
    paddingBottom: 40,
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
  quoteBox: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  quoteText: {
    fontSize: 14,
    fontStyle: 'italic',
    color: '#334155',
  },
  tabsRow: {
    gap: 8,
    paddingBottom: 4,
  },
  tabButton: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
  },
  tabButtonActive: {
    backgroundColor: '#0f172a',
    borderColor: '#0f172a',
  },
  tabButtonInactive: {
    backgroundColor: '#ffffff',
    borderColor: '#e2e8f0',
  },
  tabButtonText: {
    fontSize: 13,
    fontWeight: '600',
  },
  tabButtonTextActive: {
    color: '#ffffff',
  },
  tabButtonTextInactive: {
    color: '#0f172a',
  },
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#0f172a',
    marginBottom: 10,
  },
  muted: {
    color: '#64748b',
    fontSize: 13,
  },
  chatHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  chatTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#0f172a',
  },
  chatSubtitle: {
    marginTop: 2,
    fontSize: 12,
    fontWeight: '600',
    color: '#64748b',
  },
  chatHeaderButton: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#ffffff',
  },
  chatHeaderButtonText: {
    fontSize: 12,
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
  bubble: {
    maxWidth: '82%',
    borderRadius: 18,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  bubbleUser: {
    backgroundColor: '#2563eb',
    borderTopRightRadius: 6,
  },
  bubbleAssistant: {
    backgroundColor: '#f1f5f9',
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
  typingRow: {
    position: 'absolute',
    left: 12,
    bottom: 70,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(255,255,255,0.95)',
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#e2e8f0',
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
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
    backgroundColor: '#ffffff',
  },
  composerInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#ffffff',
    borderRadius: 16,
    paddingVertical: 10,
    paddingHorizontal: 12,
    fontSize: 14,
    fontWeight: '600',
    color: '#0f172a',
    maxHeight: 110,
  },
  sendButton: {
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 16,
    backgroundColor: '#0f172a',
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
    padding: 12,
  },
  metricTileFirst: {
    borderRadius: 16,
  },
  metricTileLast: {
    borderRadius: 16,
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
    backgroundColor: '#0f172a',
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  primaryButtonFull: {
    flex: 1,
    backgroundColor: '#0f172a',
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 16,
    alignItems: 'center',
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
  sessionCard: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 16,
    padding: 12,
    backgroundColor: '#ffffff',
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
    backgroundColor: '#f1f5f9',
    borderRadius: 16,
    padding: 14,
  },
  chip: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 14,
    borderWidth: 1,
  },
  chipActive: {
    backgroundColor: '#0f172a',
    borderColor: '#0f172a',
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
    color: '#ffffff',
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
  modalSafe: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  modalHeader: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#ffffff',
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#0f172a',
  },
  modalClose: {
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 12,
    backgroundColor: '#f1f5f9',
  },
  modalCloseText: {
    fontWeight: '800',
    color: '#0f172a',
    fontSize: 12,
  },
  modalContent: {
    padding: 16,
    gap: 14,
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
    paddingVertical: 12,
    paddingHorizontal: 12,
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
  exerciseHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  iconButton: {
    width: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 14,
    backgroundColor: '#ffffff',
  },
  iconButtonText: {
    fontSize: 18,
  },
});
