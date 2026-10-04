// Season: several tournaments over weeks with one running table.
// Points per tournament: 1 for taking part, 2 per round survived, +3 for the final, +5 for the win.
// Bigger tournaments have more rounds and therefore give more points – a win there is worth more.

import { computeState } from './engine';
import { participantMap } from './participants';
import { songRuns, type SongRun } from './stats';
import type { Song, Tournament } from './types';

export interface Season {
  id: string;
  name: string;
  createdAt: string;
  closed?: boolean;
}

export const SEASON_RULES = 'Teilnahme 1 Punkt · je überstandene Runde 2 Punkte · Finale +3 · Sieg +5';

export function seasonPoints(r: SongRun, roundsTotal: number): number {
  const survived = r.champion ? roundsTotal : r.lastRound;
  return 1 + 2 * survived + (r.finalist ? 3 : 0) + (r.champion ? 5 : 0);
}

export interface SeasonLine {
  entry: Song;
  points: number;
  tournaments: number;
  titles: number;
  finals: number;
  /** Points per finished tournament of the season, oldest first (– = not part of it). */
  form: Array<number | null>;
}

export interface SeasonTable {
  songs: SeasonLine[];
  artists: Array<{ name: string; points: number; songs: number; titles: number }>;
  finished: Tournament[];
  running: Tournament[];
}

export function seasonTable(seasonId: string, tournaments: Tournament[]): SeasonTable {
  const inSeason = tournaments.filter((t) => t.seasonId === seasonId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const finished: Tournament[] = [];
  const running: Tournament[] = [];
  const lines = new Map<string, SeasonLine>();
  const artists = new Map<string, { name: string; points: number; songs: Set<string>; titles: number }>();
  const done = inSeason.filter((t) => {
    const fin = computeState(t).finished;
    (fin ? finished : running).push(t);
    return fin;
  });
  done.forEach((t, ti) => {
    const state = computeState(t);
    const byId = participantMap(t);
    for (const r of songRuns(t, state)) {
      const entry = byId.get(r.songId);
      if (!entry) continue;
      const pts = seasonPoints(r, state.rounds.length);
      let l = lines.get(r.songId);
      if (!l) {
        l = { entry, points: 0, tournaments: 0, titles: 0, finals: 0, form: done.map(() => null) };
        lines.set(r.songId, l);
      }
      l.points += pts;
      l.tournaments++;
      if (r.champion) l.titles++;
      if (r.finalist) l.finals++;
      l.form[ti] = pts;
      for (const name of entry.artists.length ? entry.artists.slice(0, 1) : ['Unbekannter Interpret']) {
        const key = name.toLowerCase();
        const a = artists.get(key) ?? { name, points: 0, songs: new Set<string>(), titles: 0 };
        a.points += pts;
        a.songs.add(r.songId);
        if (r.champion) a.titles++;
        artists.set(key, a);
      }
    }
  });
  return {
    songs: [...lines.values()].sort((a, b) => b.points - a.points || b.titles - a.titles || b.finals - a.finals),
    artists: [...artists.values()]
      .map((a) => ({ name: a.name, points: a.points, songs: a.songs.size, titles: a.titles }))
      .sort((a, b) => b.points - a.points),
    finished,
    running,
  };
}
