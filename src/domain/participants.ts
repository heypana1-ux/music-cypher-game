// Participants: normally a participant is a song. In the artist cypher a participant is an artist
// who brings a new song every round. These helpers hide that difference from the rest of the app.

import { mulberry32, shuffle } from './rng';
import { previewRounds } from './engine';
import type { ArtistParticipant, Song, Tournament, TournamentConfig } from './types';

export const isArtistMode = (t: Pick<Tournament, 'artistMode'>) => !!t.artistMode;

/** Display entry for an artist participant (title = artist name, cover = first song's cover). */
function artistEntry(p: ArtistParticipant, byId: Map<string, Song>, index: number): Song {
  const first = byId.get(p.songIds[0]);
  return {
    id: p.id,
    title: p.name,
    artists: [p.name],
    album: `${p.songIds.length} Songs`,
    coverUrl: p.songIds.map((id) => byId.get(id)?.coverUrl).find(Boolean),
    origin: first?.origin ?? 'manual',
    originalIndex: index,
  };
}

/** Everything that can appear in draw/decisions, as Song-shaped entries. */
export function participants(t: Pick<Tournament, 'songs' | 'artistMode'>): Song[] {
  if (!t.artistMode) return t.songs;
  const byId = new Map(t.songs.map((s) => [s.id, s]));
  return t.artistMode.participants.map((p, i) => artistEntry(p, byId, i));
}

export function participantMap(t: Pick<Tournament, 'songs' | 'artistMode'>): Map<string, Song> {
  return new Map(participants(t).map((s) => [s.id, s]));
}

/** The real song a participant plays in a round. */
export function songInRound(t: Pick<Tournament, 'songs' | 'artistMode'>, participantId: string, roundIndex: number): Song | undefined {
  if (!t.artistMode) return t.songs.find((s) => s.id === participantId);
  const p = t.artistMode.participants.find((x) => x.id === participantId);
  if (!p) return undefined;
  const songId = p.songIds[Math.min(roundIndex, p.songIds.length - 1)];
  return t.songs.find((s) => s.id === songId);
}

/**
 * Song-shaped entries for one round, keyed by participant ID. In artist mode each entry carries the
 * round's real song (title, cover, audio) but keeps the participant ID so decisions stay valid.
 * `audioKey` points to the real song for local audio and snippet positions.
 */
export function roundEntries(t: Pick<Tournament, 'songs' | 'artistMode'>, roundIndex: number): Map<string, Song> {
  if (!t.artistMode) return new Map(t.songs.map((s) => [s.id, s]));
  const out = new Map<string, Song>();
  for (const p of t.artistMode.participants) {
    const real = songInRound(t, p.id, roundIndex);
    if (real) out.set(p.id, { ...real, id: p.id, audioKey: real.id });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Planning an artist cypher from the selected songs

export interface ArtistCandidate {
  key: string;
  name: string;
  songs: Song[];
}

/** Group songs by their main (first) artist. */
export function artistCandidates(songs: Song[]): ArtistCandidate[] {
  const map = new Map<string, ArtistCandidate>();
  for (const s of songs) {
    const name = s.artists[0]?.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (!map.has(key)) map.set(key, { key, name, songs: [] });
    map.get(key)!.songs.push(s);
  }
  return [...map.values()].sort((a, b) => b.songs.length - a.songs.length || a.name.localeCompare(b.name, 'de'));
}

export interface ArtistPlan {
  /** Rounds the tournament will have = songs each artist needs. */
  rounds: number;
  eligible: ArtistCandidate[];
  /** Artists with too few songs for this many rounds. */
  tooFew: ArtistCandidate[];
}

/**
 * Which artists can take part: everyone needs one new song per round. The number of rounds depends
 * on the number of artists, so this is solved as a fixpoint (fewer artists → fewer rounds needed).
 * `limit` caps the field (e.g. 16 artists).
 */
export function planArtists(songs: Song[], config: TournamentConfig, limit?: number): ArtistPlan {
  // Sorted by song count (most first). The largest field P whose weakest artist still has a song
  // for every round wins – more artists means more rounds, so this is checked for every P.
  const all = artistCandidates(songs);
  const maxP = Math.min(all.length, limit ?? Infinity);
  for (let p = maxP; p >= 2; p--) {
    const field = all.slice(0, p);
    const rounds = previewRounds(config, p).length;
    if (field[p - 1].songs.length >= rounds) {
      return { rounds, eligible: field, tooFew: all.slice(p) };
    }
  }
  return { rounds: 0, eligible: [], tooFew: all };
}

/** Freeze the participants: each artist's songs in playing order (random, seeded, or import order). */
export function buildArtistParticipants(
  eligible: ArtistCandidate[],
  rounds: number,
  order: 'random' | 'original',
  seed: number,
): ArtistParticipant[] {
  const rand = mulberry32(seed ^ 0x5bd1e995);
  return eligible.map((a) => {
    const songs = order === 'random' ? shuffle(a.songs, rand) : a.songs.slice().sort((x, y) => x.originalIndex - y.originalIndex);
    return { id: `ar:${a.key}`, name: a.name, songIds: songs.slice(0, Math.max(rounds, 1)).map((s) => s.id) };
  });
}

/** Round labels say "Songs"; in an artist cypher the participants are artists. */
export function unitize(text: string, artist: boolean): string {
  return artist ? text.replace(/(\d+) Songs\b/g, '$1 Künstler') : text;
}
