import { v4 as uuidv4 } from 'uuid';
import sharp from 'sharp';
import {
  generateTiles,
  countTiles,
  getImageMeta,
  cropRegionWithPadding,
  computeOverlap,
} from './imageTiler.js';
import {
  detectRegionsInTile,
  recognizeTextInCrop,
  STAGE1_SYSTEM_PROMPT,
  STAGE2_SYSTEM_PROMPT,
} from './qwenClient.js';
import {
  Detection,
  mergeDetectionsWithProvenance,
  BBox,
} from '../utils/bbox.js';
import { Response } from 'express';
import { sendProgress, sendComplete, sendError } from '../utils/sse.js';
import pLimit from 'p-limit';
import { DebugWriter, makeRunId } from './debugCapture.js';

/* ============================================================
 * 配置接口（严格遵循用户技术方案）
 * ============================================================ */
export interface PipelineOptions {
  // === 阶段一：Tiling 检测参数 ===
  tileSize?: number;           // 默认 1536
  overlapRatio?: number;       // 默认 0.45（推荐）
  // 兼容旧的绝对像素（如果提供则优先）
  overlap?: number;

  // === 阶段二：高清识别参数 ===
  contextPadding?: number;     // 外扩上下文，默认 50 像素

  // === 通用 ===
  maxConcurrency?: number;     // 并发限制，默认 2（保护限流和成本）
  stage1Model?: string;
  stage2Model?: string;        // 可与 stage1 不同，推荐用同一强模型

  // === 输出控制 ===
  saveArtifacts?: boolean;     // 是否生成 annotated.jpg 和 detections.json
  outputDir?: string;          // 保存目录，默认 ./output
  originalFileName?: string;   // 用于命名输出文件

  // === 调试模式 ===
  debug?: boolean;             // 是否抓取中间产物（瓦片/crop/manifest）
  debugDir?: string;           // debug 包根目录，默认 ./output/debug
}

export interface PipelineResult {
  imageWidth: number;
  imageHeight: number;
  detections: Detection[];     // 最终经过 Stage2 精炼的检测结果
  stats: {
    stage1Tiles: number;
    stage1Raw: number;         // Stage1 原始检出
    afterNMS: number;
    stage2Processed: number;   // 进入 Stage2 的数量
    finalCount: number;
    durationMs: number;
  };
  annotatedImageBuffer?: Buffer; // 如果 saveArtifacts 则生成
  jsonResult?: object;
  debugBundleId?: string;        // 调试模式产物目录名（用于前端拉取 manifest）
}

/* ============================================================
 * 主流程：严格按照「阶段一 → NMS合并 → 阶段二」的顺序
 * ============================================================ */
