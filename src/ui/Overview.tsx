import { useMemo, useState } from 'react';
import { computeState, reopen } from '../domain/engine';
import type { MatchState, PlayoffState, RoundState, Song } from '../domain/types';
import { Modal, Seg } from './common';
import { describeTarget, groupName } from './Play';
import { useStore } from './store';

export function Overview({ id }: { id: string }) {
  const { tournaments, go, saveTournament, toast } = useStore();
  const t = tournaments.find((x) => x.id === id);
  const state = useMemo(() => (t ? computeState(t) : null), [t]);
  const [roundIdx, setRoundIdx] = useState<number | null>(null);
  const [view, setView] = useState<'list' | 'tree'>('list');
  const [reopenId, setReopenId] = useState<string | null>(null);

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
  const ri = roundIdx ?? state.rounds.length - 1;
  const round = state.rounds[ri];
  const removedCount = reopenId ? state.validDecisions.length - reopen(t, reopenId).length : 0;

  return (
    <div className="stack">
      <div className="row">
        <div style={{ flex: 1, minWidth: 220 }}>
          <div className="small muted">{t.name}</div>
          <h1 style={{ margin: 0 }}>Turnierübersicht</h1>
        </div>
        {state.finished ? (
          <button className="btn primary" onClick={() => go({ page: 'result', id: t.id })}>
            Ergebnis ansehen
          </button>
        ) : (
          <button className="btn primary" onClick={() => go({ page: 'play', id: t.id })}>
            Weiter entscheiden
          </button>
        )}
      </div>

      {t.config.format === 'duel' && (
        <Seg
          label="Ansicht"
          value={view}
          onChange={setView}
          options={[
            { value: 'list', label: 'Rundenliste' },
            { value: 'tree', label: 'Turnierbaum' },
          ]}
        />
      )}

      {view === 'tree' && t.config.format === 'duel' ? (
        <div className="bracket" aria-label="Turnierbaum">
          {state.rounds.map((r) => (
            <div className="col" key={r.index}>
              <h3>
                {r.label}
                {r.byes > 0 && <span className="tiny faint"> · {r.byes} Freilose</span>}
              </h3>
              {r.matches
                .filter((m) => m.kind !== 'bye')
                .map((m) => (
                  <MatchBox key={m.id} round={r} match={m} songs={songs} onReopen={setReopenId} />
                ))}
            </div>
          ))}
        </div>
      ) : (
        <>
          <div className="round-tabs" role="tablist" aria-label="Runden">
            {state.rounds.map((r) => (
              <button
                key={r.index}
                role="tab"
                aria-selected={r.index === ri}
                className={`btn small ${r.index === ri ? 'primary' : ''}`}
                onClick={() => setRoundIdx(r.index)}
              >
                {r.label}
                {r.complete ? ' ✓' : ''}
              </button>
            ))}
          </div>
          {round && (
            <section className="card">
              <div className="section-title">
                <h2 style={{ margin: 0 }}>{round.label}</h2>
                <span className="muted small">{round.sublabel}</span>
                {round.complete ? <span className="chip accent">abgeschlossen</span> : <span className="chip warn">läuft</span>}
              </div>
              {round.notes.map((n) => (
                <p key={n} className="small muted" style={{ margin: '0 0 6px' }}>
                  {n}
                </p>
              ))}
              {ri === 0 && t.drawNotes.map((n) => (
                <p key={n} className="small muted" style={{ margin: '0 0 6px' }}>
                  {n}
                </p>
              ))}
              <div className="matchgrid" style={{ marginTop: 10 }}>
                {round.matches
                  .filter((m) => !(round.isPrelim && m.kind === 'bye'))
                  .map((m) => (
                    <MatchBox key={m.id} round={round} match={m} songs={songs} onReopen={setReopenId} />
                  ))}
                {round.playoffs.map((p) => (
                  <PlayoffBox key={p.id} round={round} playoff={p} songs={songs} onReopen={setReopenId} />
                ))}
              </div>
              {round.isPrelim && round.byes > 0 && (
                <details style={{ marginTop: 12 }}>
                  <summary className="small">{round.byes} direkt gesetzte Songs anzeigen</summary>
                  <p className="small muted">
                    {round.matches
                      .filter((m) => m.kind === 'bye')
                      .map((m) => songs.get(m.songIds[0])?.title)
                      .join(' · ')}
                  </p>
                </details>
              )}
            </section>
          )}
        </>
      )}

      <p className="tiny faint">
        Legende: ✓ weiter · ◆ Zusatzplatz · ✕ ausgeschieden · ○ offen. Auslosung, Freilose und Gruppen beeinflussen den Verlauf.
      </p>

      {reopenId && (
        <Modal
          title="Ergebnis ändern?"
          onClose={() => setReopenId(null)}
          actions={
            <>
              <button className="btn ghost" onClick={() => setReopenId(null)}>
                Abbrechen
              </button>
              <button
                className="btn primary"
                onClick={() => {
                  const decisions = reopen(t, reopenId);
                  saveTournament({ ...t, decisions });
                  setReopenId(null);
                  toast('Begegnung wieder geöffnet.');
                  go({ page: 'play', id: t.id });
                }}
              >
                Neu entscheiden
              </button>
            </>
          }
        >
          <p>
            <strong>{describeTarget(state, reopenId)}</strong> wird wieder geöffnet.
          </p>
          <p className="muted">
            {removedCount > 1
              ? `Insgesamt ${removedCount} Entscheidungen werden zurückgesetzt – darunter abhängige Zusatzplätze und alle späteren Runden.`
              : 'Nur diese Entscheidung wird zurückgesetzt.'}
          </p>
        </Modal>
      )}
    </div>
  );
}

