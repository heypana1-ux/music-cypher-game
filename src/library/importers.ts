// Song import. Turns files (CSV / JSON) into Songs – no network access, no Spotify API.
//
// Supported:
//  - Exportify CSV (exportify.net) and similar playlist exports (TuneMyMusic, Soundiiz, own Excel files)
//  - Spotify account data export ("Playlist1.json", "YourLibrary.json" from spotify.com → Privacy → Download your data)
//  - Generic JSON: [{ title, artists | artist, album, cover, durationMs, spotifyId | spotifyUrl | uri, audioUrl }]

import { hashString } from '../domain/rng';
import type { Song, SongOrigin } from '../domain/types';

export interface ImportIssue {
  row: number;
  label: string;
  reason: string;
}

export interface ImportResult {
  songs: Song[];
  /** Entries merged because they had the same stable ID. */
  duplicates: Array<{ title: string; count: number }>;
  unsupported: ImportIssue[];
  totalEntries: number;
  formatLabel: string;
  /** For Spotify data exports with multiple playlists. */
  playlists?: string[];
}

export class ImportError extends Error {}

// ---------------------------------------------------------------------------
// Spotify IDs

const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;

export interface SpotifyRef {
  type: 'track' | 'episode' | 'local' | 'other';
  id?: string;
}

/** Parse spotify:track:ID, https://open.spotify.com/(intl-de/)track/ID?si=…, or a bare 22-char ID. */
export function parseSpotifyRef(raw: string | undefined | null): SpotifyRef | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  if (s.startsWith('spotify:local:')) return { type: 'local' };
  let m = /^spotify:(track|episode|[a-z]+):([A-Za-z0-9]+)/.exec(s);
  if (m) return { type: m[1] === 'track' ? 'track' : m[1] === 'episode' ? 'episode' : 'other', id: m[2] };
  m = /open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:embed\/)?(track|episode|[a-z]+)\/([A-Za-z0-9]{22})/.exec(s);
  if (m) return { type: m[1] === 'track' ? 'track' : m[1] === 'episode' ? 'episode' : 'other', id: m[2] };
  if (SPOTIFY_ID.test(s)) return { type: 'track', id: s };
  return { type: 'other' };
}

// ---------------------------------------------------------------------------
// CSV

/** RFC-4180-ish CSV parser with quote handling, BOM removal and ; / , / tab detection. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const count = (ch: string) => {
    let n = 0;
    let q = false;
    for (const c of firstLine) {
      if (c === '"') q = !q;
      else if (!q && c === ch) n++;
    }
    return n;
  };
  const delim = [',', ';', '\t'].reduce((best, d) => (count(d) > count(best) ? d : best), ',');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"' && field === '') {
      inQuotes = true;
    } else if (c === delim) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

const HEADER_ALIASES: Record<string, string[]> = {
  title: ['track name', 'title', 'titel', 'name', 'song', 'track', 'song name', 'track title'],
  artists: ['artist name(s)', 'artist names', 'artist', 'artists', 'interpret', 'interpreten', 'artist name', 'künstler'],
  album: ['album name', 'album', 'album title'],
  durationMs: ['duration (ms)', 'track duration (ms)', 'duration_ms', 'durationms', 'dauer (ms)'],
  durationText: ['duration', 'dauer', 'length', 'länge', 'time'],
  uri: ['track uri', 'spotify uri', 'uri', 'spotify - id', 'spotify id', 'spotify_id', 'spotifyid', 'spotify url', 'spotify link', 'url', 'link', 'id'],
  cover: ['album image url', 'cover', 'cover url', 'image', 'image url', 'artwork', 'album art'],
  artistUris: ['artist uri(s)', 'artist uris'],
  audioUrl: ['audio url', 'audiourl', 'audio', 'mp3'],
  type: ['type', 'typ'],
};

function findColumn(header: string[], key: string): number {
  const norm = header.map((h) => h.trim().toLowerCase());
  for (const alias of HEADER_ALIASES[key]) {
    const i = norm.indexOf(alias);
    if (i >= 0) return i;
  }
  return -1;
}

/** "3:45" or "1:02:03" → ms */
function parseDurationText(s: string): number | undefined {
  const t = s.trim();
  if (!t) return undefined;
  if (/^\d+$/.test(t)) {
    const n = Number(t);
    return n > 10000 ? n : n * 1000; // plain seconds unless it is obviously ms
  }
  const parts = t.split(':').map(Number);
  if (parts.some((p) => Number.isNaN(p))) return undefined;
  return parts.reduce((acc, p) => acc * 60 + p, 0) * 1000;
}

