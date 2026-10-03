// Local audio files the user assigns to songs (own files). Stored only in this browser (IndexedDB).

const DB = 'music-cypher-audio';
const STORE = 'files';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB nicht verfügbar'));
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export interface StoredAudio {
  name: string;
  blob: Blob;
}

export const putAudio = (songId: string, file: File) =>
  tx('readwrite', (s) => s.put({ name: file.name, blob: file } satisfies StoredAudio, songId));

export const getAudio = (songId: string) => tx<StoredAudio | undefined>('readonly', (s) => s.get(songId));

export const deleteAudio = (songId: string) => tx('readwrite', (s) => s.delete(songId));

export async function listAudioIds(): Promise<string[]> {
  try {
    const keys = await tx<IDBValidKey[]>('readonly', (s) => s.getAllKeys());
    return keys.map(String);
  } catch {
    return [];
  }
}

/** Match file names to songs: "Artist - Title.mp3" or "Title.mp3". */
export function matchFilesToSongs<S extends { id: string; title: string; artists: string[] }>(
  files: File[],
  songs: S[],
): Array<{ file: File; song: S }> {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/\.[a-z0-9]{2,4}$/, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  const out: Array<{ file: File; song: S }> = [];
  const used = new Set<string>();
  for (const file of files) {
    const f = norm(file.name);
    // prefer "artist title" matches, then exact title, then title contained
    const scored = songs
      .filter((s) => !used.has(s.id))
      .map((s) => {
        const t = norm(s.title);
        const a = norm(s.artists.join(' '));
        let score = 0;
        if (f === t) score = 3;
        else if (a && f.includes(t) && f.includes(a)) score = 4;
        else if (t.length > 3 && f.includes(t)) score = 1;
        return { s, score };
      })
      .filter((x) => x.score > 0)
      .sort((x, y) => y.score - x.score);
    if (scored[0]) {
      used.add(scored[0].s.id);
      out.push({ file, song: scored[0].s });
    }
  }
  return out;
}
