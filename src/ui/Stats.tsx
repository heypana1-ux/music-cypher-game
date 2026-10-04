import { useMemo, useState, type ReactNode } from 'react';
import { participantMap } from '../domain/participants';
import { computeState } from '../domain/engine';
import {
  overallStats,
  pct,
  tournamentStats,
  type ArtistLine,
  type SongLine,
  type TournamentStats,
} from '../domain/stats';
import { computeRatings, START_RATING, type SongRating } from '../domain/rating';
import type { Tournament } from '../domain/types';
import { SpotifyExportModal } from './ShareTools';
import { artistsOf, Cover, fmtDate } from './common';
import { useStore } from './store';

const fmt1 = (x: number | null) => (x === null ? '–' : x.toFixed(1).replace('.', ','));

// ---------------------------------------------------------------------------
// Building blocks

export function Tiles({ items }: { items: Array<{ label: string; value: ReactNode; hl?: boolean }> }) {
  return (
    <div className="stat-grid">
      {items.map((i) => (
        <div key={i.label} className={`stat ${i.hl ? 'hl' : ''}`}>
          <b>{i.value}</b>
          <span>{i.label}</span>
        </div>
      ))}
    </div>
  );
}

/** Horizontal single-series bars with the value written next to each bar. */
export function BarList({
  rows,
  max,
  empty = 'Noch keine Daten.',
}: {
  rows: Array<{ key: string; label: ReactNode; sub?: ReactNode; value: number; display: string }>;
  max?: number;
  empty?: string;
}) {
  if (!rows.length) return <p className="muted small">{empty}</p>;
  const m = max ?? Math.max(...rows.map((r) => r.value), 1);
  return (
    <ol className="barlist">
      {rows.map((r) => (
        <li key={r.key} title={`${typeof r.label === 'string' ? r.label : ''}: ${r.display}`}>
          <div className="bl-text">
            <span className="bl-label">{r.label}</span>
            {r.sub && <span className="bl-sub">{r.sub}</span>}
          </div>
          <div className="bl-track" aria-hidden="true">
            <div className="bl-bar" style={{ width: `${Math.max(2, (r.value / m) * 100)}%` }} />
          </div>
          <span className="bl-val">{r.display}</span>
        </li>
      ))}
    </ol>
  );
}

/** Vertical histogram for scores 1–10. */
function Histogram({ counts }: { counts: number[] }) {
  const max = Math.max(...counts, 1);
  const total = counts.reduce((a, b) => a + b, 0);
  return (
    <div className="histo" role="img" aria-label={`Verteilung deiner Punkte: ${counts.map((c, i) => `${i + 1} Punkte ${c}-mal`).join(', ')}`}>
      {counts.map((c, i) => (
        <div key={i} className="histo-col" title={`${i + 1} Punkte: ${c}× (${pct(total ? c / total : 0)})`}>
          <span className="histo-n">{c || ''}</span>
          <div className="histo-bar" style={{ height: `${(c / max) * 100}%` }} />
          <span className="histo-x">{i + 1}</span>
        </div>
      ))}
    </div>
  );
}

interface Col<T> {
  key: string;
  label: string;
  value: (r: T) => number | string | null;
  render?: (r: T) => ReactNode;
  num?: boolean;
}

