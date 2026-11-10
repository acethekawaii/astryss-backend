import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import { siteStats } from '../site-stats.config';
import type { ManilaDate, VisitorHash } from '../types/site-stats.types';

// One document per visitor per Manila day. Its only job is to say whether a
// hit is that visitor's first today, so the TTL index drops it a few days on.
@Schema({
  collection: 'site_visitors',
  timestamps: false,
  versionKey: false,
  strict: true,
})
export class Visitor {
  @Prop({ required: true, type: String })
  date: ManilaDate;

  @Prop({ required: true, type: String })
  hash: VisitorHash;

  @Prop({ required: true, type: Date })
  at: Date;
}

export const VisitorSchema = SchemaFactory.createForClass(Visitor);
VisitorSchema.index({ date: 1, hash: 1 }, { unique: true });
VisitorSchema.index(
  { at: 1 },
  { expireAfterSeconds: siteStats.visitorHashTtlSeconds },
);

export type VisitorDocument = HydratedDocument<Visitor>;
