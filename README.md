# Music Cypher

Persönliche Musikturniere: Songs treten im **Duell** (2 Songs) oder in **Vierer-Cyphers** gegeneinander an. Du hörst, du entscheidest – am Ende steht dein Gewinner. Die App bewertet keine Musik selbst. Sie verwaltet Songs, Wiedergabe, Gruppen, Bewertungen und Qualifikation.

## Starten

```bash
npm install
npm run dev        # Entwicklung: http://localhost:5173
npm test           # Turnier- und Import-Tests (Vitest)
npm run build      # Typprüfung + statischer Build nach dist/
```

Die App ist eine reine Browser-App ohne Backend. `dist/` kann auf jedem statischen Hosting liegen (z. B. GitHub Pages, Netlify). Alles wird lokal im Browser gespeichert.

## Spotify: was geht und was nicht

Stand: Oktober 2026. Geprüft wurden die Developer Policy und der Migration Guide vom Februar 2026.

| Frage | Antwort |
| --- | --- |
| Direkte Spotify-API-Anbindung | **Nicht aktiviert.** Die Spotify Developer Policy verbietet Spiele und Quizze ausdrücklich (Abschnitt „Prohibited Applications“). Ein Turnier, in dem Songs gegeneinander antreten, fällt sehr wahrscheinlich darunter. Daran ändert auch eine Umbenennung nichts. |
| Technische Lage der API seit Feb. 2026 | Development Mode: Der App-Besitzer braucht Premium, es gibt höchstens 5 Nutzer und 1 Client-ID. `GET /playlists/{id}/items` (früher `/tracks`) liefert Inhalte nur noch für **eigene oder gemeinsam bearbeitete** Playlists. Für Preview-URLs kann man sich nicht darauf verlassen. |
| **Playlist-Import (empfohlen)** | Per **Datei**: [Exportify](https://exportify.net) exportiert jede eigene Playlist als CSV. Alternativ der offizielle Spotify-Datenexport (Konto → Datenschutz → „Deine Daten herunterladen“ → `Playlist1.json`). Beides importiert die App direkt, auch mit 170+ Songs, inklusive Spotify-Song-ID. |
| Abspielen | Songs mit Spotify-ID laufen über den **offiziellen Spotify-Embed-Player**, also Spotifys eigenes Widget. Mit Premium-Login im Desktop-Browser meist der ganze Song, sonst eine Vorschau. Die App fasst den Audiostream nie an und lädt nichts herunter. Daneben gibt es den Link „In Spotify öffnen“. |
| Eigene Audiodateien | Lassen sich pro Song oder gesammelt (Zuordnung über den Dateinamen) hinterlegen. Sie bleiben nur in diesem Browser (IndexedDB). Möglich sind ein 30-Sekunden-Ausschnitt mit wählbarem Startpunkt oder der ganze Song. |

Eine austauschbare Schnittstelle für Quellen ist vorbereitet (`src/playback/sources.ts`, `IMPORT_CONNECTORS`). Ein direkter API-Connector ist dort bewusst als deaktiviert eingetragen. Wird die App jemals öffentlich, müssen auch die Embed-Nutzungsbedingungen neu geprüft werden.

## Regeln in Kürze

- **Duell:** Bei N Songs entsteht ein Baum mit B = nächste Zweierpotenz ≥ N und B − N Freilosen. Freilose werden gleichmäßig verteilt, also nie zwei leere Plätze in einer Begegnung. Ein Song mit Freilos kommt automatisch weiter. Ohne Spiel um Platz 3 gibt es genau N − 1 echte Duelle.
- **Feste Hauptrunde** (z. B. 128): Überzählige Songs spielen sichtbare Vorrunden. Beispiel 150 Songs: 106 sind direkt gesetzt, 44 spielen 22 Duelle, danach geht es mit genau 128 weiter. Bei mehr als 2× Hauptrunde gibt es mehrere Vorrunden (300 → 256 → 128).
- **Cypher:** Möglichst viele Vierergruppen. Ein Rest von 2–3 Songs bildet eine **Sondergruppe** (weiter kommen höchstens Größe − 1), ein einzelner Rest-Song bekommt ein **Freilos**. Ab 2–4 verbleibenden Songs folgt das **Finale** mit genau einem Gewinner.
- **Bewertung:** direkte Auswahl, Rangfolge (Ziehen oder ↑↓, optional 4/3/2/1 Rangpunkte nur zur Anzeige) oder Punkte 1–10. Punkte gelten nur für die aktuelle Runde. Ein Gleichstand an einer Qualifikationsgrenze muss ausdrücklich entschieden werden.
- **Zusatzplätze:** Es gibt keine, einen je Block aus zwei vollständigen Cyphers, oder eine feste Zahl je Runde (begrenzt, damit jede Runde Songs ausscheiden lässt). Verglichen werden die Erstplatzierten hinter den direkt Qualifizierten. Mit Punkten entscheidet die Punktzahl, bei Gleichstand du selbst. Bei Rangfolge entscheidest immer du.
- **Ergebnis:** Gewinner, Finale, Weg zum Sieg. Alle anderen Songs erscheinen nur gruppiert nach der Runde, in der sie ausgeschieden sind. Erfundene exakte Plätze gibt es nicht.

## Architektur

React + TypeScript + Vite. Der Stack ist schlank, typsicher und braucht kein Backend.

```
src/domain/    Turnierlogik (unabhängig von UI, Player und Spotify)
  engine.ts    Rundenaufbau, Freilose, Gruppen, Zusatzplätze, Replay, Undo, Vorschau
  config.ts    Presets, Validierung, Beschreibung
  results.ts   Weg des Gewinners, Ausscheiden nach Runden, Export
src/library/   Import (CSV/Exportify, Spotify-Datenexport, JSON), Duplikate, Demo-Songs
src/playback/  Musikquellen, globaler Player (immer nur ein Song), Demo-Synth, Audio-Speicher
src/storage/   localStorage, Sicherung als JSON (ohne Zugangsdaten – es gibt keine)
src/ui/        Seiten: Start, Sammlung, Einstellungen, Begegnung, Übersicht, Ergebnis
```

Der Turnierstand wird nie direkt verändert. Er wird **vollständig aus Konfiguration, eingefrorenen Songs, Auslosung und der Liste bestätigter Entscheidungen berechnet** (Replay). Deshalb gilt:

- Neuladen kann nichts verlieren.
- „Rückgängig“ und „Ergebnis ändern“ entfernen Entscheidungen. Davon abhängige Zusatzplätze und spätere Runden werden automatisch neu berechnet oder verworfen.
- Doppelte Bestätigungen bleiben wirkungslos.
- Ein Zufallsseed und die konkrete Auslosung werden gespeichert, damit Paarungen stabil bleiben.
