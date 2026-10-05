// Fahrmodus: songs play one after another, a voice announces them, and you only tap big buttons.
// Marks are saved as a draft; the decision is one tap ("Vorschlag übernehmen") or later when parked.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { emptyDraft, proposal, proposalDecision, RATING_LABELS, type CarStyle, type DraftTarget } from '../domain/carDraft';
import { addDecision, computeState, findMatch, findPlayoff } from '../domain/engine';
import { participantMap, roundEntries } from '../domain/participants';
import { newId } from '../domain/rng';
import type { CarDraft, CarRating, Decision, Song, TournamentState } from '../domain/types';
import { getAudio } from '../playback/audioStore';
import { player } from '../playback/player';
import { playbackFor } from '../playback/sources';
import { say, setSpeechEnabled, stopSpeech } from '../playback/speech';
import { createEmbed, type EmbedController, type PlaybackUpdate } from '../playback/spotifyEmbed';
import { demoUrl } from '../playback/synth';
import { fmtSeconds } from './common';
import { matchTitle } from './Play';
import { useStore } from './store';

// ---------------------------------------------------------------------------
// Preferences

interface CarPrefs {
  style: CarStyle;
  voice: boolean;
  length: 'full' | 'snippet';
}
const PREF_KEY = 'mc.car.v1';
function loadCarPrefs(): CarPrefs {
  try {
    return { style: 'buttons', voice: true, length: 'full', ...JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}') };
  } catch {
    return { style: 'buttons', voice: true, length: 'full' };
  }
}
function saveCarPrefs(p: CarPrefs) {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}
const SNIPPET = 30;

// ---------------------------------------------------------------------------
// Screen stays on while driving

function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let cancelled = false;
    const request = async () => {
      try {
        lock = await navigator.wakeLock.request('screen');
      } catch {
        /* e.g. battery saver */
      }
    };
    void request();
    const onVis = () => document.visibilityState === 'visible' && !cancelled && void request();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVis);
      void lock?.release().catch(() => undefined);
    };
  }, [active]);
}

// ---------------------------------------------------------------------------
// Playback: own audio element for files/demo, Spotify's iFrame API for Spotify songs

interface PlayState {
  kind: 'none' | 'audio' | 'spotify' | 'missing';
  playing: boolean;
  position: number; // s
  duration: number; // s
  /** Spotify didn't start on its own – a tap on its play button is needed. */
  needsTap: boolean;
  /** Spotify only plays the 30-second preview (not logged in). */
  preview: boolean;
  error: string | null;
}

const idle: PlayState = { kind: 'none', playing: false, position: 0, duration: 0, needsTap: false, preview: false, error: null };

