// Single global player: only one song plays at a time inside the app.

import { useSyncExternalStore } from 'react';
import type { Song } from '../domain/types';
import { loadPrefs, savePrefs, type Prefs } from '../storage/storage';
import { getAudio } from './audioStore';
import { playbackFor, type PlaybackKind } from './sources';
import { demoUrl } from './synth';

export const SNIPPET_SECONDS = 30;

export interface PlayerState {
  song: Song | null;
  kind: PlaybackKind;
  status: 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error' | 'embed';
  position: number;
  duration: number;
  volume: number;
  mode: 'snippet' | 'full';
  snippetStart: number;
  error: string | null;
}

let prefs: Prefs = typeof localStorage !== 'undefined' ? loadPrefs() : { volume: 0.8, playMode: 'snippet', snippetStart: {} };

let state: PlayerState = {
  song: null,
  kind: 'none',
  status: 'idle',
  position: 0,
  duration: 0,
  volume: prefs.volume,
  mode: prefs.playMode,
  snippetStart: 0,
  error: null,
};

const listeners = new Set<() => void>();
let audio: HTMLAudioElement | null = null;
let objectUrl: string | null = null;
let localIds: ReadonlySet<string> = new Set();
let token = 0;

function set(patch: Partial<PlayerState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

function el(): HTMLAudioElement {
  if (!audio) {
    audio = new Audio();
    audio.preload = 'auto';
    audio.volume = state.volume;
    audio.addEventListener('timeupdate', () => {
      if (!audio) return;
      if (state.mode === 'snippet' && audio.currentTime >= state.snippetStart + SNIPPET_SECONDS) {
        audio.pause();
        set({ status: 'ended', position: audio.currentTime });
        return;
      }
      set({ position: audio.currentTime });
    });
    audio.addEventListener('loadedmetadata', () => set({ duration: audio!.duration || 0 }));
    audio.addEventListener('play', () => set({ status: 'playing' }));
    audio.addEventListener('pause', () => {
      if (state.status === 'playing') set({ status: 'paused' });
    });
    audio.addEventListener('ended', () => set({ status: 'ended' }));
    audio.addEventListener('error', () => {
      if (state.song && audio?.getAttribute('src')) {
        set({ status: 'error', error: 'Die Audiodatei konnte nicht abgespielt werden.' });
      }
    });
  }
  return audio;
}

export const player = {
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  get: () => state,
  setLocalAudioIds(ids: ReadonlySet<string>) {
    localIds = ids;
  },

  async load(song: Song, autoplay = true) {
    const my = ++token;
    this.stop(false);
    const info = playbackFor(song, localIds);
    const snippetStart = prefs.snippetStart[song.id] ?? 0;
    set({ song, kind: info.kind, position: 0, duration: 0, error: null, snippetStart });
    if (info.kind === 'spotify') {
      set({ status: 'embed' });
      return;
    }
    if (info.kind === 'none') {
      set({ status: 'error', error: 'Für diesen Song ist keine Wiedergabe verfügbar. Du kannst trotzdem entscheiden.' });
      return;
    }
    set({ status: 'loading' });
    let src: string;
    try {
      if (info.kind === 'local') {
        const stored = await getAudio(song.id);
        if (!stored) throw new Error('missing');
        if (my !== token) return;
        objectUrl = URL.createObjectURL(stored.blob);
        src = objectUrl;
      } else if (info.kind === 'url') src = song.audioUrl!;
      else src = demoUrl(song.demoTone!);
    } catch {
      if (my === token) set({ status: 'error', error: 'Die zugeordnete Audiodatei wurde nicht gefunden.' });
      return;
    }
    if (my !== token) return;
    const a = el();
    a.src = src;
    a.currentTime = state.mode === 'snippet' ? snippetStart : 0;
    if (autoplay) {
      a.play().catch(() => {
        if (my === token && state.status === 'loading') set({ status: 'paused' });
      });
    } else set({ status: 'paused' });
  },

  toggle(song: Song) {
    if (state.song?.id === song.id && state.kind !== 'spotify') {
      const a = el();
      if (state.status === 'playing') a.pause();
      else if (state.status === 'paused' || state.status === 'ended') {
        if (state.status === 'ended' || (state.mode === 'snippet' && a.currentTime >= state.snippetStart + SNIPPET_SECONDS)) {
          a.currentTime = state.mode === 'snippet' ? state.snippetStart : 0;
        }
        a.play().catch(() => undefined);
      } else if (state.status === 'error') void this.load(song);
      return;
    }
    if (state.song?.id === song.id && state.kind === 'spotify') return;
    void this.load(song);
  },

  seek(seconds: number) {
    if (!audio || !state.song) return;
    audio.currentTime = Math.max(0, Math.min(seconds, state.duration || seconds));
    set({ position: audio.currentTime });
  },

  setVolume(v: number) {
    const vol = Math.max(0, Math.min(1, v));
    if (audio) audio.volume = vol;
    prefs = { ...prefs, volume: vol };
    savePrefs(prefs);
    set({ volume: vol });
  },

  setMode(mode: 'snippet' | 'full') {
    prefs = { ...prefs, playMode: mode };
    savePrefs(prefs);
    set({ mode });
    if (audio && mode === 'snippet' && state.song) {
      const a = audio;
      if (a.currentTime < state.snippetStart || a.currentTime > state.snippetStart + SNIPPET_SECONDS) a.currentTime = state.snippetStart;
    }
  },

  /** Use the current position as snippet start for this song (manual chorus position). */
  setSnippetStartHere() {
    if (!audio || !state.song) return;
    const start = Math.floor(audio.currentTime);
    prefs = { ...prefs, snippetStart: { ...prefs.snippetStart, [state.song.id]: start } };
    savePrefs(prefs);
    set({ snippetStart: start, mode: 'snippet' });
  },

  stop(clear = true) {
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
    }
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
    if (clear) {
      token++;
      set({ song: null, kind: 'none', status: 'idle', position: 0, duration: 0, error: null });
    }
  },
};

export function usePlayer(): PlayerState {
  return useSyncExternalStore(player.subscribe, player.get, player.get);
}
