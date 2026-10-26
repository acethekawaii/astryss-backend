// Renders the Stardust placement log into the homepage loop, a timelapse for
// social posts and a poster frame. Reads MONGO_URI from .env without writing to
// it, and needs ffmpeg (libx264, libvpx-vp9) on PATH. See docs/stardust-api.md.
//
//   npm run stardust:timelapse [-- --out <dir>]

import { spawn } from 'child_process';
import { once } from 'events';
import { mkdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { parseArgs } from 'util';
import * as dotenv from 'dotenv';
import mongoose from 'mongoose';

import {
  Placement,
  PlacementSchema,
} from '../src/features/stardust/schemas/placement.schema';
import { stardust } from '../src/features/stardust/stardust.config';
import { parseHexRgb } from '../src/features/stardust/stardust.invariants';

type Board = { width: number; height: number };
type Cut = { build: number; hold: number };
type Painted = Pick<Placement, 'x' | 'y' | 'color'>;

const FPS = 30;
const TARGET_WIDTH = 1920;
const framesIn = (seconds: number) => Math.round(seconds * FPS);
// Frames of placements, then frames held on the finished canvas.
const LOOP: Cut = { build: framesIn(8.5), hold: framesIn(1.5) };
const TIMELAPSE: Cut = { build: framesIn(23), hold: framesIn(2) };

// ffmpeg arguments written as one line; none of them contain spaces.
const argv = (line: string) => line.split(' ');
// Level 4.1 caps x264's reference frames for phones and social uploads.
const H264 = argv(
  '-c:v libx264 -preset veryslow -tune animation -crf 18 -profile:v high -level:v 4.1 -movflags +faststart',
);
const VP9 = argv(
  '-c:v libvpx-vp9 -crf 24 -b:v 0 -deadline good -cpu-used 2 -row-mt 1',
);

const palette = stardust.palette.map(parseHexRgb);

function parseBoard(id: string): Board {
  const match = /^(\d+)x(\d+)$/.exec(id);
  if (!match) {
    throw new Error(`Unrecognized board "${id}"`);
  }
  return { width: Number(match[1]), height: Number(match[2]) };
}

// Placements painted by the end of each frame. They are spread evenly by
// count, not by time, so quiet days don't stall the video. The first frame is
// the blank board and the hold repeats the finished canvas.
function plan(total: number, cut: Cut): number[] {
  return [
    ...Array.from({ length: cut.build }, (_, i) =>
      Math.round((total * i) / (cut.build - 1)),
    ),
    ...Array<number>(cut.hold).fill(total),
  ];
}

function* render(
  board: Board,
  placements: Painted[],
  marks: number[],
): Generator<Buffer> {
  const rgb = Buffer.alloc(board.width * board.height * 3);
  for (let i = 0; i < board.width * board.height; i++) {
    rgb.set(palette[stardust.blank], i * 3);
  }
  let painted = 0;
  for (const mark of marks) {
    for (; painted < mark; painted++) {
      const { x, y, color } = placements[painted];
      rgb.set(palette[color], (y * board.width + x) * 3);
    }
    yield Buffer.from(rgb);
  }
}

function input({ width, height }: Board): string[] {
  return argv(
    `-f rawvideo -pix_fmt rgb24 -s ${width}x${height} -framerate ${FPS} -i pipe:0`,
  );
}

// Nearest-neighbor by an even factor keeps each board pixel a hard-edged block
// that 4:2:0 chroma never straddles. The sRGB tag keeps browsers' colors in
// line with the PNG poster, and setsar declares the square pixels X asks for.
function upscale({ width, height }: Board, scale: number): string {
  return [
    `scale=${width * scale}:${height * scale}:flags=neighbor:out_color_matrix=bt709:out_range=tv`,
    'format=yuv420p',
    'setparams=color_primaries=bt709:color_trc=iec61966-2-1',
    'setsar=1',
  ].join(',');
}

// Keyframes on the blank board and where the hold starts, so the finished
// canvas is coded whole instead of predicted through every placement.
function keyframes(cut: Cut): string[] {
  return ['-g', String(cut.build)];
}

async function ffmpeg(args: string[], video: Iterable<Buffer>): Promise<void> {
  const child = spawn(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-y', ...args],
    { stdio: ['pipe', 'inherit', 'inherit'] },
  );
  const exited = new Promise<void>((resolve, reject) => {
    child.on('error', (err: NodeJS.ErrnoException) => {
      reject(err.code === 'ENOENT' ? new Error('ffmpeg is not on PATH') : err);
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with code ${code}`));
      }
    });
  });
  // Writes fail with EPIPE once ffmpeg has quit; `exited` reports why.
  child.stdin.on('error', () => {});
  for (const frame of video) {
    if (!child.stdin.write(frame)) {
      await Promise.race([once(child.stdin, 'drain'), exited]);
    }
  }
  child.stdin.end();
  await exited;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { out: { type: 'string', default: 'out/stardust' } },
  });
  const out = resolve(values.out);

  dotenv.config({ quiet: true });
  const uri = process.env.MONGO_URI;
  if (!uri) {
    throw new Error('MONGO_URI is required');
  }

  // With autoIndex and autoCreate off, compiling the model sends nothing, so
  // the find is the only command this script runs.
  const conn = await mongoose
    .createConnection(uri, { autoIndex: false, autoCreate: false })
    .asPromise();
  const log = await conn
    .model(Placement.name, PlacementSchema)
    .find({}, { x: 1, y: 1, color: 1, at: 1, board: 1 })
    .sort({ at: 1, _id: 1 })
    .lean()
    .exec()
    .finally(() => conn.close());
  const newest = log.at(-1);
  if (!newest) {
    throw new Error('stardust_placements is empty');
  }

  // A resize starts a fresh board, so the newest placement's board is live.
  const placements = log.filter((p) => p.board === newest.board);
  const board = parseBoard(newest.board);
  for (const { x, y, color } of placements) {
    if (x < 0 || x >= board.width || y < 0 || y >= board.height) {
      throw new Error(`Placement (${x}, ${y}) is off board ${newest.board}`);
    }
    if (!palette[color]) {
      throw new Error(`Placement color ${color} is not in the palette`);
    }
  }
  const scale = Math.max(2, 2 * Math.round(TARGET_WIDTH / board.width / 2));

  const day = (at: Date) => at.toISOString().slice(0, 10);
  console.log(
    `${newest.board}: ${placements.length} placements from ${day(placements[0].at)} to ${day(newest.at)}, ` +
      `rendering at ${board.width * scale}x${board.height * scale}`,
  );
  if (placements.length < log.length) {
    console.log(
      `Skipped ${log.length - placements.length} placements from earlier boards`,
    );
  }

  mkdirSync(out, { recursive: true });
  const file = (name: string) => join(out, name);
  const wrote = (...names: string[]) => {
    for (const name of names) {
      const kb = statSync(file(name)).size / 1024;
      console.log(`  ${file(name)}  ${kb.toFixed(0)} KB`);
    }
  };

  await ffmpeg(
    [
      ...input(board),
      '-filter_complex',
      `[0:v]${upscale(board, scale)},split=2[webm][mp4]`,
      ...['-map', '[webm]', ...VP9, ...keyframes(LOOP)],
      file('stardust-loop.webm'),
      ...['-map', '[mp4]', ...H264, ...keyframes(LOOP)],
      file('stardust-loop.mp4'),
    ],
    render(board, placements, plan(placements.length, LOOP)),
  );
  wrote('stardust-loop.webm', 'stardust-loop.mp4');

  await ffmpeg(
    [
      ...input(board),
      ...['-vf', upscale(board, scale), ...H264, ...keyframes(TIMELAPSE)],
      file('stardust-timelapse.mp4'),
    ],
    render(board, placements, plan(placements.length, TIMELAPSE)),
  );
  wrote('stardust-timelapse.mp4');

  await ffmpeg(
    [
      ...input(board),
      '-vf',
      `scale=${board.width * scale}:${board.height * scale}:flags=neighbor`,
      ...argv('-frames:v 1 -update 1'),
      file('stardust-poster.png'),
    ],
    render(board, placements, [placements.length]),
  );
  wrote('stardust-poster.png');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