function useCarPlayback(host: React.RefObject<HTMLDivElement | null>, localAudio: ReadonlySet<string>, onEnded: () => void) {
  const [st, setSt] = useState<PlayState>(idle);
  const audio = useRef<HTMLAudioElement | null>(null);
  const ctrl = useRef<EmbedController | null>(null);
  const token = useRef(0);
  const limit = useRef<number | null>(null);
  const ended = useRef(false);
  const armed = useRef(false);
  const objectUrl = useRef<string | null>(null);
  const endedCb = useRef(onEnded);
  endedCb.current = onEnded;
  const tapTimer = useRef<number | undefined>(undefined);

  const fireEnded = () => {
    if (ended.current) return;
    ended.current = true;
    endedCb.current();
  };

  const onSpotify = useRef((d: PlaybackUpdate) => {
    void d;
  });
  onSpotify.current = (d: PlaybackUpdate) => {
    const pos = d.position / 1000;
    const dur = d.duration / 1000;
    if (!armed.current) {
      // ignore stale updates of the previous track until the new one is really running
      if (!d.isPaused && pos < 5) armed.current = true;
      else return;
    }
    window.clearTimeout(tapTimer.current);
    setSt((s) => ({ ...s, playing: !d.isPaused, position: pos, duration: dur, needsTap: false, preview: dur > 0 && dur <= 31 }));
    if (limit.current !== null && pos >= limit.current) {
      ctrl.current?.pause();
      fireEnded();
    } else if (dur > 0 && pos >= dur - 0.8) fireEnded();
  };

  const stop = useCallback(() => {
    token.current++;
    window.clearTimeout(tapTimer.current);
    if (audio.current) {
      audio.current.pause();
      audio.current.removeAttribute('src');
    }
    if (objectUrl.current) {
      URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = null;
    }
    try {
      ctrl.current?.pause();
    } catch {
      /* not ready */
    }
    setSt(idle);
  }, []);

  const play = useCallback(
    async (song: Song, snippet: boolean) => {
      stop();
      const my = token.current;
      ended.current = false;
      armed.current = false;
      const info = playbackFor(song, localAudio);
      if (info.kind === 'none') {
        setSt({ ...idle, kind: 'missing', error: 'Für diesen Song gibt es keine Wiedergabe.' });
        return;
      }
      if (info.kind === 'spotify' && song.spotifyTrackId) {
        limit.current = snippet ? SNIPPET : null;
        setSt({ ...idle, kind: 'spotify' });
        try {
          if (!ctrl.current) {
            if (!host.current) return;
            ctrl.current = await createEmbed(host.current, song.spotifyTrackId);
            ctrl.current.addListener('playback_update', (e) => onSpotify.current(e.data));
            await new Promise<void>((r) => {
              ctrl.current!.addListener('ready', () => r());
              window.setTimeout(r, 4000);
            });
          } else {
            ctrl.current.loadUri(`spotify:track:${song.spotifyTrackId}`);
          }
          if (my !== token.current) return;
          ctrl.current.play();
          tapTimer.current = window.setTimeout(() => {
            if (my === token.current && !armed.current) setSt((s) => ({ ...s, needsTap: true }));
          }, 4500);
        } catch (e) {
          if (my === token.current) setSt({ ...idle, kind: 'spotify', error: e instanceof Error ? e.message : 'Spotify-Fehler' });
        }
        return;
      }
      // own audio / demo
      if (!audio.current) {
        const a = new Audio();
        a.preload = 'auto';
        a.addEventListener('timeupdate', () => {
          const pos = a.currentTime;
          setSt((s) => ({ ...s, position: pos, duration: a.duration || s.duration }));
          if (limit.current !== null && pos >= limit.current) {
            a.pause();
            fireEnded();
          }
        });
        a.addEventListener('play', () => setSt((s) => ({ ...s, playing: true, needsTap: false })));
        a.addEventListener('pause', () => setSt((s) => ({ ...s, playing: false })));
        a.addEventListener('ended', () => fireEnded());
        audio.current = a;
      }
      const a = audio.current;
      let src: string;
      if (info.kind === 'local') {
        const stored = await getAudio(song.audioKey ?? song.id);
        if (my !== token.current) return;
        if (!stored) {
          setSt({ ...idle, kind: 'missing', error: 'Die Audiodatei wurde nicht gefunden.' });
          return;
        }
        objectUrl.current = URL.createObjectURL(stored.blob);
        src = objectUrl.current;
      } else src = info.kind === 'url' ? song.audioUrl! : demoUrl(song.demoTone!);
      limit.current = snippet ? SNIPPET : null;
      setSt({ ...idle, kind: 'audio' });
      a.src = src;
      a.currentTime = 0;
      a.play().catch(() => my === token.current && setSt((s) => ({ ...s, needsTap: true })));
    },
    [host, localAudio, stop],
  );

  const toggle = useCallback(() => {
    if (st.kind === 'audio' && audio.current) {
      if (audio.current.paused) void audio.current.play().catch(() => undefined);
      else audio.current.pause();
    } else if (st.kind === 'spotify') ctrl.current?.togglePlay();
  }, [st.kind]);

  useEffect(
    () => () => {
      stop();
      try {
        ctrl.current?.destroy();
      } catch {
        /* ignore */
      }
      ctrl.current = null;
    },
    [stop],
  );

  return { st, play, stop, toggle };
}