export async function runTwoStagePipeline(
  imageBuffer: Buffer,
  res?: Response,                 // 可选：用于 SSE 进度（Web 场景）
  options: PipelineOptions = {}
): Promise<PipelineResult> {
  const startTime = Date.now();

  // ---------- 读取配置 ----------
  const tileSize = options.tileSize ?? Number(process.env.TILE_SIZE) ?? 1536;
  const overlapRatio = options.overlapRatio ?? 0.45;
  const absoluteOverlap = options.overlap ?? computeOverlap(tileSize, overlapRatio);
  const padding = options.contextPadding ?? 50;
  const maxConcurrency = options.maxConcurrency ?? Number(process.env.MAX_CONCURRENCY) ?? 2;

  const stage1Model = options.stage1Model ?? process.env.QWEN_VL_MODEL ?? 'qwen-vl-max-latest';
  const stage2Model = options.stage2Model ?? stage1Model;

  const saveArtifacts = options.saveArtifacts ?? false;
  const outputDir = options.outputDir || './output';

  // ---------- 调试模式初始化 ----------
  const debug = options.debug ?? false;
  const debugDir = options.debugDir || './output/debug';
  const debugWriter: DebugWriter | null = debug ? new DebugWriter(makeRunId(), debugDir) : null;
  if (debugWriter) {
    await debugWriter.init();
    await debugWriter.writeOriginal(imageBuffer);
  }

  // ---------- 元数据 ----------
  const meta = await getImageMeta(imageBuffer);
  const { width: W, height: H } = meta;

  if (debugWriter) {
    debugWriter.setMeta(W, H, {
      tileSize,
      overlapRatio,
      overlapPx: absoluteOverlap,
      contextPadding: padding,
      maxConcurrency,
      stage1Model,
      stage2Model,
    });
  }

  const totalTiles = await countTiles(imageBuffer, tileSize, absoluteOverlap);

  sendProgressSafe(res, {
    stage: 'stage1_tiling',
    total: totalTiles,
    current: 0,
    message: `【阶段一】图片 ${W}×${H}，tileSize=${tileSize}，overlapRatio=${overlapRatio}，预计 ${totalTiles} 个瓦片`,
  });

  // ============================================================
  // 阶段一：重叠分块检测（找 BBox）
  // ============================================================
  const stage1Detections: Detection[] = [];
  let tilesProcessed = 0;

  const limit = pLimit(maxConcurrency);

  const tileJobs: Promise<void>[] = [];

  for await (const tile of generateTiles(imageBuffer, tileSize, absoluteOverlap)) {
    const job = limit(async () => {
      // 调试模式：落盘瓦片
      if (debugWriter) {
        await debugWriter.writeTile(tile.index, tile.x, tile.y, tile.width, tile.height, tile.buffer);
      }

      // 调用 Stage1 专用检测函数（高召回 Prompt）
      const localDets = await detectRegionsInTile(tile.buffer, stage1Model);

      // 映射到全局坐标
      for (const d of localDets) {
        const globalBbox: BBox = [
          tile.x + d.bbox[0],
          tile.y + d.bbox[1],
          tile.x + d.bbox[2],
          tile.y + d.bbox[3],
        ];
        stage1Detections.push({
          id: uuidv4(),
          text: d.text,
          bbox: globalBbox,
          confidence: d.confidence,
          sourceTile: tile.index,
          style: d.style,
        });
      }

      tilesProcessed += 1;

      sendProgressSafe(res, {
        stage: 'stage1_processing',
        current: tilesProcessed,
        total: totalTiles,
        message: `【阶段一】瓦片 ${tilesProcessed}/${totalTiles}，本瓦片检出 ${localDets.length} 处`,
        partialDetections: stage1Detections.length,
      });
    });

    tileJobs.push(job);
  }

  await Promise.all(tileJobs);

  sendProgressSafe(res, {
    stage: 'nms_merging',
    current: tilesProcessed,
    total: totalTiles,
    message: `【NMS+合并】Stage1 原始检出 ${stage1Detections.length}，正在执行 NMS + 相邻框合并...`,
  });

  // 调试模式：记录 Stage1 原始检出（合并前）
  if (debugWriter) {
    debugWriter.setStage1Raw(stage1Detections);
  }

  // NMS + 相邻框合并（严格按照技术方案要求），带溯源
  const mergeProv = mergeDetectionsWithProvenance(stage1Detections, {
    nmsIou: 0.45,
    adjacentMaxGap: 32,
    adjacentOverlap: 0.55,
  });
  const afterNMS = mergeProv.result;

  if (debugWriter) {
    debugWriter.setMerge(mergeProv);
  }

  sendProgressSafe(res, {
    stage: 'stage2_start',
    current: afterNMS.length,
    message: `【阶段二准备】NMS 后剩余 ${afterNMS.length} 个候选区域，开始高清 crop + 二次识别`,
  });

  // ============================================================
  // 阶段二：高清识别（对每个最终 BBox crop 后精确识别）
  // ============================================================
  const finalDetections: Detection[] = [];
  const stage2Limit = pLimit(Math.min(2, maxConcurrency)); // Stage2 更保守

  let stage2Done = 0;

  const stage2Jobs = afterNMS.map((det) =>
    stage2Limit(async () => {
      try {
        // 从原始大图 crop（外扩 padding）
        const { buffer: cropBuffer } = await cropRegionWithPadding(
          imageBuffer,
          det.bbox,
          padding,
          'jpeg'
        );

        // 调试模式：落盘 crop 小图
        const cropFile = debugWriter ? await debugWriter.writeCrop(det.id, cropBuffer) : undefined;

        // 送 Stage2 专用识别 Prompt
        const recog = await recognizeTextInCrop(cropBuffer, stage2Model);

        const refined: Detection = {
          ...det,
          // 保留 Stage1 的粗识别作为备选
          text: det.text,
          // 用 Stage2 的精确结果
          refinedText: recog.text || det.text,
          refinedConfidence: recog.confidence,
          refinedStyle: recog.style,
          confidence: recog.confidence ?? det.confidence,
          style: det.style || recog.style,
          cropFile,
        };

        finalDetections.push(refined);
      } catch (e: any) {
        console.warn('[Stage2] 单区域处理失败，保留 Stage1 结果:', e?.message);
        finalDetections.push(det); // 失败时至少保留 Stage1 的框
      }

      stage2Done += 1;

      sendProgressSafe(res, {
        stage: 'stage2_recognizing',
        current: stage2Done,
        total: afterNMS.length,
        message: `【阶段二】${stage2Done}/${afterNMS.length} 完成精炼识别`,
        partialDetections: finalDetections.length,
      });
    })
  );

  await Promise.all(stage2Jobs);

  // 最终排序（便于阅读）
  finalDetections.sort((a, b) => {
    const [ax1, ay1] = a.bbox;
    const [bx1, by1] = b.bbox;
    if (Math.abs(ay1 - by1) > 24) return ay1 - by1;
    return ax1 - bx1;
  });

  // ============================================================
  // 生成标注图 + JSON（可选）
  // ============================================================
  let annotatedImageBuffer: Buffer | undefined;
  let jsonResult: any;

  if (saveArtifacts) {
    sendProgressSafe(res, {
      stage: 'generating_annotated',
      message: '正在生成 annotated.jpg 和 detections.json ...',
    });

    annotatedImageBuffer = await generateAnnotatedImage(imageBuffer, finalDetections);

    jsonResult = {
      meta: {
        imageWidth: W,
        imageHeight: H,
        generatedAt: new Date().toISOString(),
        pipeline: 'two-stage-qwen-vl',
        tileSize,
        overlapRatio,
        contextPadding: padding,
        stage1Model,
        stage2Model,
      },
      stats: {
        stage1Raw: stage1Detections.length,
        afterNMS: afterNMS.length,
        final: finalDetections.length,
      },
      detections: finalDetections.map((d) => ({
        id: d.id,
        text: d.refinedText || d.text,
        bbox: d.bbox,
        confidence: d.refinedConfidence ?? d.confidence,
        style: d.refinedStyle || d.style,
        stage1Text: d.text,
        stage1Style: d.style,
      })),
    };

    // 写入磁盘
    await saveArtifactsToDisk(annotatedImageBuffer, jsonResult, outputDir, options.originalFileName);
  }

  // 调试模式：写入 manifest.json
  let debugBundleId: string | undefined;
  if (debugWriter) {
    await debugWriter.flush(finalDetections);
    debugBundleId = debugWriter.runId;
  }

  const result: PipelineResult = {
    imageWidth: W,
    imageHeight: H,
    detections: finalDetections,
    stats: {
      stage1Tiles: tilesProcessed,
      stage1Raw: stage1Detections.length,
      afterNMS: afterNMS.length,
      stage2Processed: afterNMS.length,
      finalCount: finalDetections.length,
      durationMs: Date.now() - startTime,
    },
    annotatedImageBuffer,
    jsonResult,
    debugBundleId,
  };

  // 打印文字列表（供知识库比对）
  printDetectionSummary(result);

  sendProgressSafe(res, {
    stage: 'complete',
    current: finalDetections.length,
    message: `完成！最终检出 ${finalDetections.length} 处文字（Stage1 原始 ${stage1Detections.length} → NMS后 ${afterNMS.length}）`,
  });

  if (res) {
    // Web 场景：发送适配后的 DetectResult 结构（字段名与前端对齐），
    // CLI 场景仍返回完整的 PipelineResult（stats 字段名更细）。
    sendComplete(res, {
      imageWidth: result.imageWidth,
      imageHeight: result.imageHeight,
      detections: result.detections,
      debugBundleId: result.debugBundleId,
      stats: {
        tilesProcessed: result.stats.stage1Tiles,
        rawDetections: result.stats.stage1Raw,
        afterDedup: result.stats.finalCount,
        durationMs: result.stats.durationMs,
      },
    });
  }

  return result;
}

