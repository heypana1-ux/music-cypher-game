// Statistics derived from tournaments. Pure functions – everything comes from the replayed state,
// so the numbers always match what the tournament actually decided.

import { computeState } from './engine';
import type { Song, Tournament, TournamentState } from './types';

export interface SongRun {
  songId: string;
  tournamentId: string;
  /** Index of the last round the song took part in. */
  lastRound: number;
  /** Rounds the tournament has (finished) or has so far (running). */
  roundsTotal: number;
  encounters: number;
  advances: number;
  byes: number;
  extraSpots: number;
  scores: number[];
  champion: boolean;
  finalist: boolean;
  alive: boolean;
  /** Short human label: "Sieger", "Finale", "Ausgeschieden: Halbfinale", "noch dabei". */
  stage: string;
  /** 0..1 – share of rounds survived. Only meaningful in finished tournaments. */
  progress: number;
}

export function artistKey(name: string): string {
  return name.trim().toLowerCase();
}

/** One SongRun per participant of a tournament. */
export function songRuns(t: Tournament, state: TournamentState = computeState(t)): SongRun[] {
  const runs = new Map<string, SongRun>();
  for (const s of t.songs) {
    runs.set(s.id, {
      songId: s.id,
      tournamentId: t.id,
      lastRound: 0,
      roundsTotal: Math.max(1, state.rounds.length),
      encounters: 0,
      advances: 0,
      byes: 0,
      extraSpots: 0,
      scores: [],
      champion: state.champion === s.id,
      finalist: false,
      alive: true,
      stage: state.finished ? '' : 'noch dabei',
      progress: 0,
    });
  }
  for (const round of state.rounds) {
    const extraWinners = new Set(round.playoffs.flatMap((p) => p.winners));
    for (const m of round.matches) {
      for (const id of m.songIds) {
        const r = runs.get(id);
        if (!r) continue;
        if (m.kind !== 'thirdPlace') r.lastRound = Math.max(r.lastRound, round.index);
        if (m.kind === 'final') r.finalist = true;
        if (m.kind === 'bye') {
          r.byes++;
          continue;
        }
        if (!m.outcome) continue;
        r.encounters++;
        const score = m.decision?.scores?.[id];
        if (typeof score === 'number') r.scores.push(score);
        if (m.outcome.qualified.includes(id)) r.advances++;
        else if (extraWinners.has(id)) {
          r.advances++;
          r.extraSpots++;
        } else if (m.kind !== 'thirdPlace') {
          r.alive = false;
          r.stage = m.kind === 'final' ? 'Finale' : `Aus: ${round.label}`;
        }
      }
    }
  }
  for (const r of runs.values()) {
    if (r.champion) {
      r.stage = 'Sieger';
      r.alive = false;
    } else if (state.thirdPlace === r.songId) {
      r.stage = 'Platz 3';
    } else if (state.finished && r.alive) {
      r.alive = false;
      r.stage = r.finalist ? 'Finale' : 'Ausgeschieden';
    } else if (r.alive) {
      r.stage = `noch dabei · ${state.rounds[r.lastRound]?.label ?? ''}`.trim();
    }
    // Champion survived every round; someone out in round 1 survived none.
    r.progress = r.champion ? 1 : r.roundsTotal > 0 ? r.lastRound / r.roundsTotal : 0;
  }
  return [...runs.values()];
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export interface ArtistLine {
  key: string;
  name: string;
  songs: number;
  tournaments: number;
  encounters: number;
  advances: number;
  winRate: number | null;
  titles: number;
  finals: number;
  avgProgress: number | null;
  avgScore: number | null;
  alive: number;
  bestStage: string;
}

export interface SongLine {
  song: Song;
  appearances: number;
  encounters: number;
  advances: number;
  winRate: number | null;
  titles: number;
  finals: number;
  avgProgress: number | null;
  avgScore: number | null;
  bestScore: number | null;
  stage: string;
}

function stageRank(stage: string): number {
  if (stage === 'Sieger') return 3;
  if (stage === 'Finale') return 2;
  if (stage === 'Platz 3') return 1.5;
  if (stage.startsWith('noch dabei')) return 1;
  return 0;
}

function aggregateArtists(entries: Array<{ t: Tournament; runs: SongRun[]; finished: boolean }>): ArtistLine[] {
  const map = new Map<string, ArtistLine & { _progress: number[]; _scores: number[]; _t: Set<string>; _bestLast: number }>();
  for (const { t, runs, finished } of entries) {
    const byId = new Map(t.songs.map((s) => [s.id, s]));
    for (const r of runs) {
      const song = byId.get(r.songId);
      const names = song && song.artists.length ? song.artists : ['Unbekannter Interpret'];
      for (const name of names) {
        const key = artistKey(name);
        let a = map.get(key);
        if (!a) {
          a = {
            key,
            name,
            songs: 0,
            tournaments: 0,
            encounters: 0,
            advances: 0,
            winRate: null,
            titles: 0,
            finals: 0,
            avgProgress: null,
            avgScore: null,
            alive: 0,
            bestStage: '',
            _progress: [],
            _scores: [],
            _t: new Set(),
            _bestLast: -1,
          };
          map.set(key, a);
        }
        a.songs++;
        a._t.add(t.id);
        a.encounters += r.encounters;
        a.advances += r.advances;
        if (r.champion) a.titles++;
        if (r.finalist) a.finals++;
        if (r.alive) a.alive++;
        if (finished) a._progress.push(r.progress);
        a._scores.push(...r.scores);
        const rank = stageRank(r.stage) * 100 + r.lastRound;
        if (rank > a._bestLast) {
          a._bestLast = rank;
          a.bestStage = r.stage;
        }
      }
    }
  }
  return [...map.values()].map(({ _progress, _scores, _t, _bestLast: _unused, ...a }) => ({
    ...a,
    tournaments: _t.size,
    winRate: a.encounters ? a.advances / a.encounters : null,
    avgProgress: avg(_progress),
    avgScore: avg(_scores),
  }));
}

export interface ScoreHighlight {
  songId: string;
  value: number;
  round: string;
}

export interface CloseCall {
  label: string;
  winner: string;
  loser: string;
  gap: number;
  tie: boolean;
}

export interface TournamentStats {
  songs: number;
  rounds: number;
  decisions: number;
  encountersDone: number;
  byes: number;
  extraSpots: number;
  alive: number;
  /** 0..1, based on eliminated songs: (N − alive) / (N − 1). */
  progress: number;
  minutes: number | null;
  secondsPerDecision: number | null;
  scoreHistogram: number[] | null;
  avgScore: number | null;
  topScores: ScoreHighlight[];
  closeCalls: CloseCall[];
  tiesDecided: number;
  artists: ArtistLine[];
  songsTable: SongLine[];
  runs: SongRun[];
}

export function tournamentStats(t: Tournament, state: TournamentState = computeState(t)): TournamentStats {
  const runs = songRuns(t, state);
  const byId = new Map(t.songs.map((s) => [s.id, s]));
  const alive = state.finished ? 0 : runs.filter((r) => r.alive).length;
  const n = t.songs.length;
  const progress = state.finished ? 1 : n > 1 ? (n - Math.max(alive, 1)) / (n - 1) : 0;

  // time
  const times = state.validDecisions.map((d) => Date.parse(d.at)).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  let active = 0;
  for (let i = 1; i < times.length; i++) {
    const gap = times[i] - times[i - 1];
    if (gap < 20 * 60_000) active += gap; // longer pauses don't count as listening time
  }
  const minutes = times.length > 1 ? active / 60_000 : null;

  // scores
  const all: Array<{ id: string; v: number; round: string }> = [];
  const closeCalls: CloseCall[] = [];
  let tiesDecided = 0;
  for (const round of state.rounds) {
    for (const m of round.matches) {
      const sc = m.decision?.scores;
      if (sc) {
        for (const id of m.songIds) all.push({ id, v: sc[id], round: round.label });
        const o = m.outcome?.order;
        if (o && o.length > m.advanceCount) {
          const w = o[m.advanceCount - 1];
          const l = o[m.advanceCount];
          closeCalls.push({ label: round.label, winner: w, loser: l, gap: sc[w] - sc[l], tie: sc[w] === sc[l] });
        }
      }
      tiesDecided += m.decision?.resolvedTies?.length ?? 0;
    }
    for (const p of round.playoffs) if (p.decision && p.scores) tiesDecided++;
  }
  const hist = all.length ? Array.from({ length: 10 }, (_, i) => all.filter((x) => x.v === i + 1).length) : null;

  const songsTable: SongLine[] = runs.map((r) => ({
    song: byId.get(r.songId)!,
    appearances: 1,
    encounters: r.encounters,
    advances: r.advances,
    winRate: r.encounters ? r.advances / r.encounters : null,
    titles: r.champion ? 1 : 0,
    finals: r.finalist ? 1 : 0,
    avgProgress: state.finished ? r.progress : null,
    avgScore: avg(r.scores),
    bestScore: r.scores.length ? Math.max(...r.scores) : null,
    stage: r.stage,
  }));

  return {
    songs: n,
    rounds: state.rounds.length,
    decisions: state.validDecisions.length,
    encountersDone: state.rounds.reduce((k, r) => k + r.matches.filter((m) => m.status === 'done').length, 0),
    byes: state.rounds.reduce((k, r) => k + r.byes, 0),
    extraSpots: state.rounds.reduce((k, r) => k + r.playoffs.reduce((j, p) => j + p.winners.length, 0), 0),
    alive,
    progress,
    minutes,
    secondsPerDecision: minutes !== null && state.validDecisions.length > 1 ? (minutes * 60) / (state.validDecisions.length - 1) : null,
    scoreHistogram: hist,
    avgScore: avg(all.map((x) => x.v)),
    topScores: all
      .filter((x) => x.v === Math.max(...all.map((y) => y.v)))
      .slice(0, 5)
      .map((x) => ({ songId: x.id, value: x.v, round: x.round })),
    closeCalls: closeCalls.sort((a, b) => a.gap - b.gap).slice(0, 5),
    tiesDecided,
    artists: aggregateArtists([{ t, runs, finished: state.finished }]),
    songsTable,
    runs,
  };
}

export interface Champion {
  tournament: Tournament;
  song: Song;
  date: string;
}

export interface OverallStats {
  tournaments: number;
  finished: number;
  running: number;
  decisions: number;
  encounters: number;
  uniqueSongs: number;
  uniqueArtists: number;
  formats: { duel: number; cypher: number };
  champions: Champion[];
  artists: ArtistLine[];
  songs: SongLine[];
}

export function overallStats(tournaments: Tournament[]): OverallStats {
  const entries = tournaments.map((t) => {
    const state = computeState(t);
    return { t, state, runs: songRuns(t, state), finished: state.finished };
  });
  const songAgg = new Map<string, SongLine & { _progress: number[]; _scores: number[]; _best: number }>();
  for (const { t, runs, finished } of entries) {
    const byId = new Map(t.songs.map((s) => [s.id, s]));
    for (const r of runs) {
      let s = songAgg.get(r.songId);
      if (!s) {
        s = {
          song: byId.get(r.songId)!,
          appearances: 0,
          encounters: 0,
          advances: 0,
          winRate: null,
          titles: 0,
          finals: 0,
          avgProgress: null,
          avgScore: null,
          bestScore: null,
          stage: '',
          _progress: [],
          _scores: [],
          _best: -1,
        };
        songAgg.set(r.songId, s);
      }
      s.appearances++;
      s.encounters += r.encounters;
      s.advances += r.advances;
      if (r.champion) s.titles++;
      if (r.finalist) s.finals++;
      if (finished) s._progress.push(r.progress);
      s._scores.push(...r.scores);
      const rank = stageRank(r.stage) * 100 + r.lastRound;
      if (rank > s._best) {
        s._best = rank;
        s.stage = r.stage;
      }
    }
  }
  const songs: SongLine[] = [...songAgg.values()].map(({ _progress, _scores, _best: _unused, ...s }) => ({
    ...s,
    winRate: s.encounters ? s.advances / s.encounters : null,
    avgProgress: avg(_progress),
    avgScore: avg(_scores),
    bestScore: _scores.length ? Math.max(..._scores) : null,
  }));
  const champions: Champion[] = entries
    .filter((e) => e.state.champion)
    .map((e) => ({
      tournament: e.t,
      song: e.t.songs.find((s) => s.id === e.state.champion)!,
      date: e.t.updatedAt,
    }))
    .sort((a, b) => b.date.localeCompare(a.date));
  const artists = aggregateArtists(entries);
  return {
    tournaments: tournaments.length,
    finished: entries.filter((e) => e.finished).length,
    running: entries.filter((e) => !e.finished).length,
    decisions: entries.reduce((k, e) => k + e.state.validDecisions.length, 0),
    encounters: entries.reduce((k, e) => k + e.runs.reduce((j, r) => j + r.encounters, 0), 0),
    uniqueSongs: songAgg.size,
    uniqueArtists: artists.length,
    formats: {
      duel: tournaments.filter((t) => t.config.format === 'duel').length,
      cypher: tournaments.filter((t) => t.config.format === 'cypher').length,
    },
    champions,
    artists,
    songs,
  };
}

/** Compact history of one song across other tournaments – shown on song cards. */
export interface SongHistory {
  appearances: number;
  titles: number;
  finals: number;
  winRate: number | null;
}

export function songHistoryIndex(tournaments: Tournament[], excludeId?: string): Map<string, SongHistory> {
  const map = new Map<string, SongHistory>();
  for (const s of overallStats(tournaments.filter((t) => t.id !== excludeId)).songs) {
    map.set(s.song.id, { appearances: s.appearances, titles: s.titles, finals: s.finals, winRate: s.winRate });
  }
  return map;
}

export function pct(x: number | null | undefined, digits = 0): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return '–';
  return `${(x * 100).toFixed(digits)} %`;
}
