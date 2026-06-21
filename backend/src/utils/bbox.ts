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

  // 调试模式：该框对应的 Stage2 crop 文件（相对 debug 目录的路径）
  cropFile?: string;
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
    .replace(/[\s　 ]+/g, '')
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

/* ============================================================
 * 调试溯源：记录被 NMS 抑制的框、被相邻合并的来源
 * ============================================================ */

export interface SuppressedRecord {
  id: string;
  bbox: BBox;
  text: string;
  suppressedBy: string; // 抑制它的保留框 id
  iou: number;
  phase: 'nms1' | 'nms2';
}

export interface MergedGroup {
  intoId: string; // 合并结果框 id
  fromIds: string[]; // 被合并进来的框 id
}

export interface MergeProvenance {
  result: Detection[];
  suppressed: SuppressedRecord[]; // 两轮 NMS 被抑制的框
  mergedGroups: MergedGroup[]; // 相邻合并的来源
}

/**
 * NMS（带抑制记录版）：行为与 nms() 完全一致，额外把被抑制的框写入 outSuppressed。
 */
function nmsWithSuppression(
  detections: Detection[],
  iouThreshold: number,
  phase: 'nms1' | 'nms2',
  outSuppressed: SuppressedRecord[]
): Detection[] {
  if (detections.length === 0) return [];

  const sorted = [...detections].sort((a, b) => {
    const ca = a.confidence ?? 0;
    const cb = b.confidence ?? 0;
    if (Math.abs(ca - cb) > 0.05) {
      return cb - ca;
    }
    return bboxArea(b.bbox) - bboxArea(a.bbox);
  });

  const kept: Detection[] = [];

  for (const det of sorted) {
    let suppressor: { id: string; iou: number } | null = null;
    for (const exist of kept) {
      const v = iou(det.bbox, exist.bbox);
      if (v >= iouThreshold) {
        suppressor = { id: exist.id, iou: v };
        break;
      }
    }
    if (suppressor) {
      outSuppressed.push({
        id: det.id,
        bbox: det.bbox,
        text: det.refinedText || det.text || '',
        suppressedBy: suppressor.id,
        iou: suppressor.iou,
        phase,
      });
    } else {
      kept.push(det);
    }
  }

  return kept;
}

/**
 * 相邻框合并（带合并来源记录版）：行为与 mergeAdjacentBoxes() 一致，
 * 额外把每次合并的来源（fromIds → intoId）记录到 mergedGroups。
 */
function mergeAdjacentInternal(
  detections: Detection[],
  maxGap = 28,
  minOverlapRatio = 0.55
): { result: Detection[]; mergedGroups: MergedGroup[] } {
  const mergedGroupsMap = new Map<string, string[]>();

  if (detections.length <= 1) {
    return { result: detections, mergedGroups: [] };
  }

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

        const aRight = a[2], aLeft = a[0], aTop = a[1], aBot = a[3];
        const bRight = b[2], bLeft = b[0], bTop = b[1], bBot = b[3];

        const hGap = Math.max(0, Math.max(bLeft - aRight, aLeft - bRight));
        const vGap = Math.max(0, Math.max(bTop - aBot, aTop - bBot));

        // 水平相邻（同一行文字常见）
        const yOverlap = Math.min(aBot, bBot) - Math.max(aTop, bTop);
        const yMinH = Math.min(aBot - aTop, bBot - bTop);
        const yOverlapRatio = yMinH > 0 ? yOverlap / yMinH : 0;

        if (hGap <= maxGap && hGap >= 0 && yOverlapRatio >= minOverlapRatio) {
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
          const arr = mergedGroupsMap.get(current.id) || [];
          arr.push(sorted[j].d.id);
          mergedGroupsMap.set(current.id, arr);
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
          const arr = mergedGroupsMap.get(current.id) || [];
          arr.push(sorted[j].d.id);
          mergedGroupsMap.set(current.id, arr);
          used.add(sorted[j].idx);
          merged = true;
          break;
        }
      }
    }
    result.push(current);
  }

  const mergedGroups: MergedGroup[] = Array.from(mergedGroupsMap.entries()).map(([intoId, fromIds]) => ({
    intoId,
    fromIds,
  }));

  return {
    result: result.sort((a, b) => {
      const [ax1, ay1] = a.bbox;
      const [bx1, by1] = b.bbox;
      if (Math.abs(ay1 - by1) > 24) return ay1 - by1;
      return ax1 - bx1;
    }),
    mergedGroups,
  };
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
  return nmsWithSuppression(detections, iouThreshold, 'nms1', []);
}

/**
 * 相邻框合并（对外保留的无溯源版本）
 */
export function mergeAdjacentBoxes(
  detections: Detection[],
  maxGap = 28,
  minOverlapRatio = 0.55
): Detection[] {
  return mergeAdjacentInternal(detections, maxGap, minOverlapRatio).result;
}

/**
 * 综合去重合并（带溯源）：先 NMS，再相邻框合并，最后轻量二次 NMS。
 * 同时记录被抑制/被合并的来源，供调试模式可视化。
 */
export function mergeDetectionsWithProvenance(
  detections: Detection[],
  options: {
    nmsIou?: number;
    adjacentMaxGap?: number;
    adjacentOverlap?: number;
  } = {}
): MergeProvenance {
  const { nmsIou = 0.45, adjacentMaxGap = 28, adjacentOverlap = 0.55 } = options;

  const suppressed: SuppressedRecord[] = [];

  let result = nmsWithSuppression(detections, nmsIou, 'nms1', suppressed);
  const adj = mergeAdjacentInternal(result, adjacentMaxGap, adjacentOverlap);
  result = adj.result;
  result = nmsWithSuppression(result, 0.55, 'nms2', suppressed);

  return { result, suppressed, mergedGroups: adj.mergedGroups };
}

/**
 * 综合去重合并（无溯源版本，向后兼容）。
 * 与 mergeDetectionsWithProvenance 走同一条实现，只是丢弃溯源信息。
 */
export function mergeDetectionsNMS(
  detections: Detection[],
  options: {
    nmsIou?: number;
    adjacentMaxGap?: number;
    adjacentOverlap?: number;
  } = {}
): Detection[] {
  return mergeDetectionsWithProvenance(detections, options).result;
}

/** 旧版兼容（保留） */
export function mergeDetections(detections: Detection[], iouThreshold = 0.55): Detection[] {
  return mergeDetectionsNMS(detections, { nmsIou: iouThreshold });
}
