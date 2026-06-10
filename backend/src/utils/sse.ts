import { Response } from 'express';

export function initSSE(res: Response) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // 禁用 nginx 等代理缓冲
  res.setHeader('X-Accel-Buffering', 'no');
}

export function sendEvent(res: Response, event: string, data: unknown) {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  res.write(`event: ${event}\ndata: ${payload}\n\n`);
}

export function sendProgress(
  res: Response,
  payload: {
    stage: string;
    current?: number;
    total?: number;
    message?: string;
    partialDetections?: number;
  }
) {
  sendEvent(res, 'progress', payload);
}

export function sendComplete(res: Response, payload: unknown) {
  sendEvent(res, 'complete', payload);
}

export function sendError(res: Response, error: string) {
  sendEvent(res, 'error', { error });
}
