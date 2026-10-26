# Stardust API

## Origins

CORS and the live WebSocket accept these origins:

- `http://localhost:3000`
- `https://astryss.acethekawaii.com`

The session token is the `Authorization` bearer for HTTP and the socket's first text frame. It is not a cookie.

## Session

`POST /api/v2/stardust/session`

Body is ignored. Response:

```json
{
  "statusCode": 201,
  "message": "Success",
  "data": {
    "token": "1.xxxxxxxxxxxxxxxx.yyyyyyyyyyyyyyyy"
  }
}
```

## Board

`GET /api/v2/stardust/board`

Headers:

- `Content-Type: application/octet-stream`
- `Cache-Control: no-store`

Body is a `STBD` snapshot. Layout:

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 4 | magic `STBD` |
| 4 | 1 | version `1` |
| 5 | 2 | width u16be |
| 7 | 2 | height u16be |
| 9 | 4 | seq u32be |
| 13 | 1 | palette length |
| 14 | `paletteLength * 3` | RGB triples |
| header end | `width * height` | color indexes |

Header length is `14 + paletteLength * 3`.

Example: width 192, height 108, palette length 16, header length 62, body length `62 + 20736`.

Clients should read the size from the header rather than hard-code it. Changing the size in `stardust.config.ts` starts a fresh board; earlier boards keep their own Redis keys and placement log.

## Pixels

`POST /api/v2/stardust/pixels`

Headers:

- `Authorization: Bearer <token>`
- `Content-Type: application/json`

Body:

```json
{ "x": 12, "y": 34, "color": 5 }
```

`color` is the palette index.

Success `201`:

```json
{
  "statusCode": 201,
  "message": "Success",
  "data": {
    "x": 12,
    "y": 34,
    "color": 5,
    "nextAllowedAt": "2026-09-27T05:00:30.000Z"
  }
}
```

Cooldown `429`:

```json
{
  "statusCode": 429,
  "error": "HttpException",
  "timestamp": "2026-09-27T05:00:00.000Z",
  "path": "/api/v2/stardust/pixels",
  "message": {
    "remainingMs": 29541,
    "nextAllowedAt": "2026-09-27T05:00:29.541Z"
  }
}
```

Other statuses: `400` bad cell or color, `401` missing or bad token, `503` board not ready or board write failed after the log append.

## Stats

`GET /api/v2/stardust/stats`

No token. Response `200`, without the `statusCode`/`data` envelope:

```json
{ "totalPixels": 1334 }
```

`totalPixels` counts every placement in the log, on every board size, including pixels later painted over. The server reuses one count for 30 seconds, so the number can trail the log by up to that long, and polling faster returns the same value.

## Live WebSocket

URL: `ws://<host>/api/v2/stardust/live` (or `wss` behind TLS).

First client message:

```json
{ "token": "1.xxxxxxxxxxxxxxxx.yyyyyyyyyyyyyyyy" }
```

Later client messages are ignored. Missing or foreign `Origin`, a bad token, or no token within 5 seconds closes with code `1008`.

Server frames are binary `STPX` only. Layout:

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 4 | magic `STPX` |
| 4 | 1 | version `1` |
| 5 | 2 | count u16be |
| 7 | `count * 9` | records |

Each record is 9 bytes: seq u32be, x u16be, y u16be, color u8.

## Palette

| Index | Hex |
| --- | --- |
| 0 | `#FFFFFF` |
| 1 | `#E4E4E4` |
| 2 | `#888888` |
| 3 | `#222222` |
| 4 | `#FFA7D1` |
| 5 | `#E50000` |
| 6 | `#E59500` |
| 7 | `#A06A42` |
| 8 | `#E5D900` |
| 9 | `#94E044` |
| 10 | `#02BE01` |
| 11 | `#00D3DD` |
| 12 | `#0083C7` |
| 13 | `#0000EA` |
| 14 | `#CF6EE4` |
| 15 | `#820080` |

## Timelapse render

`npm run stardust:timelapse` replays the placement log into video for the homepage and social posts. It reads `stardust_placements` from `MONGO_URI` in `.env` without writing to it, and needs `ffmpeg` with libx264 and libvpx-vp9 on `PATH`.

```bash
npm run stardust:timelapse
npm run stardust:timelapse -- --out ../astryss-frontend/public/assets/stardust
```

Files land in `out/stardust/`, which git ignores, unless `--out` names another directory. Each run overwrites them.

| File | Contents |
| --- | --- |
| `stardust-loop.webm` | VP9, 10 s, no audio: 8.5 s of placements from a blank board, then 1.5 s on the current canvas. The homepage loop. |
| `stardust-loop.mp4` | The same loop in H.264, for browsers without WebM. |
| `stardust-timelapse.mp4` | H.264, 25 s, no audio: 23 s of placements, then 2 s on the final canvas. For X and Facebook. |
| `stardust-poster.png` | The current canvas, the same as the videos' last frame. |

Placements replay in `at` order onto a white board (index 0), spread evenly by count rather than by time, so quiet days don't become dead air. The board size comes from the placements' `board` field. Each board pixel becomes a square block, scaled nearest-neighbor by the even factor that lands closest to 1920 px wide: 10 for 192×108, giving 1920×1080. If the log spans more than one board size, the script renders the board of the newest placement and says how many placements it skipped.

Homepage markup, with the files in the frontend's `public/assets/stardust/`:

```html
<video autoplay muted loop playsinline poster="/assets/stardust/stardust-poster.png">
  <source src="/assets/stardust/stardust-loop.webm" type="video/webm" />
  <source src="/assets/stardust/stardust-loop.mp4" type="video/mp4" />
</video>
```

Browsers smooth video they resize. `image-rendering: pixelated` keeps the blocks hard-edged where it is supported.
