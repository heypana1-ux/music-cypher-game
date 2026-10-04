import { useEffect, useMemo, useState } from 'react';
import { participantMap, roundEntries } from '../domain/participants';
import type { Song, Tournament, TournamentState } from '../domain/types';
import { spotifyExport } from '../library/spotifyExport';
import { download, safeFileName } from '../storage/storage';
import { Modal } from './common';
import { useStore } from './store';

// ---------------------------------------------------------------------------
// Back to Spotify

export function SpotifyExportModal({
  title,
  songs,
  fileBase,
  onClose,
  counts = [8, 16, 32],
}: {
  title: string;
  /** Already in the desired order (best first). */
  songs: Song[];
  fileBase: string;
  onClose: () => void;
  counts?: number[];
}) {
  const { toast } = useStore();
  const options = [...counts.filter((c) => c < songs.length), songs.length];
  const [n, setN] = useState(options[0]);
  const chosen = songs.slice(0, n);
  const ex = useMemo(() => spotifyExport(chosen), [chosen]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(ex.links);
      toast(`${ex.count} Spotify-Links kopiert.`);
    } catch {
      toast('Kopieren nicht möglich – nutze „CSV herunterladen“.');
    }
  };

  return (
    <Modal
      title={title}
      onClose={onClose}
      actions={
        <>
          <button className="btn ghost" onClick={onClose}>
            Schließen
          </button>
          <button className="btn" onClick={() => download(`${safeFileName(fileBase)}-spotify.csv`, ex.csv, 'text/csv')}>
            CSV herunterladen
          </button>
          <button className="btn primary" onClick={copy} disabled={ex.count === 0}>
            Links kopieren
          </button>
        </>
      }
    >
      <div className="row">
        <span className="small muted">Wie viele Songs?</span>
        <div className="seg" role="group" aria-label="Anzahl">
          {options.map((o) => (
            <button key={o} aria-pressed={n === o} onClick={() => setN(o)}>
              {o === songs.length ? `Alle (${o})` : `Top ${o}`}
            </button>
          ))}
        </div>
      </div>
      <ol className="export-list small">
        {chosen.slice(0, 12).map((s) => (
          <li key={s.id} className={s.spotifyTrackId ? '' : 'faint'}>
            {s.title} <span className="muted">– {s.artists.join(', ')}</span>
            {!s.spotifyTrackId && <span className="chip warn" style={{ marginLeft: 6 }}>kein Spotify-Link</span>}
          </li>
        ))}
        {chosen.length > 12 && <li className="faint">… und {chosen.length - 12} weitere</li>}
      </ol>
      <div className="notice small">
        <strong>So landet die Liste in Spotify:</strong>
        <ol style={{ margin: '6px 0 0', paddingLeft: 18 }}>
          <li>„Links kopieren“ tippen.</li>
          <li>In der Spotify-<strong>Desktop-App</strong> eine neue Playlist öffnen, in die leere Liste klicken und Strg+V (Mac: ⌘+V) drücken.</li>
        </ol>
        <p style={{ margin: '6px 0 0' }}>
          Am Handy geht das Einfügen nicht – dort lädst du die CSV z. B. bei TuneMyMusic oder Soundiiz hoch, die daraus eine Playlist bauen.
        </p>
        {ex.skipped.length > 0 && (
          <p className="tiny" style={{ margin: '6px 0 0' }}>
            {ex.skipped.length} Songs haben keinen Spotify-Link und fehlen bei den kopierten Links (in der CSV stehen sie mit Titel).
          </p>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Share image (1080×1920, story format)

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
    setTimeout(() => resolve(null), 4000);
  });
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else line = test;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const cut = lines.slice(0, maxLines);
    let last = cut[maxLines - 1];
    while (ctx.measureText(`${last}…`).width > maxWidth && last.length > 1) last = last.slice(0, -1);
    cut[maxLines - 1] = `${last}…`;
    return cut;
  }
  return lines;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function hue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

