// Local persistence. Collection and tournaments in localStorage, audio files in IndexedDB.
// Nothing here contains credentials – there are none in this app.

import { computeState } from '../domain/engine';
import type { Song, Tournament } from '../domain/types';

const LIB_KEY = 'mc.library.v1';
const TOURN_KEY = 'mc.tournaments.v1';
const PREF_KEY = 'mc.prefs.v1';

export interface ImportSummary {
  entries: number;
  duplicates: number;
  unsupported: Array<{ label: string; reason: string }>;
  sources: string[];
}

export interface LibraryState {
  songs: Song[];
  selected: string[];
  summary: ImportSummary;
  allowNoAudio: boolean;
}

export const emptySummary = (): ImportSummary => ({ entries: 0, duplicates: 0, unsupported: [], sources: [] });

export function emptyLibrary(): LibraryState {
  return { songs: [], selected: [], summary: emptySummary(), allowNoAudio: true };
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): string | null {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : 'Speichern fehlgeschlagen';
  }
}

export function loadLibrary(): LibraryState {
  const lib = read<LibraryState>(LIB_KEY, emptyLibrary());
  return { ...emptyLibrary(), ...lib, summary: { ...emptySummary(), ...lib.summary } };
}

export function saveLibrary(lib: LibraryState): string | null {
  return write(LIB_KEY, lib);
}

export function loadTournaments(): Tournament[] {
  const list = read<Tournament[]>(TOURN_KEY, []);
  return Array.isArray(list) ? list.filter(isTournament) : [];
}

export function saveTournaments(list: Tournament[]): string | null {
  return write(TOURN_KEY, list);
}

export interface Prefs {
  volume: number;
  playMode: 'snippet' | 'full';
  snippetStart: Record<string, number>;
}

export function loadPrefs(): Prefs {
  return { volume: 0.8, playMode: 'snippet', snippetStart: {}, ...read<Partial<Prefs>>(PREF_KEY, {}) };
}

export function savePrefs(p: Prefs): void {
  write(PREF_KEY, p);
}

// ---------------------------------------------------------------------------
// Backup export / import

export function isTournament(v: unknown): v is Tournament {
  if (typeof v !== 'object' || v === null) return false;
  const t = v as Record<string, unknown>;
  return (
    typeof t.id === 'string' &&
    typeof t.name === 'string' &&
    typeof t.seed === 'number' &&
    Array.isArray(t.songs) &&
    Array.isArray(t.draw) &&
    Array.isArray(t.decisions) &&
    typeof t.config === 'object' &&
    t.config !== null
  );
}

export function backupFile(t: Tournament): string {
  return JSON.stringify({ app: 'Music Cypher', kind: 'tournament-backup', version: 1, tournament: t }, null, 2);
}

export function parseBackup(text: string): Tournament {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Die Sicherungsdatei ist kein gültiges JSON.');
  }
  const t = (data as { tournament?: unknown })?.tournament ?? data;
  if (!isTournament(t)) throw new Error('Diese Datei ist keine Music-Cypher-Turniersicherung.');
  const songIds = new Set(t.songs.map((s) => s.id));
  if (!t.draw.every((id) => songIds.has(id))) throw new Error('Die Sicherung ist unvollständig: Auslosung und Songs passen nicht zusammen.');
  const tournament: Tournament = { ...t, postponed: t.postponed ?? [], drawNotes: t.drawNotes ?? [] };
  // replay once – drops anything inconsistent instead of crashing later
  const state = computeState(tournament);
  return { ...tournament, decisions: state.validDecisions };
}

export function download(fileName: string, content: string, type = 'application/json'): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function safeFileName(s: string): string {
  return s.replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'music-cypher';
}
