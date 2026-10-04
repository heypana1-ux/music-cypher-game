// Core domain model. Everything here is independent of Spotify, the player and the UI.

export type SongOrigin = 'demo' | 'manual' | 'csv' | 'json' | 'spotify-export' | 'exportify';

/** A song as stored in the collection and frozen into a tournament. */
export interface Song {
  /** Stable ID. Spotify-based songs use `sp:<trackId>`, others a content hash or random ID. */
  id: string;
  title: string;
  artists: string[];
  album?: string;
  coverUrl?: string;
  durationMs?: number;
  origin: SongOrigin;
  /** Spotify track ID (22 chars) if known – used for the official Spotify embed / link. */
  spotifyTrackId?: string;
  /** A directly playable audio URL the user is allowed to use (e.g. own server). */
  audioUrl?: string;
  /** Demo songs carry a synth recipe instead of real audio. */
  demoTone?: number;
  /** Position in the original import (for "ursprüngliche Reihenfolge"). */
  originalIndex: number;
  /** Artist mode: the real song ID behind a participant proxy (local audio, snippet start). */
  audioKey?: string;
}

/** How the next round's groups are formed. */
export type RegroupMode = 'bracket' | 'mix' | 'random';

export type MatchFormat = 'duel' | 'cypher';
export type Evaluation = 'select' | 'rank' | 'score';
export type ExtraMode = 'none' | 'perBlock' | 'perRound';
export type DrawMode = 'random' | 'original';

export interface TournamentConfig {
  format: MatchFormat;
  /** Duels always use 'select'. */
  evaluation: Evaluation;
  /** Cypher only: songs advancing per full group of four. */
  advancePerGroup: 1 | 2 | 3;
  extraMode: ExtraMode;
  /** For extraMode 'perRound': number of extra spots per round. */
  extraPerRound: number;
  drawMode: DrawMode;
  /** Cypher only: draw new groups every round (seeded and stored). Legacy – see `regroup`. */
  reshufflePerRound: boolean;
  /**
   * Cypher only: how qualifiers are grouped for the next round.
   * bracket = stable tree, mix = songs from the same group are split up, random = new draw.
   * Undefined → derived from reshufflePerRound (older saves).
   */
  regroup?: RegroupMode;
  avoidSameArtist: boolean;
  /** Duel only: 'auto' or a power of two naming the main round (e.g. 128 = 64stel-Finale). */
  duelMainRound: 'auto' | number;
  /** Duel only: play a match for third place. */
  thirdPlaceMatch: boolean;
  /** Rank mode: show 4/3/2/1 rank points (display only). */
  showRankPoints: boolean;
  /** Hide title, artist and cover until a match is decided. */
  blindMode?: boolean;
  /** Don't show earlier scores/places on the cards (always on in blind mode). */
  hidePastScores?: boolean;
  /** Party mode: names of everyone voting on this device (2–8). Empty/undefined = solo. */
  partyPlayers?: string[];
  presetId?: string;
}

/** One person's vote in party mode. Stored with the decision for statistics. */
export interface PartyVote {
  player: string;
  selected?: string[];
  order?: string[];
  scores?: Record<string, number>;
}

/** A confirmed decision. The tournament state is fully derived by replaying these. */
export interface Decision {
  id: string;
  /** Match ID or playoff ID. */
  targetId: string;
  /** Participants at decision time – guards against applying to a changed match. */
  songIds: string[];
  at: string;
  /** Select mode / playoffs: chosen songs (order irrelevant). */
  selected?: string[];
  /** Rank and score mode: full order, best first. */
  order?: string[];
  /** Score mode: 1–10 per song. */
  scores?: Record<string, number>;
  /** Score mode: tie clusters the user explicitly ordered (each as a set of song IDs). */
  resolvedTies?: string[][];
  /** Party mode: the individual votes the result was aggregated from. */
  votes?: PartyVote[];
}

export interface Tournament {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  config: TournamentConfig;
  /** Frozen participants. */
  songs: Song[];
  /** Seed for every random step; stored so reloading never changes pairings. */
  seed: number;
  /** The concrete draw for round 1 (song IDs). Stored explicitly, not only the seed. */
  draw: string[];
  /** Note produced by the draw (e.g. artist separation not fully possible). */
  drawNotes: string[];
  decisions: Decision[];
  /** Match/playoff IDs the user put aside for later. */
  postponed: string[];
  /** Import summary at freeze time (informational). */
  sourceInfo?: string;
  /**
   * Artist cypher: participants are artists, each brings a new song every round.
   * Then `draw` and all decisions use participant IDs ("ar:…"), `songs` holds the real songs.
   */
  artistMode?: { participants: ArtistParticipant[] };
  /** Season this tournament counts for. */
  seasonId?: string;
}

export interface ArtistParticipant {
  id: string;
  name: string;
  /** Real song IDs in playing order: round 1 plays songIds[0], round 2 songIds[1], … */
  songIds: string[];
}

export type MatchKind = 'duel' | 'cypher' | 'special' | 'bye' | 'final' | 'thirdPlace';

export interface MatchOutcome {
  /** Full order (best first) if the evaluation produced one. */
  order: string[] | null;
  /** Ties that remain unresolved because they did not affect qualification. */
  sharedTies: string[][];
  qualified: string[];
  eliminated: string[];
  /** The best non-qualified song – candidate for an extra spot. */
  candidate: string | null;
}

export interface MatchState {
  id: string;
  roundIndex: number;
  index: number;
  kind: MatchKind;
  songIds: string[];
  advanceCount: number;
  evaluation: Evaluation;
  /** For per-block extras: index of the 8-song block; null if not part of a full block. */
  blockIndex: number | null;
  /** True if this group must also determine an extra-spot candidate. */
  candidateRequired: boolean;
  status: 'open' | 'done' | 'auto';
  decision?: Decision;
  outcome?: MatchOutcome;
}

export interface PlayoffState {
  id: string;
  roundIndex: number;
  scope: 'block' | 'round';
  blockIndex: number | null;
  /** Matches whose candidates compete. */
  sourceMatchIds: string[];
  candidates: string[];
  spots: number;
  status: 'waiting' | 'open' | 'done' | 'auto';
  /** Score mode: the candidates' scores from their group. */
  scores?: Record<string, number>;
  /** Winners that are certain without a decision (score mode). */
  sureWinners: string[];
  /** Candidates the user must choose between. */
  contested: string[];
  /** How many of the contested the user must pick. */
  contestedSpots: number;
  decision?: Decision;
  winners: string[];
}

export interface RoundState {
  index: number;
  label: string;
  sublabel: string;
  entrants: string[];
  matches: MatchState[];
  playoffs: PlayoffState[];
  isFinal: boolean;
  isPrelim: boolean;
  complete: boolean;
  byes: number;
  notes: string[];
}

export type OpenItem = { type: 'match'; id: string } | { type: 'playoff'; id: string };

export interface TournamentState {
  rounds: RoundState[];
  champion: string | null;
  runnerUp: string | null;
  thirdPlace: string | null;
  /** Decisions that were applied (others were invalid/orphaned). */
  validDecisions: Decision[];
  droppedDecisions: Decision[];
  /** Items needing a user decision right now (current round). */
  openItems: OpenItem[];
  finished: boolean;
}
