import { useMemo, useState } from 'react';
import { checkConfig, describeConfig, normalizeConfig, PRESETS } from '../domain/config';
import { makeDraw, nextPow2, previewRounds } from '../domain/engine';
import { newId, randomSeed } from '../domain/rng';
import type { Tournament, TournamentConfig } from '../domain/types';
import { playbackFor } from '../playback/sources';
import { Seg } from './common';
import { useStore } from './store';

export function Setup() {
  const { library, setupConfig, setSetupConfig, saveTournament, go, localAudio } = useStore();
  const [name, setName] = useState(() => `Turnier vom ${new Date().toLocaleDateString('de-DE')}`);
  const [starting, setStarting] = useState(false);
  const config = setupConfig;
  const set = (patch: Partial<TournamentConfig>) => setSetupConfig(normalizeConfig({ ...config, ...patch, presetId: undefined }));

  const selectedSongs = useMemo(() => {
    const ids = new Set(library.selected);
    return library.songs.filter((s) => ids.has(s.id));
  }, [library]);
  const n = selectedSongs.length;
  const check = checkConfig(config, n);
  const preview = useMemo(() => (n >= 2 && check.errors.length === 0 ? previewRounds(config, n) : []), [config, n, check.errors.length]);
  const noAudio = selectedSongs.filter((s) => playbackFor(s, localAudio).kind === 'none').length;
  const spotifyOnly = selectedSongs.filter((s) => playbackFor(s, localAudio).kind === 'spotify').length;
  const players = config.partyPlayers ?? [];
  const partyOn = config.partyPlayers !== undefined;
  const setPlayers = (list: string[] | undefined) => setSetupConfig({ ...config, partyPlayers: list });
  const isDuel = config.format === 'duel';
  const extrasPossible = !isDuel && config.evaluation !== 'select';

  const mainRoundOptions = useMemo(() => {
    const b = nextPow2(Math.max(2, n));
    const opts: Array<{ value: string; label: string }> = [{ value: 'auto', label: `Automatisch (${b} Plätze)` }];
    for (let m = b; m >= 8; m /= 2) {
      const extra = n - m;
      const desc = extra > 0 ? `${extra} Songs über Vorrunde` : extra < 0 ? `${-extra} Freilose` : 'ohne Freilose';
      opts.push({ value: String(m), label: `${m} Songs (${desc})` });
    }
    return opts;
  }, [n]);

  const start = () => {
    if (starting || check.errors.length) return;
    setStarting(true);
    const seed = randomSeed();
    const frozen = selectedSongs.map((s) => ({ ...s }));
    const { draw, notes } = makeDraw(frozen, config, seed);
    const now = new Date().toISOString();
    const t: Tournament = {
      id: newId('t-'),
      name: name.trim() || 'Music Cypher',
      createdAt: now,
      updatedAt: now,
      config: { ...config, partyPlayers: partyOn ? players.map((p) => p.trim()).filter(Boolean) : undefined },
      songs: frozen,
      seed,
      draw,
      drawNotes: notes,
      decisions: [],
      postponed: [],
      sourceInfo: library.summary.sources.join(', '),
    };
    saveTournament(t);
    go({ page: 'play', id: t.id });
  };

  if (library.songs.length === 0) {
    return (
      <div className="card">
        <h1>Turnier einrichten</h1>
        <p className="muted">Deine Sammlung ist noch leer.</p>
        <button className="btn primary" onClick={() => go({ page: 'library' })}>
          Zur Songsammlung
        </button>
      </div>
    );
  }

  return (
    <div className="stack">
      <div>
        <h1>Turnier einrichten</h1>
        <p className="muted" style={{ margin: 0 }}>
          Wähle ein Format. Feinheiten findest du unter „Erweiterte Einstellungen“.
        </p>
      </div>

      <section className="card">
        <h2>Zusammenfassung deiner Auswahl</h2>
        <div className="stat-grid">
          <div className="stat">
            <b>{library.summary.entries}</b>
            <span>importierte Einträge</span>
          </div>
          <div className="stat">
            <b>{library.summary.duplicates}</b>
            <span>Duplikate zusammengeführt</span>
          </div>
          <div className="stat">
            <b>{library.summary.unsupported.length}</b>
            <span>nicht unterstützt</span>
          </div>
          <div className="stat hl">
            <b>{n}</b>
            <span>Songs ausgewählt</span>
          </div>
          <div className="stat">
            <b>{noAudio}</b>
            <span>ohne Wiedergabe</span>
          </div>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn small ghost" onClick={() => go({ page: 'library' })}>
            ← Auswahl ändern
          </button>
        </div>
      </section>

      <section className="card">
        <h2>Format</h2>
        <div className="presets" role="group" aria-label="Vorlagen">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              className="preset"
              aria-pressed={config.presetId === p.id}
              onClick={() => setSetupConfig({ ...p.config, avoidSameArtist: config.avoidSameArtist, drawMode: config.drawMode, blindMode: config.blindMode, partyPlayers: config.partyPlayers })}
            >
              <span className="pname">
                {config.presetId === p.id && <span aria-hidden="true">✓</span>}
                {p.name}
              </span>
              <span className="pdesc">{p.description}</span>
            </button>
          ))}
        </div>

        <div className="grid-2" style={{ marginTop: 20 }}>
          <div className="opt-group">
            <span className="label">Begegnung</span>
            <Seg
              label="Begegnungsformat"
              value={config.format}
              onChange={(v) => set({ format: v })}
              options={[
                { value: 'duel', label: 'Duell (2 Songs)' },
                { value: 'cypher', label: 'Cypher (4 Songs)' },
              ]}
            />
          </div>
          {!isDuel && (
            <div className="opt-group">
              <span className="label">Bewertung</span>
              <Seg
                label="Bewertung"
                value={config.evaluation}
                onChange={(v) => set({ evaluation: v })}
                options={[
                  { value: 'select', label: 'Direkt wählen' },
                  { value: 'rank', label: 'Rangfolge' },
                  { value: 'score', label: 'Punkte 1–10' },
                ]}
              />
            </div>
          )}
          {!isDuel && (
            <div className="opt-group">
              <span className="label">Weiter pro Cypher</span>
              <Seg
                label="Weiterkommende pro Cypher"
                value={config.advancePerGroup}
                onChange={(v) => set({ advancePerGroup: v })}
                options={[
                  { value: 1, label: '1 Song' },
                  { value: 2, label: '2 Songs' },
                  { value: 3, label: '3 Songs' },
                ]}
              />
            </div>
          )}
          {extrasPossible && (
            <div className="opt-group">
              <span className="label">Zusatzplätze</span>
              <Seg
                label="Zusatzplätze"
                value={config.extraMode}
                onChange={(v) => set({ extraMode: v })}
                options={[
                  { value: 'none', label: 'Keine' },
                  { value: 'perBlock', label: '1 je 2 Cyphers' },
                  { value: 'perRound', label: 'Fest je Runde' },
                ]}
              />
              {config.extraMode === 'perRound' && (
                <label className="row small">
                  Anzahl je Runde
                  <input
                    type="number"
                    min={1}
                    max={64}
                    value={config.extraPerRound}
                    onChange={(e) => set({ extraPerRound: Math.max(1, Math.min(64, Number(e.target.value) || 1)) })}
                    style={{ width: 90 }}
                  />
                </label>
              )}
              <span className="tiny muted">
                {config.extraMode === 'perBlock'
                  ? `Zwei Cyphers bilden einen Block. Die beiden ${config.advancePerGroup + 1}.-Platzierten werden verglichen, der bessere kommt zusätzlich weiter.`
                  : config.extraMode === 'perRound'
                    ? `Erst wenn alle Cyphers der Runde fertig sind, werden alle ${config.advancePerGroup + 1}.-Platzierten verglichen.`
                    : 'Nur die direkt Qualifizierten kommen weiter.'}
              </span>
            </div>
          )}
          {!isDuel && config.evaluation === 'select' && (
            <p className="tiny muted" style={{ alignSelf: 'end' }}>
              Zusatzplätze gibt es nur mit Rangfolge oder Punkten – sonst wäre unklar, wer Dritter wurde.
            </p>
          )}
        </div>
      </section>

      <details className="advanced">
        <summary>Erweiterte Einstellungen</summary>
        <div className="grid-2">
          <div className="opt-group">
            <span className="label">Auslosung</span>
            <Seg
              label="Auslosung"
              value={config.drawMode}
              onChange={(v) => set({ drawMode: v })}
              options={[
                { value: 'random', label: 'Zufällig' },
                { value: 'original', label: 'Reihenfolge der Sammlung' },
              ]}
            />
            <span className="tiny muted">
              {config.drawMode === 'random'
                ? 'Wird beim Start einmal ausgelost und gespeichert – Neuladen ändert nichts.'
                : 'Die ursprüngliche Reihenfolge dient als Setzliste: Freilose gehen an die ersten Songs.'}
            </span>
          </div>
          <label className="check">
            <input type="checkbox" checked={config.avoidSameArtist} onChange={(e) => set({ avoidSameArtist: e.target.checked })} />
            <span>
              Gleiche Interpreten in Runde 1 trennen
              <span className="tiny muted">Wird wenn möglich eingehalten; sonst erklärt die App, warum nicht.</span>
            </span>
          </label>
          {!isDuel && (
            <label className="check">
              <input type="checkbox" checked={config.reshufflePerRound} onChange={(e) => set({ reshufflePerRound: e.target.checked })} />
              <span>
                Jede Runde neu auslosen
                <span className="tiny muted">Standard: Der Turnieraufbau bleibt stabil. Neue Auslosungen werden gespeichert.</span>
              </span>
            </label>
          )}
          {!isDuel && config.evaluation === 'rank' && (
            <label className="check">
              <input type="checkbox" checked={config.showRankPoints} onChange={(e) => set({ showRankPoints: e.target.checked })} />
              <span>
                Rangpunkte anzeigen (4/3/2/1)
                <span className="tiny muted">Nur zur Anzeige – kein Vergleich zwischen Gruppen.</span>
              </span>
            </label>
          )}
          {isDuel && (
            <div className="opt-group">
              <span className="label">Hauptrunde</span>
              <select
                value={String(config.duelMainRound)}
                onChange={(e) => set({ duelMainRound: e.target.value === 'auto' ? 'auto' : Number(e.target.value) })}
                aria-label="Hauptrunde"
              >
                {mainRoundOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <span className="tiny muted">
                Mehr Songs als Plätze? Dann spielen die zusätzlichen Songs eine Vorrunde – niemand fliegt ohne Entscheidung raus.
              </span>
            </div>
          )}
          {isDuel && (
            <label className="check">
              <input type="checkbox" checked={config.thirdPlaceMatch} onChange={(e) => set({ thirdPlaceMatch: e.target.checked })} />
              <span>
                Spiel um Platz 3
                <span className="tiny muted">Die beiden Halbfinal-Verlierer treten noch einmal an.</span>
              </span>
            </label>
          )}
        </div>
      </details>

      <section className="card">
        <h2>Spielmodus</h2>
        <div className="grid-2">
          <div className="stack" style={{ gap: 8 }}>
            <label className="check">
              <input type="checkbox" checked={!!config.blindMode} onChange={(e) => setSetupConfig({ ...config, blindMode: e.target.checked })} />
              <span>
                <strong>Blind-Modus</strong>
                <span className="tiny muted">Titel, Interpret und Cover bleiben verdeckt, bis du entschieden hast. Nur der Klang zählt.</span>
              </span>
            </label>
            {config.blindMode && spotifyOnly > 0 && (
              <div className="notice warn small">
                {spotifyOnly} Songs laufen über den Spotify-Player – der zeigt Titel und Cover selbst an. Wirklich blind
                funktioniert es mit eigenen Audiodateien und den Demo-Songs.
              </div>
            )}
          </div>
          <div className="stack" style={{ gap: 8 }}>
            <label className="check">
              <input
                type="checkbox"
                checked={partyOn}
                onChange={(e) => setPlayers(e.target.checked ? (players.length ? players : ['', '']) : undefined)}
              />
              <span>
                <strong>Partymodus</strong>
                <span className="tiny muted">Mehrere stimmen nacheinander am selben Gerät ab, die Gruppe entscheidet.</span>
              </span>
            </label>
            {partyOn && (
              <div className="stack" style={{ gap: 6 }}>
                {players.map((p, i) => (
                  <div className="row" key={i} style={{ gap: 6, flexWrap: 'nowrap' }}>
                    <input
                      type="text"
                      value={p}
                      placeholder={`Name ${i + 1}`}
                      aria-label={`Name Person ${i + 1}`}
                      maxLength={24}
                      onChange={(e) => setPlayers(players.map((x, j) => (j === i ? e.target.value : x)))}
                    />
                    <button
                      className="btn icon small ghost"
                      onClick={() => setPlayers(players.filter((_, j) => j !== i))}
                      disabled={players.length <= 2}
                      aria-label={`Person ${i + 1} entfernen`}
                    >
                      ✕
                    </button>
                  </div>
                ))}
                {players.length < 8 && (
                  <button className="btn small" onClick={() => setPlayers([...players, ''])}>
                    + Person
                  </button>
                )}
                <span className="tiny muted">
                  {config.format === 'duel' || config.evaluation === 'select'
                    ? 'Jede Person wählt – die meisten Stimmen gewinnen.'
                    : config.evaluation === 'rank'
                      ? 'Jede Person sortiert – Platzpunkte werden addiert.'
                      : 'Jede Person vergibt Punkte – der Durchschnitt zählt.'}{' '}
                  Bei Gleichstand an der Grenze entscheidet ihr gemeinsam.
                </span>
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="card">
        <h2>So läuft dein Turnier ab</h2>
        <ul className="small muted" style={{ marginTop: 0 }}>
          {describeConfig(config).map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
        {check.errors.map((e) => (
          <div key={e} className="notice error" role="alert" style={{ marginBottom: 10 }}>
            {e}
          </div>
        ))}
        {check.warnings.map((w) => (
          <div key={w} className="notice warn" style={{ marginBottom: 10 }}>
            {w}
          </div>
        ))}
        {preview.length > 0 && (
          <ol className="preview-list" aria-label="Runden-Vorschau">
            {preview.map((r, i) => (
              <li key={i}>
                <span className="num">{r.songs}</span>
                <div>
                  <strong>{r.label}</strong> <span className="muted small">· {r.sublabel}</span>
                  {r.extraSpots > 0 && <div className="small" style={{ color: 'var(--violet)' }}>+ {r.extraSpots} Zusatzplatz/-plätze</div>}
                  {r.notes.map((note) => (
                    <div key={note} className="tiny muted">
                      {note}
                    </div>
                  ))}
                </div>
              </li>
            ))}
            <li>
              <span className="num">1</span>
              <div>
                <strong>Dein Gewinner</strong>
              </div>
            </li>
          </ol>
        )}
        <p className="tiny faint" style={{ marginTop: 12 }}>
          Auslosung, Freilose und Gruppen beeinflussen den Verlauf. Das Ergebnis zeigt deinen persönlichen Gewinner – keine
          objektive Rangliste.
        </p>
      </section>

      <section className="card">
        <div className="row">
          <label className="field" style={{ flex: 1, minWidth: 220 }}>
            Name des Turniers
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <button className="btn primary big" onClick={start} disabled={starting || check.errors.length > 0} style={{ alignSelf: 'flex-end' }}>
            Turnier starten
          </button>
        </div>
        <p className="tiny faint" style={{ marginBottom: 0 }}>
          Beim Start wird die Auswahl eingefroren: Spätere Änderungen an der Sammlung verändern dieses Turnier nicht.
        </p>
      </section>
    </div>
  );
}