function MatchBox({
  round,
  match,
  songs,
  onReopen,
}: {
  round: RoundState;
  match: MatchState;
  songs: Map<string, Song>;
  onReopen: (id: string) => void;
}) {
  const extraWinners = new Set(round.playoffs.flatMap((p) => p.winners));
  const order = match.outcome?.order ?? match.songIds;
  const scores = match.decision?.scores;
  const title =
    match.kind === 'bye'
      ? 'Freilos'
      : match.kind === 'final'
        ? 'Finale'
        : match.kind === 'thirdPlace'
          ? 'Spiel um Platz 3'
          : groupName(round, match.id);
  return (
    <div className={`mbox ${match.status === 'open' ? 'open' : ''}`}>
      <div className="mhead">
        <span>{title}</span>
        {match.kind === 'special' && <span className="chip warn">{match.advanceCount} weiter</span>}
        {match.kind === 'bye' && <span className="chip">kommt automatisch weiter</span>}
        <span className="spacer" />
        {match.status === 'done' && (
          <button className="btn small ghost" onClick={() => onReopen(match.id)} aria-label={`${title} neu entscheiden`}>
            ändern
          </button>
        )}
      </div>
      {order.map((id, i) => {
        const s = songs.get(id);
        const q = match.outcome?.qualified.includes(id);
        const e = extraWinners.has(id);
        const status = match.status === 'open' ? 'o' : q ? 'q' : e ? 'e' : 'x';
        return (
          <div className={`mline ${status === 'q' || status === 'e' ? 'q' : status === 'x' ? 'x' : ''}`} key={id}>
            <span className={`mark ${status}`} aria-label={status === 'q' ? 'weiter' : status === 'e' ? 'Zusatzplatz' : status === 'x' ? 'ausgeschieden' : 'offen'}>
              {status === 'q' ? '✓' : status === 'e' ? '◆' : status === 'x' ? '✕' : '○'}
            </span>
            {match.outcome?.order && match.status === 'done' && <span className="tiny faint">{i + 1}.</span>}
            <span className="nm">{s?.title ?? id}</span>
            {scores && <span className="tiny muted">{scores[id]} P.</span>}
          </div>
        );
      })}
    </div>
  );
}

function PlayoffBox({
  round,
  playoff,
  songs,
  onReopen,
}: {
  round: RoundState;
  playoff: PlayoffState;
  songs: Map<string, Song>;
  onReopen: (id: string) => void;
}) {
  const label = playoff.scope === 'block' ? `Zusatzplatz · ${playoff.sourceMatchIds.map((m) => groupName(round, m)).join(' + ')}` : 'Zusatzplätze der Runde';
  return (
    <div className={`mbox ${playoff.status === 'open' ? 'open' : ''}`} style={{ borderStyle: 'dashed' }}>
      <div className="mhead">
        <span>{label}</span>
        <span className="spacer" />
        {playoff.status === 'done' && (
          <button className="btn small ghost" onClick={() => onReopen(playoff.id)}>
            ändern
          </button>
        )}
      </div>
      {playoff.status === 'waiting' ? (
        <div className="small muted">Wartet, bis {playoff.scope === 'block' ? 'beide Cyphers' : 'alle Cyphers'} entschieden sind.</div>
      ) : (
        playoff.candidates.map((id) => {
          const w = playoff.winners.includes(id);
          const st = playoff.status === 'open' && !playoff.sureWinners.includes(id) ? 'o' : w ? 'e' : 'x';
          return (
            <div className={`mline ${st === 'e' ? 'q' : st === 'x' ? 'x' : ''}`} key={id}>
              <span className={`mark ${st}`}>{st === 'e' ? '◆' : st === 'x' ? '✕' : '○'}</span>
              <span className="nm">{songs.get(id)?.title}</span>
              {playoff.scores && <span className="tiny muted">{playoff.scores[id]} P.</span>}
            </div>
          );
        })
      )}
      {playoff.status === 'auto' && <div className="tiny faint">per Punktevergleich</div>}
      {playoff.status === 'done' && <div className="tiny faint">deine Entscheidung</div>}
    </div>
  );
}
