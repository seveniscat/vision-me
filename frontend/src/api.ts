import axios from 'axios';
import type { DetectResult, DetectProgress } from './types';

const api = axios.create({
  baseURL: '/api',
  timeout: 1000 * 60 * 10, // 10 分钟
});

export async function detectImage(
  file: File,
  onProgress: (p: DetectProgress) => void,
  onComplete: (result: DetectResult) => void,
  onError: (err: string) => void
) {
  const formData = new FormData();
  formData.append('image', file);

  try {
    const response = await fetch('/api/detect', {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const text = await response.text();
      onError(text || `请求失败: ${response.status}`);
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      onError('无法读取响应流');
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // 按 SSE 事件切分（data: ...\n\n）
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';

      for (const part of parts) {
        const lines = part.trim().split('\n');
        let event = 'message';
        let data = '';

        for (const line of lines) {
          if (line.startsWith('event:')) {
            event = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            data = line.slice(5).trim();
          }
        }

        if (!data) continue;

        try {
          const payload = JSON.parse(data);

          if (event === 'progress') {
            onProgress(payload as DetectProgress);
          } else if (event === 'complete') {
            onComplete(payload as DetectResult);
            return;
          } else if (event === 'error') {
            onError(payload.error || '检测失败');
            return;
          }
        } catch (e) {
          console.warn('解析 SSE 数据失败', data);
        }
      }
    }
  } catch (e: any) {
    onError(e?.message || '网络请求异常');
  }
}

export interface AppInfo {
  model: string;
  tileSize: number;
  overlapRatio: number;
  contextPadding: number;
  maxConcurrency: number;
  ossEnabled: boolean;
  note?: string;
}

export async function getInfo(): Promise<AppInfo> {
  const { data } = await api.get<AppInfo>('/info');
  return data;
}

export interface UploadResult {
  url: string;
  key: string;
  name?: string;
  size?: number;
}

/** 上传图片到 OSS（后端 POST /api/upload），返回可访问 URL */
export async function uploadImage(file: File): Promise<UploadResult> {
  const form = new FormData();
  form.append('image', file);
  const { data } = await api.post<UploadResult>('/upload', form, {
    timeout: 1000 * 60 * 5, // 大图最多 5 分钟
  });
  return data;
}