/* ============================================================
 * 辅助函数
 * ============================================================ */

function sendProgressSafe(res: Response | undefined, payload: any) {
  if (res) {
    sendProgress(res, payload);
  } else {
    // CLI 模式直接打印
    if (payload.message) console.log(`[${payload.stage || 'progress'}] ${payload.message}`);
  }
}

/**
 * 使用 sharp + SVG 叠加在原图上绘制检测框和文字标签
 * 红色框 + 白色文字标签（带半透明背景）
 */
export async function generateAnnotatedImage(
  originalBuffer: Buffer,
  detections: Detection[]
): Promise<Buffer> {
  const meta = await getImageMeta(originalBuffer);
  const { width, height } = meta;

  // 构建 SVG 覆盖层（所有框和文字）
  let svgElements = '';

  for (const det of detections) {
    const [x1, y1, x2, y2] = det.bbox;
    const mainText = (det.refinedText || det.text || '').replace(/[<>&"']/g, '');
    const style = (det.refinedStyle || det.style || '').replace(/[<>&"']/g, '');
    const displayText = mainText.length > 28 ? mainText.slice(0, 26) + '…' : mainText;
    const labelText = style ? `${displayText} · ${style}` : displayText;

    // 框（红色，清晰醒目）
    svgElements += `
      <rect x="${x1}" y="${y1}" width="${x2 - x1}" height="${y2 - y1}"
            fill="none" stroke="#ff3b30" stroke-width="3.5" rx="2"/>
    `;

    // 标签背景 + 文字
    const labelY = Math.max(18, y1 - 6);
    const labelWidth = Math.min(labelText.length * 8.8 + 20, 320);
    svgElements += `
      <rect x="${x1}" y="${labelY - 16}" width="${labelWidth}" height="18"
            fill="#ff3b30" rx="3"/>
      <text x="${x1 + 6}" y="${labelY - 2}"
            font-family="PingFang SC, Microsoft YaHei, sans-serif"
            font-size="11.5" fill="#ffffff" font-weight="500">${labelText}</text>
    `;
  }

  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      ${svgElements}
    </svg>
  `.trim();

  const svgBuffer = Buffer.from(svg);

  // 合成到原图
  const annotated = await sharp(originalBuffer)
    .composite([
      {
        input: svgBuffer,
        top: 0,
        left: 0,
      },
    ])
    .jpeg({ quality: 92 })
    .toBuffer();

  return annotated;
}

async function saveArtifactsToDisk(
  annotatedBuffer: Buffer,
  jsonData: any,
  outputDir: string,
  originalName?: string
) {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');

  await fs.mkdir(outputDir, { recursive: true });

  const base = (originalName || 'image')
    .replace(/\.[^.]+$/, '')
    .replace(/[^\w\u4e00-\u9fa5-]/g, '_')
    .slice(0, 60);

  const annotatedPath = path.join(outputDir, `${base}_annotated.jpg`);
  const jsonPath = path.join(outputDir, `${base}_detections.json`);

  await fs.writeFile(annotatedPath, annotatedBuffer);
  await fs.writeFile(jsonPath, JSON.stringify(jsonData, null, 2));

  console.log(`\n[Artifacts] 已保存：`);
  console.log(`  - ${annotatedPath}`);
  console.log(`  - ${jsonPath}\n`);
}

/**
 * 在控制台打印检测到的文字列表（供后续知识库比对使用）
 */
function printDetectionSummary(result: PipelineResult) {
  console.log('\n' + '='.repeat(70));
  console.log(`【最终检测结果】共 ${result.detections.length} 处文字`);
  console.log('='.repeat(70));

  result.detections.forEach((d, i) => {
    const text = (d.refinedText || d.text || '(空)').trim();
    const conf = ((d.refinedConfidence ?? d.confidence ?? 0) * 100).toFixed(0);
    const [x1, y1, x2, y2] = d.bbox;
    const style = d.refinedStyle || d.style ? ` [${d.refinedStyle || d.style}]` : '';
    console.log(
      `${(i + 1).toString().padStart(3, ' ')}. [${x1},${y1},${x2},${y2}] (${conf}%)${style}  ${text}`
    );
  });

  if (result.detections.length === 0) {
    console.log('（未检测到任何文字）');
  }
  console.log('='.repeat(70) + '\n');
}

/* ============================================================
 * 兼容旧接口（保持 Web API 不破坏）
 * ============================================================ */
export interface DetectOptions {
  tileSize?: number;
  overlap?: number;
  overlapRatio?: number;
  maxConcurrency?: number;
  model?: string;
  contextPadding?: number;
  debug?: boolean;
  debugDir?: string;
}

export interface DetectResult {
  imageWidth: number;
  imageHeight: number;
  detections: Detection[];
  debugBundleId?: string;
  stats: {
    tilesProcessed: number;
    rawDetections: number;
    afterDedup: number;
    durationMs: number;
  };
}

export async function detectTextOnLargeImage(
  imageBuffer: Buffer,
  res: Response,
  options: DetectOptions = {}
): Promise<DetectResult> {
  const pipelineResult = await runTwoStagePipeline(imageBuffer, res, {
    tileSize: options.tileSize,
    overlap: options.overlap,
    overlapRatio: options.overlapRatio,
    maxConcurrency: options.maxConcurrency,
    stage1Model: options.model,
    stage2Model: options.model,
    contextPadding: options.contextPadding,
    // Web 场景默认不落盘，由前端负责可视化
    saveArtifacts: false,
    debug: options.debug,
    debugDir: options.debugDir,
  });

  // 适配旧的 DetectResult 结构
  return {
    imageWidth: pipelineResult.imageWidth,
    imageHeight: pipelineResult.imageHeight,
    detections: pipelineResult.detections,
    debugBundleId: pipelineResult.debugBundleId,
    stats: {
      tilesProcessed: pipelineResult.stats.stage1Tiles,
      rawDetections: pipelineResult.stats.stage1Raw,
      afterDedup: pipelineResult.stats.finalCount,
      durationMs: pipelineResult.stats.durationMs,
    },
  };
}
