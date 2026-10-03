// "Back to Spotify" without the Spotify API: song links you paste into a Spotify playlist
// (desktop app: open the playlist, Ctrl/Cmd+V), or a CSV for playlist tools like TuneMyMusic / Soundiiz.

import type { Song } from '../domain/types';

export interface SpotifyExport {
  links: string;
  csv: string;
  count: number;
  skipped: Song[];
}

const csvCell = (s: string) => (/[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export function spotifyExport(songs: Song[]): SpotifyExport {
  const withId = songs.filter((s) => s.spotifyTrackId);
  const links = withId.map((s) => `https://open.spotify.com/track/${s.spotifyTrackId}`).join('\n');
  const rows = [['Track name', 'Artist name', 'Album', 'Spotify - id', 'Spotify URI']];
  for (const s of songs) {
    rows.push([s.title, s.artists.join(', '), s.album ?? '', s.spotifyTrackId ?? '', s.spotifyTrackId ? `spotify:track:${s.spotifyTrackId}` : '']);
  }
  return {
    links,
    csv: rows.map((r) => r.map(csvCell).join(',')).join('\n'),
    count: withId.length,
    skipped: songs.filter((s) => !s.spotifyTrackId),
  };
}
