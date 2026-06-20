#!/usr/bin/env node
/**
 * Vision-Me 两阶段文字检测 CLI
 *
 * 用法：
 *   tsx src/scripts/run-pipeline.ts /path/to/large-diecut.jpg
 *   或
 *   node dist/scripts/run-pipeline.js /path/to/large-diecut.jpg
 *
 * 可选环境变量：
 *   DASHSCOPE_API_KEY=sk-xxx
 *   QWEN_VL_MODEL=qwen-vl-max-latest
 *
 * 可通过命令行参数覆盖：
 *   --tileSize 1536
 *   --overlapRatio 0.45
 *   --padding 50
 *   --concurrency 2
 *   --saveArtifacts true   （默认开启）
 *   --outputDir ./output
 */

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runTwoStagePipeline } from '../services/detector.js';

function parseArgs() {
  const args = process.argv.slice(2);
  const result: Record<string, any> = {
    imagePath: '',
    tileSize: undefined,
    overlapRatio: undefined,
    padding: undefined,
    concurrency: undefined,
    saveArtifacts: true,
    outputDir: './output',
    debug: false,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--') && !result.imagePath) {
      result.imagePath = a;
      continue;
    }
    if (a === '--tileSize' || a === '-t') result.tileSize = Number(args[++i]);
    else if (a === '--overlapRatio' || a === '-o') result.overlapRatio = Number(args[++i]);
    else if (a === '--padding' || a === '-p') result.padding = Number(args[++i]);
    else if (a === '--concurrency' || a === '-c') result.concurrency = Number(args[++i]);
    else if (a === '--outputDir') result.outputDir = args[++i];
    else if (a === '--no-save') result.saveArtifacts = false;
    else if (a === '--debug') result.debug = true;
  }

  return result;
}

async function main() {
  const cfg = parseArgs();

  if (!cfg.imagePath) {
    console.error(`
用法: tsx src/scripts/run-pipeline.ts <图片路径> [选项]

必须参数:
  <图片路径>          超大刀模图（推荐 4000×4000 ~ 9000×9000+）

可选参数:
  --tileSize 1536           瓦片大小（默认 1536）
  --overlapRatio 0.45       重叠比例（默认 0.45，强烈推荐）
  --padding 50              Stage2 外扩上下文像素（默认 50）
  --concurrency 2           最大并发（默认 2）
  --outputDir ./output      产物输出目录
  --no-save                 不保存 annotated.jpg 和 json
  --debug                   抓取中间产物（瓦片/crop/manifest）到 output/debug/<runId>/

示例:
  tsx src/scripts/run-pipeline.ts ./samples/box-9000.jpg --overlapRatio 0.5 --padding 60
`);
    process.exit(1);
  }

  const absPath = path.resolve(cfg.imagePath);
  console.log(`\n[CLI] 读取图片: ${absPath}`);

  let buffer: Buffer;
  try {
    buffer = await fs.readFile(absPath);
  } catch (e) {
    console.error('[CLI] 无法读取图片文件:', e);
    process.exit(1);
  }

  const fileName = path.basename(absPath);

  console.log('[CLI] 开始执行严格两阶段检测流程...\n');

  try {
    const result = await runTwoStagePipeline(buffer, undefined, {
      tileSize: cfg.tileSize,
      overlapRatio: cfg.overlapRatio,
      contextPadding: cfg.padding,
      maxConcurrency: cfg.concurrency,
      saveArtifacts: cfg.saveArtifacts,
      outputDir: cfg.outputDir,
      originalFileName: fileName,
      debug: cfg.debug,
    });

    console.log('[CLI] 流程完成！');
    console.log('最终统计:', result.stats);

    if (cfg.saveArtifacts) {
      console.log(`\n产物已保存到: ${path.resolve(cfg.outputDir)}`);
      console.log('  - *_annotated.jpg  （带红色框 + 文字标签的标注图）');
      console.log('  - *_detections.json（结构化结果，含全局坐标）');
    }

    // 额外：如果用户想直接得到 annotated buffer，也可以在这里写
    process.exit(0);
  } catch (err: any) {
    console.error('\n[CLI] 流程执行失败:', err?.message || err);
    process.exit(1);
  }
}

main();
