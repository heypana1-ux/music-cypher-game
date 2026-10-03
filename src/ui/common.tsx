import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Song } from '../domain/types';
import { player, usePlayer, SNIPPET_SECONDS } from '../playback/player';
import { playbackFor, spotifyEmbedUrl } from '../playback/sources';
import { useStore } from './store';

export function fmtDuration(ms?: number): string {
  if (!ms || ms <= 0) return '–:––';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function fmtSeconds(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

export function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

export function artistsOf(s: Song | undefined): string {
  return s && s.artists.length ? s.artists.join(', ') : 'Unbekannter Interpret';
}

function hue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

/** Album cover with a neutral generated placeholder when missing or broken. */
export function Cover({ song, size = 48, className = '' }: { song: Song | undefined; size?: number | 'fill'; className?: string }) {
  const [broken, setBroken] = useState(false);
  const style = size === 'fill' ? undefined : { width: size, height: size, fontSize: Math.max(12, Number(size) / 3) };
  const h = hue(song?.id ?? 'x');
  const initials = (song?.title ?? '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
  if (song?.coverUrl && !broken) {
    return (
      <div className={`cover ${className}`} style={style}>
        <img src={song.coverUrl} alt="" loading="lazy" onError={() => setBroken(true)} />
      </div>
    );
  }
  return (
    <div
      className={`cover ${className}`}
      style={{
        ...style,
        background: `linear-gradient(135deg, hsl(${h} 55% 32%), hsl(${(h + 60) % 360} 50% 18%))`,
      }}
      aria-hidden="true"
    >
      <span style={size === 'fill' ? { fontSize: '2.4rem' } : undefined}>{initials}</span>
    </div>
  );
}

export function PlaybackChip({ song }: { song: Song }) {
  const { localAudio } = useStore();
  const info = playbackFor(song, localAudio);
  const cls = info.kind === 'none' ? 'chip warn' : info.kind === 'spotify' ? 'chip violet' : 'chip accent';
  return <span className={cls}>{info.kind === 'none' ? '⊘ ' : '♪ '}{info.label}</span>;
}

export function PlayButton({ song, compact = false }: { song: Song; compact?: boolean }) {
  const p = usePlayer();
  const { localAudio } = useStore();
  const info = playbackFor(song, localAudio);
  const active = p.song?.id === song.id;
  const playing = active && (p.status === 'playing' || p.status === 'embed' || p.status === 'loading');
  if (info.kind === 'none') {
    return (
      <button className={`btn ${compact ? 'small' : ''}`} disabled title="Keine Wiedergabe verfügbar">
        Kein Audio
      </button>
    );
  }
  const label = info.kind === 'spotify' ? (active ? 'Im Player' : 'Anhören') : playing ? 'Pause' : 'Anhören';
  return (
    <button
      className={`btn ${compact ? 'small' : ''}`}
      onClick={() => player.toggle(song)}
      aria-pressed={active}
      aria-label={`${label}: ${song.title}`}
    >
      <span aria-hidden="true">{playing && info.kind !== 'spotify' ? '❚❚' : '▶'}</span> {label}
    </button>
  );
}

export function PlayerDock() {
  const p = usePlayer();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = p.song ? (ref.current?.offsetHeight ?? 0) : 0;
    document.documentElement.style.setProperty('--dock-h', `${h}px`);
    document.body.classList.toggle('has-dock', !!p.song);
  }, [p.song, p.kind]);
  if (!p.song) return null;
  const s = p.song;
  const snippetEnd = p.snippetStart + SNIPPET_SECONDS;
  return (
    <div className="dock" ref={ref} role="region" aria-label="Wiedergabe">
      <div className="dock-inner">
        <Cover song={s} size={48} />
        <div className="meta">
          <div className="title">{s.title}</div>
          <div className="small muted">{artistsOf(s)}</div>
        </div>
        {p.kind === 'spotify' && s.spotifyTrackId ? (
          <>
            <iframe
              key={s.spotifyTrackId}
              title={`Spotify-Player: ${s.title}`}
              src={spotifyEmbedUrl(s.spotifyTrackId)}
              allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
              loading="lazy"
            />
            <span className="tiny muted" style={{ maxWidth: 220 }}>
              Offizieller Spotify-Player. Mit Premium-Login im Browser meist ganzer Song, sonst Vorschau.
            </span>
          </>
        ) : p.status === 'error' ? (
          <span className="small" style={{ color: 'var(--warn)' }}>{p.error}</span>
        ) : (
          <>
            <button className="btn icon" onClick={() => player.toggle(s)} aria-label={p.status === 'playing' ? 'Pause' : 'Abspielen'}>
              {p.status === 'playing' ? '❚❚' : '▶'}
            </button>
            <div className="seek">
              <span>{fmtSeconds(p.position)}</span>
              <input
                type="range"
                min={0}
                max={p.duration || 1}
                step={0.5}
                value={Math.min(p.position, p.duration || 1)}
                onChange={(e) => player.seek(Number(e.target.value))}
                aria-label="Position"
              />
              <span>{fmtSeconds(p.duration)}</span>
            </div>
            <div className="seg" role="group" aria-label="Wiedergabelänge">
              <button aria-pressed={p.mode === 'snippet'} onClick={() => player.setMode('snippet')}>
                {SNIPPET_SECONDS} s
              </button>
              <button aria-pressed={p.mode === 'full'} onClick={() => player.setMode('full')}>
                Ganz
              </button>
            </div>
            <button className="btn small ghost" onClick={() => player.setSnippetStartHere()} title="Der 30-Sekunden-Ausschnitt startet künftig an dieser Stelle">
              Ausschnitt ab hier
            </button>
            <div className="vol">
              <span aria-hidden="true">🔊</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={p.volume}
                onChange={(e) => player.setVolume(Number(e.target.value))}
                aria-label="Lautstärke"
              />
            </div>
            {p.mode === 'snippet' && (
              <span className="tiny faint">
                Ausschnitt {fmtSeconds(p.snippetStart)}–{fmtSeconds(snippetEnd)}
              </span>
            )}
          </>
        )}
        <button className="btn icon small ghost" onClick={() => player.stop()} aria-label="Wiedergabe schließen">
          ✕
        </button>
      </div>
    </div>
  );
}

export function Modal({
  title,
  children,
  onClose,
  actions,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  actions: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('button, input, select')?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={ref} onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        <div className="stack">{children}</div>
        <div className="row end" style={{ marginTop: 18 }}>
          {actions}
        </div>
      </div>
    </div>
  );
}

export function Seg<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Array<{ value: T; label: string; disabled?: boolean }>;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} aria-pressed={value === o.value} disabled={o.disabled} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
