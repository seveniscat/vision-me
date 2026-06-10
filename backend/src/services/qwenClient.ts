import OpenAI from 'openai';
import { Buffer } from 'node:buffer';

export interface QwenDetection {
  text: string;
  bbox: [number, number, number, number]; // pixel coordinates relative to the image sent to the model (after normalization conversion)
  style?: string;                         // e.g. "3D金属", "卡通手写", "渐变轮廓"
  confidence?: number;                    // 0~1
  rawConfidence?: string;                 // "high" | "medium" | "low" from model
}

let openai: OpenAI | null = null;

function getClient() {
  if (!openai) {
    const apiKey = process.env.DASHSCOPE_API_KEY;
    if (!apiKey) {
      throw new Error('缺少 DASHSCOPE_API_KEY 环境变量');
    }
    openai = new OpenAI({
      apiKey,
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    });
  }
  return openai;
}

const DEFAULT_MODEL = process.env.QWEN_VL_MODEL || 'qwen-vl-max-latest';

/* ============================================================
 * 阶段一 Prompt（瓦片级别）：文字区域检测 + 初步识别
 * 严格按照用户提供的优化提示词
 * ============================================================ */
export const STAGE1_SYSTEM_PROMPT = `你是一位专业的包装设计文字识别专家，擅长识别各种艺术化、装饰性强、特效化的字体（包括3D、渐变、轮廓、卡通融合、手写风、金属质感等）。

任务：
1. 仔细观察图片中所有文字区域，特别是艺术感很强的装饰文字。
2. 尽可能准确地还原原始文字内容，即使字体被严重艺术化、变形、添加特效或与图形融合，也要尽力识别。
3. 支持中文、英文、法语混排。

请按以下JSON格式严格输出（不要添加额外解释）：
{
  "texts": [
    {
      "text": "识别到的完整文字",
      "bbox": [x1, y1, x2, y2],   // 相对坐标，左上角为(0,0)，右下角为(1,1)
      "style": "艺术风格简述（如3D金属、卡通手写）",
      "confidence": "high/medium/low"
    }
  ]
}

如果文字被艺术化处理得很严重，请优先根据整体视觉语义和常见包装用词进行合理还原。`;

export const STAGE1_USER_PROMPT = `请仔细观察当前图像瓦片中的所有文字区域（尤其是艺术化、装饰性强的文字），并严格按照指定 JSON 格式返回结果。`;

/* ============================================================
 * 阶段二 Prompt（高清单区域精炼）：针对已 crop 的艺术字区域做精确还原
 * 基于用户优化提示词的精神，专注单个区域的高精度识别
 * ============================================================ */
export const STAGE2_SYSTEM_PROMPT = `你是一位专业的包装设计文字识别专家，擅长识别各种艺术化、装饰性强、特效化的字体（包括3D、渐变、轮廓、卡通融合、手写风、金属质感等）。

你现在收到的是**从原始超高分辨率刀模图上精确裁剪出来的单个文字区域**（已在外扩约50像素上下文），这个区域主要包含一个或少数几个艺术文字元素。

任务：
1. 仔细观察这个裁剪区域中的文字，特别是艺术感很强的装饰文字。
2. 尽可能准确地还原原始文字内容。即使字体被严重艺术化、变形、添加特效或与图形融合，也要尽力识别并还原为设计者最可能想要表达的文字。
3. 支持中文、英文、法语混排。

请按以下JSON格式严格输出（不要添加额外解释）：
{
  "texts": [
    {
      "text": "识别到的完整文字（优先使用视觉语义 + 常见包装用词合理还原）",
      "bbox": [x1, y1, x2, y2],   // 相对坐标，相对于当前这张裁剪图，左上角(0,0)，右下角(1,1)
      "style": "艺术风格简述（如3D金属、卡通手写、渐变轮廓）",
      "confidence": "high/medium/low"
    }
  ]
}

如果区域内有多个文字，请都列出；如果只有主要的一个，请重点还原它。`;

export const STAGE2_USER_PROMPT = `请以最高精度识别并还原这张裁剪图中的艺术文字内容，严格按指定 JSON 格式输出。`;

/**
 * ==================== 阶段一：瓦片文字区域检测 ====================
 * 让模型在有上下文的 tile 上找出所有可能的文字框（高召回）
 * 现在使用用户优化后的提示词 + 支持 normalized bbox (0-1)
 */
export async function detectRegionsInTile(
  tileBuffer: Buffer,
  model: string = DEFAULT_MODEL
): Promise<QwenDetection[]> {
  const client = getClient();

  // 先获取瓦片尺寸，用于把模型返回的 0-1 归一化坐标转成像素
  const meta = await (await import('sharp')).default(tileBuffer).metadata();
  const imgW = meta.width || 1;
  const imgH = meta.height || 1;

  const base64 = tileBuffer.toString('base64');
  const dataUrl = `data:image/jpeg;base64,${base64}`;

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: STAGE1_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: dataUrl } },
            { type: 'text', text: STAGE1_USER_PROMPT },
          ],
        },
      ],
      temperature: 0.1,
      max_tokens: 6000,
    });

    const content = response.choices[0]?.message?.content?.trim() || '';
    return parseTextsResponse(content, imgW, imgH);
  } catch (err: any) {
    console.error('[Qwen Stage1] 瓦片检测失败:', err?.message || err);
    return [];
  }
}

/**
 * ==================== 阶段二：高清单区域精确识别 ====================
 * 接收 Stage1 产出的 crop（已带 padding），让模型专注识别这一个区域
 * 返回精炼后的主文字 + style + confidence（我们主要使用 text）
 */
