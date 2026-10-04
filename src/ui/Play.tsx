import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { addDecision, computeState, findMatch, findPlayoff, relevantTies, roundOfTarget, undoLast } from '../domain/engine';
import { roundEntries, unitize } from '../domain/participants';
import { newId } from '../domain/rng';
import { aggregateVotes, applyTieOrder, type AggregateInput } from '../domain/party';
import { computeRatings } from '../domain/rating';
import { pct, songHistoryIndex } from '../domain/stats';
import type { Decision, MatchState, PartyVote, PlayoffState, RoundState, Song, Tournament, TournamentState } from '../domain/types';
import { player, usePlayer } from '../playback/player';
import { artistsOf, Cover, Modal, PlaybackChip, PlayButton } from './common';
import { useStore } from './store';

type SongMap = Map<string, Song>;

/** How a song is shown – blind mode replaces title, artist and cover until the decision. */
interface Label {
  title: string;
  artists: string;
  /** undefined → neutral placeholder cover */
  song: Song | undefined;
  hidden: boolean;
}
/** Hide earlier scores/places (blind mode or the "frühere Punkte ausblenden" option). */
const HidePastCtx = createContext(false);
const LabelCtx = createContext<(id: string) => Label>(() => ({ title: '', artists: '', song: undefined, hidden: false }));
const useLabel = () => useContext(LabelCtx);

function realLabels(songs: SongMap) {
  return (id: string): Label => {
    const s = songs.get(id);
    return { title: s?.title ?? id, artists: artistsOf(s), song: s, hidden: false };
  };
}

