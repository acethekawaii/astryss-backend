export const stardust = {
  width: 192,
  height: 108,
  palette: [
    '#FFFFFF',
    '#E4E4E4',
    '#888888',
    '#222222',
    '#FFA7D1',
    '#E50000',
    '#E59500',
    '#A06A42',
    '#E5D900',
    '#94E044',
    '#02BE01',
    '#00D3DD',
    '#0083C7',
    '#0000EA',
    '#CF6EE4',
    '#820080',
    '#FFF9EC',
    '#D7F6FD',
    '#FFEBF5',
    '#A8A9DB',
    '#880015',
    '#FF94AC',
    '#FAFFA3',
    '#FFC90E',
  ],
  paletteDisplayOrder: [
    // neutrals
    0, 16, 1, 2, 3,
    // reds and pinks
    18, 4, 21, 5, 20,
    // oranges, yellows, and browns
    22, 8, 23, 6, 7,
    // greens
    9, 10,
    // blues
    17, 11, 12, 13,
    // purples
    19, 14, 15,
  ],
  blank: 0,
  identityCooldownMs: 5000,
  ipLimit: 40,
  ipWindowMs: 60000,
  flushMs: 150,
  trustedProxyHops: 1,
  tallyTtlMs: 30000,
} as const;

const originalPalette = [
  '#FFFFFF',
  '#E4E4E4',
  '#888888',
  '#222222',
  '#FFA7D1',
  '#E50000',
  '#E59500',
  '#A06A42',
  '#E5D900',
  '#94E044',
  '#02BE01',
  '#00D3DD',
  '#0083C7',
  '#0000EA',
  '#CF6EE4',
  '#820080',
] as const;

function assertPalette(): void {
  for (const [index, hex] of originalPalette.entries()) {
    if (stardust.palette[index] !== hex) {
      throw new Error(`palette index ${index} must remain ${hex}`);
    }
  }

  const uniqueHexes = new Set(stardust.palette.map((hex) => hex.toUpperCase()));
  if (uniqueHexes.size !== stardust.palette.length) {
    throw new Error('palette must not contain duplicate hex values');
  }

  const displayIndexes = new Set<number>(stardust.paletteDisplayOrder);
  if (
    displayIndexes.size !== stardust.palette.length ||
    stardust.paletteDisplayOrder.some(
      (index) => index < 0 || index >= stardust.palette.length,
    )
  ) {
    throw new Error(
      'paletteDisplayOrder must contain every palette index once',
    );
  }
}

assertPalette();

export const boardByteLength = stardust.width * stardust.height;

// Scopes the Redis keys and the placement log to one board size, so a resized
// deploy starts a fresh board instead of failing on, or replaying into, the old one.
export const boardId = `${stardust.width}x${stardust.height}`;
