export type BBox = [number, number, number, number]; // [x1, y1, x2, y2] 左上右下，相对于图片左上角(0,0)

export interface Detection {
  id: string;
  text: string;                    // Stage1 初步识别
  bbox: BBox;
  confidence?: number;
  sourceTile?: number;

  style?: string;                  // 来自模型的艺术风格描述

  // Stage2 精炼后的信息
  refinedText?: string;
  refinedConfidence?: number;
  refinedStyle?: string;
}

/** 计算两个 bbox 的 IoU (Intersection over Union) */
export function iou(a: BBox, b: BBox): number {
  const [ax1, ay1, ax2, ay2] = a;
  const [bx1, by1, bx2, by2] = b;

  const interX1 = Math.max(ax1, bx1);
  const interY1 = Math.max(ay1, by1);
  const interX2 = Math.min(ax2, bx2);
  const interY2 = Math.min(ay2, by2);

  const interW = Math.max(0, interX2 - interX1);
  const interH = Math.max(0, interY2 - interY1);
  const interArea = interW * interH;

  if (interArea === 0) return 0;

  const areaA = (ax2 - ax1) * (ay2 - ay1);
  const areaB = (bx2 - bx1) * (by2 - by1);
  const union = areaA + areaB - interArea;

  return interArea / union;
}

/** 计算 bbox 面积 */
export function bboxArea(b: BBox): number {
  return Math.max(0, (b[2] - b[0]) * (b[3] - b[1]));
}

/** 文本归一化（用于相似度判断） */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s\u3000\u00A0]+/g, '')
    .replace(/[·•・—–―]+/g, '')
    .trim();
}

