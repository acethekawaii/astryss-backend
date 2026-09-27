import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import type { AnonId, ColorIndex } from '../types/stardust.types';

@Schema({
  collection: 'stardust_placements',
  timestamps: false,
  versionKey: false,
  strict: true,
})
export class Placement {
  @Prop({ required: true, type: Number })
  x: number;

  @Prop({ required: true, type: Number })
  y: number;

  @Prop({ required: true, type: Number })
  color: ColorIndex;

  @Prop({ required: true, type: String })
  anonId: AnonId;

  @Prop({ required: true, type: Date })
  at: Date;

  @Prop({ required: true, type: String })
  board: string;
}

export const PlacementSchema = SchemaFactory.createForClass(Placement);
PlacementSchema.index({ board: 1, at: 1, _id: 1 });

export type PlacementDocument = HydratedDocument<Placement>;
