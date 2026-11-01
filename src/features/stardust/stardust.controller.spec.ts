import type { Canvas } from './canvas';
import { stardust } from './stardust.config';
import { StardustController } from './stardust.controller';
import type { Tally } from './tally';

describe('StardustController', () => {
  it('includes the palette display order in stats', async () => {
    const tally = {
      totalPixels: jest.fn().mockResolvedValue(1334),
    } as unknown as Tally;
    const controller = new StardustController(
      {} as Canvas,
      tally,
      'unused-test-secret',
    );

    await expect(controller.getStats()).resolves.toEqual({
      totalPixels: 1334,
      paletteDisplayOrder: stardust.paletteDisplayOrder,
    });
  });
});