/** 简单文本相似度判断 */
export function textSimilar(a: string, b: string): boolean {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (na === nb) return true;
  if (na.length === 0 || nb.length === 0) return false;

  if (Math.min(na.length, nb.length) <= 4) {
    return na.includes(nb) || nb.includes(na);
  }
  const dist = levenshtein(na, nb);
  const maxLen = Math.max(na.length, nb.length);
  return dist / maxLen < 0.35;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

/**
 * 标准 NMS（Non-Maximum Suppression）
 * 按置信度（或面积）从高到低排序，抑制高 IoU 的重复框
 */
export function nms(
  detections: Detection[],
  iouThreshold = 0.45,
  preferConfidence = true
): Detection[] {
  if (detections.length === 0) return [];

  // 排序：优先用 confidence，其次用面积
  const sorted = [...detections].sort((a, b) => {
    const ca = a.confidence ?? 0;
    const cb = b.confidence ?? 0;
    if (preferConfidence && Math.abs(ca - cb) > 0.05) {
      return cb - ca;
    }
    return bboxArea(b.bbox) - bboxArea(a.bbox);
  });

  const kept: Detection[] = [];

  for (const det of sorted) {
    let suppressed = false;
    for (const exist of kept) {
      if (iou(det.bbox, exist.bbox) >= iouThreshold) {
        suppressed = true;
        break;
      }
    }
    if (!suppressed) {
      kept.push(det);
    }
  }

  return kept;
}

/**
 * 相邻框合并（针对被切断的同一行/同一艺术字）
 * 如果两个框在空间上很接近（小间隙 + 大部分垂直/水平对齐），且文本语义可能连续，则合并。
 */
export function mergeAdjacentBoxes(
  detections: Detection[],
  maxGap = 28,           // 允许的最大像素间隙
  minOverlapRatio = 0.55 // 垂直或水平方向的最小重叠比例
): Detection[] {
  if (detections.length <= 1) return detections;

  const result: Detection[] = [];
  const used = new Set<number>();

  // 按 y 中心排序，便于找同行
  const sorted = [...detections].map((d, idx) => ({ d, idx })).sort((a, b) => {
    const cyA = (a.d.bbox[1] + a.d.bbox[3]) / 2;
    const cyB = (b.d.bbox[1] + b.d.bbox[3]) / 2;
    return cyA - cyB;
  });

  for (let i = 0; i < sorted.length; i++) {
    if (used.has(sorted[i].idx)) continue;

    let current = { ...sorted[i].d };
    used.add(sorted[i].idx);

    let merged = true;
    while (merged) {
      merged = false;
      for (let j = 0; j < sorted.length; j++) {
        if (used.has(sorted[j].idx)) continue;

        const a = current.bbox;
        const b = sorted[j].d.bbox;

        // 计算中心和间隙
        const aRight = a[2], aLeft = a[0], aTop = a[1], aBot = a[3];
        const bRight = b[2], bLeft = b[0], bTop = b[1], bBot = b[3];

        const hGap = Math.max(0, Math.max(bLeft - aRight, aLeft - bRight));
        const vGap = Math.max(0, Math.max(bTop - aBot, aTop - bBot));

        // 水平相邻（同一行文字常见）
        const yOverlap = Math.min(aBot, bBot) - Math.max(aTop, bTop);
        const yMinH = Math.min(aBot - aTop, bBot - bTop);
        const yOverlapRatio = yMinH > 0 ? yOverlap / yMinH : 0;

        if (hGap <= maxGap && hGap >= 0 && yOverlapRatio >= minOverlapRatio) {
          // 合并
          const mergedBbox: BBox = [
            Math.min(aLeft, bLeft),
            Math.min(aTop, bTop),
            Math.max(aRight, bRight),
            Math.max(aBot, bBot),
          ];
          const mergedText = (current.refinedText || current.text) + ' ' + (sorted[j].d.refinedText || sorted[j].d.text);
          current = {
            ...current,
            bbox: mergedBbox,
            text: (current.text + ' ' + sorted[j].d.text).trim(),
            refinedText: mergedText.trim(),
            confidence: Math.max(current.confidence ?? 0, sorted[j].d.confidence ?? 0),
            refinedConfidence: Math.max(current.refinedConfidence ?? 0, sorted[j].d.refinedConfidence ?? 0),
          };
          used.add(sorted[j].idx);
          merged = true;
          break;
        }

        // 垂直方向（极少见，但也支持）
        const xOverlap = Math.min(aRight, bRight) - Math.max(aLeft, bLeft);
        const xMinW = Math.min(aRight - aLeft, bRight - bLeft);
        const xOverlapRatio = xMinW > 0 ? xOverlap / xMinW : 0;

        if (vGap <= maxGap && vGap >= 0 && xOverlapRatio >= minOverlapRatio) {
          const mergedBbox: BBox = [
            Math.min(aLeft, bLeft),
            Math.min(aTop, bTop),
            Math.max(aRight, bRight),
            Math.max(aBot, bBot),
          ];
          current = {
            ...current,
            bbox: mergedBbox,
            text: (current.text + ' ' + sorted[j].d.text).trim(),
          };
          used.add(sorted[j].idx);
          merged = true;
          break;
        }
      }
    }
    result.push(current);
  }

  // 排序输出
  return result.sort((a, b) => {
    const [ax1, ay1] = a.bbox;
    const [bx1, by1] = b.bbox;
    if (Math.abs(ay1 - by1) > 24) return ay1 - by1;
    return ax1 - bx1;
  });
}

/**
 * 综合去重合并：先 NMS，再相邻框合并
 * 这是推荐给 Stage1 后的合并策略
 */
export function mergeDetectionsNMS(
  detections: Detection[],
  options: {
    nmsIou?: number;
    adjacentMaxGap?: number;
    adjacentOverlap?: number;
  } = {}
): Detection[] {
  const { nmsIou = 0.45, adjacentMaxGap = 28, adjacentOverlap = 0.55 } = options;

  let result = nms(detections, nmsIou);
  result = mergeAdjacentBoxes(result, adjacentMaxGap, adjacentOverlap);

  // 再次轻量 NMS（防止合并后仍残留小重叠）
  result = nms(result, 0.55);

  return result;
}

/** 旧版兼容（保留） */
export function mergeDetections(detections: Detection[], iouThreshold = 0.55): Detection[] {
  return mergeDetectionsNMS(detections, { nmsIou: iouThreshold });
}
