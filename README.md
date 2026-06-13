# Vision-Me · 超大分辨率刀模图文字检测（严格两阶段方案）

针对 **8000×8000 ~ 9000×9000+** 超高分辨率包装刀模图的**文字区域检测 + 高清艺术字识别**系统。

严格按照指定技术方案实现：

1. **阶段一**：重叠分块（Tiling）检测 → Qwen VL-Max 找 BBox + 粗识别 → 全局坐标映射 → **NMS + 相邻框合并**
2. **阶段二**：对每个最终 BBox 从**原始高分辨率图** crop（外扩 50px 上下文）→ 再次送 Qwen VL-Max **精确识别**
3. 输出：带框标注图 `annotated.jpg` + 结构化 `detections.json` + 控制台文字列表

## 核心特性

- **严格两阶段流程**（完全符合技术方案要求）
- 推荐参数：`tileSize=1536`，`overlapRatio=0.45`，`contextPadding=50`
- 优秀艺术字 Prompt（Stage1 高召回定位 + Stage2 高精度识别）
- 支持中文 + 英文 + 法语混排
- NMS + 相邻框合并（防止艺术字被切断）
- 内存友好（惰性瓦片 + 仅对候选区域做高清 crop）
- CLI 一键处理本地大图 + Web 在线可视化双模式

## 项目结构

```
vision-me/
├── backend/
│   ├── src/
│   │   ├── services/
│   │   │   ├── detector.ts      # 严格两阶段主流程
│   │   │   ├── imageTiler.ts    # 瓦片生成 + 高清 crop（带 padding）
│   │   │   └── qwenClient.ts    # 两个阶段的专用 Prompt + 调用
│   │   ├── utils/bbox.ts        # NMS + 相邻合并（核心）
│   │   └── scripts/run-pipeline.ts   # CLI 入口
│   └── ...
└── frontend/                    # React + Ant Design 可视化界面
```

## 快速开始

### 1. 配置后端

```bash
cd backend
npm install
cp .env.example .env
# 必须填写 DASHSCOPE_API_KEY
```

推荐 `.env`（严格方案默认值）：

```env
DASHSCOPE_API_KEY=sk-xxx
QWEN_VL_MODEL=qwen-vl-max-latest
TILE_SIZE=1536
OVERLAP_RATIO=0.45
CONTEXT_PADDING=50
MAX_CONCURRENCY=2
```

### 2. 使用 CLI 处理本地超大图（推荐用于生产刀模图）

```bash
# 基础用法
npx tsx src/scripts/run-pipeline.ts /path/to/your-9000x9000-diecut.jpg

# 自定义参数
npx tsx src/scripts/run-pipeline.ts ./samples/box.jpg \
  --overlapRatio 0.48 \
  --padding 60 \
  --concurrency 1 \
  --outputDir ./artifacts
```

输出：
- `*_annotated.jpg` — 原图 + 红色检测框 + 文字标签
- `*_detections.json` — 完整结构化结果（全局坐标 + 精炼文字 + 置信度）
- 控制台直接打印文字列表（方便和知识库比对）

快捷命令（已在 package.json 配置）：

```bash
npm run detect /path/to/image.jpg
```

### 3. 启动 Web 服务 + 前端（可视化验证）

```bash
# 首次运行先安装前后端依赖
make install

# 一键启动后端 + 前端
make dev
```

也可以按需单独启动：

```bash
make backend
make frontend
```

前端已适配新流程，返回的是 **Stage2 精炼后的文字**。

## 技术方案实现细节

### 阶段一 Prompt（检测 + 定位）
- 强调“高召回”，要求把各种艺术字、特效字、极小字、旋转字都框出来
- 返回局部 bbox + 初步文本

### 阶段二 Prompt（高清精识）
- 收到的是**带 50px 上下文的单个 crop**
- 极致强调艺术字识别能力 + 多语言支持
- 返回单个区域的最终准确文字

### 合并策略
- 先标准 NMS（IoU 0.45）
- 再相邻框合并（支持同一行被瓦片切断的文字）
- 最后轻量二次 NMS

### 内存与效率
- 使用 `sharp` 惰性生成瓦片（不会同时加载所有瓦片）
- Stage2 只对最终少量候选区域做 crop（极大降低成本和内存）
- 可配置并发

## 输出 JSON 示例结构

```json
{
  "meta": { "imageWidth": 9000, "imageHeight": 9000, ... },
  "detections": [
    {
      "id": "...",
      "text": "LUXE PARIS 2025",
      "bbox": [1240, 680, 1620, 742],
      "confidence": 0.94
    }
  ]
}
```

## 推荐模型

- `qwen-vl-max-latest`（当前艺术字效果最好的视觉模型）
- 可通过 `stage1Model` / `stage2Model` 分别指定（高级用法）

## 注意事项

- 超大图调用次数多，务必关注百炼用量和预算。
- Stage2 的 crop 质量直接影响最终识别精度，padding=50 是经验值，可根据字体大小微调。
- 极端抽象艺术字仍可能需要人工复核。

---

严格按照技术方案实现完毕。如需进一步调整 Prompt、合并阈值、增加导出带框 PNG、或者对接知识库比对模块，请继续告诉我。
