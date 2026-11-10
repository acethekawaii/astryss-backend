import { INestApplication, Logger } from '@nestjs/common';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Model } from 'mongoose';
import request from 'supertest';
import type { App } from 'supertest/types';

import { HttpExceptionFilter } from 'src/common/filters/http-exception.filter';

import type { UnhashedIp } from '../stardust/types/stardust.types';
import { VisitDay, VisitDayDocument } from './schemas/visit-day.schema';
import { Visitor, VisitorDocument } from './schemas/visitor.schema';
import { siteStats } from './site-stats.config';
import { manilaDate } from './site-stats.invariants';
import { SiteStatsModule } from './site-stats.module';
import type { VisitSummary } from './types/site-stats.types';
import { Visits } from './visits';

jest.setTimeout(60_000);

const SECRET = 'site-stats-test-secret-0123456789abcdef';
const BROWSER =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const HIT = '/api/v2/stats/visits/hit';
const VISITS = '/api/v2/stats/visits';

describe('site stats', () => {
  let mongo: MongoMemoryServer;
  let app: INestApplication<App>;
  let visits: Visits;
  let days: Model<VisitDayDocument>;
  let visitors: Model<VisitorDocument>;
  let dbCount = 0;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
  });

  afterAll(async () => {
    await mongo.stop();
  });

  beforeEach(async () => {
    dbCount += 1;
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongo.getUri(`site-stats-${dbCount}`)),
        SiteStatsModule.forRoot({ secret: SECRET }),
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v2');
    app.useGlobalFilters(new HttpExceptionFilter());
    // Listening once lets parallel requests share one server; supertest
    // would otherwise listen and close it for every request.
    await app.listen(0, '127.0.0.1');
    visits = app.get(Visits);
    days = app.get(getModelToken(VisitDay.name));
    visitors = app.get(getModelToken(Visitor.name));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  function hit(ip: string, userAgent: string | null = BROWSER) {
    const req = request(app.getHttpServer())
      .post(HIT)
      .set('X-Forwarded-For', ip);
    if (userAgent !== null) {
      req.set('User-Agent', userAgent);
    }
    return req.send({ path: '/release' });
  }

  async function getVisits(): Promise<VisitSummary> {
    const res = await request(app.getHttpServer()).get(VISITS).expect(200);
    return res.body as VisitSummary;
  }

  it('counts 100 parallel hits exactly', async () => {
    const responses = await Promise.all(
      Array.from({ length: 100 }, (_, i) => hit(`198.51.100.${i}`)),
    );
    expect(responses.map((res) => res.status)).toEqual(Array(100).fill(204));
    await visits.drain();

    await expect(getVisits()).resolves.toEqual({
      totalPageviews: 100,
      todayPageviews: 100,
      todayVisitors: 100,
      since: manilaDate(Date.now()),
    });
    expect(await days.countDocuments()).toBe(1);
  });

  it('counts 100 parallel hits from one browser as 100 page views and 1 visitor', async () => {
    const nowMs = Date.now();
    for (let i = 0; i < 100; i++) {
      visits.track('203.0.113.9' as UnhashedIp, BROWSER, nowMs);
    }
    await visits.drain();

    await expect(visits.summary(nowMs)).resolves.toMatchObject({
      totalPageviews: 100,
      todayPageviews: 100,
      todayVisitors: 1,
    });
    expect(await visitors.countDocuments()).toBe(1);
  });

  it('counts one browser once a day, and another IP or user agent as another visitor', async () => {
    for (let i = 0; i < 5; i++) {
      await hit('203.0.113.7').expect(204);
    }
    await hit('203.0.113.7', `${BROWSER} Edg/130.0`).expect(204);
    await hit('203.0.113.8').expect(204);
    await visits.drain();

    await expect(getVisits()).resolves.toMatchObject({
      totalPageviews: 7,
      todayPageviews: 7,
      todayVisitors: 3,
    });
  });

  it('ignores bots and requests without a user agent', async () => {
    const bots = [
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)',
      'Mozilla/5.0 (compatible; Baiduspider/2.0)',
      'SemrushCrawler/1.0',
      'WhatsApp/2.23 Link Preview',
      '',
    ];
    for (const userAgent of bots) {
      await hit('203.0.113.7', userAgent).expect(204);
    }
    await hit('203.0.113.7', null).expect(204);
    await visits.drain();

    expect(await days.countDocuments()).toBe(0);
    expect(await visitors.countDocuments()).toBe(0);
  });

  it('rate-limits hits per IP and does not count the excess', async () => {
    const responses = await Promise.all(
      Array.from({ length: siteStats.hitLimit + 5 }, () => hit('203.0.113.7')),
    );
    const statuses = responses.map((res) => res.status);
    expect(statuses.filter((status) => status === 204)).toHaveLength(
      siteStats.hitLimit,
    );
    expect(statuses.filter((status) => status === 429)).toHaveLength(5);
    await hit('203.0.113.8').expect(204);
    await visits.drain();

    await expect(getVisits()).resolves.toMatchObject({
      totalPageviews: siteStats.hitLimit + 1,
      todayVisitors: 2,
    });
  });

  it('resets today at Manila midnight while the total keeps going', async () => {
    const ip = '203.0.113.7' as UnhashedIp;
    const lastSecond = Date.UTC(2026, 10, 10, 15, 59, 59);
    const midnight = Date.UTC(2026, 10, 10, 16, 0, 0);

    for (let i = 0; i < 3; i++) {
      visits.track(ip, BROWSER, lastSecond);
    }
    await visits.drain();
    await expect(visits.summary(lastSecond)).resolves.toEqual({
      totalPageviews: 3,
      todayPageviews: 3,
      todayVisitors: 1,
      since: '2026-11-10',
    });

    for (let i = 0; i < 2; i++) {
      visits.track(ip, BROWSER, midnight);
    }
    await visits.drain();
    // One second after the last read, inside its cache window: the new day
    // still reads fresh.
    await expect(visits.summary(midnight)).resolves.toEqual({
      totalPageviews: 5,
      todayPageviews: 2,
      todayVisitors: 1,
      since: '2026-11-10',
    });
    expect(
      await days.find({}, { _id: 0 }).sort({ date: 1 }).lean().exec(),
    ).toEqual([
      { date: '2026-11-10', pageviews: 3, visitors: 1 },
      { date: '2026-11-11', pageviews: 2, visitors: 1 },
    ]);
  });

  it('serves one read for the cache window', async () => {
    const ip = '203.0.113.7' as UnhashedIp;
    const nowMs = Date.UTC(2026, 10, 10, 4, 0, 0);

    visits.track(ip, BROWSER, nowMs);
    await visits.drain();
    await expect(visits.summary(nowMs)).resolves.toMatchObject({
      totalPageviews: 1,
    });

    visits.track(ip, BROWSER, nowMs + 1000);
    await visits.drain();
    await expect(
      visits.summary(nowMs + siteStats.summaryTtlMs - 1),
    ).resolves.toMatchObject({ totalPageviews: 1 });
    await expect(
      visits.summary(nowMs + siteStats.summaryTtlMs),
    ).resolves.toMatchObject({ totalPageviews: 2 });
  });

  it('returns plain JSON with a public Cache-Control matching the cache window', async () => {
    const res = await request(app.getHttpServer()).get(VISITS).expect(200);

    expect(res.headers['cache-control']).toBe('public, max-age=60');
    expect(res.body).toEqual({
      totalPageviews: 0,
      todayPageviews: 0,
      todayVisitors: 0,
      since: null,
    });
  });

  it('stores no raw IP or user agent', async () => {
    const ip = '203.0.113.42';
    await hit(ip).expect(204);
    await visits.drain();

    const stored = JSON.stringify([
      await days.find().lean().exec(),
      await visitors.find().lean().exec(),
    ]);
    expect(stored).not.toContain(ip);
    expect(stored).not.toContain('Mozilla');

    const [visitor] = await visitors.find({}, { _id: 0 }).lean().exec();
    expect(Object.keys(visitor).sort()).toEqual(['at', 'date', 'hash']);
    expect(visitor.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('expires visitor hashes after a few days and keeps day counts', async () => {
    const visitorIndexes = await visitors.collection.indexes();
    expect(visitorIndexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: { at: 1 },
          expireAfterSeconds: siteStats.visitorHashTtlSeconds,
        }),
        expect.objectContaining({ key: { date: 1, hash: 1 }, unique: true }),
      ]),
    );

    const dayIndexes = await days.collection.indexes();
    expect(dayIndexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: { date: 1 }, unique: true }),
      ]),
    );
    expect(
      dayIndexes.some((index) => index.expireAfterSeconds !== undefined),
    ).toBe(false);
  });

  it('rejects a hit without a valid path and does not count it', async () => {
    const post = () =>
      request(app.getHttpServer()).post(HIT).set('User-Agent', BROWSER);

    await post().send({}).expect(400);
    await post().send({ path: 'release' }).expect(400);
    await post()
      .set('Content-Type', 'text/plain')
      .send('{"path":"/release"}')
      .expect(400);
    await visits.drain();

    expect(await days.countDocuments()).toBe(0);
  });

  it('answers 204 before the write finishes, and a failed write is only logged', async () => {
    let fail!: (err: Error) => void;
    const stalled = new Promise<never>((_, reject) => {
      fail = reject;
    });
    jest
      .spyOn(visitors, 'updateOne')
      .mockReturnValue({ exec: () => stalled } as never);
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    await hit('203.0.113.7').expect(204);
    fail(new Error('Mongo is down'));
    await visits.drain();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Mongo is down'));
    expect(await days.countDocuments()).toBe(0);
  });
});
