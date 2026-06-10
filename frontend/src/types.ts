export interface Detection {
  id: string;
  text: string;                    // Stage1 粗识别（保留）
  refinedText?: string;            // Stage2 精炼后的最终文字（优先使用）
  bbox: [number, number, number, number]; // 全局原始像素坐标
  confidence?: number;
  refinedConfidence?: number;
  style?: string;                  // Stage1 风格
  refinedStyle?: string;           // Stage2 风格
  sourceTile?: number;
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
  stats: {
    tilesProcessed: number;
    rawDetections: number;
    afterDedup: number;
    durationMs: number;
  };
}
