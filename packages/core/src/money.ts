/**
 * Money is held as integer fils (1 AED = 100 fils) so sums never drift.
 * Rates are held as basis points (1% = 100 bp).
 */
export type Fils = number;
export type BasisPoints = number;

export const aed = (amount: number): Fils => Math.round(amount * 100);
export const toAed = (fils: Fils): number => fils / 100;

export function assertFils(value: number, label = "amount"): Fils {
  if (!Number.isInteger(value)) throw new Error(`${label} must be whole fils, got ${value}`);
  if (value < 0) throw new Error(`${label} must not be negative, got ${value}`);
  return value;
}

/** Multiply by a basis-point rate, rounding half up to the fil. */
export const applyBp = (fils: Fils, bp: BasisPoints): Fils => Math.round((fils * bp) / 10_000);

/** Round up to the next multiple of `step` (step in fils). */
export function ceilTo(fils: Fils, step: Fils): Fils {
  if (step <= 0) return fils;
  return Math.ceil(fils / step) * step;
}

/** Round down to a multiple of `step` (step in fils). */
export function floorTo(fils: Fils, step: Fils): Fils {
  if (step <= 0) return fils;
  return Math.floor(fils / step) * step;
}

export function formatAed(fils: Fils): string {
  const whole = fils / 100;
  return `AED ${whole.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

/** Split an amount into shares that always add back to the total (largest remainder). */
export function splitByShares(total: Fils, sharesBp: BasisPoints[]): Fils[] {
  const sum = sharesBp.reduce((a, b) => a + b, 0);
  if (sum !== 10_000) throw new Error(`shares must add up to 10000 bp, got ${sum}`);
  const raw = sharesBp.map((s) => (total * s) / 10_000);
  const floors = raw.map(Math.floor);
  let remainder = total - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (remainder <= 0) break;
    floors[i] = (floors[i] ?? 0) + 1;
    remainder -= 1;
  }
  return floors;
}
