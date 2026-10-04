// Music sources: which (allowed) way a song can be played. The tournament logic never depends on this.

import type { Song } from '../domain/types';

export type PlaybackKind = 'local' | 'url' | 'demo' | 'spotify' | 'none';

export interface PlaybackInfo {
  kind: PlaybackKind;
  label: string;
  /** Own controls (play/pause, progress, volume, 30-s snippet) are possible. */
  controllable: boolean;
  /** Link to open the song in the Spotify app. */
  spotifyUrl?: string;
}

export function spotifyTrackUrl(id: string): string {
  return `https://open.spotify.com/track/${id}`;
}

export function spotifyEmbedUrl(id: string): string {
  return `https://open.spotify.com/embed/track/${id}?utm_source=generator&theme=0`;
}

/**
 * Priority: own local file > own audio URL > demo synth > official Spotify embed > none.
 * The Spotify embed is Spotify's own player widget – the app never touches the audio stream.
 */
export function playbackFor(song: Song, localAudio: ReadonlySet<string>): PlaybackInfo {
  const spotifyUrl = song.spotifyTrackId ? spotifyTrackUrl(song.spotifyTrackId) : undefined;
  if (localAudio.has(song.audioKey ?? song.id)) return { kind: 'local', label: 'Eigene Audiodatei', controllable: true, spotifyUrl };
  if (song.audioUrl) return { kind: 'url', label: 'Eigene Audio-URL', controllable: true, spotifyUrl };
  if (song.demoTone) return { kind: 'demo', label: 'Demo-Klang', controllable: true };
  if (song.spotifyTrackId) return { kind: 'spotify', label: 'Spotify-Player', controllable: false, spotifyUrl };
  return { kind: 'none', label: 'Keine Wiedergabe', controllable: false };
}

/**
 * Import connectors. File-based import is always available. A direct Spotify Web API connector
 * is prepared as an interface only and deliberately not enabled – see README ("Spotify").
 */
export interface ImportConnector {
  id: string;
  name: string;
  enabled: boolean;
  reason?: string;
}

export const IMPORT_CONNECTORS: ImportConnector[] = [
  { id: 'file', name: 'Datei (CSV / JSON / Spotify-Datenexport)', enabled: true },
  {
    id: 'spotify-web-api',
    name: 'Spotify direkt (Web API)',
    enabled: false,
    reason:
      'Nicht aktiviert: Die Spotify-Entwicklerrichtlinien verbieten Spiele. Nutze stattdessen einen Datei-Export deiner Playlist.',
  },
];
