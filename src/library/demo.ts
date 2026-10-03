import type { Song } from '../domain/types';

// Invented songs and artists – clearly marked as examples. Audio is synthesised in the browser.
const DEMO: Array<[string, string, string]> = [
  ['Neonregen', 'Die Lichtfänger', 'Nachtschicht'],
  ['Kreise im Kopf', 'Mila Sturm', 'Gegenwind'],
  ['Asphaltblumen', 'Kollektiv Echo', 'Beton & Blüten'],
  ['Letzte Bahn', 'Die Lichtfänger', 'Nachtschicht'],
  ['Kupferherz', 'Jonas Weit', 'Kupferherz'],
  ['Sommer ohne Ende', 'Paula & die Pausen', 'Hitzefrei'],
  ['Funkstille', 'Mila Sturm', 'Gegenwind'],
  ['Papierflieger', 'Nordlicht Trio', 'Leichtgewicht'],
  ['Basslinie 7', 'DJ Morgengrau', 'Clubnächte'],
  ['Rückenwind', 'Jonas Weit', 'Kupferherz'],
  ['Glasklar', 'Kollektiv Echo', 'Beton & Blüten'],
  ['Zwischen den Zeilen', 'Ria Vogel', 'Notizen'],
  ['Mondsichel', 'Nordlicht Trio', 'Leichtgewicht'],
  ['Kein Zurück', 'Paula & die Pausen', 'Hitzefrei'],
  ['Takt für Takt', 'DJ Morgengrau', 'Clubnächte'],
  ['Wolkenkratzer', 'Ria Vogel', 'Notizen'],
  ['Elektrisch', 'Die Lichtfänger', 'Strom'],
  ['Stadt aus Sand', 'Mila Sturm', 'Gezeiten'],
  ['Wellenreiter', 'Nordlicht Trio', 'Gezeiten'],
  ['Herzschlag (Live)', 'Jonas Weit', 'Live im Hafen'],
  ['Herzschlag', 'Jonas Weit', 'Kupferherz'],
  ['Morgenrot', 'Ria Vogel', 'Notizen'],
  ['Echolot', 'Kollektiv Echo', 'Tiefsee'],
  ['Letzter Tanz', 'Paula & die Pausen', 'Hitzefrei'],
];

export function demoSongs(startIndex = 0): Song[] {
  return DEMO.map(([title, artist, album], i) => ({
    id: `demo:${i + 1}`,
    title,
    artists: [artist],
    album,
    durationMs: 30_000,
    origin: 'demo' as const,
    demoTone: i + 1,
    originalIndex: startIndex + i,
  }));
}
