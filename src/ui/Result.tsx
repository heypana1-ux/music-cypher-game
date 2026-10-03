import { useMemo, useState } from 'react';
import { describeConfig } from '../domain/config';
import { computeState } from '../domain/engine';
import { eliminationGroups, resultExport, resultOrder, songLine, songPath } from '../domain/results';
import { mergeSongs } from '../library/importers';
import { backupFile, download, safeFileName } from '../storage/storage';
import { artistsOf, Cover, PlayButton } from './common';
import { groupName } from './Play';
import { ShareImageModal, SpotifyExportModal } from './ShareTools';
import { TournamentStatsView } from './Stats';

function Confetti() {
  const colors = ['var(--accent)', 'var(--violet)', '#ffffff', 'var(--warn)'];
  return (
    <div className="confetti" aria-hidden="true">
      {Array.from({ length: 36 }, (_, i) => (
        <i
          key={i}
          style={{
            left: `${(i * 37) % 100}%`,
            background: colors[i % colors.length],
            animationDelay: `${(i % 12) * 0.12}s`,
            animationDuration: `${2.4 + (i % 5) * 0.35}s`,
            transform: `rotate(${i * 29}deg)`,
          }}
        />
      ))}
    </div>
  );
}
import { useStore } from './store';

export function Result({ id }: { id: string }) {
  const { tournaments, go, updateLibrary, setSetupConfig, toast } = useStore();
  const t = tournaments.find((x) => x.id === id);
  const state = useMemo(() => (t ? computeState(t) : null), [t]);
  const [modal, setModal] = useState<'spotify' | 'image' | null>(null);

  if (!t || !state) {
    return (
      <div className="card">
        <h1>Turnier nicht gefunden</h1>
        <button className="btn" onClick={() => go({ page: 'home' })}>
          Zur Startseite
        </button>
      </div>
    );
  }
  const songs = new Map(t.songs.map((s) => [s.id, s]));
  if (!state.finished) {
    return (
      <div className="card">
        <h1>Noch kein Ergebnis</h1>
        <p className="muted">Es sind noch Entscheidungen offen.</p>
        <button className="btn primary" onClick={() => go({ page: 'play', id: t.id })}>
          Weiter entscheiden
        </button>
      </div>
    );
  }
  const champ = songs.get(state.champion!)!;
  const path = songPath(state, champ.id);
  const finalRound = state.rounds[state.rounds.length - 1];
  const fin = finalRound.matches.find((m) => m.kind === 'final');
  const finalists = fin ? fin.songIds.filter((x) => x !== champ.id) : [];
  const finalOrder = fin?.outcome?.order;
  const groups = eliminationGroups(state);

  const share = async () => {
    const lines = [
      `🏆 Mein Music-Cypher-Gewinner: ${songLine(champ)}`,
      state.runnerUp ? `🥈 Finale: ${songLine(songs.get(state.runnerUp))}` : '',
      `${t.name} · ${t.songs.length} Songs`,
      champ.spotifyTrackId ? `https://open.spotify.com/track/${champ.spotifyTrackId}` : '',
    ].filter(Boolean);
    const text = lines.join('\n');
    try {
      if (navigator.share) await navigator.share({ text });
      else {
        await navigator.clipboard.writeText(text);
        toast('Ergebnis in die Zwischenablage kopiert.');
      }
    } catch {
      /* user cancelled */
    }
  };

  const sameSelection = () => {
    updateLibrary((l) => {
      const m = mergeSongs(l.songs, t.songs);
      return { ...l, songs: m.songs, selected: t.songs.map((s) => s.id) };
    });
    setSetupConfig({ ...t.config });
    toast(`${t.songs.length} Songs aus diesem Turnier ausgewählt.`);
    go({ page: 'setup' });
  };

  return (
    <div className="stack">
      <section className="winner">
        <Confetti />
        <Cover song={champ} size={200} />
        <div className="crown">Dein Gewinner</div>
        <h1>{champ.title}</h1>
        <div className="muted" style={{ fontSize: '1.1rem' }}>
          {artistsOf(champ)}
          {champ.album ? ` · ${champ.album}` : ''}
        </div>
        <div className="row" style={{ justifyContent: 'center', marginTop: 16 }}>
          <PlayButton song={champ} />
          <button className="btn" onClick={() => setModal('image')}>
            Als Bild teilen
          </button>
          <button className="btn" onClick={() => setModal('spotify')}>
            Nach Spotify
          </button>
          <button className="btn ghost" onClick={share}>
            Text teilen
          </button>
        </div>
        <p className="tiny faint" style={{ marginTop: 16, marginBottom: 0 }}>
          {t.name} · {t.songs.length} Songs · Ergebnis deiner persönlichen Entscheidungen
        </p>
      </section>

      <div className="grid-2">
        <section className="card">
          <h2>Finale</h2>
          {finalOrder && finalists.length > 1 ? (
            <ol className="path">
              {finalOrder.map((sid, i) => (
                <li key={sid}>
                  <strong>{i + 1}.</strong> {songLine(songs.get(sid))}
                  {fin?.decision?.scores && <span className="muted small"> · {fin.decision.scores[sid]} P.</span>}
                </li>
              ))}
            </ol>
          ) : (
            <div className="stack" style={{ gap: 8 }}>
              {state.runnerUp && (
                <div>
                  <span className="chip">Finalist</span> {songLine(songs.get(state.runnerUp))}
                </div>
              )}
              {!state.runnerUp &&
                finalists.map((sid) => (
                  <div key={sid}>
                    <span className="chip">Finalist</span> {songLine(songs.get(sid))}
                  </div>
                ))}
              {state.thirdPlace && (
                <div>
                  <span className="chip">Platz 3</span> {songLine(songs.get(state.thirdPlace))}
                </div>
              )}
            </div>
          )}
          {finalOrder && finalists.length > 1 && <p className="tiny faint">Rangfolge im Finale – von dir festgelegt.</p>}
        </section>

        <section className="card">
          <h2>Weg zum Sieg</h2>
          <ol className="path">
            {path.map((step) => {
              const m = step.match;
              const opp = m.songIds.filter((x) => x !== champ.id);
              const score = m.decision?.scores?.[champ.id];
              const place = m.outcome?.order ? m.outcome.order.indexOf(champ.id) + 1 : null;
              return (
                <li key={m.id}>
                  <strong>{step.round.label}</strong>
                  {m.kind === 'cypher' || m.kind === 'special' ? <span className="muted small"> · {groupName(step.round, m.id)}</span> : null}
                  <div className="small">
                    {step.via === 'bye'
                      ? 'Freilos – automatisch weiter'
                      : `gegen ${opp.map((o) => songs.get(o)?.title).join(', ')}`}
                  </div>
                  <div className="tiny muted">
                    {step.via === 'extra' && 'Über den Zusatzplatz weiter. '}
                    {place && `Platz ${place}. `}
                    {score !== undefined && `${score} Punkte.`}
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      </div>

      <section>
        <div className="section-title">
          <h2 style={{ margin: 0 }}>Turnier in Zahlen</h2>
          <button className="btn small ghost" onClick={() => go({ page: 'stats', id: t.id })}>
            Alle Statistiken →
          </button>
        </div>
        <TournamentStatsView t={t} compact />
      </section>

      {groups.length > 0 && (
        <section className="card">
          <h2>Wie weit die anderen kamen</h2>
          <p className="tiny faint">
            Ein K.-o.-Turnier bestimmt keine exakte Rangfolge aller Songs – deshalb nur gruppiert nach Ausscheiden.
          </p>
          {groups.map((g) => (
            <details key={g.label} style={{ marginBottom: 8 }}>
              <summary>
                <strong>{g.label}</strong> <span className="muted small">({g.songIds.length})</span>
              </summary>
              <ul className="small" style={{ marginTop: 6 }}>
                {g.songIds.map((sid) => (
                  <li key={sid}>{songLine(songs.get(sid))}</li>
                ))}
              </ul>
            </details>
          ))}
        </section>
      )}

      <section className="card">
        <h2>Regeln dieses Turniers</h2>
        <ul className="small muted">
          {describeConfig(t.config).map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
        <div className="row">
          <button className="btn" onClick={() => go({ page: 'overview', id: t.id })}>
            Alle Entscheidungen ansehen
          </button>
          <button
            className="btn"
            onClick={() =>
              download(`${safeFileName(t.name)}-ergebnis.json`, JSON.stringify(resultExport(t, state), null, 2))
            }
          >
            Ergebnis exportieren
          </button>
          <button className="btn" onClick={() => download(`${safeFileName(t.name)}-sicherung.json`, backupFile(t))}>
            Sicherung speichern
          </button>
          <button className="btn primary" onClick={sameSelection}>
            Neues Turnier mit derselben Auswahl
          </button>
        </div>
      </section>
      {modal === 'spotify' && (
        <SpotifyExportModal
          title="Ergebnis nach Spotify"
          songs={resultOrder(state).map((r) => songs.get(r.songId)!)}
          fileBase={t.name}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'image' && <ShareImageModal t={t} state={state} onClose={() => setModal(null)} />}
    </div>
  );
}
