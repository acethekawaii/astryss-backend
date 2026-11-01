import { BadRequestException } from '@nestjs/common';

import { boardByteLength, stardust } from './stardust.config';
import {
  encodeSnapshot,
  parseHexRgb,
  parsePlaceBody,
} from './stardust.invariants';

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
];

const appendedPalette = [
  '#FFF9EC',
  '#D7F6FD',
  '#FFEBF5',
  '#A8A9DB',
  '#880015',
  '#FF94AC',
  '#FAFFA3',
  '#FFC90E',
];

function decodePalette(snapshot: Buffer): [number, number, number][] {
  const length = snapshot.readUInt8(13);
  return Array.from({ length }, (_, index) => {
    const at = 14 + index * 3;
    return [snapshot[at], snapshot[at + 1], snapshot[at + 2]];
  });
}

describe('Stardust palette', () => {
  it('keeps the original indexes and appends eight unique colors', () => {
    expect(stardust.palette).toEqual([...originalPalette, ...appendedPalette]);
    expect(new Set(stardust.palette).size).toBe(24);
  });

  it('exposes every index once in hue-grouped display order', () => {
    expect(stardust.paletteDisplayOrder).toEqual([
      0, 16, 1, 2, 3, 18, 4, 21, 5, 20, 22, 8, 23, 6, 7, 9, 10, 17, 11, 12, 13,
      19, 14, 15,
    ]);
    expect(new Set(stardust.paletteDisplayOrder).size).toBe(24);
  });

  it('encodes and decodes all 24 colors in an 86-byte snapshot header', () => {
    const board = Buffer.alloc(boardByteLength, stardust.blank);
    board[0] = 23;

    const snapshot = encodeSnapshot(board, 42);
    const palette = decodePalette(snapshot);

    expect(snapshot.toString('ascii', 0, 4)).toBe('STBD');
    expect(snapshot.readUInt8(4)).toBe(1);
    expect(snapshot.readUInt8(13)).toBe(24);
    expect(snapshot.length).toBe(86 + boardByteLength);
    expect(palette).toEqual(stardust.palette.map(parseHexRgb));
    expect(snapshot[86]).toBe(23);
  });

  it('accepts color 23 and rejects color 24 as invalid', () => {
    expect(parsePlaceBody({ x: 0, y: 0, color: 23 }).color).toBe(23);

    try {
      parsePlaceBody({ x: 0, y: 0, color: 24 });
      throw new Error('Expected color 24 to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).message).toBe('Invalid color');
    }
  });
});
