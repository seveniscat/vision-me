import { createHash } from 'node:crypto';

/**
 * 公司签名上传服务客户端。
 *
 * 严格镜像 ui-admin-template 的 `src/utils/upload`（签名）+ `src/services/common/upload`（两步上传），
 * 不引入新依赖（用 Node 内置 crypto / fetch）。
 *
 * 流程：
 *   1. GET  {API_UPLOAD}/upload/token   —— appId + rnd + timestamp + MD5 signature → uploadToken
 *   2. POST {API_UPLOAD}/upload/single  —— file + appId + uploadToken → filename
 *   3. URL = {API_UPLOAD_HOST}/file/{filename}
 *
 * 签名算法（同 getSignature）：参数按 key 字母序排 → `key=value` 用 `&` 连 → 尾部拼 SECRET → md5(hex)。
 *
 * 配置（.env）：API_UPLOAD / API_UPLOAD_APPID / API_UPLOAD_SECRET / API_UPLOAD_HOST
 */

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
};

interface UploadConfig {
  base: string;
  appId: string;
  secret: string;
  host: string;
}

interface UploadServiceResp {
  code?: number;
  message?: string;
  data?: { uploadToken?: string; expires?: number; filename?: string };
}

export function isUploadConfigured(): boolean {
  return !!(
    process.env.API_UPLOAD &&
    process.env.API_UPLOAD_APPID &&
    process.env.API_UPLOAD_SECRET &&
    process.env.API_UPLOAD_HOST
  );
}

function getConfig(): UploadConfig {
  if (!isUploadConfigured()) {
    throw new Error(
      '上传服务未配置：请在 .env 设置 API_UPLOAD / API_UPLOAD_APPID / API_UPLOAD_SECRET / API_UPLOAD_HOST'
    );
  }
  return {
    base: process.env.API_UPLOAD!.replace(/\/$/, ''),
    appId: process.env.API_UPLOAD_APPID!,
    secret: process.env.API_UPLOAD_SECRET!,
    host: process.env.API_UPLOAD_HOST!.replace(/\/$/, ''),
  };
}

/** 随机字符串（镜像参考实现 randomString，字符表一致） */
function randomString(len = 8): string {
  const chars = 'ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678';
  let s = '';
  for (let i = 0; i < len; i++) {
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return s;
}

/** MD5 签名（镜像 getSignature）：key 排序 → `key=value` 用 & 连 → 尾部拼 SECRET → md5 */
function sign(params: Record<string, string>, secret: string): string {
  const sorted = Object.keys(params)
    .map((k) => k.trim())
    .sort((a, b) => a.localeCompare(b));
  const base = sorted.map((k) => `${k}=${params[k]}`).join('&');
  return createHash('md5').update(base + secret).digest('hex');
}

/** 构造上传签名参数：{ appId, rnd, timestamp, signature } */
function buildSignParams(appId: string, secret: string): Record<string, string> {
  const params: Record<string, string> = {
    appId,
    rnd: randomString(8),
    timestamp: String(Math.floor(Date.now() / 1000)),
  };
  params.signature = sign(params, secret);
  return params;
}

/** 第一步：GET /upload/token 拿 uploadToken */
async function getUploadToken(cfg: UploadConfig): Promise<string> {
  const params = buildSignParams(cfg.appId, cfg.secret);
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${cfg.base}/upload/token?${qs}`, { method: 'GET' });
  const json = (await res.json()) as UploadServiceResp;
  if (json.code !== 0 || !json.data?.uploadToken) {
    throw new Error(`获取上传凭证失败: ${json.message || res.status}`);
  }
  return json.data.uploadToken;
}

/** 第二步：POST /upload/single 传文件，返回服务端生成的 filename */
async function uploadSingle(
  cfg: UploadConfig,
  uploadToken: string,
  buffer: Buffer,
  filename: string,
  mimetype: string
): Promise<string> {
  const form = new FormData();
  // 复制到普通 ArrayBuffer 再构造 Blob（Buffer 可能基于 SharedArrayBuffer，不兼容 BlobPart）
  const bytes = new Uint8Array(buffer.byteLength);
  bytes.set(buffer);
  form.append('file', new Blob([bytes.buffer], { type: mimetype }), filename);
  form.append('appId', cfg.appId);
  form.append('uploadToken', uploadToken);

  const res = await fetch(`${cfg.base}/upload/single`, { method: 'POST', body: form });
  const json = (await res.json()) as UploadServiceResp;
  if (json.code !== 0 || !json.data?.filename) {
    throw new Error(`上传失败: ${json.message || res.status}`);
  }
  return json.data.filename;
}

/**
 * 上传图片 buffer 到签名上传服务，返回可访问 URL 与文件名 key。
 */
export async function uploadImage(
  buffer: Buffer,
  mimetype: string,
  originalName?: string
): Promise<{ url: string; key: string }> {
  const cfg = getConfig();
  const token = await getUploadToken(cfg);
  const ext = EXT_BY_MIME[mimetype] || 'bin';
  const uploadFilename = originalName || `upload-${Date.now()}.${ext}`;
  const key = await uploadSingle(cfg, token, buffer, uploadFilename, mimetype);
  return { url: `${cfg.host}/file/${key}`, key };
}
