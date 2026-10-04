import { useMemo, useState, type ReactNode } from 'react';
import { participantMap } from '../domain/participants';
import { computeState } from '../domain/engine';
import {
  songRuns,
  overallStats,
  pct,
  tournamentStats,
  type ArtistLine,
  type SongLine,
  type TournamentStats,
} from '../domain/stats';
import { computeRatings, ratingInsights, START_RATING, tournamentSurprises, type HeadToHead, type SongRating } from '../domain/rating';
import { newId } from '../domain/rng';
import { SEASON_RULES, seasonTable, type Season } from '../domain/season';
import type { Tournament } from '../domain/types';
import { SpotifyExportModal } from './ShareTools';
import { artistsOf, Cover, fmtDate, Modal } from './common';
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

      <TournamentUpsets t={t} />

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
  const { tournaments, go, seasons, saveSeason } = useStore();
  const selectedSeason = id?.startsWith('se-') ? seasons.find((x) => x.id === id) : undefined;
  const selected = id && !selectedSeason ? tournaments.find((t) => t.id === id) : undefined;
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
        <button role="tab" aria-selected={!selected && !selectedSeason} className={`btn small ${!selected && !selectedSeason ? 'primary' : ''}`} onClick={() => go({ page: 'stats' })}>
          Gesamt
        </button>
        {seasons.map((x) => (
          <button
            key={x.id}
            role="tab"
            aria-selected={selectedSeason?.id === x.id}
            className={`btn small ${selectedSeason?.id === x.id ? 'primary' : ''}`}
            onClick={() => go({ page: 'stats', id: x.id })}
          >
            🏁 {x.name}
          </button>
        ))}
        <button
          className="btn small ghost"
          onClick={() => {
            const season: Season = { id: newId('se-'), name: `Saison ${seasons.length + 1}`, createdAt: new Date().toISOString() };
            saveSeason(season);
            go({ page: 'stats', id: season.id });
          }}
        >
          + Saison
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

      {selectedSeason ? (
        <SeasonView season={selectedSeason} />
      ) : selected ? (
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
          <SurpriseSection />
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

// ---------------------------------------------------------------------------
// Underdogs, upsets, rivalries

function songCell(song: { title: string; artists: string[] } & Parameters<typeof Cover>[0]['song']) {
  return (
    <span className="cell-song">
      <Cover song={song} size={32} />
      <span>
        <strong>{song!.title}</strong>
        <span className="tiny muted"> {artistsOf(song)}</span>
      </span>
    </span>
  );
}

function SurpriseSection() {
  const { tournaments, go } = useStore();
  const insights = useMemo(() => ratingInsights(tournaments), [tournaments]);
  const surprises = useMemo(() => tournamentSurprises(tournaments, (t) => songRuns(t)), [tournaments]);
  const rivalries = useMemo(
    () =>
      [...insights.h2h.values()]
        .filter((h) => h.meetings.length >= 2)
        .sort((a, b) => b.meetings.length - a.meetings.length || Math.abs(a.winsA - a.winsB) - Math.abs(b.winsA - b.winsB))
        .slice(0, 8),
    [insights],
  );
  const [h2hOpen, setH2hOpen] = useState<HeadToHead | null>(null);
  const empty = !insights.upsets.length && !surprises.underdogs.length && !surprises.flops.length && !rivalries.length;
  return (
    <section className="card">
      <h3>Underdogs & Überraschungen</h3>
      <p className="tiny muted">
        Grundlage ist das Gesamt-Rating zum jeweiligen Zeitpunkt: Wer gewinnt gegen einen höher bewerteten Song, sorgt für eine
        Überraschung. Underdogs und gestolperte Favoriten vergleichen das Turnierergebnis mit der Rangfolge vor dem Turnier
        (nur Songs mit mindestens zwei früheren Vergleichen).
      </p>
      {empty ? (
        <p className="muted small">Noch zu wenige Turniere – nach zwei, drei Turnieren mit gleichen Songs wird es hier spannend.</p>
      ) : (
        <div className="grid-2">
          <div>
            <h4 className="subhead">🐶 Underdogs</h4>
            {surprises.underdogs.length ? (
              <ul className="plain small">
                {surprises.underdogs.slice(0, 6).map((u) => (
                  <li key={u.tournament.id + u.song.id}>
                    <button className="linkish" onClick={() => go({ page: 'result', id: u.tournament.id })}>
                      <strong>{u.song.title}</strong>
                    </button>{' '}
                    <span className="muted">
                      – vorher Platz {u.preRank} von {u.rated} ({Math.round(u.preRating)}), dann <strong style={{ color: 'var(--accent)' }}>{u.stage}</strong> ·{' '}
                      {u.tournament.name}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">Noch keine.</p>
            )}
            <h4 className="subhead">📉 Gestolperte Favoriten</h4>
            {surprises.flops.length ? (
              <ul className="plain small">
                {surprises.flops.slice(0, 6).map((u) => (
                  <li key={u.tournament.id + u.song.id}>
                    <strong>{u.song.title}</strong>{' '}
                    <span className="muted">
                      – vorher Platz {u.preRank} von {u.rated} ({Math.round(u.preRating)}), dann <strong style={{ color: 'var(--danger)' }}>{u.stage}</strong> ·{' '}
                      {u.tournament.name}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">Noch keine.</p>
            )}
          </div>
          <div>
            <h4 className="subhead">⚡ Größte Überraschungen in Begegnungen</h4>
            {insights.upsets.length ? (
              <ul className="plain small">
                {insights.upsets.slice(0, 8).map((u, i) => (
                  <li key={i}>
                    <strong>{u.winner.title}</strong> schlägt <strong>{u.loser.title}</strong>{' '}
                    <span className="muted">
                      · {Math.round(u.winnerRating)} gegen {Math.round(u.loserRating)} (+{Math.round(u.gap)}) · {u.label} · {u.tournamentName}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">Noch keine.</p>
            )}
            <h4 className="subhead">🤝 Rivalitäten</h4>
            {rivalries.length ? (
              <ul className="plain small">
                {rivalries.map((h) => (
                  <li key={h.a.id + h.b.id}>
                    <button className="linkish" onClick={() => setH2hOpen(h)}>
                      {h.a.title} <strong>{h.winsA}</strong> : <strong>{h.winsB}</strong> {h.b.title}
                    </button>
                    <span className="muted"> · {h.meetings.length}× getroffen{h.draws ? `, ${h.draws}× gleich` : ''}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">Noch keine Songs, die sich mehrfach begegnet sind.</p>
            )}
          </div>
        </div>
      )}
      {h2hOpen && <H2HModal h={h2hOpen} onClose={() => setH2hOpen(null)} />}
    </section>
  );
}

export function H2HModal({ h, onClose }: { h: HeadToHead; onClose: () => void }) {
  return (
    <Modal
      title="Head-to-Head"
      onClose={onClose}
      actions={
        <button className="btn primary" onClick={onClose}>
          Schließen
        </button>
      }
    >
      <div className="h2h-head">
        <div>{songCell(h.a)}</div>
        <div className="h2h-score">
          {h.winsA} : {h.winsB}
          {h.draws ? <span className="tiny muted"> ({h.draws}× gleich)</span> : null}
        </div>
        <div>{songCell(h.b)}</div>
      </div>
      <ul className="plain small">
        {h.meetings
          .slice()
          .reverse()
          .map((m, i) => (
            <li key={i}>
              {m.winner === null ? 'Unentschieden' : <strong>{m.winner === h.a.id ? h.a.title : h.b.title}</strong>}
              <span className="muted">
                {' '}
                · {m.label} · {m.tournamentName} · {fmtDate(m.at)}
              </span>
            </li>
          ))}
      </ul>
    </Modal>
  );
}

function TournamentUpsets({ t }: { t: Tournament }) {
  const { tournaments } = useStore();
  const upsets = useMemo(() => ratingInsights(tournaments).upsets.filter((u) => u.tournamentId === t.id), [tournaments, t.id]);
  if (!upsets.length) return null;
  return (
    <section className="card">
      <h3>⚡ Überraschungen in diesem Turnier</h3>
      <ul className="plain small">
        {upsets.slice(0, 6).map((u, i) => (
          <li key={i}>
            <strong>{u.winner.title}</strong> schlägt <strong>{u.loser.title}</strong>{' '}
            <span className="muted">
              · Rating {Math.round(u.winnerRating)} gegen {Math.round(u.loserRating)} · {u.label}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Season

function SeasonView({ season }: { season: Season }) {
  const { tournaments, saveSeason, deleteSeason, saveTournament, go, toast } = useStore();
  const table = useMemo(() => seasonTable(season.id, tournaments), [season.id, tournaments]);
  const [name, setName] = useState(season.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [add, setAdd] = useState('');
  const free = tournaments.filter((t) => !t.seasonId);
  const leader = table.songs[0];
  const podium = table.songs.slice(0, 3);
  const songRows = table.songs.filter((l) => !l.entry.id.startsWith('ar:'));
  const artistEntries = table.songs.filter((l) => l.entry.id.startsWith('ar:'));

  return (
    <div className="stack">
      <section className="card">
        <div className="row">
          <input
            type="text"
            value={name}
            aria-label="Name der Saison"
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name.trim() && name !== season.name && saveSeason({ ...season, name: name.trim() })}
            style={{ flex: 1, minWidth: 200, fontSize: '1.3rem', fontWeight: 800 }}
          />
          {season.closed ? <span className="chip">abgeschlossen</span> : <span className="chip accent">läuft</span>}
          <button className="btn small" onClick={() => saveSeason({ ...season, closed: !season.closed })}>
            {season.closed ? 'Wieder öffnen' : 'Saison abschließen'}
          </button>
          <button className="btn small ghost danger" onClick={() => setConfirmDelete(true)}>
            Löschen
          </button>
        </div>
        <p className="tiny muted" style={{ marginBottom: 0 }}>
          Punkte: {SEASON_RULES}. Es zählen nur abgeschlossene Turniere.
        </p>
      </section>

      <Tiles
        items={[
          { label: 'Turniere gewertet', value: table.finished.length, hl: true },
          { label: 'laufen noch', value: table.running.length },
          { label: 'Songs mit Punkten', value: table.songs.length },
          ...(leader ? [{ label: season.closed ? 'Saison-Champion' : 'Spitzenreiter', value: leader.entry.title }] : []),
        ]}
      />

      {podium.length > 0 && (
        <section className="card">
          <h3>{season.closed ? '🏆 Saison-Podium' : 'Aktuelle Spitze'}</h3>
          <div className="podium">
            {podium.map((l, i) => (
              <div key={l.entry.id} className={`podium-item p${i + 1}`}>
                <div className="podium-rank">{i + 1}</div>
                <Cover song={l.entry} size={64} />
                <strong>{l.entry.title}</strong>
                <span className="tiny muted">{artistsOf(l.entry)}</span>
                <span className="podium-pts">{l.points} Punkte</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="card">
        <h3>Tabelle</h3>
        {table.songs.length === 0 ? (
          <p className="muted small">Noch kein abgeschlossenes Turnier in dieser Saison.</p>
        ) : (
          <SortTable
            rows={[...songRows, ...artistEntries]}
            initial="points"
            rowKey={(l) => l.entry.id}
            limit={30}
            cols={[
              { key: 'rank', label: '#', value: (l) => table.songs.indexOf(l) + 1, num: true },
              { key: 'title', label: 'Song / Künstler', value: (l) => l.entry.title, render: (l) => songCell(l.entry) },
              { key: 'points', label: 'Punkte', value: (l) => l.points, render: (l) => <strong>{l.points}</strong>, num: true },
              { key: 'tournaments', label: 'Turniere', value: (l) => l.tournaments, num: true },
              { key: 'finals', label: 'Finals', value: (l) => l.finals, num: true },
              { key: 'titles', label: 'Siege', value: (l) => l.titles, num: true },
              {
                key: 'form',
                label: 'Form',
                value: (l) => l.form.slice(-3).reduce<number>((k, x) => k + (x ?? 0), 0),
                render: (l) => (
                  <span className="form">
                    {l.form.slice(-5).map((x, i) => (
                      <span key={i} className={x === null ? 'f-none' : x >= 10 ? 'f-top' : x >= 5 ? 'f-mid' : 'f-low'} title={x === null ? 'nicht dabei' : `${x} Punkte`}>
                        {x ?? '–'}
                      </span>
                    ))}
                  </span>
                ),
              },
            ]}
          />
        )}
      </section>

      {table.artists.length > 0 && (
        <section className="card">
          <h3>Interpreten der Saison</h3>
          <BarList
            rows={table.artists.slice(0, 10).map((a) => ({
              key: a.name,
              label: a.name,
              sub: `${a.songs} ${a.songs === 1 ? 'Song' : 'Songs'}${a.titles ? ` · ${a.titles}× Sieg` : ''}`,
              value: a.points,
              display: `${a.points} P.`,
            }))}
          />
        </section>
      )}

      <section className="card">
        <h3>Turniere dieser Saison</h3>
        <div className="tlist">
          {[...table.finished, ...table.running].map((t) => {
            const st = computeState(t);
            const champ = st.champion ? participantMap(t).get(st.champion) : undefined;
            return (
              <div className="titem" key={t.id}>
                <div className="grow">
                  <strong>{t.name}</strong>
                  <div className="small muted">
                    {champ ? `🏆 ${champ.title}` : 'läuft'} · {t.draw.length} {t.artistMode ? 'Künstler' : 'Songs'} · {fmtDate(t.createdAt)}
                  </div>
                </div>
                <button className="btn small ghost" onClick={() => go({ page: st.finished ? 'result' : 'play', id: t.id })}>
                  Öffnen
                </button>
                <button
                  className="btn small ghost danger"
                  onClick={() => {
                    saveTournament({ ...t, seasonId: undefined });
                    toast('Turnier aus der Saison genommen.');
                  }}
                >
                  Aus Saison nehmen
                </button>
              </div>
            );
          })}
          {table.finished.length + table.running.length === 0 && <p className="muted small">Noch keine Turniere. Wähle beim Turnierstart diese Saison aus oder füge ein vorhandenes hinzu.</p>}
        </div>
        {free.length > 0 && (
          <div className="row" style={{ marginTop: 12 }}>
            <select value={add} onChange={(e) => setAdd(e.target.value)} aria-label="Turnier hinzufügen" style={{ flex: 1, minWidth: 200 }}>
              <option value="">Vorhandenes Turnier hinzufügen …</option>
              {free.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({fmtDate(t.createdAt)})
                </option>
              ))}
            </select>
            <button
              className="btn small"
              disabled={!add}
              onClick={() => {
                const t = tournaments.find((x) => x.id === add);
                if (t) saveTournament({ ...t, seasonId: season.id });
                setAdd('');
              }}
            >
              Hinzufügen
            </button>
          </div>
        )}
      </section>

      {confirmDelete && (
        <Modal
          title="Saison löschen?"
          onClose={() => setConfirmDelete(false)}
          actions={
            <>
              <button className="btn ghost" onClick={() => setConfirmDelete(false)}>
                Abbrechen
              </button>
              <button
                className="btn danger"
                onClick={() => {
                  deleteSeason(season.id);
                  setConfirmDelete(false);
                  go({ page: 'stats' });
                }}
              >
                Saison löschen
              </button>
            </>
          }
        >
          <p>Die Tabelle von „{season.name}“ verschwindet. Die Turniere selbst bleiben erhalten.</p>
        </Modal>
      )}
    </div>
  );
}
