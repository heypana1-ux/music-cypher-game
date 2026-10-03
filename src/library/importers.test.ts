import { describe, expect, it } from 'vitest';
import { ImportError, importText, manualSong, mergeSongs, parseCsv, parseSpotifyRef, splitArtists } from './importers';

describe('parseSpotifyRef', () => {
  it('handles URIs, links with locale and query, bare IDs', () => {
    expect(parseSpotifyRef('spotify:track:4uLU6hMCjMI75M1A2tKUQC')).toEqual({ type: 'track', id: '4uLU6hMCjMI75M1A2tKUQC' });
    expect(parseSpotifyRef('https://open.spotify.com/intl-de/track/4uLU6hMCjMI75M1A2tKUQC?si=abc')).toEqual({
      type: 'track',
      id: '4uLU6hMCjMI75M1A2tKUQC',
    });
    expect(parseSpotifyRef('4uLU6hMCjMI75M1A2tKUQC')?.id).toBe('4uLU6hMCjMI75M1A2tKUQC');
    expect(parseSpotifyRef('spotify:episode:4uLU6hMCjMI75M1A2tKUQC')?.type).toBe('episode');
    expect(parseSpotifyRef('spotify:local:Artist:Album:Title:200')?.type).toBe('local');
  });
});

describe('CSV', () => {
  it('parses quotes, embedded commas, newlines and semicolon files', () => {
    expect(parseCsv('a,b\n"x, y","he said ""hi"""\n')).toEqual([['a', 'b'], ['x, y', 'he said "hi"']]);
    expect(parseCsv('﻿Titel;Interpret\r\nA;B\r\n')).toEqual([['Titel', 'Interpret'], ['A', 'B']]);
    expect(parseCsv('a,b\n"multi\nline",2')).toEqual([['a', 'b'], ['multi\nline', '2']]);
  });

  it('imports an Exportify export with duplicates, podcasts and local files', () => {
    const csv = [
      '"Track URI","Track Name","Album Name","Artist Name(s)","Release Date","Duration (ms)","Popularity"',
      '"spotify:track:4uLU6hMCjMI75M1A2tKUQC","Never Gonna Give You Up","Whenever You Need Somebody","Rick Astley","1987","213573","80"',
      '"spotify:track:4uLU6hMCjMI75M1A2tKUQC","Never Gonna Give You Up","Whenever You Need Somebody","Rick Astley","1987","213573","80"',
      '"spotify:track:0VjIjW4GlUZAMYd2vXMi3b","Blinding Lights","After Hours","The Weeknd","2020","200040","90"',
      '"spotify:track:1111111111111111111111","Song (Live)","Live","Tyler, The Creator","2020","1","1"',
      '"spotify:track:2222222222222222222222","Duet","X","Artist A,Artist B","2020","1","1"',
      '"spotify:episode:3333333333333333333333","Some Podcast","","","","",""',
      '"spotify:local:a:b:c:1","Local Song","","Me","","",""',
      '"","","","","","",""',
    ].join('\n');
    const r = importText('playlist.csv', csv);
    expect(r.formatLabel).toBe('Exportify-CSV');
    expect(r.songs.map((s) => s.title)).toEqual(['Never Gonna Give You Up', 'Blinding Lights', 'Song (Live)', 'Duet', 'Local Song']);
    expect(r.duplicates).toEqual([{ title: 'Never Gonna Give You Up', count: 2 }]);
    expect(r.unsupported.map((u) => u.reason)).toEqual(['Podcast-Folge – nur Songs können teilnehmen.']);
    expect(r.songs[0].spotifyTrackId).toBe('4uLU6hMCjMI75M1A2tKUQC');
    expect(r.songs[0].durationMs).toBe(213573);
    expect(r.songs[2].artists).toEqual(['Tyler, The Creator']);
    expect(r.songs[3].artists).toEqual(['Artist A', 'Artist B']);
    expect(r.songs[4].spotifyTrackId).toBeUndefined();
  });

  it('does not merge versions only because titles match', () => {
    const csv = 'Title,Artist,Album\nHerzschlag,Jonas,Studio\nHerzschlag,Jonas,Live im Hafen\n';
    expect(importText('x.csv', csv).songs.length).toBe(2);
  });

  it('gives a clear error without a title column', () => {
    expect(() => importText('x.csv', 'foo,bar\n1,2')).toThrow(ImportError);
    expect(() => importText('x.csv', '')).toThrow('leer');
  });

  it('reads German Excel style with semicolons and m:ss durations', () => {
    const r = importText('x.csv', 'Titel;Interpret;Dauer\nLied;Band;3:30\n');
    expect(r.songs[0]).toMatchObject({ title: 'Lied', artists: ['Band'], durationMs: 210000 });
  });
});

describe('JSON', () => {
  it('imports the Spotify account data export and lists playlists', () => {
    const data = {
      playlists: [
        {
          name: 'Cypher 170',
          items: [
            { track: { trackName: 'A', artistName: 'X', albumName: 'Al', trackUri: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC' }, episode: null, localTrack: null },
            { track: null, episode: { episodeName: 'Pod', showName: 'Show', episodeUri: 'spotify:episode:x' }, localTrack: null },
          ],
        },
        { name: 'Other', items: [{ track: { trackName: 'B', artistName: 'Y', albumName: 'Bl', trackUri: 'spotify:track:0VjIjW4GlUZAMYd2vXMi3b' } }] },
      ],
    };
    const all = importText('Playlist1.json', JSON.stringify(data));
    expect(all.playlists).toEqual(['Cypher 170', 'Other']);
    expect(all.songs.length).toBe(2);
    expect(all.unsupported.length).toBe(1);
    const one = importText('Playlist1.json', JSON.stringify(data), { playlistIndex: 1 });
    expect(one.songs.map((s) => s.title)).toEqual(['B']);
    expect(one.songs[0].origin).toBe('spotify-export');
  });

  it('imports generic JSON and reports invalid entries', () => {
    const r = importText(
      'x.json',
      JSON.stringify({ songs: [{ title: 'A', artists: ['X', 'Y'], spotifyUrl: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC' }, { foo: 1 }, 5] }),
    );
    expect(r.songs.length).toBe(1);
    expect(r.songs[0].artists).toEqual(['X', 'Y']);
    expect(r.unsupported.length).toBe(2);
  });

  it('rejects broken JSON with a friendly message', () => {
    expect(() => importText('x.json', '{"songs": [')).toThrow('beschädigt');
    expect(() => importText('x.json', '{"foo": 1}')).toThrow('nicht erkannt');
  });
});

describe('helpers', () => {
  it('mergeSongs keeps stable IDs and appends', () => {
    const a = importText('a.csv', 'Title,Artist\nA,X\nB,Y\n').songs;
    const b = importText('b.csv', 'Title,Artist\nB,Y\nC,Z\n').songs;
    const m = mergeSongs(a, b);
    expect(m.added).toBe(1);
    expect(m.merged).toBe(1);
    expect(m.songs.map((s) => s.originalIndex)).toEqual([0, 1, 2]);
  });

  it('manualSong validates input', () => {
    expect(manualSong('', 'x', '', '', 0)).toBe('Bitte gib einen Titel ein.');
    const s = manualSong('T', 'A; B', '', 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC', 0);
    expect(typeof s).toBe('object');
    if (typeof s === 'object') {
      expect(s.id).toBe('sp:4uLU6hMCjMI75M1A2tKUQC');
      expect(s.artists).toEqual(['A', 'B']);
    }
    expect(splitArtists('')).toEqual([]);
  });
});
