import { useRef, useState } from 'react';
import { participantMap } from '../domain/participants';
import { seasonTable } from '../domain/season';
import { computeState } from '../domain/engine';
import { songLine } from '../domain/results';
import type { Tournament } from '../domain/types';
import { demoSongs } from '../library/demo';
import { mergeSongs } from '../library/importers';
import { parseBackup } from '../storage/storage';
import { fmtDate, Modal } from './common';
import { useInstall } from './install';
import { useStore } from './store';

export function Home() {
  const { tournaments, go, updateLibrary, library, saveTournament, deleteTournament, toast, seasons } = useStore();
  const activeSeason = seasons.filter((x) => !x.closed).slice(-1)[0];
  const seasonLeader = activeSeason ? seasonTable(activeSeason.id, tournaments).songs[0] : undefined;
  const [confirmDelete, setConfirmDelete] = useState<Tournament | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const withState = tournaments.map((t) => ({ t, s: computeState(t) }));
  const running = withState.filter((x) => !x.s.finished);
  const done = withState.filter((x) => x.s.finished);

  const startDemo = () => {
    updateLibrary((l) => {
      const { songs } = mergeSongs(l.songs, demoSongs());
      const demoIds = songs.filter((s) => s.origin === 'demo').map((s) => s.id);
      return {
        ...l,
        songs,
        selected: demoIds,
        summary: {
          ...l.summary,
          entries: l.summary.entries + (l.songs.some((s) => s.origin === 'demo') ? 0 : demoIds.length),
          sources: Array.from(new Set([...l.summary.sources, 'Beispielsongs (erfunden)'])),
        },
      };
    });
    toast('24 erfundene Beispielsongs geladen und ausgewählt.');
    go({ page: 'library' });
  };

  const importBackup = async (file: File) => {
    try {
      const t = parseBackup(await file.text());
      const exists = tournaments.some((x) => x.id === t.id);
      saveTournament(t);
      toast(exists ? 'Turnier aus Sicherung wiederhergestellt (überschrieben).' : 'Turnier aus Sicherung wiederhergestellt.');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Import fehlgeschlagen.');
    }
  };

  return (
    <div className="stack">
      <section className="hero">
        <h1>Dein persönliches Musikturnier.</h1>
        <p>
          Lass Songs im Duell oder in Vierer-Cyphers gegeneinander antreten. Du hörst, du entscheidest – am Ende steht dein
          Gewinner. Keine Algorithmen, nur dein Geschmack.
        </p>
      </section>

      <InstallBanner />

      <div className="home-actions">
        <button className="action-tile primary" onClick={() => go({ page: 'library' })}>
          <strong>Neues Turnier</strong>
          <span className="muted small">
            {library.songs.length ? `${library.songs.length} Songs in deiner Sammlung` : 'Songs importieren und loslegen'}
          </span>
        </button>
        <button className="action-tile" onClick={startDemo}>
          <strong>Demo ausprobieren</strong>
          <span className="muted small">24 erfundene Beispielsongs mit Demo-Klängen</span>
        </button>
        {activeSeason && (
          <button className="action-tile" onClick={() => go({ page: 'stats', id: activeSeason.id })}>
            <strong>🏁 {activeSeason.name}</strong>
            <span className="muted small">
              {seasonLeader ? `Spitze: ${seasonLeader.entry.title} · ${seasonLeader.points} Punkte` : 'Noch kein Turnier gewertet'}
            </span>
          </button>
        )}
        {tournaments.length > 0 && (
          <button className="action-tile" onClick={() => go({ page: 'stats' })}>
            <strong>Statistiken</strong>
            <span className="muted small">
              {done.length} abgeschlossen · {running.length} laufend · Hall of Fame
            </span>
          </button>
        )}
        <button className="action-tile" onClick={() => fileRef.current?.click()}>
          <strong>Sicherung laden</strong>
          <span className="muted small">Ein exportiertes Turnier wiederherstellen</span>
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void importBackup(f);
            e.target.value = '';
          }}
        />
      </div>

      {running.length > 0 && (
        <section className="card">
          <h2>Weitermachen</h2>
          <div className="tlist">
            {running.map(({ t, s }) => {
              const r = s.rounds[s.rounds.length - 1];
              return (
                <div className="titem" key={t.id}>
                  <div className="grow">
                    <strong>{t.name}</strong>
                    <div className="small muted">
                      {t.draw.length} {t.artistMode ? 'Künstler' : 'Songs'} · {r ? `${r.label} · noch ${s.openItems.length} offen` : ''} · {fmtDate(t.updatedAt)}
                    </div>
                  </div>
                  <button className="btn primary small" onClick={() => go({ page: 'play', id: t.id })}>
                    Fortsetzen
                  </button>
                  <button className="btn small ghost" onClick={() => go({ page: 'overview', id: t.id })}>
                    Übersicht
                  </button>
                  <button className="btn small ghost danger" onClick={() => setConfirmDelete(t)} aria-label={`${t.name} löschen`}>
                    Löschen
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {done.length > 0 && (
        <section className="card">
          <h2>Abgeschlossene Turniere</h2>
          <div className="tlist">
            {done.map(({ t, s }) => (
              <div className="titem" key={t.id}>
                <div className="grow">
                  <strong>{t.name}</strong>
                  <div className="small muted">
                    🏆 {songLine(participantMap(t).get(s.champion!))} · {t.draw.length} {t.artistMode ? 'Künstler' : 'Songs'} · {fmtDate(t.updatedAt)}
                  </div>
                </div>
                <button className="btn small" onClick={() => go({ page: 'result', id: t.id })}>
                  Ergebnis
                </button>
                <button className="btn small ghost danger" onClick={() => setConfirmDelete(t)} aria-label={`${t.name} löschen`}>
                  Löschen
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="card soft small muted">
        <strong style={{ color: 'var(--text)' }}>So funktioniert’s:</strong> Sammlung importieren (z. B. deine Spotify-Playlist als
        Datei) → Songs auswählen → Format wählen → hören und entscheiden. Alles wird automatisch in diesem Browser gespeichert.
      </section>

      {confirmDelete && (
        <Modal
          title="Turnier löschen?"
          onClose={() => setConfirmDelete(null)}
          actions={
            <>
              <button className="btn ghost" onClick={() => setConfirmDelete(null)}>
                Abbrechen
              </button>
              <button
                className="btn danger"
                onClick={() => {
                  deleteTournament(confirmDelete.id);
                  setConfirmDelete(null);
                  toast('Turnier gelöscht.');
                }}
              >
                Endgültig löschen
              </button>
            </>
          }
        >
          <p>
            „{confirmDelete.name}“ und alle Entscheidungen werden aus diesem Browser entfernt. Exportiere vorher eine Sicherung,
            wenn du es behalten willst.
          </p>
        </Modal>
      )}
    </div>
  );
}

function InstallBanner() {
  const inst = useInstall();
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem('mc.installDismissed') === '1';
    } catch {
      return false;
    }
  });
  if (hidden || inst.standalone || (!inst.canPrompt && !inst.ios)) return null;
  const dismiss = () => {
    setHidden(true);
    try {
      localStorage.setItem('mc.installDismissed', '1');
    } catch {
      /* ignore */
    }
  };
  return (
    <section className="card soft install-banner">
      <img src="./icons/icon-192.png" alt="" width={48} height={48} style={{ borderRadius: 12 }} />
      <div style={{ flex: 1, minWidth: 200 }}>
        <strong>Music Cypher als App</strong>
        <div className="small muted">
          {inst.canPrompt
            ? 'Auf den Homescreen legen – startet im Vollbild und funktioniert auch offline.'
            : 'Im Safari unten auf „Teilen“ (□↑) tippen und „Zum Home-Bildschirm“ wählen.'}
        </div>
      </div>
      {inst.canPrompt && (
        <button className="btn primary" onClick={() => void inst.install()}>
          Installieren
        </button>
      )}
      <button className="btn small ghost" onClick={dismiss}>
        Nicht jetzt
      </button>
    </section>
  );
}