export function splitArtists(raw: string, uriCount?: number): string[] {
  const s = raw.trim();
  if (!s) return [];
  if (s.includes(';')) return s.split(';').map((a) => a.trim()).filter(Boolean);
  // Exportify joins names with "," (no space). Names like "Tyler, The Creator" contain ", ".
  const parts = s.split(/,(?!\s)/).map((a) => a.trim()).filter(Boolean);
  if (uriCount && uriCount > 1) {
    const loose = s.split(',').map((a) => a.trim()).filter(Boolean);
    if (loose.length === uriCount) return loose;
  }
  return parts;
}

interface RawEntry {
  row: number;
  title?: string;
  artists: string[];
  album?: string;
  durationMs?: number;
  coverUrl?: string;
  ref: SpotifyRef | null;
  rawRef?: string;
  audioUrl?: string;
  explicitId?: string;
  typeHint?: string;
}

function entriesFromCsv(text: string): { entries: RawEntry[]; formatLabel: string } {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new ImportError('Die CSV-Datei enthält keine Songzeilen.');
  const header = rows[0];
  const col = (k: string) => findColumn(header, k);
  const ti = col('title');
  if (ti < 0) {
    throw new ImportError(
      'In der CSV-Datei fehlt eine Spalte für den Titel (z. B. „Track Name“, „Title“ oder „Titel“).',
    );
  }
  const ai = col('artists');
  const ali = col('album');
  const dmi = col('durationMs');
  const dti = col('durationText');
  const ui = col('uri');
  const ci = col('cover');
  const aui = col('artistUris');
  const aud = col('audioUrl');
  const tyi = col('type');
  const isExportify = header.some((h) => h.trim().toLowerCase() === 'track uri');
  const entries = rows.slice(1).map((r, i): RawEntry => {
    const get = (c: number) => (c >= 0 ? (r[c] ?? '').trim() : '');
    const uriCount = aui >= 0 ? get(aui).split(',').filter(Boolean).length : undefined;
    const dms = get(dmi);
    return {
      row: i + 2,
      title: get(ti),
      artists: splitArtists(get(ai), uriCount),
      album: get(ali) || undefined,
      durationMs: dms && /^\d+$/.test(dms) ? Number(dms) : parseDurationText(get(dti)),
      coverUrl: /^https?:\/\//.test(get(ci)) ? get(ci) : undefined,
      ref: parseSpotifyRef(get(ui)),
      rawRef: get(ui),
      audioUrl: /^https?:\/\//.test(get(aud)) ? get(aud) : undefined,
      typeHint: get(tyi).toLowerCase() || undefined,
    };
  });
  return { entries, formatLabel: isExportify ? 'Exportify-CSV' : 'CSV-Datei' };
}

// ---------------------------------------------------------------------------
// JSON

