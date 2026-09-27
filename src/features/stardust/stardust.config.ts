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
  ],
  blank: 0,
  identityCooldownMs: 30000,
  ipLimit: 10,
  ipWindowMs: 60000,
  flushMs: 150,
  trustedProxyHops: 1,
} as const;

export const boardByteLength = stardust.width * stardust.height;

// Scopes the Redis keys and the placement log to one board size, so a resized
// deploy starts a fresh board instead of failing on, or replaying into, the old one.
export const boardId = `${stardust.width}x${stardust.height}`;
