import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { detectTextOnLargeImage } from './services/detector.js';
import { uploadToOss, isOssConfigured } from './services/ossClient.js';
import { initSSE, sendError } from './utils/sse.js';

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

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// 核心接口：上传图片并进行全图文字检测（严格两阶段流程 + SSE 进度）
app.post('/api/detect', upload.single('image'), async (req, res) => {
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
    `[Detect] 收到文件: ${req.file.originalname || 'unknown'}, 大小: ${(req.file.size / 1024 / 1024).toFixed(2)}MB`
  );

  // 设置 SSE 响应头
  initSSE(res);
  res.flushHeaders?.();

  try {
    await detectTextOnLargeImage(req.file.buffer, res, {
      // 严格技术方案推荐参数 + 可覆盖
      tileSize: req.query.tileSize ? Number(req.query.tileSize) : undefined,
      overlap: req.query.overlap ? Number(req.query.overlap) : undefined,
      overlapRatio: req.query.overlapRatio ? Number(req.query.overlapRatio) : undefined,
      contextPadding: req.query.padding ? Number(req.query.padding) : undefined,
      maxConcurrency: req.query.concurrency ? Number(req.query.concurrency) : undefined,
      model: (req.query.model as string) || undefined,
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
    ossEnabled: isOssConfigured(),
    note: '严格按照「阶段一瓦片检测 → NMS合并 → 阶段二高清识别」两阶段流程实现',
  });
});

// 图片上传到 OSS（独立能力）：返回可访问 URL 与对象 key
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
    const { url, key } = await uploadToOss(req.file.buffer, contentType, req.file.originalname);
    res.json({ url, key, name: req.file.originalname, size: req.file.size });
  } catch (err: any) {
    console.error('[Upload] 上传 OSS 失败:', err?.message || err);
    res.status(500).json({ error: err?.message || '上传失败' });
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 Vision-Me Backend 已启动`);
  console.log(`   端口: ${PORT}`);
  console.log(`   健康检查: http://localhost:${PORT}/health`);
  console.log(`   检测接口: POST http://localhost:${PORT}/api/detect (multipart, field=image)`);
  console.log(`   模型: ${process.env.QWEN_VL_MODEL || 'qwen-vl-max-latest (默认)'}\n`);
});
