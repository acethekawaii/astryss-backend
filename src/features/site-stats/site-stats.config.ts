export const SITE_STATS_SECRET = 'SITE_STATS_SECRET';

export const siteStats = {
  // Philippine time has no daylight saving, so a fixed offset is exact.
  manilaOffsetMs: 8 * 60 * 60 * 1000,
  hitLimit: 30,
  hitWindowMs: 60_000,
  summaryTtlMs: 60_000,
  // A hash only matters on its own Manila day. Three days is long enough to
  // outlive that day and short enough that the hashes don't pile up.
  visitorHashTtlSeconds: 3 * 24 * 60 * 60,
  maxPathLength: 2048,
  botUserAgent: /bot|crawl|spider|preview/i,
} as const;
