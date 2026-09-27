export type AnonId = string & { readonly __brand: 'AnonId' };
export type ColorIndex = number & { readonly __brand: 'ColorIndex' };
export type Cell = { x: number; y: number } & { readonly __brand: 'Cell' };
export type UnhashedIp = string & { readonly __brand: 'UnhashedIp' };
export type IpHash = string & { readonly __brand: 'IpHash' };

export type StoredPlacement = {
  x: number;
  y: number;
  color: ColorIndex;
  anonId: AnonId;
  at: Date;
};

export type LivePixel = {
  seq: number;
  x: number;
  y: number;
  color: ColorIndex;
};

export type CooldownView = {
  identityRemainingMs: number;
  ipHits: number[];
};

export type CooldownDenial = {
  ok: false;
  remainingMs: number;
  nextAllowedAt: string;
};

export type CooldownAllow = {
  ok: true;
  identityTtlMs: number;
  recordIpAtMs: number;
  nextAllowedAt: string;
};

export type CooldownPlan = CooldownDenial | CooldownAllow;