interface SpotifyExportPlaylist {
  name?: string;
  items?: Array<{
    track?: { trackName?: string; artistName?: string; albumName?: string; trackUri?: string } | null;
    episode?: { episodeName?: string; showName?: string; episodeUri?: string } | null;
    localTrack?: { uri?: string } | null;
    audiobook?: unknown;
  }>;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

export function listSpotifyExportPlaylists(data: unknown): string[] | null {
  if (isObj(data) && Array.isArray(data.playlists)) {
    return (data.playlists as SpotifyExportPlaylist[]).map((p, i) => p.name || `Playlist ${i + 1}`);
  }
  return null;
}

function entriesFromJson(
  data: unknown,
  playlistIndex: number | 'all',
): { entries: RawEntry[]; formatLabel: string; origin: SongOrigin; playlists?: string[] } {
  // Spotify data export: Playlist1.json
  const playlists = listSpotifyExportPlaylists(data);
  if (playlists && isObj(data)) {
    const all = data.playlists as SpotifyExportPlaylist[];
    const chosen = playlistIndex === 'all' ? all : [all[playlistIndex]].filter(Boolean);
    const entries: RawEntry[] = [];
    let row = 1;
    for (const pl of chosen) {
      for (const it of pl.items ?? []) {
        if (it.track) {
          entries.push({
            row: row++,
            title: it.track.trackName,
            artists: it.track.artistName ? [it.track.artistName] : [],
            album: it.track.albumName,
            ref: parseSpotifyRef(it.track.trackUri),
            rawRef: it.track.trackUri,
          });
        } else if (it.episode) {
          entries.push({ row: row++, title: it.episode.episodeName, artists: [], ref: { type: 'episode' }, typeHint: 'episode' });
        } else if (it.localTrack) {
          entries.push({ row: row++, title: it.localTrack.uri, artists: [], ref: { type: 'local' } });
        } else {
          entries.push({ row: row++, title: undefined, artists: [], ref: { type: 'other' }, typeHint: 'audiobook' });
        }
      }
    }
    return { entries, formatLabel: 'Spotify-Datenexport (Playlists)', origin: 'spotify-export', playlists };
  }
  // Spotify data export: YourLibrary.json
  if (isObj(data) && Array.isArray(data.tracks) && (data.tracks as unknown[]).every((t) => isObj(t) && 'track' in t)) {
    const entries = (data.tracks as Array<Record<string, unknown>>).map((t, i) => ({
      row: i + 1,
      title: str(t.track),
      artists: str(t.artist) ? [str(t.artist)!] : [],
      album: str(t.album),
      ref: parseSpotifyRef(str(t.uri)),
      rawRef: str(t.uri),
    }));
    return { entries, formatLabel: 'Spotify-Datenexport (Lieblingssongs)', origin: 'spotify-export' };
  }
  // Generic
  const list = Array.isArray(data) ? data : isObj(data) && Array.isArray(data.songs) ? data.songs : null;
  if (!list) {
    throw new ImportError(
      'Dieses JSON-Format wird nicht erkannt. Erwartet wird eine Liste von Songs, ein Objekt mit „songs“ oder eine Spotify-Datenexport-Datei (Playlist1.json).',
    );
  }
  const entries = (list as unknown[]).map((v, i): RawEntry => {
    if (!isObj(v)) return { row: i + 1, artists: [], ref: { type: 'other' } };
    const artistsRaw = v.artists ?? v.artist ?? v.interpret;
    const artists = Array.isArray(artistsRaw)
      ? artistsRaw.map((a) => (isObj(a) ? str(a.name) : str(a))).filter((a): a is string => !!a)
      : typeof artistsRaw === 'string'
        ? splitArtists(artistsRaw)
        : [];
    const refRaw = str(v.spotifyId) ?? str(v.spotifyUrl) ?? str(v.uri) ?? str(v.url);
    const dur = typeof v.durationMs === 'number' ? v.durationMs : typeof v.duration_ms === 'number' ? v.duration_ms : undefined;
    return {
      row: i + 1,
      title: str(v.title) ?? str(v.name) ?? str(v.titel),
      artists,
      album: isObj(v.album) ? str(v.album.name) : str(v.album),
      durationMs: dur,
      coverUrl: str(v.cover) ?? str(v.coverUrl) ?? str(v.image),
      ref: parseSpotifyRef(refRaw),
      rawRef: refRaw,
      audioUrl: str(v.audioUrl),
      explicitId: str(v.id) && !parseSpotifyRef(str(v.id))?.id ? str(v.id) : undefined,
      typeHint: str(v.type)?.toLowerCase(),
    };
  });
  return { entries, formatLabel: 'JSON-Datei', origin: 'json' };
}

// ---------------------------------------------------------------------------
// Normalisation, validation, de-duplication

function buildSongs(entries: RawEntry[], origin: SongOrigin, startIndex: number): Omit<ImportResult, 'formatLabel' | 'totalEntries'> {
  const unsupported: ImportIssue[] = [];
  const byId = new Map<string, Song>();
  const dupCount = new Map<string, number>();
  let index = startIndex;
  for (const e of entries) {
    const label = e.title || e.rawRef || `Zeile ${e.row}`;
    if (e.ref?.type === 'episode' || e.typeHint === 'episode' || e.typeHint === 'podcast') {
      unsupported.push({ row: e.row, label, reason: 'Podcast-Folge – nur Songs können teilnehmen.' });
      continue;
    }
    if (e.typeHint === 'audiobook') {
      unsupported.push({ row: e.row, label, reason: 'Hörbuch – wird nicht unterstützt.' });
      continue;
    }
    if (e.ref?.type === 'other' && e.rawRef && /spotify/.test(e.rawRef)) {
      unsupported.push({ row: e.row, label, reason: 'Kein Song-Link (z. B. Album oder Playlist).' });
      continue;
    }
    if (!e.title) {
      unsupported.push({ row: e.row, label, reason: 'Kein Titel vorhanden.' });
      continue;
    }
    const spotifyTrackId = e.ref?.type === 'track' ? e.ref.id : undefined;
    // Stable ID: Spotify track ID when present; else an explicit ID; else a hash of the full metadata.
    // Different versions (Live, Remix) have different Spotify IDs or titles and are never merged by title alone.
    const id = spotifyTrackId
      ? `sp:${spotifyTrackId}`
      : e.explicitId
        ? `id:${e.explicitId}`
        : `h:${hashString([e.title, e.artists.join(','), e.album ?? '', e.durationMs ?? ''].join('|').toLowerCase())}`;
    if (byId.has(id)) {
      dupCount.set(id, (dupCount.get(id) ?? 1) + 1);
      continue;
    }
    byId.set(id, {
      id,
      title: e.title,
      artists: e.artists,
      album: e.album,
      coverUrl: e.coverUrl,
      durationMs: e.durationMs,
      origin,
      spotifyTrackId,
      audioUrl: e.audioUrl,
      originalIndex: index++,
    });
  }
  return {
    songs: [...byId.values()],
    duplicates: [...dupCount.entries()].map(([id, count]) => ({ title: byId.get(id)!.title, count })),
    unsupported,
  };
}

export interface ImportOptions {
  /** For Spotify data exports: which playlist (index) or all. */
  playlistIndex?: number | 'all';
  /** originalIndex offset when appending to an existing collection. */
  startIndex?: number;
}

export function importText(fileName: string, text: string, opts: ImportOptions = {}): ImportResult {
  const name = fileName.toLowerCase();
  const trimmed = text.trim();
  if (!trimmed) throw new ImportError('Die Datei ist leer.');
  const looksJson = name.endsWith('.json') || trimmed.startsWith('{') || trimmed.startsWith('[');
  if (looksJson) {
    let data: unknown;
    try {
      data = JSON.parse(trimmed);
    } catch {
      throw new ImportError('Die JSON-Datei ist beschädigt oder unvollständig.');
    }
    const { entries, formatLabel, origin, playlists } = entriesFromJson(data, opts.playlistIndex ?? 'all');
    const built = buildSongs(entries, origin, opts.startIndex ?? 0);
    return { ...built, totalEntries: entries.length, formatLabel, playlists };
  }
  const { entries, formatLabel } = entriesFromCsv(text);
  const built = buildSongs(entries, formatLabel.startsWith('Exportify') ? 'exportify' : 'csv', opts.startIndex ?? 0);
  return { ...built, totalEntries: entries.length, formatLabel };
}

/** Merge new songs into an existing collection by stable ID. */
export function mergeSongs(existing: Song[], incoming: Song[]): { songs: Song[]; added: number; merged: number } {
  const ids = new Set(existing.map((s) => s.id));
  let next = existing.length ? Math.max(...existing.map((s) => s.originalIndex)) + 1 : 0;
  const out = existing.slice();
  let added = 0;
  let merged = 0;
  for (const s of incoming.slice().sort((a, b) => a.originalIndex - b.originalIndex)) {
    if (ids.has(s.id)) {
      merged++;
      continue;
    }
    ids.add(s.id);
    out.push({ ...s, originalIndex: next++ });
    added++;
  }
  return { songs: out, added, merged };
}

export function manualSong(title: string, artists: string, album: string, link: string, index: number): Song | string {
  const t = title.trim();
  if (!t) return 'Bitte gib einen Titel ein.';
  const ref = parseSpotifyRef(link);
  if (link.trim() && ref?.type !== 'track' && !/^https?:\/\//.test(link.trim())) {
    return 'Der Link wurde nicht erkannt. Erlaubt sind Spotify-Songlinks oder direkte Audio-URLs.';
  }
  if (ref?.type === 'episode') return 'Podcast-Folgen werden nicht unterstützt.';
  const spotifyTrackId = ref?.type === 'track' ? ref.id : undefined;
  const audioUrl = !spotifyTrackId && /^https?:\/\//.test(link.trim()) ? link.trim() : undefined;
  const id = spotifyTrackId ? `sp:${spotifyTrackId}` : `m:${hashString(`${t}|${artists}|${album}|${Date.now()}|${Math.random()}`)}`;
  return {
    id,
    title: t,
    artists: splitArtists(artists),
    album: album.trim() || undefined,
    origin: 'manual',
    spotifyTrackId,
    audioUrl,
    originalIndex: index,
  };
}