export async function recognizeTextInCrop(
  cropBuffer: Buffer,
  model: string = DEFAULT_MODEL
): Promise<{ text: string; confidence?: number; style?: string; notes?: string }> {
  const client = getClient();

  const meta = await (await import('sharp')).default(cropBuffer).metadata();
  const imgW = meta.width || 1;
  const imgH = meta.height || 1;

  const base64 = cropBuffer.toString('base64');
  const dataUrl = `data:image/jpeg;base64,${base64}`;

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: STAGE2_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: dataUrl } },
            { type: 'text', text: STAGE2_USER_PROMPT },
          ],
        },
      ],
      temperature: 0.15,
      max_tokens: 1200,
    });

    const content = response.choices[0]?.message?.content?.trim() || '';
    const items = parseTextsResponse(content, imgW, imgH);

    if (items.length === 0) {
      return { text: '', confidence: 0 };
    }

    // 取第一个（或最可信的）作为主结果
    const best = items[0];
    return {
      text: best.text,
      confidence: best.confidence,
      style: best.style,
      notes: undefined,
    };
  } catch (err: any) {
    console.error('[Qwen Stage2] 高清识别失败:', err?.message || err);
    return { text: '', confidence: 0 };
  }
}

/* ==================== 解析辅助函数（支持用户新格式） ==================== */

/**
 * 统一解析函数
 * 支持两种返回格式：
 *   1. { "texts": [ {text, bbox:[0-1], style, confidence:"high/medium/low"}, ... ] }
 *   2. 直接数组 [ ... ] （向后兼容）
 *
 * 自动判断 bbox 是否为归一化坐标 (0~1)，如果是则使用 imgW/imgH 转成像素。
 */
export function parseTextsResponse(
  content: string,
  imgWidth: number = 1,
  imgHeight: number = 1
): QwenDetection[] {
  let jsonStr = content
    .replace(/```json\s*/gi, '')
    .replace(/```\s*$/g, '')
    .trim();

  // 尝试提取对象或数组
  let parsed: any;
  try {
    // 优先尝试找 { "texts": ... }
    const objMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (objMatch) {
      const candidate = JSON.parse(objMatch[0]);
      if (candidate && Array.isArray(candidate.texts)) {
        parsed = candidate.texts;
      } else if (Array.isArray(candidate)) {
        parsed = candidate;
      } else {
        parsed = candidate.texts || candidate;
      }
    } else {
      // 直接尝试数组
      const arrMatch = jsonStr.match(/\[[\s\S]*\]/);
      if (arrMatch) {
        parsed = JSON.parse(arrMatch[0]);
      } else {
        parsed = JSON.parse(jsonStr);
      }
    }
  } catch (e) {
    console.warn('[Qwen] JSON 解析失败，原始内容前300字:', content.slice(0, 300));
    return [];
  }

  let items: any[] = [];
  if (Array.isArray(parsed)) {
    items = parsed;
  } else if (parsed && Array.isArray(parsed.texts)) {
    items = parsed.texts;
  } else if (parsed && typeof parsed === 'object') {
    items = [parsed];
  }

  return items
    .map((item: any) => {
      if (!item || typeof item.text !== 'string') return null;

      let bboxRaw = item.bbox;
      if (!Array.isArray(bboxRaw) || bboxRaw.length !== 4) return null;

      let [x1, y1, x2, y2] = bboxRaw.map((v: any) => Number(v));

      // 判断是否为归一化坐标 (0~1)
      const isNormalized =
        Math.max(x1, y1, x2, y2) <= 1.05 && Math.min(x1, y1, x2, y2) >= -0.05;

      if (isNormalized) {
        x1 = Math.round(x1 * imgWidth);
        y1 = Math.round(y1 * imgHeight);
        x2 = Math.round(x2 * imgWidth);
        y2 = Math.round(y2 * imgHeight);
      } else {
        x1 = Math.round(x1);
        y1 = Math.round(y1);
        x2 = Math.round(x2);
        y2 = Math.round(y2);
      }

      // 保证顺序正确
      const left = Math.min(x1, x2);
      const top = Math.min(y1, y2);
      const right = Math.max(x1, x2);
      const bottom = Math.max(y1, y2);

      // 解析 confidence
      let conf: number | undefined;
      const rawConf = item.confidence;
      if (typeof rawConf === 'number') {
        conf = Math.max(0, Math.min(1, rawConf));
      } else if (typeof rawConf === 'string') {
        const lower = rawConf.toLowerCase();
        if (lower === 'high') conf = 0.9;
        else if (lower === 'medium') conf = 0.65;
        else if (lower === 'low') conf = 0.35;
      }

      return {
        text: item.text.trim(),
        bbox: [left, top, right, bottom] as [number, number, number, number],
        style: typeof item.style === 'string' ? item.style.trim() : undefined,
        confidence: conf,
        rawConfidence: typeof rawConf === 'string' ? rawConf : undefined,
      };
    })
    .filter(Boolean) as QwenDetection[];
}

// 保留旧名兼容（内部已指向新实现）
function parseDetectionsFromContent(content: string): QwenDetection[] {
  return parseTextsResponse(content, 1, 1);
}

function parseSingleRecognition(content: string): { text: string; confidence?: number; notes?: string } {
  const items = parseTextsResponse(content, 1, 1);
  if (items.length === 0) {
    // 容错：模型直接吐文字
    const cleaned = content.replace(/["'`]/g, '').trim();
    if (cleaned.length > 0 && cleaned.length < 150) {
      return { text: cleaned, confidence: 0.55 };
    }
    return { text: '' };
  }
  const first = items[0];
  return {
    text: first.text,
    confidence: first.confidence,
    notes: first.style ? `style: ${first.style}` : undefined,
  };
}
