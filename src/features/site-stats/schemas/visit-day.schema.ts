import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import type { ManilaDate } from '../types/site-stats.types';

// One document per Manila day, kept forever. Hits only ever $inc it.
@Schema({
  collection: 'site_visit_days',
  timestamps: false,
  versionKey: false,
  strict: true,
})
export class VisitDay {
  @Prop({ required: true, type: String })
  date: ManilaDate;

  @Prop({ type: Number })
  pageviews: number;

  @Prop({ type: Number })
  visitors: number;
}

export const VisitDaySchema = SchemaFactory.createForClass(VisitDay);
VisitDaySchema.index({ date: 1 }, { unique: true });

export type VisitDayDocument = HydratedDocument<VisitDay>;
