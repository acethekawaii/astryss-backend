import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { IncomingMessage } from 'http';
import { Duplex } from 'stream';
import { WebSocketServer } from 'ws';

import { getAllowedOrigins } from 'src/config/allowed-origins';

import { Canvas } from './canvas';

const LIVE_PATH = '/api/v2/stardust/live';

@Injectable()
export class LiveGateway implements OnModuleInit, OnModuleDestroy {
  private wss: WebSocketServer | null = null;
  private readonly onUpgrade = (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => {
    const host = req.headers.host ?? 'localhost';
    const pathname = new URL(req.url ?? '/', `http://${host}`).pathname;
    if (pathname !== LIVE_PATH) {
      return;
    }
    if (!this.wss) {
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const origin = req.headers.origin;
      if (!origin || !getAllowedOrigins().includes(origin)) {
        ws.close(1008);
        return;
      }
      this.canvas.watch(ws);
    });
  };

  constructor(
    private readonly canvas: Canvas,
    private readonly httpAdapterHost: HttpAdapterHost,
  ) {}

  onModuleInit(): void {
    this.wss = new WebSocketServer({ noServer: true });
    const server = this.httpAdapterHost.httpAdapter.getHttpServer();
    server.on('upgrade', this.onUpgrade);
  }

  onModuleDestroy(): void {
    const server = this.httpAdapterHost.httpAdapter.getHttpServer();
    server.off('upgrade', this.onUpgrade);
    this.wss?.close();
    this.wss = null;
  }
}