/** Blind mode: "Song 1" … in the order of the current encounter. Also masks the player bar. */
function BlindProvider({ ids, children }: { ids: string[]; children: ReactNode }) {
  const key = ids.join('|');
  useEffect(() => {
    player.setMask(Object.fromEntries(ids.map((id, i) => [id, `Song ${i + 1}`])));
    return () => player.setMask(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const fn = (id: string): Label => {
    const i = ids.indexOf(id);
    return { title: i >= 0 ? `Song ${i + 1}` : 'Verdeckter Song', artists: 'verdeckt', song: undefined, hidden: true };
  };
  return <LabelCtx.Provider value={fn}>{children}</LabelCtx.Provider>;
}

/** Per-song info line on cards: results so far in this tournament and in earlier ones. */
const SongInfoCtx = createContext<(songId: string) => ReactNode>(() => null);

function useSongInfo(t: Tournament | undefined, state: TournamentState | null, all: Tournament[]) {
  const others = all.filter((x) => x.id !== t?.id);
  const othersKey = others.map((o) => o.id + o.updatedAt).join('|');
  const history = useMemo(() => songHistoryIndex(others), [othersKey]);
  const ratings = useMemo(() => new Map(computeRatings(others).map((r) => [r.song.id, r.rating])), [othersKey]);
  return (songId: string): ReactNode => {
    const parts: ReactNode[] = [];
    if (state) {
      for (const r of state.rounds) {
        for (const m of r.matches) {
          if (m.status !== 'done' || !m.songIds.includes(songId) || !m.outcome) continue;
          const q = m.outcome.qualified.includes(songId);
          const e = r.playoffs.some((p) => p.winners.includes(songId));
          const score = m.decision?.scores?.[songId];
          const place = m.outcome.order ? m.outcome.order.indexOf(songId) + 1 : null;
          parts.push(
            <span key={m.id} className={q || e ? 'hist-q' : 'hist-x'}>
              R{r.index + 1} {q ? '✓' : e ? '◆' : '✕'}
              {score !== undefined ? ` ${score} P.` : place ? ` Pl. ${place}` : ''}
            </span>,
          );
        }
      }
    }
    const h = history.get(songId);
    if (!parts.length && !h) return null;
    return (
      <div className="song-hist">
        {parts.length > 0 && <div>Bisher: {parts}</div>}
        {h && (
          <div className="faint">
            Früher: {h.appearances}× dabei{h.titles ? ` · ${h.titles}× Sieger 🏆` : h.finals ? ` · ${h.finals}× Finale` : ''}
            {h.winRate !== null ? ` · ${pct(h.winRate)} weiter` : ''}
            {ratings.has(songId) ? ` · Rating ${Math.round(ratings.get(songId)!)}` : ''}
          </div>
        )}
      </div>
    );
  };
}

function matchTitle(round: RoundState, m: MatchState): string {
  const real = round.matches.filter((x) => x.kind !== 'bye' && x.kind !== 'thirdPlace');
  const pos = real.indexOf(m) + 1;
  switch (m.kind) {
    case 'final':
      return 'Finale';
    case 'thirdPlace':
      return 'Spiel um Platz 3';
    case 'special':
      return 'Sondergruppe';
    case 'duel':
      return `Duell ${pos} von ${real.length}`;
    case 'cypher':
      return `Cypher ${pos} von ${real.length}`;
    default:
      return 'Freilos';
  }
}

export function groupName(round: RoundState, matchId: string): string {
  const m = round.matches.find((x) => x.id === matchId);
  if (!m) return '';
  if (m.kind === 'special') return 'Sondergruppe';
  const real = round.matches.filter((x) => x.kind === 'cypher' || x.kind === 'duel');
  const i = real.indexOf(m);
  return i < 26 ? `Cypher ${String.fromCharCode(65 + i)}` : `Cypher ${i + 1}`;
}

export function Play({ id }: { id: string }) {
  const { tournaments, saveTournament, go, toast } = useStore();
  const t = tournaments.find((x) => x.id === id);
  const state = useMemo(() => (t ? computeState(t) : null), [t]);
  const songInfo = useSongInfo(t, state, tournaments);
  const [focus, setFocus] = useState<string | null>(null);
  const [justDecided, setJustDecided] = useState<string | null>(null);
  const [confirmUndo, setConfirmUndo] = useState(false);
  // Double-click guard: a target can only be committed once per render cycle.
  const committed = useRef<string | null>(null);

  const current = useMemo(() => {
    if (!state || !t) return null;
    const open = state.openItems;
    if (focus && open.some((o) => o.id === focus)) return open.find((o) => o.id === focus)!;
    return open.find((o) => !t.postponed.includes(o.id)) ?? open[0] ?? null;
  }, [state, t, focus]);

  // Changing the encounter stops playback.
  const currentId = justDecided ? `done:${justDecided}` : current?.id;
  useEffect(() => {
    player.stop();
  }, [currentId]);

  if (!t || !state) {
    return (
      <div className="card">
        <h1>Turnier nicht gefunden</h1>
        <button className="btn" onClick={() => go({ page: 'home' })}>
          Zur Startseite
        </button>
      </div>
    );
  }

  const round = state.rounds[state.rounds.length - 1];
  const songs: SongMap = roundEntries(t, round.index);
  const realMatches = state.rounds.flatMap((r) => r.matches.filter((m) => m.kind !== 'bye'));
  const decidedTotal = realMatches.filter((m) => m.status === 'done').length;
  const roundReal = round.matches.filter((m) => m.kind !== 'bye');
  const roundDone = roundReal.filter((m) => m.status === 'done').length + round.playoffs.filter((p) => p.status === 'done').length;
  const roundTotal = roundReal.length + round.playoffs.filter((p) => p.status !== 'auto').length;

  const commit = (d: Omit<Decision, 'id' | 'at'>) => {
    if (committed.current === d.targetId) return;
    committed.current = d.targetId;
    const decision: Decision = { ...d, id: newId('d-'), at: new Date().toISOString() };
    const next = addDecision(t, decision);
    if (!next) {
      toast('Diese Entscheidung wurde bereits gespeichert.');
      return;
    }
    saveTournament({ ...t, decisions: next, postponed: t.postponed.filter((x) => x !== d.targetId) });
    setJustDecided(d.targetId);
    setFocus(null);
  };

  const postpone = (itemId: string) => {
    const open = state.openItems.filter((o) => o.id !== itemId);
    if (open.length === 0) {
      toast('Das ist die letzte offene Entscheidung dieser Runde.');
      return;
    }
    saveTournament({ ...t, postponed: Array.from(new Set([...t.postponed.filter((x) => x !== itemId), itemId])) });
    const nextItem = open.find((o) => !t.postponed.includes(o.id) && o.id !== itemId) ?? open[0];
    setFocus(nextItem.id);
    toast('Zurückgestellt – die Begegnung bleibt offen.');
  };

  const lastDecision = state.validDecisions[state.validDecisions.length - 1];
  const doUndo = () => {
    const decisions = undoLast(t);
    committed.current = null;
    saveTournament({ ...t, decisions });
    setJustDecided(null);
    setFocus(lastDecision?.targetId ?? null);
    setConfirmUndo(false);
    toast('Letzte Entscheidung rückgängig gemacht.');
  };

  const header = (
    <div className="play-head">
      <div style={{ flex: 1, minWidth: 220 }}>
        <div className="small muted">{t.name}</div>
        <h1 style={{ margin: '2px 0' }}>{round.label}</h1>
        <div className="muted small">{unitize(round.sublabel, !!t.artistMode)}</div>
      </div>
      <div className="row">
        <button className="btn small ghost" onClick={() => go({ page: 'overview', id: t.id })}>
          Übersicht
        </button>
        <button className="btn small ghost" disabled={!lastDecision} onClick={() => setConfirmUndo(true)}>
          ↶ Rückgängig
        </button>
      </div>
      <div style={{ flexBasis: '100%' }}>
        <div className="progress" aria-label={`Runde: ${roundDone} von ${roundTotal} entschieden`}>
          <div style={{ width: `${roundTotal ? (roundDone / roundTotal) * 100 : 100}%` }} />
        </div>
        <div className="tiny faint" style={{ marginTop: 4 }}>
          Diese Runde: {roundDone}/{roundTotal} entschieden · Insgesamt {decidedTotal} Begegnungen entschieden
        </div>
      </div>
    </div>
  );

  const undoModal = confirmUndo && lastDecision && (
    <Modal
      title="Letzte Entscheidung rückgängig machen?"
      onClose={() => setConfirmUndo(false)}
      actions={
        <>
          <button className="btn ghost" onClick={() => setConfirmUndo(false)}>
            Abbrechen
          </button>
          <button className="btn primary" onClick={doUndo}>
            Rückgängig machen
          </button>
        </>
      }
    >
      <p>
        Die Entscheidung in <strong>{describeTarget(state, lastDecision.targetId)}</strong> wird zurückgesetzt. Davon abhängige
        Ergebnisse (Zusatzplätze, nächste Runde) werden neu berechnet.
      </p>
    </Modal>
  );

  if (justDecided) {
    return (
      <div className="stack">
        {header}
        <DecidedPanel state={state} targetId={justDecided} songs={roundEntries(t, roundOfTarget(justDecided))} blind={!!t.config.blindMode} />
        <div className="row end">
          {state.finished ? (
            <button className="btn primary big" onClick={() => go({ page: 'result', id: t.id })} autoFocus>
              Zum Ergebnis 🏆
            </button>
          ) : (
            <button className="btn primary big" onClick={() => setJustDecided(null)} autoFocus>
              Weiter →
            </button>
          )}
        </div>
        {undoModal}
      </div>
    );
  }

  if (state.finished || !current) {
    return (
      <div className="stack">
        {header}
        <div className="card">
          <h2>Turnier abgeschlossen</h2>
          <button className="btn primary" onClick={() => go({ page: 'result', id: t.id })}>
            Zum Ergebnis
          </button>
        </div>
        {undoModal}
      </div>
    );
  }

  const otherOpen = state.openItems.filter((o) => o.id !== current.id);
  const postponedOpen = state.openItems.filter((o) => t.postponed.includes(o.id) && o.id !== current.id);

  return (
    <SongInfoCtx.Provider value={songInfo}>
    <HidePastCtx.Provider value={!!(t.config.blindMode || t.config.hidePastScores)}>
    <LabelCtx.Provider value={realLabels(songs)}>
    <div className="stack">
      {header}
      {round.notes.length > 0 && round.matches.every((m) => m.status !== 'done') && (
        <div className="notice small">
          {round.notes.map((n) => (
            <div key={n}>{n}</div>
          ))}
        </div>
      )}
      {t.artistMode && (
        <div className="notice small">
          🎤 <strong>Künstler-Cypher</strong> – in dieser Runde bringt jeder Künstler seinen {round.index + 1}. Song. Wer weiterkommt,
          tritt nächste Runde mit einem neuen Song an.
        </div>
      )}
      {round.index === 0 && t.drawNotes.length > 0 && state.validDecisions.length === 0 && (
        <div className="notice small">{t.drawNotes.join(' ')}</div>
      )}
      {current.type === 'match' ? (
        <MatchBoard
          key={current.id}
          t={t}
          round={round}
          match={findMatch(state, current.id)!}
          songs={songs}
          onCommit={commit}
          onPostpone={otherOpen.length ? () => postpone(current.id) : undefined}
        />
      ) : (
        <PlayoffBoard
          key={current.id}
          t={t}
          round={round}
          playoff={findPlayoff(state, current.id)!}
          songs={songs}
          onCommit={commit}
          onPostpone={otherOpen.length ? () => postpone(current.id) : undefined}
        />
      )}
      {postponedOpen.length > 0 && (
        <div className="small muted">
          Zurückgestellt:{' '}
          {postponedOpen.map((o) => (
            <button key={o.id} className="btn small ghost" onClick={() => setFocus(o.id)}>
              {describeTarget(state, o.id)}
            </button>
          ))}
        </div>
      )}
      {undoModal}
    </div>
    </LabelCtx.Provider>
    </HidePastCtx.Provider>
    </SongInfoCtx.Provider>
  );
}

export function describeTarget(state: TournamentState, targetId: string): string {
  for (const r of state.rounds) {
    const m = r.matches.find((x) => x.id === targetId);
    if (m) return `${r.label} · ${matchTitle(r, m)}`;
    const p = r.playoffs.find((x) => x.id === targetId);
    if (p) return `${r.label} · Zusatzplatz${p.scope === 'block' ? ` (Block ${(p.blockIndex ?? 0) + 1})` : ''}`;
  }
  return targetId;
}

// ---------------------------------------------------------------------------

function SongCard({
  song,
  index,
  picked,
  dim,
  badge,
  rankBadge,
  children,
}: {
  song: Song;
  index: number;
  picked?: boolean;
  dim?: boolean;
  badge?: ReactNode;
  rankBadge?: ReactNode;
  children?: ReactNode;
}) {
  const p = usePlayer();
  const label = useLabel()(song.id);
  const hidePast = useContext(HidePastCtx);
  const info = useContext(SongInfoCtx)(song.id);
  const playing = p.song?.id === song.id;
  return (
    <article
      className={`songcard ${picked ? 'picked' : ''} ${playing ? 'playing' : ''} ${dim ? 'out' : ''} ${label.hidden ? 'blind' : ''}`}
      aria-label={`Song ${index + 1}: ${label.title}`}
    >
      {badge && <span className="badge-pick">{badge}</span>}
      {rankBadge && <span className="badge-rank">{rankBadge}</span>}
      {label.hidden ? (
        <div className="cover blind-cover" aria-hidden="true">
          <span>{index + 1}</span>
        </div>
      ) : (
        <Cover song={song} size="fill" />
      )}
      <div>
        <div className="st">{label.title}</div>
        <div className="sa">{label.hidden ? '🙈 verdeckt bis zur Entscheidung' : artistsOf(song)}</div>
        {!label.hidden && song.album && <div className="tiny faint">{song.album}</div>}
        {!label.hidden && !hidePast && info}
      </div>
      <div>
        <PlaybackChip song={song} />
      </div>
      <div className="actions">
        <PlayButton song={song} compact label={label.title} />
        {!label.hidden && song.spotifyTrackId && (
          <a className="btn small ghost" href={`https://open.spotify.com/track/${song.spotifyTrackId}`} target="_blank" rel="noreferrer" title="In Spotify öffnen">
            Spotify ↗
          </a>
        )}
      </div>
      {children}
    </article>
  );
}

/** Number keys 1–4 play/pause the songs of the current encounter. */
function useNumberKeys(list: Song[]) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.metaKey || e.ctrlKey || e.altKey) return;
      const n = Number(e.key);
      if (n >= 1 && n <= list.length) player.toggle(list[n - 1]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [list]);
}

interface BoardProps {
  t: Tournament;
  round: RoundState;
  songs: SongMap;
  onCommit: (d: Omit<Decision, 'id' | 'at'>) => void;
  onPostpone?: () => void;
  /** Party mode: the person currently voting. The board then submits a vote instead of a decision. */
  voter?: string;
}

function MatchBoard(props: BoardProps & { match: MatchState }) {
  const { match, round, songs } = props;
  const list = match.songIds.map((id) => songs.get(id)!);
  useNumberKeys(list);
  const isFinal = match.kind === 'final';
  const renderBoard = (extra: Partial<BoardProps>) => {
    const p = { ...props, ...extra };
    if (match.evaluation === 'select') return <SelectBoard {...p} list={list} />;
    if (match.evaluation === 'rank') return <RankBoard {...p} list={list} />;
    return <ScoreBoard {...p} list={list} />;
  };
  const players = props.t.config.partyPlayers ?? [];
  let board: ReactNode =
    players.length >= 2 ? (
      <PartyFlow
        players={players}
        input={match}
        targetId={match.id}
        renderBoard={(voter, onVote, first) =>
          renderBoard({ voter, onCommit: (d) => onVote({ player: voter, selected: d.selected, order: d.order, scores: d.scores }), onPostpone: first ? props.onPostpone : undefined })
        }
        toDecision={(final, agg, votes) => {
          const base = { targetId: match.id, songIds: match.songIds, votes };
          if (match.evaluation === 'select') return { ...base, selected: final.slice(0, match.advanceCount) };
          if (match.evaluation === 'rank') return { ...base, order: final };
          return { ...base, scores: agg.value, order: final, resolvedTies: agg.ties };
        }}
        onCommit={props.onCommit}
      />
    ) : (
      renderBoard({})
    );
  if (props.t.config.blindMode) board = <BlindProvider ids={match.songIds}>{board}</BlindProvider>;
  return (
    <div className="stack">
      {isFinal && (
        <div className="final-banner">
          <div className="tiny" style={{ letterSpacing: '0.15em', textTransform: 'uppercase' }}>
            {round.sublabel}
          </div>
          <h2>Das Finale</h2>
        </div>
      )}
      <div className="row">
        <h2 style={{ margin: 0 }}>{matchTitle(round, match)}</h2>
        {match.kind === 'special' && <span className="chip warn">Sondergruppe mit {match.songIds.length} Songs</span>}
        {match.candidateRequired && <span className="chip violet">Platz {match.advanceCount + 1} kämpft um einen Zusatzplatz</span>}
      </div>
      <p className="muted small" style={{ margin: 0 }}>
        {match.evaluation === 'select'
          ? match.advanceCount === 1
            ? isFinal
              ? 'Hör dir die Songs an und wähle deinen Gewinner.'
              : 'Hör dir die Songs an und wähle, wer weiterkommt.'
            : `Wähle genau ${match.advanceCount} Songs, die weiterkommen.`
          : match.evaluation === 'rank'
            ? `Ordne die Songs auf Platz 1 bis ${match.songIds.length}. ${isFinal ? 'Platz 1 gewinnt.' : `Die ersten ${match.advanceCount} kommen weiter.`}`
            : `Bewerte jeden Song von 1 bis 10. ${isFinal ? 'Die beste Bewertung gewinnt.' : `Die besten ${match.advanceCount} kommen weiter.`}`}{' '}
        <span className="faint">Tasten 1–{list.length} spielen die Songs ab.</span>
      </p>
      {board}
    </div>
  );
}

function DecisionBar({
  children,
  ready,
  onConfirm,
  onPostpone,
  confirmLabel = 'Auswahl bestätigen',
}: {
  children?: ReactNode;
  ready: boolean;
  onConfirm: () => void;
  onPostpone?: () => void;
  confirmLabel?: string;
}) {
  const [clicked, setClicked] = useState(false);
  return (
    <div className="decision-bar">
      {children}
      <span className="spacer" />
      {onPostpone && (
        <button className="btn ghost small" onClick={onPostpone}>
          Später entscheiden
        </button>
      )}
      <button
        className="btn primary"
        disabled={!ready || clicked}
        onClick={() => {
          setClicked(true);
          onConfirm();
        }}
      >
        {confirmLabel}
      </button>
    </div>
  );
}

function SelectBoard({ match, list, onCommit, onPostpone, voter }: BoardProps & { match: MatchState; list: Song[] }) {
  const [picked, setPicked] = useState<string[]>([]);
  const need = match.advanceCount;
  const toggle = (id: string) => {
    setPicked((p) => {
      if (p.includes(id)) return p.filter((x) => x !== id);
      if (need === 1) return [id];
      if (p.length >= need) return p;
      return [...p, id];
    });
  };
  const winLabel = match.kind === 'final' || match.kind === 'thirdPlace' ? 'Gewinner' : 'Weiter';
  return (
    <>
      <div className={`cards ${list.length === 2 ? 'duel' : ''}`}>
        {list.map((s, i) => {
          const on = picked.includes(s.id);
          return (
            <SongCard key={s.id} song={s} index={i} picked={on} badge={on ? <>✓ {winLabel}</> : undefined}>
              <button
                className="btn pick-btn"
                aria-pressed={on}
                onClick={() => toggle(s.id)}
                disabled={!on && need > 1 && picked.length >= need}
              >
                {on ? `✓ ${winLabel}` : need === 1 ? 'Diesen wählen' : 'Auswählen'}
              </button>
            </SongCard>
          );
        })}
      </div>
      <DecisionBar
        ready={picked.length === need}
        onPostpone={onPostpone}
        confirmLabel={voter ? `Stimme abgeben (${voter})` : undefined}
        onConfirm={() => onCommit({ targetId: match.id, songIds: match.songIds, selected: picked })}
      >
        <span className={`counter ${picked.length === need ? 'ok' : ''}`} aria-live="polite">
          {picked.length} von {need} ausgewählt
        </span>
      </DecisionBar>
    </>
  );
}

function placeLabel(i: number, total: number, showPoints: boolean) {
  return (
    <>
      <span className="pl-word">Platz </span>
      {i + 1}
      <span className="pl-dot">.</span>
      {showPoints ? <span className="tiny muted"> · {total - i} P.</span> : null}
    </>
  );
}

function RankList({
  order,
  setOrder,
  songs,
  advance,
  candidate,
  showPoints,
  extra,
}: {
  order: string[];
  setOrder: (o: string[]) => void;
  songs: SongMap;
  advance: number;
  candidate: boolean;
  showPoints: boolean;
  extra?: (id: string) => ReactNode;
}) {
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const label = useLabel();
  void songs;
  const move = (from: number, to: number) => {
    if (to < 0 || to >= order.length || from === to) return;
    const o = order.slice();
    const [x] = o.splice(from, 1);
    o.splice(to, 0, x);
    setOrder(o);
  };
  return (
    <ol className="ranklist" aria-label="Rangfolge">
      {order.map((id, i) => {
        const s = label(id);
        const q = i < advance;
        const c = candidate && i === advance;
        return (
          <li
            key={id}
            className={`rankitem ${q ? 'q' : ''} ${c ? 'cand' : ''} ${drag === i ? 'dragging' : ''} ${over === i ? 'over' : ''}`}
            draggable
            onDragStart={(e) => {
              setDrag(i);
              e.dataTransfer.effectAllowed = 'move';
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(i);
            }}
            onDragLeave={() => setOver(null)}
            onDrop={(e) => {
              e.preventDefault();
              if (drag !== null) move(drag, i);
              setDrag(null);
              setOver(null);
            }}
            onDragEnd={() => {
              setDrag(null);
              setOver(null);
            }}
          >
            <span className="place">{placeLabel(i, order.length, showPoints)}</span>
            {s.song ? <Cover song={s.song} size={40} className="rank-cover" /> : <div className="cover blind-cover rank-cover" style={{ width: 40, height: 40 }} aria-hidden="true" />}
            <div className="meta">
              <div className="title">{s.title}</div>
              <div className="sub">
                {s.artists} {extra?.(id)}
              </div>
            </div>
            <span className="tiny rstatus">
              {q ? <span style={{ color: 'var(--accent)' }}>✓<span className="st-word"> weiter</span></span> : c ? <span style={{ color: 'var(--violet)' }}>◆<span className="st-word"> Zusatzplatz?</span></span> : <span className="faint">✕<span className="st-word"> raus</span></span>}
            </span>
            <button className="btn icon small ghost" onClick={() => move(i, i - 1)} disabled={i === 0} aria-label={`${s.title} nach oben`}>
              ↑
            </button>
            <button className="btn icon small ghost" onClick={() => move(i, i + 1)} disabled={i === order.length - 1} aria-label={`${s.title} nach unten`}>
              ↓
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function RankBoard({ t, match, list, songs, onCommit, onPostpone, voter }: BoardProps & { match: MatchState; list: Song[] }) {
  const [order, setOrder] = useState<string[]>(match.songIds);
  const [touched, setTouched] = useState(false);
  const isFinal = match.kind === 'final';
  return (
    <>
      <div className="cards">
        {list.map((s, i) => (
          <SongCard key={s.id} song={s} index={i} rankBadge={touched ? `Platz ${order.indexOf(s.id) + 1}` : undefined} />
        ))}
      </div>
      <section className="card">
        <h3>Deine Rangfolge</h3>
        <p className="tiny muted">Ziehen oder mit ↑ ↓ sortieren. Die Klickreihenfolge beim Anhören spielt keine Rolle.</p>
        <RankList
          order={order}
          setOrder={(o) => {
            setOrder(o);
            setTouched(true);
          }}
          songs={songs}
          advance={match.advanceCount}
          candidate={match.candidateRequired}
          showPoints={t.config.showRankPoints && !isFinal}
        />
      </section>
      <DecisionBar
        ready
        confirmLabel={voter ? `Stimme abgeben (${voter})` : 'Rangfolge bestätigen'}
        onPostpone={onPostpone}
        onConfirm={() => onCommit({ targetId: match.id, songIds: match.songIds, order })}
      >
        <span className="small muted">{touched ? 'Rangfolge angepasst.' : 'Noch in Ausgangsreihenfolge – bitte prüfen.'}</span>
      </DecisionBar>
    </>
  );
}

function sameSet(a: string[], b: string[]) {
  return a.length === b.length && a.every((x) => b.includes(x));
}

function ScoreBoard({ match, list, onCommit, onPostpone, voter }: BoardProps & { match: MatchState; list: Song[] }) {
  const label = useLabel();
  const [scores, setScores] = useState<Record<string, number>>({});
  const [tieOrder, setTieOrder] = useState<string[]>(match.songIds);
  const [resolved, setResolved] = useState<string[][]>([]);
  const allScored = match.songIds.every((id) => typeof scores[id] === 'number');
  const order = useMemo(
    () =>
      match.songIds
        .slice()
        .sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0) || tieOrder.indexOf(a) - tieOrder.indexOf(b)),
    [match.songIds, scores, tieOrder],
  );
  // A single party vote doesn't need tie-breaks – the group result does.
  const ties = allScored && !voter ? relevantTies(order, scores, match.advanceCount, match.candidateRequired) : [];
  const open = ties.filter((c) => !resolved.some((r) => sameSet(r, c)));

  const setScore = (id: string, v: number) => {
    setScores((s) => ({ ...s, [id]: v }));
    setResolved((r) => r.filter((c) => !c.includes(id)));
  };
  const moveInTie = (id: string, dir: -1 | 1, cluster: string[]) => {
    const inCluster = order.filter((x) => cluster.includes(x));
    const i = inCluster.indexOf(id);
    const j = i + dir;
    if (j < 0 || j >= inCluster.length) return;
    const other = inCluster[j];
    setTieOrder((o) => {
      const n = o.slice();
      const a = n.indexOf(id);
      const b = n.indexOf(other);
      [n[a], n[b]] = [n[b], n[a]];
      return n;
    });
    setResolved((r) => r.filter((c) => !sameSet(c, cluster)));
  };

  return (
    <>
      <div className="cards">
        {list.map((s, i) => (
          <SongCard key={s.id} song={s} index={i} picked={typeof scores[s.id] === 'number'} rankBadge={scores[s.id] ? `${scores[s.id]} / 10` : undefined}>
            <div className="score-pad" role="group" aria-label={`Bewertung für ${label(s.id).title}`}>
              {Array.from({ length: 10 }, (_, k) => k + 1).map((v) => (
                <button key={v} aria-pressed={scores[s.id] === v} onClick={() => setScore(s.id, v)} aria-label={`${v} Punkte`}>
                  {v}
                </button>
              ))}
            </div>
          </SongCard>
        ))}
      </div>

      {allScored && (
        <section className="card">
          <h3>{voter ? `Reihenfolge nach Punkten von ${voter}` : 'Ergebnis nach deinen Punkten'}</h3>
          <ol className="ranklist">
            {order.map((id, i) => {
              const s = label(id);
              const q = i < match.advanceCount;
              const c = match.candidateRequired && i === match.advanceCount;
              return (
                <li key={id} className={`rankitem ${q ? 'q' : ''} ${c ? 'cand' : ''}`} style={{ cursor: 'default' }}>
                  <span className="place">{scores[id]} P.</span>
                  <div className="meta">
                    <div className="title">{s.title}</div>
                    <div className="sub">{s.artists}</div>
                  </div>
                  <span className="tiny" style={{ minWidth: 90, textAlign: 'right' }}>
                    {q ? <span style={{ color: 'var(--accent)' }}>✓ weiter</span> : c ? <span style={{ color: 'var(--violet)' }}>◆ Zusatzplatz?</span> : <span className="faint">✕ raus</span>}
                  </span>
                </li>
              );
            })}
          </ol>
          {ties.map((cluster) => {
            const done = resolved.some((r) => sameSet(r, cluster));
            const inOrder = order.filter((x) => cluster.includes(x));
            return (
              <div key={cluster.slice().sort().join('|')} className={`notice ${done ? 'ok' : 'warn'}`} style={{ marginTop: 12 }}>
                <strong>Gleichstand mit {scores[cluster[0]]} Punkten</strong> – entscheidet über das Weiterkommen. Hör die Songs
                direkt gegeneinander und lege die Reihenfolge fest:
                <ol className="ranklist" style={{ marginTop: 8 }}>
                  {inOrder.map((id, i) => (
                    <li key={id} className="rankitem" style={{ cursor: 'default' }}>
                      <span className="place">{i + 1}.</span>
                      <div className="meta">
                        <div className="title">{label(id).title}</div>
                      </div>
                      <PlayButton song={list.find((x) => x.id === id)!} compact label={label(id).title} />
                      <button className="btn icon small ghost" onClick={() => moveInTie(id, -1, cluster)} disabled={i === 0} aria-label="nach oben">
                        ↑
                      </button>
                      <button className="btn icon small ghost" onClick={() => moveInTie(id, 1, cluster)} disabled={i === inOrder.length - 1} aria-label="nach unten">
                        ↓
                      </button>
                    </li>
                  ))}
                </ol>
                <div className="row" style={{ marginTop: 8 }}>
                  {done ? (
                    <span>✓ Reihenfolge festgelegt</span>
                  ) : (
                    <button className="btn small primary" onClick={() => setResolved((r) => [...r, cluster])}>
                      Diese Reihenfolge festlegen
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </section>
      )}

      <DecisionBar
        ready={allScored && open.length === 0}
        confirmLabel={voter ? `Stimme abgeben (${voter})` : 'Bewertung bestätigen'}
        onPostpone={onPostpone}
        onConfirm={() =>
          onCommit({
            targetId: match.id,
            songIds: match.songIds,
            scores,
            order,
            resolvedTies: resolved.filter((r) => ties.some((c) => sameSet(c, r))),
          })
        }
      >
        <span className={`counter ${allScored ? 'ok' : ''}`}>
          {Object.keys(scores).length} von {match.songIds.length} bewertet
          {open.length > 0 && ' · Gleichstand offen'}
        </span>
      </DecisionBar>
    </>
  );
}

function PlayoffBoard(props: BoardProps & { playoff: PlayoffState }) {
  const { playoff, t } = props;
  const players = t.config.partyPlayers ?? [];
  const wrap = (node: ReactNode) => (t.config.blindMode ? <BlindProvider ids={playoff.contested}>{node}</BlindProvider> : node);
  if (players.length < 2) return wrap(<PlayoffVote {...props} />);
  return wrap(
    <PartyFlow
      players={players}
      input={{ songIds: playoff.contested, advanceCount: playoff.contestedSpots, evaluation: 'select', candidateRequired: false }}
      targetId={playoff.id}
      renderBoard={(voter, onVote, first) => (
        <PlayoffVote
          {...props}
          voter={voter}
          onPostpone={first ? props.onPostpone : undefined}
          onCommit={(d) => onVote({ player: voter, selected: d.selected })}
        />
      )}
      toDecision={(final, _agg, votes) => ({
        targetId: playoff.id,
        songIds: playoff.contested,
        selected: final.slice(0, playoff.contestedSpots),
        votes,
      })}
      onCommit={props.onCommit}
    />
  );
}

function PlayoffVote({ round, playoff, songs, onCommit, onPostpone, voter }: BoardProps & { playoff: PlayoffState }) {
  const hidePast = useContext(HidePastCtx);
  const showScores = playoff.scores && !hidePast;
  const [picked, setPicked] = useState<string[]>([]);
  const list = playoff.contested.map((id) => songs.get(id)!);
  useNumberKeys(list);
  const need = playoff.contestedSpots;
  const sources = playoff.sourceMatchIds.map((id) => round.matches.find((m) => m.id === id)!);
  const groupOf = (songId: string) => {
    const m = sources.find((x) => x.songIds.includes(songId));
    return m ? groupName(round, m.id) : '';
  };
  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : need === 1 ? [id] : p.length >= need ? p : [...p, id]));
  return (
    <div className="stack">
      <div className="row">
        <h2 style={{ margin: 0 }}>Zusatzplatz{playoff.scope === 'block' ? '' : 'e dieser Runde'}</h2>
        <span className="chip violet">
          {playoff.spots} {playoff.spots === 1 ? 'Platz' : 'Plätze'} für {playoff.candidates.length} Kandidaten
        </span>
      </div>
      <section className="card soft">
        <h3>Direkt qualifiziert</h3>
        <div className="small">
          {sources.map((m) => (
            <div key={m.id} style={{ marginBottom: 4 }}>
              <span className="muted">{groupName(round, m.id)}:</span>{' '}
              {m.outcome!.qualified.map((id) => songs.get(id)!.title).join(', ')}
            </div>
          ))}
        </div>
        {playoff.sureWinners.length > 0 && (
          <p className="small" style={{ marginTop: 8, marginBottom: 0 }}>
            Sicher über Punkte: <strong>{playoff.sureWinners.map((id) => songs.get(id)!.title).join(', ')}</strong>
          </p>
        )}
      </section>
      <p className="muted small" style={{ margin: 0 }}>
        {playoff.scores
          ? hidePast
            ? 'Gleichstand nach Punkten – du entscheidest im direkten Vergleich.'
            : `Gleichstand mit ${playoff.scores[playoff.contested[0]]} Punkten – du entscheidest im direkten Vergleich.`
          : 'Ohne vergleichbare Punkte entscheidest du selbst.'}{' '}
        Wähle {need === 1 ? 'den Song' : `${need} Songs`}, der den Zusatzplatz bekommt.
      </p>
      <div className={`cards ${list.length === 2 ? 'duel' : ''}`}>
        {list.map((s, i) => {
          const on = picked.includes(s.id);
          return (
            <SongCard
              key={s.id}
              song={s}
              index={i}
              picked={on}
              badge={on ? '✓ Zusatzplatz' : undefined}
              rankBadge={`${groupOf(s.id)}${showScores ? ` · ${playoff.scores![s.id]} P.` : ''}`}
            >
              <button className="btn pick-btn" aria-pressed={on} onClick={() => toggle(s.id)} disabled={!on && need > 1 && picked.length >= need}>
                {on ? '✓ Bekommt den Platz' : 'Diesen wählen'}
              </button>
            </SongCard>
          );
        })}
      </div>
      <DecisionBar
        ready={picked.length === need}
        onPostpone={onPostpone}
        confirmLabel={voter ? `Stimme abgeben (${voter})` : undefined}
        onConfirm={() => onCommit({ targetId: playoff.id, songIds: playoff.contested, selected: picked })}
      >
        <span className={`counter ${picked.length === need ? 'ok' : ''}`}>
          {picked.length} von {need} ausgewählt
        </span>
      </DecisionBar>
    </div>
  );
}

function DecidedPanel({ state, targetId, songs, blind }: { state: TournamentState; targetId: string; songs: SongMap; blind?: boolean }) {
  const m = findMatch(state, targetId);
  const p = findPlayoff(state, targetId);
  const round = state.rounds.find((r) => r.matches.some((x) => x.id === targetId) || r.playoffs.some((x) => x.id === targetId))!;
  const nextRound = state.rounds[round.index + 1];
  const autoPlayoffs = m ? round.playoffs.filter((x) => x.sourceMatchIds.includes(m.id) && x.status === 'auto') : [];
  const pendingPlayoff = m ? round.playoffs.find((x) => x.sourceMatchIds.includes(m.id) && x.status === 'waiting') : undefined;
  const line = (id: string, mark: ReactNode, note?: ReactNode) => {
    const s = songs.get(id)!;
    return (
      <div className="result-line" key={id}>
        {mark}
        <Cover song={s} size={36} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <strong>{s.title}</strong> <span className="muted small">{artistsOf(s)}</span>
        </div>
        {note}
      </div>
    );
  };
  const scores = m?.decision?.scores;
  return (
    <section className="card result-panel" aria-live="polite">
      <h2>
        {blind && m ? '🙉 Aufgelöst! ' : ''}
        {m ? (m.kind === 'final' ? 'Entschieden!' : 'Ergebnis') : 'Zusatzplatz vergeben'}
      </h2>
      {m?.decision?.votes && (
        <p className="small muted" style={{ marginTop: 0 }}>
          Gruppenentscheid aus {m.decision.votes.length} Stimmen ({m.decision.votes.map((v) => v.player).join(', ')}).
        </p>
      )}
      {m && m.outcome && (
        <>
          {m.outcome.qualified.map((id) =>
            line(id, <span className="mark q">✓</span>, <span className="chip accent">{m.kind === 'final' ? 'Gewinner' : 'weiter'}{scores ? ` · ${scores[id]} P.` : ''}</span>),
          )}
          {m.outcome.eliminated.map((id) => {
            const extra = round.playoffs.find((x) => x.winners.includes(id));
            const isCand = m.outcome!.candidate === id;
            return line(
              id,
              <span className={`mark ${extra ? 'e' : isCand ? 'e' : 'x'}`}>{extra ? '◆' : isCand ? '◇' : '✕'}</span>,
              <span className={`chip ${extra ? 'violet' : isCand ? 'violet' : ''}`}>
                {extra ? 'Zusatzplatz' : isCand && pendingPlayoff ? 'wartet auf Vergleich' : 'ausgeschieden'}
                {scores ? ` · ${scores[id]} P.` : ''}
              </span>,
            );
          })}
        </>
      )}
      {autoPlayoffs.map((x) => (
        <div key={x.id} className="notice" style={{ marginTop: 12 }}>
          <strong>Zusatzplatz per Punktevergleich:</strong>{' '}
          {x.candidates
            .slice()
            .sort((a, b) => (x.scores?.[b] ?? 0) - (x.scores?.[a] ?? 0))
            .map((id) => `${songs.get(id)!.title} (${x.scores?.[id]} P.)`)
            .join(' vs. ')}{' '}
          → <strong>{x.winners.map((id) => songs.get(id)!.title).join(', ')}</strong> kommt weiter.
        </div>
      ))}
      {pendingPlayoff && (
        <p className="small muted" style={{ marginTop: 12 }}>
          Der Zusatzplatz wird vergeben, sobald {pendingPlayoff.scope === 'block' ? 'die zweite Cypher dieses Blocks' : 'alle Cyphers der Runde'} entschieden {pendingPlayoff.scope === 'block' ? 'ist' : 'sind'}.
        </p>
      )}
      {p && (
        <>
          {p.winners.map((id) => line(id, <span className="mark e">◆</span>, <span className="chip violet">Zusatzplatz</span>))}
          {p.candidates.filter((c) => !p.winners.includes(c)).map((id) => line(id, <span className="mark x">✕</span>, <span className="chip">ausgeschieden</span>))}
        </>
      )}
      {nextRound && (
        <div className="notice ok" style={{ marginTop: 14 }}>
          <strong>{round.label} abgeschlossen.</strong> Weiter geht’s: {nextRound.label} – {nextRound.sublabel}.
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Party mode: everyone votes in turn on the same device, then the group result is confirmed.

function PartyFlow({
  players,
  input,
  targetId,
  renderBoard,
  toDecision,
  onCommit,
}: {
  players: string[];
  input: AggregateInput;
  targetId: string;
  renderBoard: (voter: string, onVote: (v: PartyVote) => void, first: boolean) => ReactNode;
  toDecision: (finalOrder: string[], agg: ReturnType<typeof aggregateVotes>, votes: PartyVote[]) => Omit<Decision, 'id' | 'at'>;
  onCommit: (d: Omit<Decision, 'id' | 'at'>) => void;
}) {
  const [votes, setVotes] = useState<PartyVote[]>([]);
  const [handover, setHandover] = useState(false);
  const [resolved, setResolved] = useState<string[][]>([]);
  const [tieOrder, setTieOrder] = useState<Record<string, string[]>>({});
  const label = useLabel();
  const idx = votes.length;
  const done = idx >= players.length;

  useEffect(() => {
    player.stop();
  }, [idx, handover]);

  if (!done && handover) {
    return (
      <section className="card party-handover">
        <div className="party-avatar" aria-hidden="true">
          {players[idx].slice(0, 1).toUpperCase()}
        </div>
        <h2>Stimme von {players[idx - 1]} gespeichert ✓</h2>
        <p className="muted">Gib das Gerät an <strong>{players[idx]}</strong> weiter. Die bisherigen Stimmen bleiben verdeckt.</p>
        <button className="btn primary big" onClick={() => setHandover(false)} autoFocus>
          Ich bin {players[idx]} – los geht’s
        </button>
      </section>
    );
  }

  if (!done) {
    return (
      <div className="stack">
        <div className="party-turn">
          <span className="party-avatar small" aria-hidden="true">
            {players[idx].slice(0, 1).toUpperCase()}
          </span>
          <div>
            <strong>{players[idx]} ist dran</strong>
            <div className="tiny muted">
              Stimme {idx + 1} von {players.length}
            </div>
          </div>
          <span className="spacer" />
          <div className="party-dots" aria-hidden="true">
            {players.map((p, i) => (
              <span key={p} className={i < idx ? 'done' : i === idx ? 'now' : ''} title={p} />
            ))}
          </div>
        </div>
        <div key={`${targetId}-${idx}`}>
          {renderBoard(
            players[idx],
            (v) => {
              setVotes((vs) => [...vs, v]);
              if (idx + 1 < players.length) setHandover(true);
            },
            idx === 0,
          )}
        </div>
      </div>
    );
  }

  const agg = aggregateVotes(input, votes);
  // host's ordering of tied clusters (defaults to slot order)
  const clusters = agg.ties.map((c) => tieOrder[c.slice().sort().join('|')] ?? c);
  const finalOrder = applyTieOrder(agg.order, clusters);
  const open = agg.ties.filter((c) => !resolved.some((r) => r.length === c.length && r.every((x) => c.includes(x))));
  const max = Math.max(...Object.values(agg.value), 1);
  const move = (cluster: string[], id: string, dir: -1 | 1) => {
    const key = cluster.slice().sort().join('|');
    const cur = (tieOrder[key] ?? cluster).slice();
    const i = cur.indexOf(id);
    const j = i + dir;
    if (j < 0 || j >= cur.length) return;
    [cur[i], cur[j]] = [cur[j], cur[i]];
    setTieOrder((o) => ({ ...o, [key]: cur }));
    setResolved((r) => r.filter((x) => !(x.length === cluster.length && x.every((y) => cluster.includes(y)))));
  };

  return (
    <section className="card result-panel">
      <h2>Gruppenergebnis</h2>
      <p className="small muted" style={{ marginTop: 0 }}>
        {input.evaluation === 'select' ? 'Stimmen pro Song' : input.evaluation === 'rank' ? 'Platzpunkte (Platz 1 bringt am meisten)' : 'Durchschnitt der Punkte'} ·{' '}
        {input.advanceCount} {input.advanceCount === 1 ? 'kommt' : 'kommen'} weiter
      </p>
      <ol className="barlist">
        {finalOrder.map((id, i) => (
          <li key={id}>
            <div className="bl-text">
              <span className="bl-label">
                {i < input.advanceCount ? '✓ ' : input.candidateRequired && i === input.advanceCount ? '◆ ' : '✕ '}
                {label(id).title}
              </span>
              <span className="bl-sub">{label(id).artists}</span>
            </div>
            <div className="bl-track" aria-hidden="true">
              <div className="bl-bar" style={{ width: `${Math.max(2, (agg.value[id] / max) * 100)}%`, opacity: i < input.advanceCount ? 1 : 0.45 }} />
            </div>
            <span className="bl-val">
              {agg.value[id].toLocaleString('de-DE')} {agg.unit === 'Stimmen' && agg.value[id] === 1 ? 'Stimme' : agg.unit}
            </span>
          </li>
        ))}
      </ol>
      {clusters.map((cluster) => {
        const isDone = !open.some((c) => c.length === cluster.length && c.every((x) => cluster.includes(x)));
        return (
          <div key={cluster.slice().sort().join('|')} className={`notice ${isDone ? 'ok' : 'warn'}`} style={{ marginTop: 12 }}>
            <strong>Gleichstand ({agg.value[cluster[0]].toLocaleString('de-DE')} {agg.unit})</strong> an der Grenze – einigt euch auf
            eine Reihenfolge:
            <ol className="ranklist" style={{ marginTop: 8 }}>
              {cluster.map((id, i) => (
                <li key={id} className="rankitem" style={{ cursor: 'default' }}>
                  <span className="place">{i + 1}.</span>
                  <div className="meta">
                    <div className="title">{label(id).title}</div>
                  </div>
                  <button className="btn icon small ghost" onClick={() => move(cluster, id, -1)} disabled={i === 0} aria-label="nach oben">
                    ↑
                  </button>
                  <button className="btn icon small ghost" onClick={() => move(cluster, id, 1)} disabled={i === cluster.length - 1} aria-label="nach unten">
                    ↓
                  </button>
                </li>
              ))}
            </ol>
            {isDone ? (
              <span>✓ Festgelegt</span>
            ) : (
              <button className="btn small primary" style={{ marginTop: 8 }} onClick={() => setResolved((r) => [...r, cluster])}>
                So festlegen
              </button>
            )}
          </div>
        );
      })}
      <details style={{ marginTop: 12 }}>
        <summary className="small">Einzelne Stimmen ansehen</summary>
        <ul className="small plain" style={{ marginTop: 8 }}>
          {votes.map((v) => (
            <li key={v.player}>
              <strong>{v.player}:</strong>{' '}
              {v.selected
                ? v.selected.map((id) => label(id).title).join(', ')
                : v.order
                  ? v.order.map((id, i) => `${i + 1}. ${label(id).title}`).join(' · ')
                  : Object.entries(v.scores ?? {})
                      .sort((a, b) => b[1] - a[1])
                      .map(([id, x]) => `${label(id).title} ${x}`)
                      .join(' · ')}
            </li>
          ))}
        </ul>
      </details>
      <DecisionBar ready={open.length === 0} confirmLabel="Gruppenergebnis bestätigen" onConfirm={() => onCommit(toDecision(finalOrder, agg, votes))}>
        <button
          className="btn small ghost"
          onClick={() => {
            setVotes([]);
            setResolved([]);
            setTieOrder({});
            setHandover(false);
          }}
        >
          Neu abstimmen
        </button>
      </DecisionBar>
    </section>
  );
}
