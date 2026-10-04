import { PlayerDock } from './common';
import { Home } from './Home';
import { Library } from './Library';
import { Overview } from './Overview';
import { Play } from './Play';
import { Result } from './Result';
import { CarMode } from './CarMode';
import { Setup } from './Setup';
import { StatsPage } from './Stats';
import { StoreProvider, useStore } from './store';

function Shell() {
  const { route, go, toastMsg, saveError, tournaments } = useStore();
  const tid = route.page !== 'stats' && 'id' in route ? route.id : null;
  const hasTournament = tid && tournaments.some((t) => t.id === tid);
  if (route.page === 'car') {
    return (
      <>
        <CarMode id={route.id} />
        {toastMsg && (
          <div className="toast" role="status">
            {toastMsg}
          </div>
        )}
      </>
    );
  }
  return (
    <>
      <header className="topbar">
        <button className="brand" onClick={() => go({ page: 'home' })} aria-label="Music Cypher – Startseite">
          <span className="brand-dot" aria-hidden="true" />
          Music Cypher
        </button>
        <nav aria-label="Hauptnavigation">
          <button className="btn small ghost" aria-current={route.page === 'library'} onClick={() => go({ page: 'library' })}>
            Sammlung
          </button>
          <button className="btn small ghost" aria-current={route.page === 'setup'} onClick={() => go({ page: 'setup' })}>
            Einstellungen
          </button>
          <button className="btn small ghost" aria-current={route.page === 'stats'} onClick={() => go({ page: 'stats' })}>
            Statistik
          </button>
          {hasTournament && route.page !== 'play' && (
            <button className="btn small ghost" onClick={() => go({ page: 'play', id: tid })}>
              Aktuelle Begegnung
            </button>
          )}
          {hasTournament && route.page !== 'overview' && (
            <button className="btn small ghost" onClick={() => go({ page: 'overview', id: tid })}>
              Übersicht
            </button>
          )}
        </nav>
      </header>
      <main className="main">
        {saveError && (
          <div className="notice error" role="alert" style={{ marginBottom: 16 }}>
            Speichern im Browser fehlgeschlagen ({saveError}). Exportiere eine Sicherung, damit nichts verloren geht.
          </div>
        )}
        {route.page === 'home' && <Home />}
        {route.page === 'library' && <Library />}
        {route.page === 'setup' && <Setup />}
        {route.page === 'play' && <Play id={route.id} />}
        {route.page === 'overview' && <Overview id={route.id} />}
        {route.page === 'result' && <Result id={route.id} />}
        {route.page === 'stats' && <StatsPage id={route.id} />}
      </main>
      <PlayerDock />
      {toastMsg && (
        <div className="toast" role="status">
          {toastMsg}
        </div>
      )}
    </>
  );
}

export function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}
