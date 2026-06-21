import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { BBox, Detection, MergeProvenance } from '../utils/bbox.js';

/**
 * 调试模式：把两阶段流水线的中间产物（原图 / 每个瓦片 / 每个 Stage2 crop）
 * 落盘到一个按次运行的目录，并生成 manifest.json 供前端调试视图加载。
 *
 * 目录结构：
 *   <debugDir>/<runId>/
 *     ├── original.jpg
 *     ├── manifest.json
 *     ├── tiles/0.jpg, 1.jpg, ...
 *     └── crops/<detId>.jpg
 */

export interface DebugTileEntry {
  index: number;
  x: number; // global left
  y: number; // global top
  width: number;
  height: number;
  file: string; // 相对 run 目录，如 "tiles/0.jpg"
}

export interface DebugStage1Raw {
  id: string;
  text: string;
  bbox: BBox;
  confidence?: number;
  style?: string;
  sourceTile?: number;
}

export interface DebugFinalEntry {
  id: string;
  text: string; // Stage1 粗识
  refinedText?: string;
  bbox: BBox;
  confidence?: number;
  refinedConfidence?: number;
  style?: string;
  refinedStyle?: string;
  sourceTile?: number;
  cropFile?: string; // "crops/<id>.jpg"
}

export interface DebugManifest {
  runId: string;
  createdAt: string;
  imageWidth: number;
  imageHeight: number;
  params: {
    tileSize: number;
    overlapRatio: number;
    overlapPx: number;
    contextPadding: number;
    maxConcurrency: number;
    stage1Model: string;
    stage2Model: string;
  };
  originalImage: string; // "original.jpg"
  tiles: DebugTileEntry[];
  stage1Raw: DebugStage1Raw[];
  merge: {
    suppressed: MergeProvenance['suppressed'];
    mergedGroups: MergeProvenance['mergedGroups'];
    afterCount: number;
  };
  final: DebugFinalEntry[];
}

export class DebugWriter {
  readonly runId: string;
  readonly runDir: string;
  private tiles: DebugTileEntry[] = [];
  private stage1Raw: DebugStage1Raw[] = [];
  private mergeProvenance: MergeProvenance | null = null;
  private imageWidth = 0;
  private imageHeight = 0;
  private params: DebugManifest['params'] | null = null;

  constructor(runId: string, baseDir: string) {
    this.runId = runId;
    this.runDir = path.join(baseDir, runId);
  }

  async init() {
    await fs.mkdir(path.join(this.runDir, 'tiles'), { recursive: true });
    await fs.mkdir(path.join(this.runDir, 'crops'), { recursive: true });
  }

  setMeta(w: number, h: number, params: DebugManifest['params']) {
    this.imageWidth = w;
    this.imageHeight = h;
    this.params = params;
  }

  /** 把原图归一化为 JPEG 落盘，保证前端能直接显示 */
  async writeOriginal(buffer: Buffer) {
    await sharp(buffer).jpeg({ quality: 90 }).toFile(path.join(this.runDir, 'original.jpg'));
  }

  async writeTile(index: number, x: number, y: number, w: number, h: number, buffer: Buffer) {
    const rel = `tiles/${index}.jpg`;
    await fs.writeFile(path.join(this.runDir, rel), buffer);
    this.tiles.push({ index, x, y, width: w, height: h, file: rel });
  }

  setStage1Raw(dets: Detection[]) {
    this.stage1Raw = dets.map((d) => ({
      id: d.id,
      text: d.text,
      bbox: d.bbox,
      confidence: d.confidence,
      style: d.style,
      sourceTile: d.sourceTile,
    }));
  }

  setMerge(prov: MergeProvenance) {
    this.mergeProvenance = prov;
  }

  async writeCrop(detId: string, buffer: Buffer): Promise<string> {
    const rel = `crops/${detId}.jpg`;
    await fs.writeFile(path.join(this.runDir, rel), buffer);
    return rel;
  }

  async flush(final: Detection[]): Promise<DebugManifest> {
    const manifest: DebugManifest = {
      runId: this.runId,
      createdAt: new Date().toISOString(),
      imageWidth: this.imageWidth,
      imageHeight: this.imageHeight,
      params:
        this.params || {
          tileSize: 0,
          overlapRatio: 0,
          overlapPx: 0,
          contextPadding: 0,
          maxConcurrency: 0,
          stage1Model: '',
          stage2Model: '',
        },
      originalImage: 'original.jpg',
      tiles: this.tiles,
      stage1Raw: this.stage1Raw,
      merge: {
        suppressed: this.mergeProvenance?.suppressed || [],
        mergedGroups: this.mergeProvenance?.mergedGroups || [],
        afterCount: this.mergeProvenance?.result.length ?? final.length,
      },
      final: final.map((d) => ({
        id: d.id,
        text: d.text,
        refinedText: d.refinedText,
        bbox: d.bbox,
        confidence: d.confidence,
        refinedConfidence: d.refinedConfidence,
        style: d.style,
        refinedStyle: d.refinedStyle,
        sourceTile: d.sourceTile,
        cropFile: d.cropFile,
      })),
    };

    await fs.writeFile(path.join(this.runDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    return manifest;
  }
}

/** 生成文件系统 / URL 安全的 runId：时间戳 + 短随机串 */
export function makeRunId(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