export async function renderShareImage(t: Tournament, state: TournamentState): Promise<HTMLCanvasElement> {
  const W = 1080;
  const H = 1920;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  const font = (w: number, size: number) => `${w} ${size}px Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  const byId = participantMap(t);
  const champ = byId.get(state.champion!)!;

  // background
  ctx.fillStyle = '#0d0d12';
  ctx.fillRect(0, 0, W, H);
  let g = ctx.createRadialGradient(150, 100, 0, 150, 100, 900);
  g.addColorStop(0, 'rgba(167,139,250,0.35)');
  g.addColorStop(1, 'rgba(167,139,250,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  g = ctx.createRadialGradient(W, H * 0.55, 0, W, H * 0.55, 900);
  g.addColorStop(0, 'rgba(198,255,61,0.22)');
  g.addColorStop(1, 'rgba(198,255,61,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // brand
  ctx.fillStyle = '#c6ff3d';
  ctx.beginPath();
  ctx.arc(110, 130, 26, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#0d0d12';
  ctx.beginPath();
  ctx.arc(110, 130, 9, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#f2f2f7';
  ctx.font = font(800, 44);
  ctx.textBaseline = 'middle';
  ctx.fillText('Music Cypher', 156, 132);

  // label
  ctx.textAlign = 'center';
  ctx.fillStyle = '#c6ff3d';
  ctx.font = font(800, 40);
  ctx.fillText('M E I N   G E W I N N E R', W / 2, 300);

  // cover
  const size = 700;
  const cx = (W - size) / 2;
  const cy = 360;
  ctx.save();
  ctx.shadowColor = 'rgba(198,255,61,0.35)';
  ctx.shadowBlur = 80;
  roundRect(ctx, cx, cy, size, size, 36);
  ctx.fillStyle = '#242432';
  ctx.fill();
  ctx.restore();
  ctx.save();
  roundRect(ctx, cx, cy, size, size, 36);
  ctx.clip();
  const img = champ.coverUrl ? await loadImage(champ.coverUrl) : null;
  let drawn = false;
  if (img) {
    try {
      ctx.drawImage(img, cx, cy, size, size);
      c.toDataURL(); // throws if the image tainted the canvas
      drawn = true;
    } catch {
      drawn = false;
    }
  }
  if (!drawn) {
    const h = hue(champ.id);
    const cg = ctx.createLinearGradient(cx, cy, cx + size, cy + size);
    cg.addColorStop(0, `hsl(${h} 55% 32%)`);
    cg.addColorStop(1, `hsl(${(h + 60) % 360} 50% 18%)`);
    ctx.fillStyle = cg;
    ctx.fillRect(cx, cy, size, size);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = font(800, 220);
    ctx.fillText(
      champ.title
        .split(/\s+/)
        .slice(0, 2)
        .map((w) => w[0])
        .join('')
        .toUpperCase(),
      W / 2,
      cy + size / 2 + 10,
    );
  }
  ctx.restore();

  // title + artist
  let y = cy + size + 110;
  ctx.fillStyle = '#f2f2f7';
  ctx.font = font(800, 80);
  for (const line of wrap(ctx, champ.title, 940, 2)) {
    ctx.fillText(line, W / 2, y);
    y += 92;
  }
  ctx.fillStyle = '#a3a3b8';
  ctx.font = font(500, 46);
  for (const line of wrap(ctx, champ.artists.join(', ') || 'Unbekannter Interpret', 940, 2)) {
    ctx.fillText(line, W / 2, y);
    y += 58;
  }

  // podium
  const podium: Array<[string, string]> = [];
  const fin = state.rounds[state.rounds.length - 1]?.matches.find((m) => m.kind === 'final');
  if (fin?.outcome?.order && fin.songIds.length > 2) {
    fin.outcome.order.slice(1, 3).forEach((id, i) => podium.push([`${i + 2}.`, byId.get(id)?.title ?? '']));
  } else {
    if (state.runnerUp) podium.push(['2.', byId.get(state.runnerUp)?.title ?? '']);
    if (state.thirdPlace) podium.push(['3.', byId.get(state.thirdPlace)?.title ?? '']);
  }
  y += 40;
  if (podium.length) {
    const boxH = 70 + podium.length * 64;
    roundRect(ctx, 120, y, W - 240, boxH, 28);
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fill();
    ctx.textAlign = 'left';
    let py = y + 70;
    for (const [label, name] of podium) {
      ctx.fillStyle = '#c6ff3d';
      ctx.font = font(800, 36);
      ctx.fillText(label, 170, py);
      ctx.fillStyle = '#f2f2f7';
      ctx.font = font(600, 38);
      ctx.fillText(wrap(ctx, name, 640, 1)[0] ?? '', 330, py);
      py += 64;
    }
    ctx.textAlign = 'center';
    y += boxH;
  }

  // footer
  const decisions = state.validDecisions.length;
  const format = t.config.format === 'duel' ? 'Duelle' : 'Cyphers';
  ctx.fillStyle = '#a3a3b8';
  ctx.font = font(600, 36);
  ctx.fillText(`${t.draw.length} ${t.artistMode ? 'Künstler' : 'Songs'} · ${decisions} Entscheidungen · ${t.artistMode ? 'Künstler-Cypher' : format}`, W / 2, H - 170);
  ctx.fillStyle = '#6f6f86';
  ctx.font = font(500, 32);
  ctx.fillText(
    `${wrap(ctx, t.name, 760, 1)[0]} · ${new Date(t.updatedAt).toLocaleDateString('de-DE')}`,
    W / 2,
    H - 115,
  );
  return c;
}

export function ShareImageModal({ t, state, onClose }: { t: Tournament; state: TournamentState; onClose: () => void }) {
  const { toast } = useStore();
  const [url, setUrl] = useState<string | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  useEffect(() => {
    let alive = true;
    void renderShareImage(t, state).then((canvas) =>
      canvas.toBlob((b) => {
        if (!alive || !b) return;
        setBlob(b);
        setUrl(URL.createObjectURL(b));
      }, 'image/png'),
    );
    return () => {
      alive = false;
    };
  }, [t, state]);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);

  const fileName = `${safeFileName(t.name)}-gewinner.png`;
  const share = async () => {
    if (!blob) return;
    const file = new File([blob], fileName, { type: 'image/png' });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'Mein Music-Cypher-Gewinner' });
      } catch {
        /* cancelled */
      }
    } else {
      const a = document.createElement('a');
      a.href = url!;
      a.download = fileName;
      a.click();
      toast('Bild gespeichert.');
    }
  };

  return (
    <Modal
      title="Als Bild teilen"
      onClose={onClose}
      actions={
        <>
          <button className="btn ghost" onClick={onClose}>
            Schließen
          </button>
          <button className="btn primary" onClick={share} disabled={!blob}>
            {typeof navigator !== 'undefined' && 'share' in navigator ? 'Teilen / Speichern' : 'Bild speichern'}
          </button>
        </>
      }
    >
      {url ? (
        <img src={url} alt="Vorschau des Gewinner-Bildes" className="share-preview" />
      ) : (
        <p className="muted">Bild wird erstellt …</p>
      )}
      <p className="tiny faint" style={{ margin: 0 }}>
        Hochformat 1080 × 1920 – passt direkt in eine Story.
      </p>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Bracket image: every round as a column. Duels get connector lines (a real tree), cyphers are
// shown as group columns. Large tournaments can start at a later round to keep the image legible.

const MAX_PIXELS = 16_000_000; // stays below mobile Safari's canvas limit

export function defaultBracketStart(state: TournamentState): number {
  const i = state.rounds.findIndex((r) => r.entrants.length <= 32);
  if (state.rounds[0] && state.rounds[0].entrants.length <= 64) return 0;
  return Math.max(0, i);
}

export async function renderBracketImage(t: Tournament, state: TournamentState, start: number): Promise<HTMLCanvasElement> {
  const rounds = state.rounds.slice(start);
  const duel = t.config.format === 'duel';
  const font = (w: number, size: number) => `${w} ${size}px Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  const LINE = 30;
  const PAD = 12;
  const COL_W = t.artistMode ? 470 : 330;
  const GAP_X = 60;
  const TOP = 190;
  const LEFT = 50;
  const extraWinners = new Set(state.rounds.flatMap((r) => r.playoffs.flatMap((p) => p.winners)));
  const nameOf = (id: string, ri: number) => {
    const e = roundEntries(t, ri).get(id);
    if (!e) return id;
    return t.artistMode ? `${e.artists[0]} – ${e.title}` : e.title;
  };

  // geometry
  type Box = { x: number; y: number; h: number; ri: number; match: TournamentState['rounds'][number]['matches'][number] };
  const boxes: Box[][] = [];
  const boxH = (m: Box['match']) => m.songIds.length * LINE + PAD * 2;
  let height = 0;
  if (duel) {
    const first = rounds[0].matches.filter((m) => m.kind !== 'thirdPlace');
    const unit = 2 * LINE + PAD * 2 + 18;
    height = first.length * unit;
    rounds.forEach((r, c) => {
      const span = unit * 2 ** c;
      const col: Box[] = [];
      r.matches
        .filter((m) => m.kind !== 'thirdPlace')
        .forEach((m, j) => {
          const h = boxH(m);
          col.push({ x: LEFT + c * (COL_W + GAP_X), y: TOP + j * span + span / 2 - h / 2, h, ri: r.index, match: m });
        });
      const third = r.matches.find((m) => m.kind === 'thirdPlace');
      if (third) {
        const fin = col[0];
        col.push({ x: fin.x, y: fin.y + fin.h + 90, h: boxH(third), ri: r.index, match: third });
        height = Math.max(height, fin.y + fin.h + 90 + boxH(third) - TOP + 20);
      }
      boxes.push(col);
    });
  } else {
    const colHeights = rounds.map((r) => r.matches.reduce((k, m) => k + boxH(m) + 24, 0));
    height = Math.max(...colHeights, 300);
    rounds.forEach((r, c) => {
      const total = colHeights[c];
      let y = TOP + (height - total) / 2;
      const col: Box[] = [];
      for (const m of r.matches) {
        const h = boxH(m);
        col.push({ x: LEFT + c * (COL_W + GAP_X), y, h, ri: r.index, match: m });
        y += h + 24;
      }
      boxes.push(col);
    });
  }
  const W = LEFT * 2 + (rounds.length + 1) * (COL_W + GAP_X);
  const H = TOP + height + 110;
  const scale = Math.min(1, Math.sqrt(MAX_PIXELS / (W * H)), 16000 / H, 16000 / W);
  const c = document.createElement('canvas');
  c.width = Math.round(W * scale);
  c.height = Math.round(H * scale);
  const ctx = c.getContext('2d')!;
  ctx.scale(scale, scale);

  // background
  ctx.fillStyle = '#0d0d12';
  ctx.fillRect(0, 0, W, H);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.max(W, H) * 0.6);
  g.addColorStop(0, 'rgba(167,139,250,0.22)');
  g.addColorStop(1, 'rgba(167,139,250,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // header
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#c6ff3d';
  ctx.beginPath();
  ctx.arc(LEFT + 18, 62, 18, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#0d0d12';
  ctx.beginPath();
  ctx.arc(LEFT + 18, 62, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#f2f2f7';
  ctx.font = font(800, 34);
  ctx.fillText(`${t.name}`, LEFT + 50, 62);
  ctx.fillStyle = '#a3a3b8';
  ctx.font = font(500, 22);
  ctx.fillText(
    `Music Cypher · ${t.draw.length} ${t.artistMode ? 'Künstler' : 'Songs'} · ${new Date(t.updatedAt).toLocaleDateString('de-DE')}${start > 0 ? ` · ab ${rounds[0].label}` : ''}`,
    LEFT + 50,
    102,
  );
  // column titles
  rounds.forEach((r, ci) => {
    ctx.fillStyle = '#c6ff3d';
    ctx.font = font(800, 22);
    ctx.fillText(r.label, LEFT + ci * (COL_W + GAP_X), 150);
  });

  // connectors (duel tree)
  if (duel) {
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 2;
    for (let ci = 0; ci + 1 < boxes.length; ci++) {
      boxes[ci]
        .filter((b) => b.match.kind !== 'thirdPlace')
        .forEach((b, j) => {
          const target = boxes[ci + 1].filter((x) => x.match.kind !== 'thirdPlace')[Math.floor(j / 2)];
          if (!target) return;
          const x1 = b.x + COL_W;
          const y1 = b.y + b.h / 2;
          const x2 = target.x;
          const y2 = target.y + target.h / 2;
          const mx = x1 + GAP_X / 2;
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(mx, y1);
          ctx.lineTo(mx, y2);
          ctx.lineTo(x2, y2);
          ctx.stroke();
        });
    }
  }

  const fit = (text: string, max: number) => {
    if (ctx.measureText(text).width <= max) return text;
    let s = text;
    while (s.length > 1 && ctx.measureText(`${s}…`).width > max) s = s.slice(0, -1);
    return `${s}…`;
  };

  // boxes
  for (const col of boxes) {
    for (const b of col) {
      const m = b.match;
      roundRect(ctx, b.x, b.y, COL_W, b.h, 14);
      ctx.fillStyle = m.kind === 'final' ? 'rgba(198,255,61,0.10)' : '#1b1b26';
      ctx.fill();
      ctx.strokeStyle = m.kind === 'final' ? 'rgba(198,255,61,0.6)' : '#2e2e3e';
      ctx.lineWidth = 2;
      ctx.stroke();
      const order = m.outcome?.order ?? m.songIds;
      order.forEach((id, i) => {
        const y = b.y + PAD + LINE * i + LINE / 2;
        const q = m.outcome?.qualified.includes(id);
        const e = extraWinners.has(id) && !q;
        const done = m.status !== 'open';
        ctx.font = font(q ? 700 : 500, 19);
        ctx.fillStyle = !done ? '#a3a3b8' : q ? '#c6ff3d' : e ? '#a78bfa' : '#6f6f86';
        const mark = !done ? '○' : q ? '✓' : e ? '◆' : '✕';
        ctx.fillText(mark, b.x + 14, y);
        const score = m.decision?.scores?.[id];
        const right = score !== undefined ? `${Number.isInteger(score) ? score : score.toFixed(1)}` : '';
        ctx.fillStyle = !done ? '#a3a3b8' : q || e ? '#f2f2f7' : '#6f6f86';
        ctx.fillText(fit(nameOf(id, b.ri), COL_W - 44 - (right ? 44 : 0)), b.x + 40, y);
        if (right) {
          ctx.textAlign = 'right';
          ctx.fillStyle = '#a3a3b8';
          ctx.font = font(600, 17);
          ctx.fillText(right, b.x + COL_W - 14, y);
          ctx.textAlign = 'left';
        }
      });
      if (m.kind === 'bye') {
        ctx.fillStyle = '#6f6f86';
        ctx.font = font(500, 15);
        ctx.textAlign = 'right';
        ctx.fillText('Freilos', b.x + COL_W - 14, b.y + PAD + LINE / 2);
        ctx.textAlign = 'left';
      }
      if (m.kind === 'thirdPlace') {
        ctx.fillStyle = '#a3a3b8';
        ctx.font = font(700, 17);
        ctx.fillText('Spiel um Platz 3', b.x, b.y - 16);
      }
    }
  }

  // champion
  if (state.champion) {
    const last = boxes[boxes.length - 1].find((b) => b.match.kind === 'final') ?? boxes[boxes.length - 1][0];
    const x = LEFT + rounds.length * (COL_W + GAP_X);
    const y = last.y + last.h / 2;
    ctx.strokeStyle = 'rgba(198,255,61,0.6)';
    ctx.beginPath();
    ctx.moveTo(last.x + COL_W, y);
    ctx.lineTo(x, y);
    ctx.stroke();
    roundRect(ctx, x, y - 60, COL_W, 120, 18);
    ctx.fillStyle = '#c6ff3d';
    ctx.fill();
    ctx.fillStyle = '#13160a';
    ctx.font = font(800, 18);
    ctx.fillText(t.artistMode ? '🏆  CHAMPION' : '🏆  GEWINNER', x + 20, y - 28);
    ctx.font = font(800, 26);
    const champ = participantMap(t).get(state.champion);
    ctx.fillText(fit(champ?.title ?? '', COL_W - 40), x + 20, y + 6);
    ctx.font = font(500, 18);
    ctx.fillText(fit(t.artistMode ? 'Künstler-Cypher' : (champ?.artists.join(', ') ?? ''), COL_W - 40), x + 20, y + 36);
  }

  ctx.fillStyle = '#6f6f86';
  ctx.font = font(500, 18);
  ctx.fillText('✓ weiter   ◆ Zusatzplatz   ✕ ausgeschieden   Zahlen = deine Punkte', LEFT, H - 50);
  return c;
}

export function BracketImageModal({ t, state, onClose }: { t: Tournament; state: TournamentState; onClose: () => void }) {
  const { toast } = useStore();
  const [start, setStart] = useState(() => defaultBracketStart(state));
  const [url, setUrl] = useState<string | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  useEffect(() => {
    let alive = true;
    setUrl(null);
    void renderBracketImage(t, state, start).then((canvas) =>
      canvas.toBlob((b) => {
        if (!alive || !b) return;
        setBlob(b);
        setUrl(URL.createObjectURL(b));
      }, 'image/png'),
    );
    return () => {
      alive = false;
    };
  }, [t, state, start]);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  const fileName = `${safeFileName(t.name)}-turnierbaum.png`;
  const save = async () => {
    if (!blob) return;
    const file = new File([blob], fileName, { type: 'image/png' });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'Mein Music-Cypher-Turnierbaum' });
      } catch {
        /* cancelled */
      }
    } else {
      const a = document.createElement('a');
      a.href = url!;
      a.download = fileName;
      a.click();
      toast('Turnierbaum gespeichert.');
    }
  };
  return (
    <Modal
      title="Turnierbaum als Bild"
      onClose={onClose}
      actions={
        <>
          <button className="btn ghost" onClick={onClose}>
            Schließen
          </button>
          <button className="btn primary" onClick={save} disabled={!blob}>
            Teilen / Speichern
          </button>
        </>
      }
    >
      {state.rounds.length > 1 && (
        <label className="field">
          Ab welcher Runde?
          <select value={start} onChange={(e) => setStart(Number(e.target.value))}>
            {state.rounds.map((r) => (
              <option key={r.index} value={r.index}>
                {r.label} ({r.entrants.length} {t.artistMode ? 'Künstler' : 'Songs'})
              </option>
            ))}
          </select>
        </label>
      )}
      {url ? <img src={url} alt="Vorschau des Turnierbaums" className="share-preview" /> : <p className="muted">Bild wird erstellt …</p>}
      <p className="tiny faint" style={{ margin: 0 }}>
        Bei großen Turnieren wird das Bild sehr groß – starte dann bei einer späteren Runde.
      </p>
    </Modal>
  );
}