function SortTable<T>({ rows, cols, initial, rowKey, limit = 25 }: { rows: T[]; cols: Col<T>[]; initial: string; rowKey: (r: T) => string; limit?: number }) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: initial, dir: -1 });
  const [all, setAll] = useState(false);
  const col = cols.find((c) => c.key === sort.key) ?? cols[0];
  const sorted = useMemo(() => {
    const coll = new Intl.Collator('de');
    return rows.slice().sort((a, b) => {
      const va = col.value(a);
      const vb = col.value(b);
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      const d = typeof va === 'number' && typeof vb === 'number' ? va - vb : coll.compare(String(va), String(vb));
      return d * sort.dir;
    });
  }, [rows, col, sort.dir]);
  const shown = all ? sorted : sorted.slice(0, limit);
  return (
    <div>
      <div className="table-wrap">
        <table className="stats-table">
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c.key} className={c.num ? 'num' : ''} aria-sort={sort.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
                  <button
                    onClick={() => setSort((s) => ({ key: c.key, dir: s.key === c.key ? (s.dir === 1 ? -1 : 1) : c.num ? -1 : 1 }))}
                  >
                    {c.label}
                    {sort.key === c.key ? (sort.dir === -1 ? ' ↓' : ' ↑') : ''}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={rowKey(r)}>
                {cols.map((c) => (
                  <td key={c.key} className={c.num ? 'num' : ''}>
                    {c.render ? c.render(r) : (c.value(r) ?? '–')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sorted.length > limit && (
        <button className="btn small ghost" onClick={() => setAll((v) => !v)} style={{ marginTop: 8 }}>
          {all ? 'Weniger anzeigen' : `Alle ${sorted.length} anzeigen`}
        </button>
      )}
    </div>
  );
}

function artistCols(running: boolean, overall: boolean): Col<ArtistLine>[] {
  const cols: Col<ArtistLine>[] = [
    { key: 'name', label: 'Interpret', value: (a) => a.name, render: (a) => <strong>{a.name}</strong> },
    { key: 'songs', label: 'Songs', value: (a) => a.songs, num: true },
  ];
  if (overall) cols.push({ key: 'tournaments', label: 'Turniere', value: (a) => a.tournaments, num: true });
  if (running) cols.push({ key: 'alive', label: 'Noch dabei', value: (a) => a.alive, num: true });
  cols.push(
    { key: 'encounters', label: 'Begegnungen', value: (a) => a.encounters, num: true },
    { key: 'winRate', label: 'Weiter-Quote', value: (a) => a.winRate, render: (a) => pct(a.winRate), num: true },
    { key: 'avgProgress', label: 'Ø erreicht', value: (a) => a.avgProgress, render: (a) => pct(a.avgProgress), num: true },
    { key: 'avgScore', label: 'Ø Punkte', value: (a) => a.avgScore, render: (a) => fmt1(a.avgScore), num: true },
    { key: 'finals', label: 'Finals', value: (a) => a.finals, num: true },
    { key: 'titles', label: 'Siege', value: (a) => a.titles, num: true },
    { key: 'best', label: 'Bestes Ergebnis', value: (a) => a.bestStage },
  );
  return cols;
}

function songCols(overall: boolean): Col<SongLine>[] {
  const cols: Col<SongLine>[] = [
    {
      key: 'title',
      label: 'Song',
      value: (s) => s.song.title,
      render: (s) => (
        <span className="cell-song">
          <Cover song={s.song} size={28} />
          <span>
            <strong>{s.song.title}</strong>
            <span className="tiny muted"> {artistsOf(s.song)}</span>
          </span>
        </span>
      ),
    },
  ];
  if (overall) cols.push({ key: 'appearances', label: 'Turniere', value: (s) => s.appearances, num: true });
  cols.push(
    { key: 'encounters', label: 'Begegnungen', value: (s) => s.encounters, num: true },
    { key: 'winRate', label: 'Weiter-Quote', value: (s) => s.winRate, render: (s) => pct(s.winRate), num: true },
    { key: 'avgScore', label: 'Ø Punkte', value: (s) => s.avgScore, render: (s) => fmt1(s.avgScore), num: true },
    { key: 'avgProgress', label: 'Ø erreicht', value: (s) => s.avgProgress, render: (s) => pct(s.avgProgress), num: true },
  );
  if (overall) cols.push({ key: 'titles', label: 'Siege', value: (s) => s.titles, num: true });
  cols.push({ key: 'stage', label: overall ? 'Bestes Ergebnis' : 'Stand', value: (s) => s.stage });
  return cols;
}

// ---------------------------------------------------------------------------
// Per tournament

export function TournamentStatsView({ t, compact = false }: { t: Tournament; compact?: boolean }) {
  const state = useMemo(() => computeState(t), [t]);
  const st: TournamentStats = useMemo(() => tournamentStats(t, state), [t, state]);
  const byId = participantMap(t);
  const title = (id: string) => byId.get(id)?.title ?? id;
  const topArtists = st.artists
    .filter((a) => a.songs >= 1)
    .slice()
    .sort((a, b) => b.advances - a.advances || b.songs - a.songs)
    .slice(0, 8);

  return (
    <div className="stack">
      <Tiles
        items={[
          { label: state.finished ? 'abgeschlossen' : 'Fortschritt', value: pct(st.progress), hl: true },
          ...(state.finished ? [] : [{ label: 'Songs noch dabei', value: st.alive }]),
          { label: 'Entscheidungen', value: st.decisions },
          { label: 'Begegnungen', value: st.encountersDone },
          { label: 'Runden', value: st.rounds },
          { label: 'Freilose', value: st.byes },
          ...(st.extraSpots ? [{ label: 'Zusatzplätze', value: st.extraSpots }] : []),
          ...(st.minutes !== null ? [{ label: 'aktive Zeit', value: st.minutes < 1 ? '< 1 min' : `${Math.round(st.minutes)} min` }] : []),
          ...(st.secondsPerDecision !== null ? [{ label: 'Ø pro Entscheidung', value: `${Math.round(st.secondsPerDecision)} s` }] : []),
          ...(st.avgScore !== null ? [{ label: 'Ø vergebene Punkte', value: fmt1(st.avgScore) }] : []),
        ]}
      />

      <div className="grid-2">
        <section className="card">
          <h3>Interpreten mit den meisten Siegen in Begegnungen</h3>
          <BarList
            rows={topArtists.map((a) => ({
              key: a.key,
              label: a.name,
              sub: `${a.songs} ${a.songs === 1 ? 'Song' : 'Songs'}${state.finished ? '' : ` · ${a.alive} noch dabei`}`,
              value: a.advances,
              display: `${a.advances}× weiter`,
            }))}
            empty="Noch keine Entscheidungen."
          />
        </section>
        {st.scoreHistogram ? (
          <section className="card">
            <h3>Deine Punkteverteilung</h3>
            <Histogram counts={st.scoreHistogram} />
            <p className="tiny muted" style={{ marginBottom: 0 }}>
              Ø {fmt1(st.avgScore)} Punkte · {st.tiesDecided} Gleichstände selbst entschieden
            </p>
          </section>
        ) : (
          <section className="card">
            <h3>Wer am weitesten kam</h3>
            <BarList
              rows={st.songsTable
                .slice()
                .sort((a, b) => b.advances - a.advances)
                .slice(0, 8)
                .map((s) => ({
                  key: s.song.id,
                  label: s.song.title,
                  sub: artistsOf(s.song),
                  value: s.advances,
                  display: `${s.advances} ${s.advances === 1 ? 'Runde' : 'Runden'}`,
                }))}
            />
          </section>
        )}
      </div>

      {st.party && (
        <section className="card">
          <h3>Partymodus: Wer liegt am häufigsten mit der Gruppe?</h3>
          <BarList
            max={1}
            rows={st.party
              .slice()
              .sort((a, b) => (b.agreement ?? -1) - (a.agreement ?? -1))
              .map((p) => ({
                key: p.player,
                label: p.player,
                sub: `${p.votes} ${p.votes === 1 ? 'Stimme' : 'Stimmen'}`,
                value: p.agreement ?? 0,
                display: pct(p.agreement),
              }))}
          />
          <p className="tiny muted" style={{ marginBottom: 0 }}>
            Anteil der eigenen Favoriten, die am Ende auch per Gruppenentscheid weiterkamen.
          </p>
        </section>
      )}

      {(st.closeCalls.length > 0 || st.topScores.length > 0) && (
        <div className="grid-2">
          {st.topScores.length > 0 && (
            <section className="card">
              <h3>Höchste Bewertungen</h3>
              <ul className="plain">
                {st.topScores.map((x, i) => (
                  <li key={i}>
                    <strong>{x.value} P.</strong> {title(x.songId)} <span className="muted small">· {x.round}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {st.closeCalls.length > 0 && (
            <section className="card">
              <h3>Knappste Entscheidungen</h3>
              <ul className="plain">
                {st.closeCalls.map((c, i) => (
                  <li key={i}>
                    <strong>{title(c.winner)}</strong> vor {title(c.loser)}{' '}
                    <span className="muted small">
                      · {c.tie ? 'Punktgleich, von dir entschieden' : `${c.gap} ${c.gap === 1 ? 'Punkt' : 'Punkte'} Unterschied`} · {c.label}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}

      {!compact && (
        <>
          <section className="card">
            <h3>Interpreten</h3>
            <SortTable rows={st.artists} cols={artistCols(!state.finished, false)} initial="encounters" rowKey={(a) => a.key} />
          </section>
          <section className="card">
            <h3>Songs</h3>
            <SortTable rows={st.songsTable} cols={songCols(false)} initial="encounters" rowKey={(s) => s.song.id} />
          </section>
        </>
      )}
      <p className="tiny faint">
        „Weiter-Quote“: Anteil der Begegnungen, aus denen ein Song weitergekommen ist. „Ø erreicht“: Anteil der überstandenen
        Runden (Sieger = 100 %). Freilose zählen nicht als Begegnung.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page

type Metric = 'titles' | 'winRate' | 'avgProgress' | 'songs';

export function StatsPage({ id }: { id?: string }) {
  const { tournaments, go } = useStore();
  const selected = id ? tournaments.find((t) => t.id === id) : undefined;
  const o = useMemo(() => overallStats(tournaments), [tournaments]);
  const [metric, setMetric] = useState<Metric>('winRate');
  const [minEnc, setMinEnc] = useState(3);
  const ratings = useMemo(() => computeRatings(tournaments), [tournaments]);
  const [exportRatings, setExportRatings] = useState(false);

  const artistRows = useMemo(() => {
    const list = o.artists.filter((a) => (metric === 'winRate' || metric === 'avgProgress' ? a.encounters >= minEnc : true));
    const val = (a: ArtistLine) =>
      metric === 'titles' ? a.titles + a.finals / 100 : metric === 'songs' ? a.songs : metric === 'winRate' ? (a.winRate ?? 0) : (a.avgProgress ?? -1);
    return list
      .filter((a) => metric !== 'avgProgress' || a.avgProgress !== null)
      .sort((a, b) => val(b) - val(a) || b.encounters - a.encounters)
      .slice(0, 10)
      .map((a) => ({
        key: a.key,
        label: a.name,
        sub: `${a.songs} Songs · ${a.tournaments} ${a.tournaments === 1 ? 'Turnier' : 'Turniere'} · ${a.encounters} Begegnungen`,
        value: metric === 'titles' ? a.titles : metric === 'songs' ? a.songs : metric === 'winRate' ? (a.winRate ?? 0) : (a.avgProgress ?? 0),
        display:
          metric === 'titles'
            ? `${a.titles} ${a.titles === 1 ? 'Sieg' : 'Siege'} · ${a.finals} Finals`
            : metric === 'songs'
              ? `${a.songs}`
              : pct(metric === 'winRate' ? a.winRate : a.avgProgress),
      }));
  }, [o, metric, minEnc]);

  return (
    <div className="stack">
      <div>
        <h1>Statistiken</h1>
        <p className="muted" style={{ margin: 0 }}>
          Alles aus deinen eigenen Entscheidungen – über alle Turniere oder für ein einzelnes.
        </p>
      </div>
      <div className="round-tabs" role="tablist" aria-label="Statistik-Bereich">
        <button role="tab" aria-selected={!selected} className={`btn small ${!selected ? 'primary' : ''}`} onClick={() => go({ page: 'stats' })}>
          Gesamt
        </button>
        {tournaments.map((t) => {
          const fin = computeState(t).finished;
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={selected?.id === t.id}
              className={`btn small ${selected?.id === t.id ? 'primary' : ''}`}
              onClick={() => go({ page: 'stats', id: t.id })}
            >
              {fin ? '🏆 ' : '● '}
              {t.name}
            </button>
          );
        })}
      </div>

      {selected ? (
        <>
          <div className="row">
            <h2 style={{ margin: 0 }}>{selected.name}</h2>
            <span className="muted small">
              {selected.draw.length} {selected.artistMode ? 'Künstler' : 'Songs'} · gestartet {fmtDate(selected.createdAt)}
            </span>
            <span className="spacer" />
            <button className="btn small" onClick={() => go({ page: 'overview', id: selected.id })}>
              Zur Übersicht
            </button>
          </div>
          <TournamentStatsView t={selected} />
        </>
      ) : tournaments.length === 0 ? (
        <div className="card">
          <p className="muted">Noch keine Turniere. Sobald du spielst, füllen sich hier die Statistiken.</p>
          <button className="btn primary" onClick={() => go({ page: 'library' })}>
            Turnier starten
          </button>
        </div>
      ) : (
        <>
          <Tiles
            items={[
              { label: 'Turniere', value: o.tournaments, hl: true },
              { label: 'abgeschlossen', value: o.finished },
              { label: 'laufend', value: o.running },
              { label: 'Entscheidungen', value: o.decisions },
              { label: 'verschiedene Songs', value: o.uniqueSongs },
              { label: 'Interpreten', value: o.uniqueArtists },
              { label: 'Duell / Cypher', value: `${o.formats.duel} / ${o.formats.cypher}` },
            ]}
          />

          <section className="card">
            <h3>Hall of Fame</h3>
            {o.champions.length === 0 ? (
              <p className="muted small">Noch kein Turnier abgeschlossen.</p>
            ) : (
              <ol className="hof">
                {o.champions.map((c) => (
                  <li key={c.tournament.id}>
                    <button className="hof-item" onClick={() => go({ page: 'result', id: c.tournament.id })}>
                      <Cover song={c.song} size={56} />
                      <span className="hof-text">
                        <strong>{c.song.title}</strong>
                        <span className="small muted">{artistsOf(c.song)}</span>
                        <span className="tiny faint">
                          {c.tournament.name} · {c.tournament.draw.length} {c.tournament.artistMode ? 'Künstler' : 'Songs'} · {fmtDate(c.date)}
                        </span>
                      </span>
                      <span aria-hidden="true">🏆</span>
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <RatingSection ratings={ratings} onExport={() => setExportRatings(true)} />
          {exportRatings && (
            <SpotifyExportModal
              title="Gesamt-Rating nach Spotify"
              songs={ratings.map((r) => r.song)}
              fileBase="music-cypher-rating"
              counts={[10, 25, 50]}
              onClose={() => setExportRatings(false)}
            />
          )}

          <section className="card">
            <div className="section-title">
              <h3 style={{ margin: 0 }}>Interpreten-Ranking</h3>
              <div className="seg" role="group" aria-label="Kennzahl">
                {(
                  [
                    ['winRate', 'Weiter-Quote'],
                    ['avgProgress', 'Ø erreicht'],
                    ['titles', 'Siege'],
                    ['songs', 'Songs'],
                  ] as Array<[Metric, string]>
                ).map(([k, l]) => (
                  <button key={k} aria-pressed={metric === k} onClick={() => setMetric(k)}>
                    {l}
                  </button>
                ))}
              </div>
              {(metric === 'winRate' || metric === 'avgProgress') && (
                <label className="small muted row" style={{ gap: 6 }}>
                  mind.
                  <select value={minEnc} onChange={(e) => setMinEnc(Number(e.target.value))} style={{ width: 70, minHeight: 32, padding: '2px 6px' }}>
                    {[1, 3, 5, 10].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                  Begegnungen
                </label>
              )}
            </div>
            <BarList rows={artistRows} max={metric === 'winRate' || metric === 'avgProgress' ? 1 : undefined} empty="Noch nicht genug Begegnungen für diese Ansicht." />
            {metric === 'avgProgress' && <p className="tiny faint">Nur abgeschlossene Turniere zählen für „Ø erreicht“.</p>}
          </section>

          <div className="grid-2">
            <section className="card">
              <h3>Dauerbrenner</h3>
              <p className="tiny muted">Songs, die am häufigsten mitgespielt haben.</p>
              <BarList
                rows={o.songs
                  .slice()
                  .sort((a, b) => b.appearances - a.appearances || b.advances - a.advances)
                  .slice(0, 8)
                  .map((s) => ({ key: s.song.id, label: s.song.title, sub: artistsOf(s.song), value: s.appearances, display: `${s.appearances}×` }))}
              />
            </section>
            <section className="card">
              <h3>Die stärksten Songs</h3>
              <p className="tiny muted">Ø erreichte Runden über abgeschlossene Turniere.</p>
              <BarList
                max={1}
                rows={o.songs
                  .filter((s) => s.avgProgress !== null)
                  .sort((a, b) => (b.avgProgress ?? 0) - (a.avgProgress ?? 0) || b.titles - a.titles)
                  .slice(0, 8)
                  .map((s) => ({
                    key: s.song.id,
                    label: s.song.title,
                    sub: `${artistsOf(s.song)} · ${s.appearances}× dabei`,
                    value: s.avgProgress ?? 0,
                    display: pct(s.avgProgress),
                  }))}
                empty="Noch kein Turnier abgeschlossen."
              />
            </section>
          </div>

          <section className="card">
            <h3>Alle Interpreten</h3>
            <SortTable rows={o.artists} cols={artistCols(false, true)} initial="encounters" rowKey={(a) => a.key} />
          </section>
          <section className="card">
            <h3>Alle Songs</h3>
            <SortTable rows={o.songs} cols={songCols(true)} initial="appearances" rowKey={(s) => s.song.id} />
          </section>
          <p className="tiny faint">
            Statistiken zeigen, wie deine Entscheidungen ausgefallen sind. Auslosung, Freilose und Gruppengröße beeinflussen sie –
            sie sind keine objektive Rangliste.
          </p>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overall rating

function RatingSection({ ratings, onExport }: { ratings: SongRating[]; onExport: () => void }) {
  if (!ratings.length) return null;
  const top = ratings.slice(0, 10);
  const min = Math.min(...ratings.map((r) => r.rating));
  const cols: Col<SongRating>[] = [
    { key: 'rank', label: '#', value: (r) => ratings.indexOf(r) + 1, num: true },
    {
      key: 'title',
      label: 'Song',
      value: (r) => r.song.title,
      render: (r) => (
        <span className="cell-song">
          <Cover song={r.song} size={28} />
          <span>
            <strong>{r.song.title}</strong>
            <span className="tiny muted"> {artistsOf(r.song)}</span>
          </span>
        </span>
      ),
    },
    { key: 'rating', label: 'Rating', value: (r) => r.rating, render: (r) => Math.round(r.rating), num: true },
    { key: 'peak', label: 'Bestwert', value: (r) => r.peak, render: (r) => Math.round(r.peak), num: true },
    { key: 'last', label: 'Zuletzt', value: (r) => r.lastChange, render: (r) => <Delta d={r.lastChange} />, num: true },
    { key: 'comparisons', label: 'Vergleiche', value: (r) => r.comparisons, num: true },
    { key: 'record', label: 'S / U / N', value: (r) => r.wins - r.losses, render: (r) => `${r.wins} / ${r.draws} / ${r.losses}`, num: true },
    { key: 'tournaments', label: 'Turniere', value: (r) => r.tournaments, num: true },
  ];
  return (
    <section className="card">
      <div className="section-title">
        <h3 style={{ margin: 0 }}>Gesamt-Rating</h3>
        <span className="chip violet">alle Turniere</span>
        <span className="spacer" />
        <button className="btn small" onClick={onExport}>
          Nach Spotify
        </button>
      </div>
      <p className="tiny muted">
        Wie beim Schach (Elo): Jeder Song startet mit {START_RATING}. Gewinnt er in einer Begegnung gegen einen anderen, steigt
        er – gegen starke Gegner mehr, gegen schwache weniger. So entsteht über alle Turniere deine persönliche Bestenliste,
        auch für Songs, die nie ein Turnier gewonnen haben.
      </p>
      <BarList
        rows={top.map((r, i) => ({
          key: r.song.id,
          label: `${i + 1}. ${r.song.title}`,
          sub: `${artistsOf(r.song)} · ${r.comparisons} Vergleiche`,
          value: r.rating - min + 20,
          display: `${Math.round(r.rating)}`,
        }))}
      />
      <details style={{ marginTop: 12 }}>
        <summary className="small">Komplette Rating-Tabelle ({ratings.length} Songs)</summary>
        <div style={{ marginTop: 10 }}>
          <SortTable rows={ratings} cols={cols} initial="rating" rowKey={(r) => r.song.id} />
        </div>
      </details>
    </section>
  );
}

function Delta({ d }: { d: number }) {
  const v = Math.round(d);
  if (!v) return <span className="faint">±0</span>;
  return <span style={{ color: v > 0 ? 'var(--accent)' : 'var(--danger)' }}>{v > 0 ? `▲ +${v}` : `▼ ${v}`}</span>;
}
