import OSS from 'ali-oss';

/**
 * 阿里云 OSS 客户端（单例）。凭证从环境变量读取，不硬编码。
 *
 * 需要：OSS_REGION / OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET / OSS_BUCKET
 * 可选：OSS_ENDPOINT（自定义域名/内网/CDN endpoint）
 *
 * 假设 bucket 为「公共读」，put 后返回的 url 可直接访问；
 * 私有桶需另行签名 URL（后续按需扩展）。
 */

let client: OSS | null = null;

function getClient(): OSS {
  if (client) return client;

  const region = process.env.OSS_REGION;
  const accessKeyId = process.env.OSS_ACCESS_KEY_ID;
  const accessKeySecret = process.env.OSS_ACCESS_KEY_SECRET;
  const bucket = process.env.OSS_BUCKET;
  const endpoint = process.env.OSS_ENDPOINT;

  if (!region || !accessKeyId || !accessKeySecret || !bucket) {
    throw new Error(
      'OSS 未配置：请在 .env 设置 OSS_REGION / OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET / OSS_BUCKET'
    );
  }

  const opts: OSS.Options = {
    region,
    accessKeyId,
    accessKeySecret,
    bucket,
    secure: true, // 强制 HTTPS
  };
  if (endpoint) opts.endpoint = endpoint;

  client = new OSS(opts);
  return client;
}

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
};

/**
 * 上传图片 buffer 到 OSS，返回可访问 URL 与对象 key。
 */
export async function uploadToOss(
  buffer: Buffer,
  mimetype: string,
  _originalName?: string
): Promise<{ url: string; key: string }> {
  const c = getClient();
  const ext = EXT_BY_MIME[mimetype] || 'bin';
  const stamp = Date.now();
  const rand = Math.random().toString(36).slice(2, 10);
  const key = `vision-me/${stamp}-${rand}.${ext}`;

  const result = await c.put(key, buffer);
  return { url: result.url, key };
}

/** 是否已配置 OSS（前端可据此决定是否启用上传入口） */
export function isOssConfigured(): boolean {
  return !!(
    process.env.OSS_REGION &&
    process.env.OSS_ACCESS_KEY_ID &&
    process.env.OSS_ACCESS_KEY_SECRET &&
    process.env.OSS_BUCKET
  );
}
