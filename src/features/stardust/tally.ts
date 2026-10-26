import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { stardust } from './stardust.config';
import { Placement, PlacementDocument } from './schemas/placement.schema';

// The homepage polls the total, so one count of the log serves every request
// for tallyTtlMs, and requests that arrive while it runs share it.
@Injectable()
export class Tally {
  private counted: { total: number; at: number } | null = null;
  private counting: Promise<number> | null = null;

  constructor(
    @InjectModel(Placement.name)
    private readonly placements: Model<PlacementDocument>,
  ) {}

  totalPixels(): Promise<number> {
    if (this.counted && Date.now() - this.counted.at < stardust.tallyTtlMs) {
      return Promise.resolve(this.counted.total);
    }
    this.counting ??= this.placements
      .countDocuments()
      .exec()
      .then((total) => {
        this.counted = { total, at: Date.now() };
        return total;
      })
      .finally(() => {
        this.counting = null;
      });
    return this.counting;
  }
}