/** The Spotify player host stays the same element on every screen, so the player is never rebuilt. */
function CarShell({ host, children }: { host: React.RefObject<HTMLDivElement | null>; children: React.ReactNode }) {
  const scale = useCarScale();
  return (
    <div className="car">
      <div
        className="car-scale"
        style={scale.zoom === 1 ? undefined : { zoom: scale.zoom, width: scale.width, height: scale.height }}
      >
        <div className="car-content">{children}</div>
        <div className="car-embed" ref={host} />
      </div>
    </div>
  );
}

/** Design size of the car screen (a typical phone in CSS pixels). */
const DESIGN_W = 412;
const DESIGN_H = 860;

/**
 * "Desktop-Website" in Chrome on Android lays the page out ~980px wide, which would make the car
 * screen tiny. Spotify only plays full songs in that mode, so the car screen scales itself up to
 * look exactly like the phone layout. On a normal phone the scale stays 1.
 */
export function carScale(w: number, h: number): { zoom: number; width: number; height: number } {
  const z = Math.min(w / DESIGN_W, h / DESIGN_H);
  const zoom = z > 1.15 ? Math.min(z, 4) : 1;
  return { zoom, width: w / zoom, height: h / zoom };
}

function useCarScale() {
  const read = () => carScale(window.innerWidth, window.innerHeight);
  const [s, setS] = useState(read);
  useEffect(() => {
    const on = () => setS(read());
    window.addEventListener('resize', on);
    window.addEventListener('orientationchange', on);
    return () => {
      window.removeEventListener('resize', on);
      window.removeEventListener('orientationchange', on);
    };
  }, []);
  return s;
}

/** Phone in the normal mobile layout (Spotify embed would only play previews there). */
function isMobileLayout(): boolean {
  return navigator.maxTouchPoints > 0 && window.innerWidth < 700;
}

// ---------------------------------------------------------------------------

interface Item {
  target: DraftTarget;
  title: string;
  roundLabel: string;
  roundIndex: number;
}

function itemFor(state: TournamentState, id: string): Item | null {
  for (const r of state.rounds) {
    const m = findMatch(state, id);
    if (m && m.roundIndex === r.index) {
      return {
        target: { id: m.id, songIds: m.songIds, advanceCount: m.advanceCount, evaluation: m.evaluation, candidateRequired: m.candidateRequired },
        title: matchTitle(r, m),
        roundLabel: r.label,
        roundIndex: r.index,
      };
    }
    const p = findPlayoff(state, id);
    if (p && p.roundIndex === r.index) {
      return {
        target: { id: p.id, songIds: p.contested, advanceCount: p.contestedSpots, evaluation: 'select', candidateRequired: false, isPlayoff: true },
        title: 'Zusatzplatz',
        roundLabel: r.label,
        roundIndex: r.index,
      };
    }
  }
  return null;
}

