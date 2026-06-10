import sharp from 'sharp';

export interface Tile {
  index: number;
  x: number; // global left
  y: number; // global top
  width: number;
  height: number;
  buffer: Buffer; // JPEG encoded tile
}

export interface ImageMeta {
  width: number;
  height: number;
  format?: string;
}

export async function getImageMeta(buffer: Buffer): Promise<ImageMeta> {
  const meta = await sharp(buffer).metadata();
  if (!meta.width || !meta.height) {
    throw new Error('无法读取图片尺寸');
  }
  return {
    width: meta.width,
    height: meta.height,
    format: meta.format,
  };
}

/**
 * 根据瓦片大小和重叠比例计算实际重叠像素
 */
export function computeOverlap(tileSize: number, overlapRatio: number): number {
  const ratio = Math.max(0, Math.min(0.8, overlapRatio));
  return Math.round(tileSize * ratio);
}

/**
 * 将超大图片切分为带重叠的瓦片（推荐 tileSize=1536, overlapRatio=0.45）
 * 使用惰性生成器，内存友好。
 */
export async function* generateTiles(
  imageBuffer: Buffer,
  tileSize: number,
  overlap: number // 绝对像素重叠（推荐由 overlapRatio 计算得出）
): AsyncGenerator<Tile> {
  const meta = await getImageMeta(imageBuffer);
  const { width, height } = meta;

  const step = Math.max(1, tileSize - overlap);

  let index = 0;

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const w = Math.min(tileSize, width - x);
      const h = Math.min(tileSize, height - y);

      // 提取瓦片并转为 JPEG（视觉模型更友好，体积小）
      const tileBuffer = await sharp(imageBuffer)
        .extract({ left: x, top: y, width: w, height: h })
        .jpeg({ quality: 92, chromaSubsampling: '4:2:0' })
        .toBuffer();

      yield {
        index,
        x,
        y,
        width: w,
        height: h,
        buffer: tileBuffer,
      };

      index += 1;
    }
  }
}

/** 计算总瓦片数量（用于进度显示） */
export async function countTiles(
  imageBuffer: Buffer,
  tileSize: number,
  overlap: number
): Promise<number> {
  const meta = await getImageMeta(imageBuffer);
  const { width, height } = meta;
  const step = Math.max(1, tileSize - overlap);

  const cols = Math.ceil(width / step);
  const rows = Math.ceil(height / step);
  return cols * rows;
}

/**
 * 从原始高分辨率图片中 crop 一个区域，并外扩 contextPadding 像素上下文。
 * 这是 Stage 2 的核心：给模型一个“高清聚焦”的小图进行精确识别。
 */
export async function cropRegionWithPadding(
  imageBuffer: Buffer,
  bbox: [number, number, number, number],
  padding: number = 50,
  outputFormat: 'jpeg' | 'png' = 'jpeg'
): Promise<{ buffer: Buffer; cropBbox: [number, number, number, number] }> {
  const meta = await getImageMeta(imageBuffer);
  const { width, height } = meta;

  let [x1, y1, x2, y2] = bbox;

  // 外扩上下文（保证艺术字的装饰效果不被切断）
  const px = Math.max(0, Math.floor(padding));
  x1 = Math.max(0, x1 - px);
  y1 = Math.max(0, y1 - px);
  x2 = Math.min(width, x2 + px);
  y2 = Math.min(height, y2 + px);

  const cropW = Math.max(8, x2 - x1);
  const cropH = Math.max(8, y2 - y1);

  let pipeline = sharp(imageBuffer).extract({
    left: Math.floor(x1),
    top: Math.floor(y1),
    width: Math.floor(cropW),
    height: Math.floor(cropH),
  });

  if (outputFormat === 'jpeg') {
    pipeline = pipeline.jpeg({ quality: 95, chromaSubsampling: '4:2:0' });
  } else {
    pipeline = pipeline.png({ compressionLevel: 6 });
  }

  const buffer = await pipeline.toBuffer();

  return {
    buffer,
    cropBbox: [x1, y1, x2, y2] as [number, number, number, number], // 实际最终裁剪的全局坐标
  };
}
