import { isPowerOfTwo, nextPow2, perRoundSpots } from './engine';
import type { TournamentConfig } from './types';

export interface Preset {
  id: string;
  name: string;
  description: string;
  config: TournamentConfig;
}

const base: TournamentConfig = {
  format: 'cypher',
  evaluation: 'select',
  advancePerGroup: 2,
  extraMode: 'none',
  extraPerRound: 1,
  drawMode: 'random',
  reshufflePerRound: false,
  avoidSameArtist: false,
  duelMainRound: 'auto',
  thirdPlaceMatch: false,
  showRankPoints: false,
};

export const PRESETS: Preset[] = [
  {
    id: 'duel',
    name: 'Klassisches Duell',
    description: 'Zwei Songs, du wählst einen. Der Gewinner kommt weiter.',
    config: { ...base, format: 'duel', evaluation: 'select', presetId: 'duel' },
  },
  {
    id: 'cypher-simple',
    name: 'Cypher einfach',
    description: 'Vier Songs, du wählst zwei. Beide kommen weiter.',
    config: { ...base, presetId: 'cypher-simple' },
  },
  {
    id: 'cypher-rank',
    name: 'Cypher mit Rangfolge',
    description: 'Vier Songs auf Platz 1 bis 4 setzen. Die besten kommen weiter.',
    config: { ...base, evaluation: 'rank', presetId: 'cypher-rank' },
  },
  {
    id: 'cypher-score',
    name: 'Cypher mit Punkten',
    description: 'Jeden Song mit 1 bis 10 bewerten. Die besten qualifizieren sich.',
    config: { ...base, evaluation: 'score', presetId: 'cypher-score' },
  },
  {
    id: 'cypher-blocks',
    name: 'Zwei Cyphers mit Zusatzplatz',
    description: 'Zwei Vierergruppen getrennt bewerten. Je zwei direkt weiter, dazu der bessere Drittplatzierte.',
    config: { ...base, evaluation: 'score', extraMode: 'perBlock', presetId: 'cypher-blocks' },
  },
];

export const DEFAULT_PRESET_ID = 'cypher-simple';

export function defaultConfig(): TournamentConfig {
  return { ...PRESETS.find((p) => p.id === DEFAULT_PRESET_ID)!.config };
}

/** Bring a config into a consistent shape (e.g. duels always use direct selection). */
export function normalizeConfig(c: TournamentConfig): TournamentConfig {
  const n = { ...c };
  if (n.format === 'duel') {
    n.evaluation = 'select';
    n.extraMode = 'none';
    n.reshufflePerRound = false;
  } else {
    n.duelMainRound = 'auto';
    n.thirdPlaceMatch = false;
    if (n.evaluation === 'select') n.extraMode = 'none';
  }
  if (n.extraPerRound < 1) n.extraPerRound = 1;
  return n;
}

export interface ConfigCheck {
  errors: string[];
  warnings: string[];
}

export function checkConfig(c: TournamentConfig, songCount: number): ConfigCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (songCount === 0) errors.push('Wähle mindestens zwei Songs aus – aktuell ist kein Song ausgewählt.');
  else if (songCount === 1) errors.push('Ein Turnier braucht mindestens zwei Songs. Wähle noch einen weiteren aus.');
  if (c.format === 'duel' && typeof c.duelMainRound === 'number') {
    const m = c.duelMainRound;
    if (!isPowerOfTwo(m) || m < 2) errors.push('Die Hauptrunde muss eine Zweierpotenz sein (z. B. 64 oder 128).');
    else if (songCount >= 2 && m > nextPow2(songCount)) {
      errors.push(
        `Für eine Hauptrunde mit ${m} Songs brauchst du mehr als ${m / 2} Songs, sonst entstünden Begegnungen zwischen zwei leeren Plätzen. Wähle „Automatisch“ oder eine kleinere Hauptrunde.`,
      );
    }
  }
  if (c.format === 'cypher' && c.evaluation === 'select' && c.extraMode !== 'none') {
    errors.push('Zusatzplätze brauchen eine Rangfolge oder Punkte, damit klar ist, wer Dritter wurde.');
  }
  if (c.format === 'cypher' && c.extraMode === 'perRound' && songCount >= 8) {
    const full = Math.floor(songCount / 4);
    if (perRoundSpots(c, full) < c.extraPerRound) {
      warnings.push('Die Zahl der Zusatzplätze wird je Runde begrenzt, damit in jeder Runde Songs ausscheiden.');
    }
  }
  if (c.format === 'cypher' && c.advancePerGroup === 3 && c.extraMode !== 'none') {
    warnings.push('Mit drei Weiterkommenden plus Zusatzplätzen scheiden pro Runde nur sehr wenige Songs aus – das Turnier wird lang.');
  }
  return { errors, warnings };
}

export function evaluationLabel(c: TournamentConfig): string {
  if (c.format === 'duel') return 'Direkte Auswahl';
  return c.evaluation === 'select' ? 'Direkte Auswahl' : c.evaluation === 'rank' ? 'Rangfolge' : 'Punkte (1–10)';
}

export function describeConfig(c: TournamentConfig): string[] {
  const lines: string[] = [];
  if (c.format === 'duel') {
    lines.push('Duelle: Zwei Songs, einer kommt weiter.');
    if (typeof c.duelMainRound === 'number') lines.push(`Feste Hauptrunde mit ${c.duelMainRound} Songs.`);
    if (c.thirdPlaceMatch) lines.push('Mit Spiel um Platz 3.');
  } else {
    lines.push(`Cyphers mit vier Songs – ${c.advancePerGroup} ${c.advancePerGroup === 1 ? 'kommt' : 'kommen'} weiter.`);
    lines.push(`Bewertung: ${evaluationLabel(c)}.`);
    if (c.extraMode === 'perBlock') lines.push('Ein Zusatzplatz je Block aus zwei Cyphers.');
    if (c.extraMode === 'perRound') lines.push(`${c.extraPerRound} Zusatzplatz/-plätze je Runde.`);
    if (c.reshufflePerRound) lines.push('Gruppen werden jede Runde neu ausgelost.');
  }
  lines.push(c.drawMode === 'random' ? 'Zufällige Auslosung.' : 'Ursprüngliche Reihenfolge als Setzliste.');
  if (c.avoidSameArtist) lines.push('Gleiche Interpreten in Runde 1 möglichst getrennt.');
  return lines;
}
