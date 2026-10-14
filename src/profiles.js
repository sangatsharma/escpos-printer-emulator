/**
 * Hardware profiles. Everything the interpreter lays out is in the profile's
 * own dot units; the viewer turns them into pixels with `unitMm`.
 *
 * Thermal heads are 203 dpi with square dots, so one unit is one dot both ways.
 *
 * Impact (dot-matrix) heads are not square. The RestroX generator encodes for
 * them with `ESC * 0` (8-pin, single density) and `ESC 3 16`, so the profile
 * uses half-dot columns horizontally and 1/144" vertically — the units those
 * commands are defined in — and leaves the aspect correction to the viewer.
 */

const THERMAL_BIT_IMAGE = {
  // m: [x units per column, y units per pin, pins per column]
  0: [2, 3, 8], // 8-dot single density
  1: [1, 3, 8], // 8-dot double density
  32: [2, 1, 24], // 24-dot single density
  33: [1, 1, 24], // 24-dot double density
};

const IMPACT_BIT_IMAGE = {
  0: [2, 2, 8],
  1: [1, 2, 8],
};

/** Shared by every thermal width; only the printable dots change. */
function thermal(paperMm, printableDots, printableMm) {
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
    // `ESC 3 n` on the Xprinter / ZKTeco clones RestroX ships with is in dots.
    // The generator's bands (`ESC 3 24` under 24-dot images) rely on it.
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

export const PROFILES = {
  "thermal-58": thermal(58, 384, 48),
  "thermal-72": thermal(72, 512, 64),
  "thermal-80": thermal(80, 576, 72),
  "impact-76": {
    kind: "impact",
    paperMm: 76,
    printableMm: 72,
    // 279 single-density columns (what the generator sizes images for) as
    // half-dots.
    widthUnits: 558,
    unitMm: { x: 72 / 558, y: 25.4 / 144 },
    // A 9-pin head prints 7×9 glyphs in a 9-pin-tall cell. The generator lays
    // out 48 columns of Font A on 80mm, so the cell is sized to match.
    fonts: {
      A: { w: 558 / 48, h: 18 },
      B: { w: 558 / 64, h: 18 },
      C: { w: 558 / 64, h: 18 },
    },
    kanji: { w: (558 / 48) * 2, h: 18 },
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
  },
};

/**
 * Resolve a profile from what a RestroX printer record holds: paper width in
 * millimetres plus `printerType` ("Thermal" / "Dot Matrix").
 */
export function resolveProfile({ profile, paper, type } = {}) {
  if (profile) {
    const found = PROFILES[profile];
    if (!found) {
      throw new Error(
        `Unknown profile "${profile}". Known: ${Object.keys(PROFILES).join(", ")}`,
      );
    }
    return { id: profile, ...found };
  }

  const isImpact = /dot|impact/i.test(String(type ?? ""));
  if (isImpact) return { id: "impact-76", ...PROFILES["impact-76"] };

  const mm = Number(paper ?? 80);
  const id = mm <= 58 ? "thermal-58" : mm <= 72 ? "thermal-72" : "thermal-80";
  return { id, ...PROFILES[id] };
}
