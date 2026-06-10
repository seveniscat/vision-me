# Vision-Me Backend（严格两阶段实现）

Node.js + Express 后端，**严格按照指定技术方案**实现超大刀模图的文字检测：

- **阶段一**：重叠分块（tileSize=1536 + overlapRatio=0.45）→ Qwen VL-Max 输出局部 BBox
- 全局坐标映射 + **NMS + 相邻框合并**
- **阶段二**：对每个最终 BBox 从**原始图 crop（+50px padding）** → 再次调用 Qwen VL-Max 精确识别艺术字
- 输出 annotated.jpg + detections.json + 控制台文字列表

## 推荐启动

```bash
cd backend
npm install
cp .env.example .env   # 必须填 DASHSCOPE_API_KEY
npm run dev
```

## CLI 一键处理本地大图（最常用）

```bash
# 基础
npm run detect /path/to/9000x9000-diecut.jpg

# 高级参数
npx tsx src/scripts/run-pipeline.ts ./samples/box.jpg \
  --overlapRatio 0.48 \
  --padding 60 \
  --outputDir ./artifacts
```

会自动生成：
- `box_annotated.jpg`
- `box_detections.json`

## Web API

`POST /api/detect`（multipart，field=`image`）

支持查询参数覆盖：
- `tileSize=1536`
- `overlapRatio=0.45`
- `padding=50`
- `concurrency=2`
- `model=qwen-vl-max-latest`

返回 SSE 流，事件包括：
- `stage1_tiling` / `stage1_processing`
- `nms_merging`
- `stage2_recognizing`
- `complete`

返回的 `detections` 已经是 **Stage2 精炼后的结果**（`refinedText` 字段为最终识别文字）。

## 核心文件说明

| 文件                        | 职责 |
|-----------------------------|------|
| `services/detector.ts`      | 严格两阶段主流程 + annotated 生成 |
| `services/imageTiler.ts`    | 惰性瓦片 + `cropRegionWithPadding` |
| `services/qwenClient.ts`    | 两个阶段的专用 Prompt + 调用 |
| `utils/bbox.ts`             | `nms()` + `mergeAdjacentBoxes()` + 综合合并 |
| `scripts/run-pipeline.ts`   | 独立 CLI 脚本 |

## Prompt 设计要点（已内置）

**Stage1（检测）**：高召回，强调“把各种艺术字、特效字、极小字、旋转字都框出来”，即使内容不确定也要给 bbox。

**Stage2（识别）**：收到的是带上下文的单区域 crop，极致强调艺术字辨认 + 中英法混排 + 重音符号。

## 环境变量（推荐值）

```env
TILE_SIZE=1536
OVERLAP_RATIO=0.45
CONTEXT_PADDING=50
MAX_CONCURRENCY=2
```

## 输出 JSON 关键字段

- `detections[].bbox`：**全局**原始像素坐标
- `detections[].text` / `refinedText`：Stage2 精炼后的文字
- `detections[].confidence` / `refinedConfidence`

## 内存与成本控制

- 瓦片使用 async generator，逐个处理
- Stage2 只对 NMS 后的少量候选区域 crop
- 建议先用小图验证流程，再处理真正 9000×9000 图

---

严格按照“技术方案（必须严格按照以下流程实现）”完成。