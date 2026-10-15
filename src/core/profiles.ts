import type { BitImageSpec, Profile, ProfileDefinition } from "./types.js";

/**
 * Hardware profiles. Everything the interpreter lays out is in the profile's
 * own dot units; the viewer turns them into pixels with `unitMm`.
 *
 * Thermal heads are 203 dpi with square dots, so one unit is one dot both ways.
 *
 * Impact (dot-matrix) heads are not square. Drivers usually send them 8-pin
 * single-density images (`ESC * 0`) with `ESC 3 16` line spacing, so the
 * profile uses half-dot columns horizontally and 1/144" vertically, the units
 * those commands are defined in, and leaves the aspect correction to the viewer.
 */

const THERMAL_BIT_IMAGE: Record<number, BitImageSpec> = {
  // m: [x units per column, y units per pin, pins per column]
  0: [2, 3, 8], // 8-dot single density
  1: [1, 3, 8], // 8-dot double density
  32: [2, 1, 24], // 24-dot single density
  33: [1, 1, 24], // 24-dot double density
};

const IMPACT_BIT_IMAGE: Record<number, BitImageSpec> = {
  0: [2, 2, 8],
  1: [1, 2, 8],
};

/** Shared by every thermal width; only the printable dots change. */
function thermal(paperMm: number, printableDots: number, printableMm: number): ProfileDefinition {
  return {
    kind: "thermal",
    paperMm,
    printableMm,
    widthUnits: printableDots,
    unitMm: { x: printableMm / printableDots, y: printableMm / printableDots },
    fonts: {
      A: { w: 12, h: 24 },
      B: { w: 9, h: 17 },
      C: { w: 9, h: 17 },
    },
    kanji: { w: 24, h: 24 },
    defaultLineSpacing: 30,
    // `ESC 3 n` is in dots on the common Epson-compatible clones (Xprinter,
    // ZKTeco, Rongta…), so 24-dot image bands use `ESC 3 24`.
    lineSpacingUnit: 1,
    feedUnit: 1,
    motionUnitX: 1,
    bitImage: THERMAL_BIT_IMAGE,
    supports: {
      raster: true, // GS v 0, GS ( L, GS 8 L
      qr: true, // GS ( k
      barcode: true, // GS k
      cutter: true,
    },
  };
}

/** Half-dot pitch of the impact head: 279 single-density columns span 72mm. */
const IMPACT_UNIT_X = 72 / 558;
/** A 9-pin head prints 7×9 glyphs in a 9-pin-tall cell, 48 Font A columns across 72mm. */
const IMPACT_FONT_A = 558 / 48;
const IMPACT_FONT_B = 558 / 64;

/**
 * The head and its character cells are the same on every paper width; a
 * narrower roll only shrinks the print area, and with it the columns per line.
 */
function impact(paperMm: number, printableMm: number): ProfileDefinition {
  return {
    kind: "impact",
    paperMm,
    printableMm,
    widthUnits: Math.round(printableMm / IMPACT_UNIT_X),
    unitMm: { x: IMPACT_UNIT_X, y: 25.4 / 144 },
    fonts: {
      A: { w: IMPACT_FONT_A, h: 18 },
      B: { w: IMPACT_FONT_B, h: 18 },
      C: { w: IMPACT_FONT_B, h: 18 },
    },
    kanji: { w: IMPACT_FONT_A * 2, h: 18 },
    defaultLineSpacing: 24, // 1/6"
    lineSpacingUnit: 1, // ESC 3 n is n/144"
    feedUnit: 1,
    motionUnitX: 1,
    bitImage: IMPACT_BIT_IMAGE,
    supports: {
      // Impact heads have no raster, QR or barcode commands: the firmware drops
      // the introducer and prints the parameters and data as characters.
      raster: false,
      qr: false,
      barcode: false,
      cutter: true,
    },
  };
}

export const PROFILES: Record<string, ProfileDefinition> = {
  "thermal-58": thermal(58, 384, 48),
  "thermal-72": thermal(72, 512, 64),
  "thermal-80": thermal(80, 576, 72),
  "impact-58": impact(58, 48), // 372 half-dots, 32 columns
  "impact-76": impact(76, 72), // 558 half-dots, 48 columns
};

export interface ProfileSelector {
  /** A profile id from {@link PROFILES}; wins over `paper` and `type`. */
  profile?: string;
  /** Paper width in mm: 58, 72 or 80 for thermal; 58 or 76 for dot matrix. */
  paper?: number | string;
  /** "thermal" (default), or anything containing "dot" or "impact". */
  type?: string;
}

/** Resolve a profile from a paper width and a printer type, or an explicit id. */
export function resolveProfile({ profile, paper, type }: ProfileSelector = {}): Profile {
  if (profile) {
    const found = PROFILES[profile];
    if (!found) {
      throw new Error(`Unknown profile "${profile}". Known: ${Object.keys(PROFILES).join(", ")}`);
    }
    return { id: profile, ...found };
  }

  const isImpact = /dot|impact/i.test(String(type ?? ""));
  const mm = Number(paper ?? (isImpact ? 76 : 80));
  const id = isImpact
    ? mm <= 58
      ? "impact-58"
      : "impact-76"
    : mm <= 58
      ? "thermal-58"
      : mm <= 72
        ? "thermal-72"
        : "thermal-80";
  return { id, ...PROFILES[id]! };
}
