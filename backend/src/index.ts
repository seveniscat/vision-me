import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs/promises';
import { detectTextOnLargeImage } from './services/detector.js';
import { uploadImage, isUploadConfigured } from './services/uploadClient.js';
import { initSSE, sendError } from './utils/sse.js';

// 调试包根目录（流水线落盘的 output/debug）
const DEBUG_DIR = path.resolve(process.env.DEBUG_DIR || './output/debug');

// runId 只允许字母/数字/下划线/短横，防止路径穿越
function isSafeRunId(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(id);
}

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;

// 允许大文件上传（刀模图经常 30~100MB+）
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 200 * 1024 * 1024, // 200MB
  },
});

// CORS（开发环境放开）
app.use(
  cors({
    origin: ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:3000'],
    credentials: true,
  })
);

// JSON body parser（用于 /api/detect 接收 { url }）
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// 核心接口：接收图片 URL，下载后进行全图文字检测（严格两阶段流程 + SSE 进度）
app.post('/api/detect', async (req, res) => {
  const url = typeof req.body?.url === 'string' ? req.body.url : '';
  if (!url) {
    res.status(400).json({ error: '缺少 url' });
    return;
  }

  // 设置 SSE 响应头
  initSSE(res);
  res.flushHeaders?.();

  let buffer: Buffer;
  try {
    buffer = await downloadImage(url);
    console.log(`[Detect] 下载完成: ${url}, ${(buffer.length / 1024 / 1024).toFixed(2)}MB`);
  } catch (err: any) {
    try {
      sendError(res, err?.message || '图片下载失败');
    } catch {}
    res.end();
    return;
  }

  try {
    await detectTextOnLargeImage(buffer, res, {
      tileSize: req.query.tileSize ? Number(req.query.tileSize) : undefined,
      overlap: req.query.overlap ? Number(req.query.overlap) : undefined,
      overlapRatio: req.query.overlapRatio ? Number(req.query.overlapRatio) : undefined,
      contextPadding: req.query.padding ? Number(req.query.padding) : undefined,
      maxConcurrency: req.query.concurrency ? Number(req.query.concurrency) : undefined,
      model: (req.query.model as string) || undefined,
      debug: req.query.debug === 'true',
    });
  } catch (err: any) {
    console.error('[Detect] 处理失败:', err);
    try {
      sendError(res, err?.message || '检测服务内部错误');
    } catch {}
  } finally {
    res.end();
  }
});

// 简单信息接口
app.get('/api/info', (_req, res) => {
  res.json({
    model: process.env.QWEN_VL_MODEL || 'qwen-vl-max-latest',
    tileSize: process.env.TILE_SIZE || 1536,
    overlapRatio: 0.45,
    contextPadding: 50,
    maxConcurrency: process.env.MAX_CONCURRENCY || 2,
    uploadEnabled: isUploadConfigured(),
    note: '严格按照「阶段一瓦片检测 → NMS合并 → 阶段二高清识别」两阶段流程实现',
  });
});

// ==================== 调试模式接口 ====================

// 获取某个运行包的 manifest（瓦片网格 / Stage1 原始框 / 合并溯源 / Stage2 crop 清单）
app.get('/api/debug/:runId', async (req, res) => {
  const runId = req.params.runId;
  if (!isSafeRunId(runId)) {
    res.status(400).json({ error: '非法 runId' });
    return;
  }
  const manifestPath = path.join(DEBUG_DIR, runId, 'manifest.json');
  try {
    const data = await fs.readFile(manifestPath, 'utf-8');
    res.type('application/json').send(data);
  } catch {
    res.status(404).json({ error: '调试包不存在' });
  }
});

// 提供调试包内的静态文件（原图 / 瓦片 / crop），带路径穿越防护
app.get('/api/debug/:runId/file/*', (req, res) => {
  const runId = req.params.runId;
  if (!isSafeRunId(runId)) {
    res.status(400).json({ error: '非法 runId' });
    return;
  }

  const rel = decodeURIComponent((req.params as Record<string, string>)['0'] || '');
  const parts = rel.split('/').filter(Boolean);
  if (parts.length === 0 || parts.some((p) => p === '..' || p.includes('\\'))) {
    res.status(400).json({ error: '非法路径' });
    return;
  }

  const runDir = path.resolve(DEBUG_DIR, runId);
  const filePath = path.resolve(runDir, ...parts);
  if (!filePath.startsWith(runDir + path.sep)) {
    res.status(400).json({ error: '非法路径' });
    return;
  }

  res.sendFile(filePath, (err) => {
    if (err) {
      res.status(404).json({ error: '文件不存在' });
    }
  });
});

// 图片上传（公司签名上传服务）：两步签名上传，返回可访问 URL 与文件名 key
app.post('/api/upload', upload.single('image'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: '请上传图片文件（字段名为 image）' });
    return;
  }

  const contentType = req.file.mimetype || '';
  if (!contentType.startsWith('image/')) {
    res.status(400).json({ error: '只支持图片文件 (jpg/png/webp 等)' });
    return;
  }

  console.log(
    `[Upload] 收到文件: ${req.file.originalname || 'unknown'}, 大小: ${(
      req.file.size / 1024 / 1024
    ).toFixed(2)}MB`
  );

  try {
    const { url, key } = await uploadImage(req.file.buffer, contentType, req.file.originalname);
    res.json({ url, key, name: req.file.originalname, size: req.file.size });
  } catch (err: any) {
    console.error('[Upload] 上传失败:', err?.message || err);
    res.status(500).json({ error: err?.message || '上传失败' });
  }
});

// 从 URL 下载图片到 Buffer，带超时和体积上限保护
async function downloadImage(url: string, timeoutMs = 30_000): Promise<Buffer> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('非法 url');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('url 必须是 http/https');
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(parsed, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ab = await res.arrayBuffer();
    const buf = Buffer.from(ab);
    if (buf.length > 200 * 1024 * 1024) {
      throw new Error(`图片过大 (${(buf.length / 1024 / 1024).toFixed(1)}MB > 200MB)`);
    }
    return buf;
  } catch (err: any) {
    if (err.name === 'AbortError') throw new Error('图片下载超时(30s)');
    throw new Error(`图片下载失败: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

app.listen(PORT, () => {
  console.log(`\n🚀 Vision-Me Backend 已启动`);
  console.log(`   端口: ${PORT}`);
  console.log(`   健康检查: http://localhost:${PORT}/health`);
  console.log(`   检测接口: POST http://localhost:${PORT}/api/detect (JSON body: { url })`);
  console.log(`   模型: ${process.env.QWEN_VL_MODEL || 'qwen-vl-max-latest (默认)'}\n`);
});
