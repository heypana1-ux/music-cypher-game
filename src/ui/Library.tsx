import { useMemo, useRef, useState } from 'react';
import { mulberry32, randomSeed, shuffle } from '../domain/rng';
import type { Song } from '../domain/types';
import { demoSongs } from '../library/demo';
import { ImportError, importText, listSpotifyExportPlaylists, manualSong, mergeSongs, type ImportResult } from '../library/importers';
import { deleteAudio, matchFilesToSongs, putAudio } from '../playback/audioStore';
import { player } from '../playback/player';
import { playbackFor } from '../playback/sources';
import { emptyLibrary } from '../storage/storage';
import { artistsOf, Cover, fmtDuration, Modal, PlaybackChip, PlayButton, Seg } from './common';
import { useStore } from './store';

const ORIGIN_LABEL: Record<Song['origin'], string> = {
  demo: 'Beispiel (erfunden)',
  manual: 'Manuell',
  csv: 'CSV',
  json: 'JSON',
  'spotify-export': 'Spotify-Datenexport',
  exportify: 'Exportify',
};

type SortKey = 'original' | 'title' | 'artist';

export function Library() {
  const { library, updateLibrary, go, toast, localAudio, refreshLocalAudio } = useStore();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('original');
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastReport, setLastReport] = useState<(ImportResult & { added: number; merged: number }) | null>(null);
  const [pending, setPending] = useState<{ name: string; text: string; playlists: string[] } | null>(null);
  const [playlistChoice, setPlaylistChoice] = useState<string>('all');
  const [subset, setSubset] = useState(32);
  const [showManual, setShowManual] = useState(false);
  const [showHelp, setShowHelp] = useState(library.songs.length === 0);
  const [confirmClear, setConfirmClear] = useState(false);
  const [manual, setManual] = useState({ title: '', artists: '', album: '', link: '' });
  const fileRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLInputElement>(null);
  const audioTarget = useRef<Song | null>(null);
  const bulkAudioRef = useRef<HTMLInputElement>(null);

  const selected = useMemo(() => new Set(library.selected), [library.selected]);
  const songs = library.songs;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = q
      ? songs.filter((s) => s.title.toLowerCase().includes(q) || s.artists.some((a) => a.toLowerCase().includes(q)))
      : songs.slice();
    const coll = new Intl.Collator('de');
    if (sort === 'title') list = list.sort((a, b) => coll.compare(a.title, b.title));
    else if (sort === 'artist') list = list.sort((a, b) => coll.compare(artistsOf(a), artistsOf(b)) || coll.compare(a.title, b.title));
    else list = list.sort((a, b) => a.originalIndex - b.originalIndex);
    return list;
  }, [songs, query, sort]);

  const noAudioSelected = songs.filter((s) => selected.has(s.id) && playbackFor(s, localAudio).kind === 'none').length;

  const applyImport = (res: ImportResult) => {
    updateLibrary((l) => {
      const m = mergeSongs(l.songs, res.songs);
      const newIds = m.songs.slice(l.songs.length).map((s) => s.id);
      setLastReport({ ...res, added: m.added, merged: m.merged });
      return {
        ...l,
        songs: m.songs,
        selected: Array.from(new Set([...l.selected, ...newIds])),
        summary: {
          entries: l.summary.entries + res.totalEntries,
          duplicates: l.summary.duplicates + res.duplicates.reduce((n, d) => n + d.count - 1, 0) + m.merged,
          unsupported: [...l.summary.unsupported, ...res.unsupported.map((u) => ({ label: u.label, reason: u.reason }))],
          sources: Array.from(new Set([...l.summary.sources, res.formatLabel])),
        },
      };
    });
    setError(null);
    toast(`${res.songs.length} Songs aus ${res.formatLabel} gelesen.`);
  };

  const handleFiles = async (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      try {
        const text = await file.text();
        if (file.name.toLowerCase().endsWith('.json') || text.trim().startsWith('{')) {
          let parsed: unknown = null;
          try {
            parsed = JSON.parse(text);
          } catch {
            /* reported by importText */
          }
          const pls = listSpotifyExportPlaylists(parsed);
          if (pls && pls.length > 1) {
            setPending({ name: file.name, text, playlists: pls });
            setPlaylistChoice('0');
            continue;
          }
        }
        applyImport(importText(file.name, text));
      } catch (e) {
        setError(
          e instanceof ImportError
            ? `${file.name}: ${e.message}`
            : `${file.name}: Die Datei konnte nicht gelesen werden. Unterstützt werden CSV- und JSON-Dateien.`,
        );
      }
    }
  };

  const toggle = (id: string) =>
    updateLibrary((l) => ({
      ...l,
      selected: l.selected.includes(id) ? l.selected.filter((x) => x !== id) : [...l.selected, id],
    }));

  const eligible = (s: Song) => library.allowNoAudio || playbackFor(s, localAudio).kind !== 'none';

  const selectAll = () => updateLibrary((l) => ({ ...l, selected: l.songs.filter(eligible).map((s) => s.id) }));
  const selectNone = () => updateLibrary((l) => ({ ...l, selected: [] }));
  const selectVisible = (on: boolean) =>
    updateLibrary((l) => {
      const ids = new Set(visible.filter((s) => !on || eligible(s)).map((s) => s.id));
      const sel = on ? Array.from(new Set([...l.selected, ...ids])) : l.selected.filter((id) => !ids.has(id));
      return { ...l, selected: sel };
    });
  const selectRandom = () => {
    const pool = songs.filter(eligible);
    const n = Math.min(subset, pool.length);
    const pick = shuffle(pool, mulberry32(randomSeed())).slice(0, n);
    updateLibrary((l) => ({ ...l, selected: pick.map((s) => s.id) }));
    toast(`${n} zufällige Songs ausgewählt.`);
  };

  const removeSong = (s: Song) => {
    updateLibrary((l) => ({ ...l, songs: l.songs.filter((x) => x.id !== s.id), selected: l.selected.filter((x) => x !== s.id) }));
    void deleteAudio(s.id).then(refreshLocalAudio).catch(() => undefined);
  };

  const addManual = () => {
    const next = songs.length ? Math.max(...songs.map((s) => s.originalIndex)) + 1 : 0;
    const res = manualSong(manual.title, manual.artists, manual.album, manual.link, next);
    if (typeof res === 'string') {
      setError(res);
      return;
    }
    if (songs.some((s) => s.id === res.id)) {
      setError('Dieser Song ist bereits in deiner Sammlung.');
      return;
    }
    updateLibrary((l) => ({
      ...l,
      songs: [...l.songs, res],
      selected: [...l.selected, res.id],
      summary: { ...l.summary, entries: l.summary.entries + 1, sources: Array.from(new Set([...l.summary.sources, 'Manuell'])) },
    }));
    setManual({ title: '', artists: '', album: '', link: '' });
    setError(null);
    toast(`„${res.title}“ hinzugefügt.`);
  };

  const assignAudio = async (song: Song, file: File) => {
    if (!file.type.startsWith('audio/') && !/\.(mp3|m4a|aac|wav|ogg|oga|flac|opus|webm)$/i.test(file.name)) {
      setError(`${file.name} ist keine Audiodatei.`);
      return;
    }
    try {
      await putAudio(song.id, file);
      await refreshLocalAudio();
      toast(`Audiodatei für „${song.title}“ gespeichert (nur in diesem Browser).`);
    } catch {
      setError('Die Audiodatei konnte im Browser nicht gespeichert werden (Speicher voll oder privates Fenster?).');
    }
  };

  const bulkAudio = async (files: FileList) => {
    const matches = matchFilesToSongs(Array.from(files), songs);
    for (const m of matches) {
      try {
        await putAudio(m.song.id, m.file);
      } catch {
        /* reported below */
      }
    }
    await refreshLocalAudio();
    toast(`${matches.length} von ${files.length} Dateien Songs zugeordnet (über den Dateinamen).`);
  };

  return (
    <div className="stack">
      <div className="row">
        <div>
          <h1>Songsammlung</h1>
          <p className="muted" style={{ margin: 0 }}>
            Importiere deine Playlist, füge Songs hinzu und wähle aus, wer antritt.
          </p>
        </div>
        <span className="spacer" />
        <button className="btn primary big" disabled={selected.size < 2} onClick={() => go({ page: 'setup' })}>
          Weiter: Turnier einrichten →
        </button>
      </div>

      {/* Import */}
      <section className="card">
        <div className="section-title">
          <h2>Importieren</h2>
          <button className="btn small ghost" onClick={() => setShowHelp((v) => !v)} aria-expanded={showHelp}>
            {showHelp ? 'Hilfe ausblenden' : 'Wie bekomme ich meine Spotify-Playlist hierher?'}
          </button>
        </div>
        {showHelp && <SpotifyHelp />}
        <div
          className={`dropzone ${over ? 'over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            void handleFiles(e.dataTransfer.files);
          }}
        >
          <p style={{ margin: '0 0 10px' }}>
            <strong>CSV- oder JSON-Datei hierher ziehen</strong>
            <br />
            <span className="small muted">Exportify-CSV, Spotify-Datenexport (Playlist1.json), eigene Tabellen</span>
          </p>
          <div className="row" style={{ justifyContent: 'center' }}>
            <button className="btn primary" onClick={() => fileRef.current?.click()}>
              Datei auswählen
            </button>
            <button className="btn" onClick={() => setShowManual((v) => !v)} aria-expanded={showManual}>
              Song manuell hinzufügen
            </button>
            <button
              className="btn ghost"
              onClick={() => {
                applyImport({
                  songs: demoSongs(),
                  duplicates: [],
                  unsupported: [],
                  totalEntries: 24,
                  formatLabel: 'Beispielsongs (erfunden)',
                });
              }}
            >
              Beispielsongs laden
            </button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.json,.txt,text/csv,application/json"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) void handleFiles(e.target.files);
              e.target.value = '';
            }}
          />
        </div>

        {showManual && (
          <form
            className="grid-2"
            style={{ marginTop: 16 }}
            onSubmit={(e) => {
              e.preventDefault();
              addManual();
            }}
          >
            <label className="field">
              Titel *
              <input type="text" value={manual.title} onChange={(e) => setManual({ ...manual, title: e.target.value })} required />
            </label>
            <label className="field">
              Interpret(en) <span className="tiny faint">mehrere mit ; trennen</span>
              <input type="text" value={manual.artists} onChange={(e) => setManual({ ...manual, artists: e.target.value })} />
            </label>
            <label className="field">
              Album
              <input type="text" value={manual.album} onChange={(e) => setManual({ ...manual, album: e.target.value })} />
            </label>
            <label className="field">
              Spotify-Songlink oder eigene Audio-URL
              <input
                type="url"
                inputMode="url"
                placeholder="https://open.spotify.com/track/…"
                value={manual.link}
                onChange={(e) => setManual({ ...manual, link: e.target.value })}
              />
            </label>
            <div>
              <button className="btn primary" type="submit">
                Hinzufügen
              </button>
            </div>
          </form>
        )}

        {error && (
          <div className="notice error" role="alert" style={{ marginTop: 14 }}>
            {error}
          </div>
        )}

        {lastReport && (
          <div className="notice ok" style={{ marginTop: 14 }} role="status">
            <strong>{lastReport.formatLabel}:</strong> {lastReport.totalEntries} Einträge gelesen · {lastReport.added} neu
            {lastReport.merged > 0 && ` · ${lastReport.merged} schon in der Sammlung`}
            {lastReport.duplicates.length > 0 &&
              ` · ${lastReport.duplicates.reduce((n, d) => n + d.count - 1, 0)} doppelte Einträge zusammengeführt`}
            {lastReport.unsupported.length > 0 && (
              <details style={{ marginTop: 6 }}>
                <summary>{lastReport.unsupported.length} Einträge nicht übernommen</summary>
                <ul>
                  {lastReport.unsupported.slice(0, 50).map((u, i) => (
                    <li key={i}>
                      {u.label} – <span className="muted">{u.reason}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </section>

      {/* Selection */}
      <section className="card">
        <div className="section-title">
          <h2>Auswahl</h2>
          <span className={`counter ${selected.size >= 2 ? 'ok' : ''}`} aria-live="polite">
            {selected.size} von {songs.length} Songs nehmen teil
          </span>
          {noAudioSelected > 0 && <span className="chip warn">{noAudioSelected} ohne Wiedergabe</span>}
        </div>

        {songs.length === 0 ? (
          <p className="muted">Noch keine Songs. Importiere eine Datei, füge Songs manuell hinzu oder lade die Beispielsongs.</p>
        ) : (
          <div className="stack">
            <div className="toolbar">
              <input
                type="search"
                placeholder="Nach Titel oder Interpret suchen"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Suche"
              />
              <Seg<SortKey>
                label="Sortierung"
                value={sort}
                onChange={setSort}
                options={[
                  { value: 'original', label: 'Original' },
                  { value: 'title', label: 'Titel' },
                  { value: 'artist', label: 'Interpret' },
                ]}
              />
            </div>
            <div className="toolbar">
              <button className="btn small" onClick={selectAll}>
                Alle auswählen
              </button>
              <button className="btn small" onClick={selectNone}>
                Alle abwählen
              </button>
              {query && (
                <>
                  <button className="btn small" onClick={() => selectVisible(true)}>
                    Treffer auswählen
                  </button>
                  <button className="btn small" onClick={() => selectVisible(false)}>
                    Treffer abwählen
                  </button>
                </>
              )}
              <span className="spacer" />
              <label className="row small" style={{ gap: 6 }}>
                Zufällig
                <select value={subset} onChange={(e) => setSubset(Number(e.target.value))} style={{ width: 90, minHeight: 36, padding: '4px 8px' }} aria-label="Anzahl zufälliger Songs">
                  {[8, 16, 32, 64, 128, 256].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
              <button className="btn small" onClick={selectRandom}>
                Zufällig auswählen
              </button>
            </div>
            <div className="toolbar small">
              <label className="check">
                <input
                  type="checkbox"
                  checked={library.allowNoAudio}
                  onChange={(e) => {
                    const allow = e.target.checked;
                    updateLibrary((l) => ({
                      ...l,
                      allowNoAudio: allow,
                      selected: allow ? l.selected : l.selected.filter((id) => {
                        const s = l.songs.find((x) => x.id === id);
                        return s && playbackFor(s, localAudio).kind !== 'none';
                      }),
                    }));
                  }}
                />
                <span>
                  Songs ohne Wiedergabe dürfen teilnehmen
                  <span className="tiny muted">Praktisch, wenn du die Songs ohnehin kennst.</span>
                </span>
              </label>
              <span className="spacer" />
              <button className="btn small ghost" onClick={() => bulkAudioRef.current?.click()}>
                Eigene Audiodateien zuordnen …
              </button>
              <input
                ref={bulkAudioRef}
                type="file"
                accept="audio/*"
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files) void bulkAudio(e.target.files);
                  e.target.value = '';
                }}
              />
              <button className="btn small ghost danger" onClick={() => setConfirmClear(true)}>
                Sammlung leeren
              </button>
            </div>
            <p className="tiny faint" style={{ margin: 0 }}>
              Die Sortierung ändert nur die Ansicht – nicht die Paarungen. Die Auslosung legst du in den Einstellungen fest.
            </p>

            <div className="songlist" role="list">
              {visible.map((s) => {
                const on = selected.has(s.id);
                const info = playbackFor(s, localAudio);
                return (
                  <div className={`songrow ${on ? 'on' : ''}`} key={s.id} role="listitem">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => toggle(s.id)}
                      aria-label={`${s.title} ${on ? 'abwählen' : 'auswählen'}`}
                      disabled={!on && !eligible(s)}
                    />
                    <Cover song={s} size={44} />
                    <div className="meta">
                      <div className="title">{s.title}</div>
                      <div className="sub">
                        {artistsOf(s)}
                        {s.album ? ` · ${s.album}` : ''} · {fmtDuration(s.durationMs)}
                      </div>
                    </div>
                    <div className="tags">
                      <span className="chip">{ORIGIN_LABEL[s.origin]}</span>
                      <PlaybackChip song={s} />
                    </div>
                    <PlayButton song={s} compact />
                    {localAudio.has(s.id) ? (
                      <button
                        className="btn small ghost"
                        onClick={() => {
                          if (player.get().song?.id === s.id) player.stop();
                          void deleteAudio(s.id).then(refreshLocalAudio);
                        }}
                        title="Zugeordnete Audiodatei entfernen"
                      >
                        Audio entfernen
                      </button>
                    ) : (
                      <button
                        className="btn small ghost"
                        onClick={() => {
                          audioTarget.current = s;
                          audioRef.current?.click();
                        }}
                        title="Eigene Audiodatei für diesen Song wählen"
                      >
                        {info.kind === 'none' ? 'Audio zuordnen' : 'Eigene Datei'}
                      </button>
                    )}
                    <button className="btn icon small ghost" onClick={() => removeSong(s)} aria-label={`${s.title} aus der Sammlung entfernen`}>
                      ✕
                    </button>
                  </div>
                );
              })}
              {visible.length === 0 && <p className="muted">Keine Treffer für „{query}“.</p>}
            </div>
            <input
              ref={audioRef}
              type="file"
              accept="audio/*"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f && audioTarget.current) void assignAudio(audioTarget.current, f);
                e.target.value = '';
              }}
            />
          </div>
        )}
      </section>

      {songs.length > 0 && (
        <div className="row end">
          <button className="btn primary big" disabled={selected.size < 2} onClick={() => go({ page: 'setup' })}>
            Weiter mit {selected.size} Songs →
          </button>
        </div>
      )}
      {songs.length > 0 && selected.size < 2 && (
        <p className="muted small" style={{ textAlign: 'right' }}>
          Ein Turnier braucht mindestens zwei Songs.
        </p>
      )}

      {pending && (
        <Modal
          title="Welche Playlist?"
          onClose={() => setPending(null)}
          actions={
            <>
              <button className="btn ghost" onClick={() => setPending(null)}>
                Abbrechen
              </button>
              <button
                className="btn primary"
                onClick={() => {
                  try {
                    applyImport(
                      importText(pending.name, pending.text, {
                        playlistIndex: playlistChoice === 'all' ? 'all' : Number(playlistChoice),
                      }),
                    );
                  } catch (e) {
                    setError(e instanceof Error ? e.message : 'Import fehlgeschlagen.');
                  }
                  setPending(null);
                }}
              >
                Importieren
              </button>
            </>
          }
        >
          <p className="muted">Dein Spotify-Datenexport enthält {pending.playlists.length} Playlists.</p>
          <label className="field">
            Playlist
            <select value={playlistChoice} onChange={(e) => setPlaylistChoice(e.target.value)}>
              {pending.playlists.map((p, i) => (
                <option key={i} value={String(i)}>
                  {p}
                </option>
              ))}
              <option value="all">Alle Playlists zusammen</option>
            </select>
          </label>
        </Modal>
      )}

      {confirmClear && (
        <Modal
          title="Sammlung leeren?"
          onClose={() => setConfirmClear(false)}
          actions={
            <>
              <button className="btn ghost" onClick={() => setConfirmClear(false)}>
                Abbrechen
              </button>
              <button
                className="btn danger"
                onClick={() => {
                  updateLibrary(() => emptyLibrary());
                  setLastReport(null);
                  setConfirmClear(false);
                }}
              >
                Leeren
              </button>
            </>
          }
        >
          <p>Alle Songs werden aus der Sammlung entfernt. Laufende Turniere bleiben unverändert – ihre Songs sind eingefroren.</p>
        </Modal>
      )}
    </div>
  );
}

function SpotifyHelp() {
  return (
    <div className="notice" style={{ marginBottom: 16 }}>
      <p>
        <strong>Deine Spotify-Playlist in 2 Minuten importieren (empfohlen):</strong>
      </p>
      <ol style={{ margin: '0 0 10px', paddingLeft: 20 }}>
        <li>
          Öffne <a href="https://exportify.net" target="_blank" rel="noreferrer">exportify.net</a> und melde dich mit Spotify an.
        </li>
        <li>Klicke bei deiner Playlist auf „Export“ – du bekommst eine CSV-Datei.</li>
        <li>Ziehe die Datei hier hinein. Alle Songs (auch 170+) landen mit Titel, Interpret, Album und Spotify-Link in deiner Sammlung.</li>
      </ol>
      <p className="small" style={{ margin: '0 0 6px' }}>
        <strong>Alternative ohne Drittanbieter:</strong> spotify.com → Konto → Datenschutz → „Deine Daten herunterladen“. Nach
        einigen Tagen bekommst du ein ZIP; die Datei <code>Playlist1.json</code> kannst du hier direkt importieren.
      </p>
      <p className="small muted" style={{ margin: 0 }}>
        Abspielen: Songs mit Spotify-Link laufen über den offiziellen Spotify-Player. Bist du im Browser mit deinem
        Premium-Konto eingeloggt, hörst du meist den ganzen Song, sonst eine Vorschau. Die App lädt keine Musik herunter.
      </p>
    </div>
  );
}
