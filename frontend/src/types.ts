export type BBox = [number, number, number, number];

export interface Detection {
  id: string;
  text: string;                    // Stage1 粗识别（保留）
  refinedText?: string;            // Stage2 精炼后的最终文字（优先使用）
  bbox: BBox;                      // 全局原始像素坐标
  confidence?: number;
  refinedConfidence?: number;
  style?: string;                  // Stage1 风格
  refinedStyle?: string;           // Stage2 风格
  sourceTile?: number;
  cropFile?: string;               // 调试模式：对应的 Stage2 crop 文件
}

export interface DetectProgress {
  stage: string;
  current?: number;
  total?: number;
  message?: string;
  partialDetections?: number;
}

export interface DetectResult {
  imageWidth: number;
  imageHeight: number;
  detections: Detection[];
  debugBundleId?: string;          // 调试模式产物 id（有值则可拉取 manifest）
  stats: {
    tilesProcessed: number;
    rawDetections: number;
    afterDedup: number;
    durationMs: number;
  };
}

/* ==================== 调试包类型（与后端 manifest 对齐） ==================== */

export interface DebugTileEntry {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
  file: string; // 相对 run 目录
}

export interface DebugStage1Raw {
  id: string;
  text: string;
  bbox: BBox;
  confidence?: number;
  style?: string;
  sourceTile?: number;
}

export interface DebugSuppressed {
  id: string;
  bbox: BBox;
  text: string;
  suppressedBy: string; // 抑制它的保留框 id
  iou: number;
  phase: 'nms1' | 'nms2';
}

export interface DebugMergedGroup {
  intoId: string;
  fromIds: string[];
}

export interface DebugFinalEntry {
  id: string;
  text: string;            // Stage1 粗识
  refinedText?: string;
  bbox: BBox;
  confidence?: number;
  refinedConfidence?: number;
  style?: string;
  refinedStyle?: string;
  sourceTile?: number;
  cropFile?: string;       // "crops/<id>.jpg"
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
  originalImage: string;
  tiles: DebugTileEntry[];
  stage1Raw: DebugStage1Raw[];
  merge: {
    suppressed: DebugSuppressed[];
    mergedGroups: DebugMergedGroup[];
    afterCount: number;
  };
  final: DebugFinalEntry[];
}