export function CarMode({ id }: { id: string }) {
  const { tournaments, saveTournament, go, localAudio } = useStore();
  const t = tournaments.find((x) => x.id === id);
  const state = useMemo(() => (t ? computeState(t) : null), [t]);
  const [prefs, setPrefsState] = useState<CarPrefs>(loadCarPrefs);
  const setPrefs = (p: Partial<CarPrefs>) => {
    const next = { ...prefs, ...p };
    setPrefsState(next);
    saveCarPrefs(next);
    setSpeechEnabled(next.voice);
  };
  const [started, setStarted] = useState(false);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [songIdx, setSongIdx] = useState(0);
  const [phase, setPhase] = useState<'listen' | 'review'>('listen');
  const [flash, setFlash] = useState<string | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const tRef = useRef(t);
  tRef.current = t;

  useWakeLock(started);
  useEffect(() => {
    player.stop(); // the normal player must not play at the same time
    setSpeechEnabled(prefs.voice);
    return () => stopSpeech();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const currentId = state?.openItems.find((o) => !skipped.includes(o.id))?.id ?? null;
  const item = state && currentId ? itemFor(state, currentId) : null;
  const songs = t && item ? roundEntries(t, item.roundIndex) : new Map<string, Song>();
  const list = item ? item.target.songIds.map((sid) => songs.get(sid)!).filter(Boolean) : [];
  const song = list[songIdx];
  const blind = !!t?.config.blindMode;
  const draft: CarDraft = (t && item && t.drafts?.[item.target.id]) || emptyDraft();
  const prop = item ? proposal(item.target, draft, prefs.style) : null;

  const nextRef = useRef<() => void>(() => undefined);
  const { st, play, stop, toggle } = useCarPlayback(host, localAudio, () => nextRef.current());

  const updateDraft = (fn: (d: CarDraft) => CarDraft) => {
    const cur = tRef.current;
    if (!cur || !item) return;
    const d = fn(cur.drafts?.[item.target.id] ?? emptyDraft());
    saveTournament({ ...cur, drafts: { ...(cur.drafts ?? {}), [item.target.id]: { ...d, updatedAt: new Date().toISOString() } } });
  };

  const label = (s: Song | undefined, i: number) => (blind || !s ? `Song ${i + 1}` : s.title);
  const artist = (s: Song | undefined) => (blind || !s ? '' : s.artists.join(', '));

  // announce + play whenever the song changes
  const playKey = started && phase === 'listen' && item && song ? `${item.target.id}:${songIdx}` : null;
  useEffect(() => {
    if (!playKey || !item || !song) return;
    let alive = true;
    const intro = songIdx === 0 ? `${item.roundIndex > 0 || item.title === 'Finale' ? `${item.roundLabel}. ` : ''}${item.title}. ` : '';
    const text = `${intro}Song ${songIdx + 1} von ${list.length}${blind ? '' : `: ${song.title}, von ${song.artists[0] ?? 'unbekannt'}`}.`;
    stop();
    void say(text).then(() => {
      if (alive) void play(song, prefs.length === 'snippet');
    });
    updateDraft((d) => (d.heard.includes(song.id) ? d : { ...d, heard: [...d.heard, song.id] }));
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: label(song, songIdx),
        artist: artist(song) || 'Music Cypher',
        album: `${item.title} · Song ${songIdx + 1}/${list.length}`,
      });
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playKey]);

  const goReview = () => {
    stop();
    setPhase('review');
    if (!item || !prop) return;
    const names = prop.selected.map((sid) => label(songs.get(sid), item.target.songIds.indexOf(sid))).join(' und ');
    void say(
      prop.complete
        ? `${item.title} fertig. Vorschlag: ${names} ${prop.selected.length === 1 ? 'kommt' : 'kommen'} weiter. Tippe auf Übernehmen.`
        : `${item.title} fertig. ${prop.reason ?? ''}`,
    );
  };

  const next = () => {
    if (!item) return;
    if (songIdx + 1 < list.length) setSongIdx(songIdx + 1);
    else goReview();
  };
  nextRef.current = next;
  const prev = () => songIdx > 0 && setSongIdx(songIdx - 1);

  // Bluetooth / steering wheel buttons
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const handlers: Array<[MediaSessionAction, () => void]> = [
      ['nexttrack', () => nextRef.current()],
      ['previoustrack', prev],
      ['play', toggle],
      ['pause', toggle],
    ];
    for (const [a, h] of handlers) {
      try {
        ms.setActionHandler(a, h);
      } catch {
        /* unsupported action */
      }
    }
    return () => {
      for (const [a] of handlers) {
        try {
          ms.setActionHandler(a, null);
        } catch {
          /* ignore */
        }
      }
    };
  });

  const rate = (r: CarRating) => {
    if (!song) return;
    updateDraft((d) => ({ ...d, ratings: { ...d.ratings, [song.id]: r } }));
    setFlash(RATING_LABELS[r]);
    window.setTimeout(() => setFlash(null), 900);
  };
  const toggleStar = () => {
    if (!song) return;
    updateDraft((d) => ({ ...d, stars: d.stars.includes(song.id) ? d.stars.filter((x) => x !== song.id) : [...d.stars, song.id] }));
  };

  const advanceToNextItem = () => {
    setSongIdx(0);
    setPhase('listen');
  };

  const confirm = () => {
    const cur = tRef.current;
    if (!cur || !item || !prop?.complete) return;
    const d: Decision = { ...proposalDecision(item.target, prop, draft, prefs.style), id: newId('d-'), at: new Date().toISOString() };
    const decisions = addDecision(cur, d);
    if (!decisions) return;
    const drafts = { ...(cur.drafts ?? {}) };
    delete drafts[item.target.id];
    saveTournament({ ...cur, decisions, drafts, postponed: cur.postponed.filter((x) => x !== item.target.id) });
    void say('Gespeichert.');
    advanceToNextItem();
  };

  const later = () => {
    if (!item) return;
    setSkipped((s) => [...s, item.target.id]);
    void say('Für später gemerkt.');
    advanceToNextItem();
  };

  if (!t || !state) {
    return (
      <CarShell host={host}>
        <p>Turnier nicht gefunden.</p>
        <button className="btn" onClick={() => go({ page: 'home' })}>
          Zur Startseite
        </button>
      </CarShell>
    );
  }

  const exit = () => {
    stop();
    stopSpeech();
    go({ page: 'play', id: t.id });
  };
  const party = (t.config.partyPlayers?.length ?? 0) >= 2;

  // ---- start screen
  if (!started) {
    return (
      <CarShell host={host}>
        <div className="car-top">
          <strong>🚗 Fahrmodus</strong>
          <span className="spacer" />
          <button className="btn small ghost" onClick={exit}>
            ✕ Schließen
          </button>
        </div>
        <div className="car-body stack">
          <h1 style={{ margin: 0 }}>{t.name}</h1>
          {party ? (
            <div className="notice warn">Im Partymodus stimmen mehrere Leute ab – das passt nicht zum Fahrmodus. Starte dafür ein Turnier ohne Partymodus.</div>
          ) : (
            <>
              <div className="car-setting">
                <span>Bewerten mit</span>
                <div className="seg" role="group" aria-label="Bewertung im Auto">
                  <button aria-pressed={prefs.style === 'buttons'} onClick={() => setPrefs({ style: 'buttons' })}>
                    Knöpfen
                  </button>
                  <button aria-pressed={prefs.style === 'stars'} onClick={() => setPrefs({ style: 'stars' })}>
                    ★ Merken
                  </button>
                </div>
              </div>
              <p className="small muted" style={{ margin: 0 }}>
                {prefs.style === 'buttons'
                  ? 'Pro Song ein Tipp: Top, Gut, Okay oder Raus. Die besten kommen weiter.'
                  : 'Tippe ★ bei den Songs, die weiterkommen sollen.'}
              </p>
              <div className="car-setting">
                <span>Länge</span>
                <div className="seg" role="group" aria-label="Länge">
                  <button aria-pressed={prefs.length === 'full'} onClick={() => setPrefs({ length: 'full' })}>
                    Ganzer Song
                  </button>
                  <button aria-pressed={prefs.length === 'snippet'} onClick={() => setPrefs({ length: 'snippet' })}>
                    30 Sekunden
                  </button>
                </div>
              </div>
              <div className="car-setting">
                <span>Ansage</span>
                <div className="seg" role="group" aria-label="Ansage">
                  <button aria-pressed={prefs.voice} onClick={() => setPrefs({ voice: true })}>
                    An
                  </button>
                  <button aria-pressed={!prefs.voice} onClick={() => setPrefs({ voice: false })}>
                    Aus
                  </button>
                </div>
              </div>
              {isMobileLayout() && (
                <div className="notice warn small">
                  <strong>Für ganze Spotify-Songs:</strong> In Chrome oben rechts auf ⋮ tippen und <strong>„Desktop-Website“</strong> anhaken.
                  Sonst spielt Spotify auf dem Handy nur 30-Sekunden-Vorschauen. Der Fahrmodus sieht danach genauso aus. (Geht im
                  Chrome-Tab, nicht in der installierten App.)
                </div>
              )}
              <div className="notice small">
                Handy in die Halterung, dann nur noch kurz tippen. Entschieden wird mit einem Tipp oder beim nächsten Halt – alles
                wird gespeichert. Die Weiter-Taste am Lenkrad springt zum nächsten Song (wenn dein Auto das unterstützt).
              </div>
              <button
                className="btn primary car-start"
                onClick={() => {
                  setStarted(true);
                  setSongIdx(0);
                  setPhase('listen');
                }}
                disabled={!state.openItems.length}
              >
                ▶ Los geht’s
              </button>
              {!state.openItems.length && <p className="muted">Dieses Turnier ist schon fertig.</p>}
            </>
          )}
        </div>
      </CarShell>
    );
  }

  // ---- tournament finished
  if (state.finished) {
    const champ = participantMap(t).get(state.champion!);
    return (
      <CarShell host={host}>
        <div className="car-body car-center">
          <div className="car-crown">🏆</div>
          <h1>{champ?.title}</h1>
          <p className="muted">{champ?.artists.join(', ')}</p>
          <button className="btn primary car-start" onClick={() => go({ page: 'result', id: t.id })}>
            Zum Ergebnis
          </button>
        </div>
      </CarShell>
    );
  }

  // ---- everything heard, decisions pending
  if (!item) {
    return (
      <CarShell host={host}>
        <div className="car-top">
          <strong>🚗 Fahrmodus</strong>
          <span className="spacer" />
          <button className="btn small ghost" onClick={exit}>
            ✕ Beenden
          </button>
        </div>
        <div className="car-body car-center">
          <h1>Alles gehört 👍</h1>
          <p className="muted">
            {state.openItems.length} {state.openItems.length === 1 ? 'Entscheidung wartet' : 'Entscheidungen warten'} auf dich – am besten beim nächsten
            Halt. Deine Markierungen sind gespeichert.
          </p>
          <button className="btn primary car-start" onClick={exit}>
            Jetzt entscheiden
          </button>
          <button className="btn car-big" onClick={() => setSkipped([])}>
            ↻ Nochmal von vorn hören
          </button>
        </div>
      </CarShell>
    );
  }

  const header = (
    <div className="car-top">
      <div>
        <div className="tiny muted">{item.roundLabel}</div>
        <strong>{item.title}</strong>
      </div>
      <span className="spacer" />
      <button className="btn small ghost" onClick={exit}>
        ✕ Beenden
      </button>
    </div>
  );

  // ---- review
  if (phase === 'review' && prop) {
    return (
      <CarShell host={host}>
        {header}
        <div className="car-body">
          <h2 style={{ margin: '0 0 8px' }}>{item.title} fertig</h2>
          <ol className="car-review">
            {prop.order.map((sid, i) => {
              const s = songs.get(sid);
              const idx = item.target.songIds.indexOf(sid);
              const q = i < item.target.advanceCount && prop.complete;
              const r = draft.ratings[sid];
              return (
                <li key={sid} className={q ? 'q' : ''}>
                  <span className="car-rv-mark">{q ? '✓' : prefs.style === 'stars' ? (draft.stars.includes(sid) ? '★' : '·') : i + 1}</span>
                  <span className="car-rv-title">
                    {label(s, idx)}
                    {!blind && s && <span className="muted"> · {s.artists[0]}</span>}
                  </span>
                  {prefs.style === 'buttons' && <span className={`car-rv-rating r${r ?? 0}`}>{r ? RATING_LABELS[r] : '–'}</span>}
                </li>
              );
            })}
          </ol>
          {!prop.complete && <div className="notice warn">{prop.reason}</div>}
          <div className="car-actions">
            {prop.complete && (
              <button className="btn primary car-big" onClick={confirm}>
                ✓ Übernehmen
              </button>
            )}
            <button className={`btn car-big ${prop.complete ? '' : 'primary'}`} onClick={later}>
              ⏭ Später entscheiden
            </button>
            <button
              className="btn car-big ghost"
              onClick={() => {
                setSongIdx(0);
                setPhase('listen');
              }}
            >
              ↻ Nochmal hören
            </button>
          </div>
        </div>
      </CarShell>
    );
  }

  // ---- listening
  const rating = song ? draft.ratings[song.id] : undefined;
  const starred = song ? draft.stars.includes(song.id) : false;
  const pct = st.duration ? Math.min(100, (st.position / (prefs.length === 'snippet' ? Math.min(SNIPPET, st.duration) : st.duration)) * 100) : 0;
  return (
    <CarShell host={host}>
      {header}
      <div className="car-body">
        <div className="car-dots" aria-label={`Song ${songIdx + 1} von ${list.length}`}>
          {list.map((s, i) => (
            <span key={s.id} className={i < songIdx ? 'done' : i === songIdx ? 'now' : ''} />
          ))}
        </div>
        <div className="car-song">
          <div className="car-num">Song {songIdx + 1} / {list.length}</div>
          <div className="car-title">{label(song, songIdx)}</div>
          <div className="car-artist">{artist(song)}</div>
        </div>
        <div className="car-progress">
          <div style={{ width: `${pct}%` }} />
        </div>
        <div className="tiny muted car-time">
          {fmtSeconds(st.position)} / {fmtSeconds(prefs.length === 'snippet' && st.duration ? Math.min(SNIPPET, st.duration) : st.duration)}
        </div>
        {st.needsTap && <div className="notice warn small">Spotify startet nicht von selbst – tippe unten im Spotify-Player einmal auf ▶.</div>}
        {st.preview && (
          <div className="notice small">
            Spotify spielt nur die 30-Sekunden-Vorschau.{' '}
            {isMobileLayout()
              ? 'Auf dem Handy: Chrome-Menü ⋮ → „Desktop-Website“ anhaken, dann laufen ganze Songs.'
              : 'Für ganze Songs in Chrome bei open.spotify.com einloggen.'}
          </div>
        )}
        {st.error && <div className="notice warn small">{st.error} Tippe auf ⏭, um weiterzumachen.</div>}

        {prefs.style === 'buttons' ? (
          <div className="car-rate">
            {([4, 3, 2, 1] as CarRating[]).map((r) => (
              <button key={r} className={`car-rate-btn r${r}`} aria-pressed={rating === r} onClick={() => rate(r)}>
                {r === 4 ? '🔥' : r === 3 ? '👍' : r === 2 ? '👌' : '👎'} {RATING_LABELS[r]}
              </button>
            ))}
          </div>
        ) : (
          <>
            <button className={`car-star ${starred ? 'on' : ''}`} aria-pressed={starred} onClick={toggleStar}>
              {starred ? '★ Gemerkt' : '☆ Merken'}
            </button>
            <div className={`car-star-hint ${draft.stars.length > item.target.advanceCount ? 'over' : ''}`}>
              ★ für {item.target.advanceCount} {item.target.advanceCount === 1 ? 'Song' : 'Songs'} · {draft.stars.length} gemerkt
            </div>
          </>
        )}
        {flash && <div className="car-flash">{flash}</div>}

        <div className="car-controls">
          <button className="btn car-ctl" onClick={prev} disabled={songIdx === 0} aria-label="Vorheriger Song">
            ⏮
          </button>
          <button className="btn car-ctl" onClick={toggle} aria-label={st.playing ? 'Pause' : 'Abspielen'}>
            {st.playing ? '⏸' : '▶'}
          </button>
          <button className="btn car-ctl primary" onClick={next} aria-label="Nächster Song">
            ⏭
          </button>
        </div>
      </div>
    </CarShell>
  );
}

