import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
  UseInterceptors,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { ResponseInterceptor } from 'src/common/interceptors/response.interceptor';

import { assertBearer, Canvas, STARDUST_SECRET } from './canvas';
import { clientAddress, mintToken, parsePlaceBody } from './stardust.invariants';

@Controller('stardust')
export class StardustController {
  constructor(
    private readonly canvas: Canvas,
    @Inject(STARDUST_SECRET) private readonly secret: string,
  ) {}

  @Post('session')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(ResponseInterceptor)
  createSession(): { token: string } {
    return { token: mintToken(this.secret) };
  }

  @Get('board')
  async getBoard(@Res() res: Response): Promise<void> {
    const body = await this.canvas.snapshot();
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.status(HttpStatus.OK).send(body);
  }

  @Post('pixels')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(ResponseInterceptor)
  async placePixel(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const token = assertBearer(authorization);
    const parsed = parsePlaceBody(body);
    const ip = clientAddress(
      req.headers['x-forwarded-for'],
      req.socket.remoteAddress,
    );
    return this.canvas.place(token, ip, parsed.cell, parsed.color);
  }
}
