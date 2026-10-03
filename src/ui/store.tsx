import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { defaultConfig } from '../domain/config';
import type { Tournament, TournamentConfig } from '../domain/types';
import { listAudioIds } from '../playback/audioStore';
import { player } from '../playback/player';
import {
  loadLibrary,
  loadTournaments,
  saveLibrary,
  saveTournaments,
  type LibraryState,
} from '../storage/storage';

export type Route =
  | { page: 'home' }
  | { page: 'library' }
  | { page: 'setup' }
  | { page: 'play'; id: string }
  | { page: 'overview'; id: string }
  | { page: 'result'; id: string }
  | { page: 'stats'; id?: string };

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'sammlung') return { page: 'library' };
  if (parts[0] === 'einstellungen') return { page: 'setup' };
  if (parts[0] === 'statistik') return parts[1] ? { page: 'stats', id: parts[1] } : { page: 'stats' };
  if (parts[0] === 'turnier' && parts[1]) {
    if (parts[2] === 'uebersicht') return { page: 'overview', id: parts[1] };
    if (parts[2] === 'ergebnis') return { page: 'result', id: parts[1] };
    return { page: 'play', id: parts[1] };
  }
  return { page: 'home' };
}

export function routeHash(r: Route): string {
  switch (r.page) {
    case 'home':
      return '#/';
    case 'library':
      return '#/sammlung';
    case 'setup':
      return '#/einstellungen';
    case 'play':
      return `#/turnier/${encodeURIComponent(r.id)}`;
    case 'overview':
      return `#/turnier/${encodeURIComponent(r.id)}/uebersicht`;
    case 'result':
      return `#/turnier/${encodeURIComponent(r.id)}/ergebnis`;
    case 'stats':
      return r.id ? `#/statistik/${encodeURIComponent(r.id)}` : '#/statistik';
  }
}

interface Store {
  route: Route;
  go: (r: Route) => void;
  library: LibraryState;
  updateLibrary: (fn: (l: LibraryState) => LibraryState) => void;
  tournaments: Tournament[];
  saveTournament: (t: Tournament) => void;
  deleteTournament: (id: string) => void;
  localAudio: Set<string>;
  refreshLocalAudio: () => Promise<void>;
  setupConfig: TournamentConfig;
  setSetupConfig: (c: TournamentConfig) => void;
  toast: (msg: string) => void;
  toastMsg: string | null;
  saveError: string | null;
}

const Ctx = createContext<Store | null>(null);

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error('Store missing');
  return s;
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));
  const [library, setLibrary] = useState<LibraryState>(loadLibrary);
  const [tournaments, setTournaments] = useState<Tournament[]>(loadTournaments);
  const [localAudio, setLocalAudio] = useState<Set<string>>(new Set());
  const [setupConfig, setSetupConfig] = useState<TournamentConfig>(defaultConfig);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const onHash = () => setRoute(parseHash(location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const go = useCallback((r: Route) => {
    const h = routeHash(r);
    if (location.hash !== h) location.hash = h;
    else setRoute(r);
    window.scrollTo({ top: 0 });
  }, []);

  const refreshLocalAudio = useCallback(async () => {
    const ids = new Set(await listAudioIds());
    player.setLocalAudioIds(ids);
    setLocalAudio(ids);
  }, []);

  useEffect(() => {
    void refreshLocalAudio();
  }, [refreshLocalAudio]);

  const updateLibrary = useCallback((fn: (l: LibraryState) => LibraryState) => {
    setLibrary((prev) => {
      const next = fn(prev);
      setSaveError(saveLibrary(next));
      return next;
    });
  }, []);

  const saveTournament = useCallback((t: Tournament) => {
    setTournaments((prev) => {
      const stamped = { ...t, updatedAt: new Date().toISOString() };
      const next = prev.some((x) => x.id === t.id) ? prev.map((x) => (x.id === t.id ? stamped : x)) : [stamped, ...prev];
      setSaveError(saveTournaments(next));
      return next;
    });
  }, []);

  const deleteTournament = useCallback((id: string) => {
    setTournaments((prev) => {
      const next = prev.filter((x) => x.id !== id);
      setSaveError(saveTournaments(next));
      return next;
    });
  }, []);

  const toast = useCallback((msg: string) => {
    setToastMsg(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastMsg(null), 3200);
  }, []);

  const value = useMemo<Store>(
    () => ({
      route,
      go,
      library,
      updateLibrary,
      tournaments,
      saveTournament,
      deleteTournament,
      localAudio,
      refreshLocalAudio,
      setupConfig,
      setSetupConfig,
      toast,
      toastMsg,
      saveError,
    }),
    [route, go, library, updateLibrary, tournaments, saveTournament, deleteTournament, localAudio, refreshLocalAudio, setupConfig, toast, toastMsg, saveError],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
