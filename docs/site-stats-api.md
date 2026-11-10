# Site Stats API

Astryss counts its own traffic: page views for all time, and page views and unique visitors for today. It needs no login and sets no cookies, and it stores no IP address or user agent.

"Today" is the Manila calendar day. It starts at 00:00 Asia/Manila (UTC+8, which has no daylight saving), which is 16:00 UTC the day before.

## Count a page view

`POST /api/v2/stats/visits/hit`

Headers:

- `Content-Type: application/json`

Body:

```json
{ "path": "/release" }
```

`path` is the page's path: a string that starts with `/`, at most 2048 characters. The server checks it but doesn't store it yet. Counts are for the whole site.

Response `204` with no body. The server answers before it writes, so the response never waits on the database, and a database failure is logged on the server rather than returned.

| Status | Meaning |
| --- | --- |
| `204` | Accepted. Counted, or ignored as a bot. |
| `400` | Body is not JSON with a valid `path`. Not counted. |
| `429` | More than 30 hits from this IP in the current minute. Not counted. |

The `429` body uses the usual error shape:

```json
{
  "statusCode": 429,
  "error": "HttpException",
  "timestamp": "2026-11-10T05:00:00.000Z",
  "path": "/api/v2/stats/visits/hit",
  "message": "Too many hits"
}
```

Send it once per page view and don't wait on it:

```ts
fetch(`${API_URL}/api/v2/stats/visits/hit`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ path: location.pathname }),
  keepalive: true,
}).catch(() => {});
```

`navigator.sendBeacon` with a string body sends `text/plain`, which this endpoint rejects with `400`, so use `fetch` with `keepalive`.

## Read the counts

`GET /api/v2/stats/visits`

No token. Response `200`, without the `statusCode`/`data` envelope:

```json
{
  "totalPageviews": 48210,
  "todayPageviews": 312,
  "todayVisitors": 97,
  "since": "2026-11-10"
}
```

| Field | Meaning |
| --- | --- |
| `totalPageviews` | Every counted hit since counting began. |
| `todayPageviews` | Counted hits since 00:00 Manila today. |
| `todayVisitors` | Distinct visitors since 00:00 Manila today. |
| `since` | The first Manila day with a counted hit, `YYYY-MM-DD`. `null` until the first hit. |

Headers: `Cache-Control: public, max-age=60`.

The server reuses one read for 60 seconds, and reads again once Manila midnight passes. With the browser's own 60-second cache on top, a new hit can take up to two minutes to show.

## What counts

- **Page view**: every hit that isn't a bot, rate-limited, or invalid.
- **Visitor**: the SHA-256 of the client IP, the user agent, and a daily salt. The salt is an HMAC-SHA256 of the Manila date, keyed with `SITE_STATS_SECRET`. One browser on one network counts once a day. A different browser, user agent, or IP counts as another visitor. Salts change at Manila midnight, so the same browser counts again the next day, and one day's hashes can't be matched with another day's.
- **Bots**: a missing or blank user agent, or one containing `bot`, `crawl`, `spider`, or `preview` (case-insensitive), gets `204` and isn't counted.
- **Rate limit**: 30 hits per IP per fixed one-minute window. The window lives in the API process's memory: the API runs as one container, and a restart only resets the current minute. The memory is keyed by an HMAC of the IP, not the IP itself.
- **Client IP**: the address one proxy hop in from the end of `X-Forwarded-For` (Caddy), the same rule Stardust uses.

## Storage

| Collection | Document | Kept |
| --- | --- | --- |
| `site_visit_days` | `{ date, pageviews, visitors }`, one per Manila day, unique on `date` | Forever |
| `site_visitors` | `{ date, hash, at }`, one per visitor per day, unique on `(date, hash)` | A TTL index deletes it 3 days after `at` (its first hit) |

Each counted hit makes two atomic upserts: one inserts the visitor document only if it doesn't exist yet, and one `$inc`s the day's `pageviews` by 1, and its `visitors` by 1 when that insert happened. The unique indexes make simultaneous upserts of the same document resolve to one document, so parallel hits never lose or double a count. The API builds those indexes before it accepts traffic.

The lifetime total isn't kept in a separate counter. `GET /visits` sums `pageviews` over the day documents. This way a hit makes one counting write instead of two, the total can't drift from the daily counts, and the sum is over one document per day.

If the visitor insert succeeds and the day update then fails, that visitor goes uncounted for the day. It is never counted twice.

## Configuration

`SITE_STATS_SECRET` is required, at least 32 characters (`openssl rand -hex 32`), and the API refuses to start without it. Keep it stable: a new secret mid-day makes returning visitors count again that day.
