# Unify Image Upload Entry — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the two upload entries (local-only select + OSS-upload card) into a single OSS-upload path, with `/api/detect` consuming an OSS URL instead of a multipart file.

**Architecture:** Frontend uploads to `/api/upload` (existing), stores the returned OSS URL. Clicking "开始检测" POSTs `{ url }` to `/api/detect`. Backend downloads the image from the URL into a Buffer and feeds it to the existing two-stage pipeline unchanged.

**Tech Stack:** Express + multer (backend), React + Ant Design + Vite (frontend), TypeScript on both sides.

**Spec:** `docs/superpowers/specs/2026-06-22-unify-upload-design.md`

---

### Task 1: Backend — switch `/api/detect` to JSON body with URL

**Files:**
- Modify: `backend/src/index.ts` (lines 1-10 for imports/middleware, lines 42-82 for `/api/detect` handler)

- [ ] **Step 1: Add `express.json()` middleware**

In `backend/src/index.ts`, find the existing CORS middleware block (currently lines 30-36) and add `express.json()` immediately after it:

```ts
// 允许大文件上传（刀模图经常 30~100MB+）
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 200 * 1024 * 1024, // 200MB
  },
});

// JSON body parser（用于 /api/detect 接收 { url }）
app.use(express.json({ limit: '1mb' }));
```

- [ ] **Step 2: Add `downloadImage` helper above `app.listen`**

Insert this function between the `/api/upload` handler and `app.listen(PORT, ...)` (around line 170):

```ts
// 从 URL 下载图片到 Buffer，带超时和体积上限保护
async function downloadImage(url: string, timeoutMs = 30_000): Promise<Buffer> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('非法 url');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('url 必须是 http/https');
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(parsed, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ab = await res.arrayBuffer();
    const buf = Buffer.from(ab);
    if (buf.length > 200 * 1024 * 1024) {
      throw new Error(`图片过大 (${(buf.length / 1024 / 1024).toFixed(1)}MB > 200MB)`);
    }
    return buf;
  } catch (err: any) {
    if (err.name === 'AbortError') throw new Error('图片下载超时(30s)');
    throw new Error(`图片下载失败: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 3: Rewrite `/api/detect` handler**

Replace the entire current `/api/detect` handler (lines 42-82) with:

```ts
// 核心接口：接收图片 URL，下载后进行全图文字检测（严格两阶段流程 + SSE 进度）
app.post('/api/detect', async (req, res) => {
  const url = typeof req.body?.url === 'string' ? req.body.url : '';
  if (!url) {
    res.status(400).json({ error: '缺少 url' });
    return;
  }

  // 设置 SSE 响应头
  initSSE(res);
  res.flushHeaders?.();

  let buffer: Buffer;
  try {
    buffer = await downloadImage(url);
    console.log(`[Detect] 下载完成: ${url}, ${(buffer.length / 1024 / 1024).toFixed(2)}MB`);
  } catch (err: any) {
    try {
      sendError(res, err?.message || '图片下载失败');
    } catch {}
    res.end();
    return;
  }

  try {
    await detectTextOnLargeImage(buffer, res, {
      tileSize: req.query.tileSize ? Number(req.query.tileSize) : undefined,
      overlap: req.query.overlap ? Number(req.query.overlap) : undefined,
      overlapRatio: req.query.overlapRatio ? Number(req.query.overlapRatio) : undefined,
      contextPadding: req.query.padding ? Number(req.query.padding) : undefined,
      maxConcurrency: req.query.concurrency ? Number(req.query.concurrency) : undefined,
      model: (req.query.model as string) || undefined,
      debug: req.query.debug === 'true',
    });
  } catch (err: any) {
    console.error('[Detect] 处理失败:', err);
    try {
      sendError(res, err?.message || '检测服务内部错误');
    } catch {}
  } finally {
    res.end();
  }
});
```

Note: `upload.single('image')` middleware is removed from `/api/detect` (kept on `/api/upload`).

- [ ] **Step 4: Verify backend typechecks**

Run: `cd backend && npm run typecheck`
Expected: no errors. If `express.json` types unresolved, ensure `@types/express` is in `package.json` (it's already there at `^4.17.21`).

- [ ] **Step 5: Manually verify error paths with curl**

Start backend: `cd backend && npm run dev` (in a separate terminal).

Then run each curl and verify output:

```bash
# Missing url field
curl -X POST http://localhost:3001/api/detect \
  -H 'Content-Type: application/json' \
  -d '{}'
# Expected: {"error":"缺少 url"}

# Invalid URL
curl -X POST http://localhost:3001/api/detect \
  -H 'Content-Type: application/json' \
  -d '{"url":"not-a-url"}'
# Expected: event: error\ndata: {"error":"非法 url"}  (SSE stream)

# 404 URL
curl -N -X POST http://localhost:3001/api/detect \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com/nonexistent.jpg"}'
# Expected: event: error\ndata: {"error":"图片下载失败: HTTP 404"}
```

Stop the backend with Ctrl+C after verification.

- [ ] **Step 6: Commit**

```bash
git add backend/src/index.ts
git commit -m "$(cat <<'EOF'
feat(detect): switch /api/detect to JSON { url } body

Drop multipart handling on /api/detect in favor of JSON body with an
image URL. Backend downloads the image with a 30s timeout and 200MB
size cap before running the existing two-stage pipeline. /api/upload
still accepts multipart for the OSS upload step.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Frontend — change `detectImage` signature to take URL

**Files:**
- Modify: `frontend/src/api.ts:9-86`

- [ ] **Step 1: Replace `detectImage` function**

Replace the entire `detectImage` function in `frontend/src/api.ts` (currently lines 9-86) with:

```ts
export async function detectImage(
  url: string,
  onProgress: (p: DetectProgress) => void,
  onComplete: (result: DetectResult) => void,
  onError: (err: string) => void,
  debug = false
) {
  try {
    const endpoint = debug ? '/api/detect?debug=true' : '/api/detect';
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
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
```

- [ ] **Step 2: Verify frontend typechecks**

Run: `cd frontend && npm run typecheck`
Expected: errors in `App.tsx` complaining that `detectImage` was called with a `File` instead of `string`. These will be fixed in Task 4. Do not commit yet.

Do NOT commit yet — the call site in `App.tsx` still passes a File. Committing now would leave the repo in a broken state.

---

### Task 3: Frontend — add `disabled` prop to `UploadButton`

**Files:**
- Modify: `frontend/src/components/UploadButton.tsx`

- [ ] **Step 1: Add `disabled` to props interface and component body**

In `frontend/src/components/UploadButton.tsx`, modify the props interface (lines 7-12) and the destructure (line 19):

```ts
export interface UploadButtonProps {
  accept?: string;
  maxSize?: number; // MB
  onUploaded?: (info: UploadResult) => void;
  text?: string;
  disabled?: boolean;
}
```

```ts
export default function UploadButton(props: UploadButtonProps) {
  const { accept = 'image/*', maxSize = 200, onUploaded, text = '上传图片', disabled = false } = props;
```

- [ ] **Step 2: Apply `disabled` to the Upload + Button**

In the same file, modify the JSX return (lines 48-57) to pass `disabled` through:

```tsx
return (
  <>
    <Upload accept={accept} showUploadList={false} customRequest={handleUpload} disabled={disabled}>
      <Button icon={<CloudUploadOutlined />} block disabled={disabled}>
        {text}
      </Button>
    </Upload>
    {progress > 0 && progress < 100 && (
      <Progress percent={progress} size="small" style={{ marginTop: 8 }} />
    )}
  </>
);
```

- [ ] **Step 3: Verify typecheck**

Run: `cd frontend && npm run typecheck`
Expected: only the same `App.tsx` errors from Task 2 remain. `UploadButton.tsx` itself compiles cleanly.

Do NOT commit yet — Tasks 2-4 land in one commit to keep the frontend coherent.

---

### Task 4: Frontend — collapse `App.tsx` state and UI to single OSS upload entry

**Files:**
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Replace state declarations**

In `frontend/src/App.tsx`, find the state block at lines 37-52 and replace with:

```ts
const [imageUrl, setImageUrl] = useState<string | null>(null);
const [imageSize, setImageSize] = useState<number | null>(null);
const [imageMeta, setImageMeta] = useState<{ width: number; height: number } | null>(null);

const [detections, setDetections] = useState<Detection[]>([]);
const [selectedId, setSelectedId] = useState<string | undefined>();

const [isDetecting, setIsDetecting] = useState(false);
const [progress, setProgress] = useState<DetectProgress | null>(null);
const [stats, setStats] = useState<DetectResult['stats'] | null>(null);

const [debugMode, setDebugMode] = useState(false);
const [debugBundle, setDebugBundle] = useState<{ runId: string; manifest: DebugManifest } | null>(null);

const [uploadEnabled, setUploadEnabled] = useState(false);
```

Removed: `imageFile`, `ossUrl`. Added: `imageSize` (bytes, from `UploadResult.size`).

- [ ] **Step 2: Simplify imports**

Replace the import block at lines 1-31 to remove unused symbols. The final imports should be:

```ts
import { useState, useEffect } from 'react';
import {
  Layout,
  Button,
  Card,
  Checkbox,
  Progress,
  Typography,
  Space,
  message,
  Tag,
  Divider,
  Alert,
} from 'antd';
import {
  PlayCircleOutlined,
  ClearOutlined,
  DownloadOutlined,
  ZoomInOutlined,
  CompressOutlined,
} from '@ant-design/icons';
import ImageViewer from './components/ImageViewer';
import ResultsTable from './components/ResultsTable';
import DebugViewer from './components/DebugViewer';
import UploadButton from './components/UploadButton';
import { detectImage, fetchDebugManifest, getInfo, type UploadResult } from './api';
import type { Detection, DetectProgress, DetectResult, DebugManifest } from './types';
```

Removed: `Upload`, `UploadOutlined`, `CloudUploadOutlined`, `UploadProps`. `Card` and `Typography` stay (still used elsewhere). `Divider` stays (used in toolbar).

- [ ] **Step 3: Replace `resetAll`**

Find `resetAll` (lines 61-72) and replace with:

```ts
const resetAll = () => {
  setImageUrl(null);
  setImageSize(null);
  setImageMeta(null);
  setDetections([]);
  setSelectedId(undefined);
  setProgress(null);
  setStats(null);
  setDebugBundle(null);
  setIsDetecting(false);
};
```

No more `URL.revokeObjectURL` — the URL is owned by the OSS service, not the browser.

- [ ] **Step 4: Delete `handleFileSelect` and `uploadProps`**

Remove the entire `handleFileSelect` function (lines 74-101) and the `uploadProps` object (lines 103-107). They are no longer referenced.

- [ ] **Step 5: Rewrite `runDetection`**

Find `runDetection` (lines 109-154) and replace its opening and the `detectImage` call:

```ts
const runDetection = async () => {
  if (!imageUrl) {
    message.error('请先上传图片');
    return;
  }

  setIsDetecting(true);
  setProgress({ stage: 'uploading', message: '正在下载图片并准备处理...' });
  setDetections([]);
  setSelectedId(undefined);
  setStats(null);

  await detectImage(
    imageUrl,
    (p) => setProgress(p),
    async (result) => {
      setDetections(result.detections);
      setStats(result.stats);
      setProgress(null);
      setIsDetecting(false);

      if (debugMode && result.debugBundleId) {
        try {
          const manifest = await fetchDebugManifest(result.debugBundleId);
          setDebugBundle({ runId: result.debugBundleId, manifest });
        } catch {
          message.error('加载调试包失败，请检查后端');
        }
        return;
      }

      message.success(`检测完成！共识别 ${result.detections.length} 处文字`);
      if (result.detections.length > 0) {
        setSelectedId(result.detections[0].id);
      }
    },
    (err) => {
      setIsDetecting(false);
      setProgress(null);
      message.error('检测失败: ' + err);
    },
    debugMode
  );
};
```

- [ ] **Step 6: Replace the top-toolbar upload control**

Find the toolbar `<div className="controls">` block (lines 222-270) and replace its first `<Upload>` element (lines 223-227) with `UploadButton`:

Before:
```tsx
<div className="controls">
  <Upload {...uploadProps}>
    <Button icon={<UploadOutlined />} disabled={isDetecting}>
      上传图片
    </Button>
  </Upload>

  <Button
    type="primary"
    ...
```

After:
```tsx
<div className="controls">
  <UploadButton
    disabled={isDetecting || !uploadEnabled}
    onUploaded={(info: UploadResult) => {
      setImageUrl(info.url);
      setImageSize(info.size ?? null);
      const img = new Image();
      img.onload = () => setImageMeta({ width: img.width, height: img.height });
      img.src = info.url;
    }}
  />

  <Button
    type="primary"
    ...
```

- [ ] **Step 7: Update the size display**

In the same toolbar, find the `imageMeta` Text block (lines 264-269) and update to use `imageSize`:

```tsx
{imageMeta && (
  <Text type="secondary" style={{ fontSize: 12 }}>
    {imageMeta.width} × {imageMeta.height} px
    {imageSize != null && ` · ${(imageSize / 1024 / 1024).toFixed(1)}MB`}
  </Text>
)}
```

- [ ] **Step 8: Pass `imageUrl` to ImageViewer (already correct, but verify)**

`ImageViewer` is currently rendered with `imageUrl={imageUrl}` where `imageUrl` was `string`. Now it's `string | null`. Check `ImageViewer` props — if it requires `string`, either:
- Pass `imageUrl={imageUrl || ''}` at the call site, OR
- Update `ImageViewer` props to accept `string | null`

Inspect `frontend/src/components/ImageViewer.tsx` first. If it accepts `string | null` or `string | undefined`, no change. If it requires `string`, update the call site to `imageUrl={imageUrl || ''}`.

Run: `grep -n 'imageUrl' frontend/src/components/ImageViewer.tsx`

Decision rule: prefer the call-site fix `imageUrl={imageUrl || ''}` — smaller blast radius.

- [ ] **Step 9: Remove the right-sidebar "图片上传" card**

Find the `<Card>` block titled "图片上传" (lines 312-335 in the sidebar) and delete it entirely. The block starts with:

```tsx
<Card
  size="small"
  title={
    <>
      <CloudUploadOutlined /> 图片上传
    </>
  }
  extra={uploadEnabled ? <Tag color="green">已启用</Tag> : <Tag>未配置</Tag>}
  style={{ margin: 12, flexShrink: 0 }}
>
  <UploadButton ... />
  {ossUrl && (...)}
</Card>
```

After removal, the sidebar's first child becomes `<div className="results-header">`.

- [ ] **Step 10: Verify typecheck passes**

Run: `cd frontend && npm run typecheck`
Expected: PASS, no errors.

If errors mention missing imports (e.g., `Upload`, `UploadOutlined`), check Step 2 — those imports should be removed. If errors mention unused imports, remove them.

- [ ] **Step 11: Commit Tasks 2-4 together**

```bash
git add frontend/src/api.ts frontend/src/components/UploadButton.tsx frontend/src/App.tsx
git commit -m "$(cat <<'EOF'
refactor(frontend): unify upload entry to single OSS path

Remove the right-sidebar OSS upload card and the local-only file picker
in the toolbar. The toolbar now uses UploadButton which performs the
real signed upload. App state collapses from {imageFile, imageUrl,
ossUrl} to {imageUrl, imageSize}. detectImage sends { url } JSON to
/api/detect instead of multipart form.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: End-to-end manual verification

**Files:** none modified

- [ ] **Step 1: Start both servers**

Run: `make dev`
Expected: backend on 3001, frontend on 5173, both hot-reloading.

- [ ] **Step 2: Verify upload-enabled state**

Open http://localhost:5173. The top "上传图片" button should be enabled (not grayed out), because `.env` has the OSS service configured (`API_UPLOAD_*`).

Devtools → Network → check `GET /api/info` response shows `uploadEnabled: true`.

- [ ] **Step 3: Verify happy path**

Click "上传图片" → select a small JPG/PNG.
Expected:
- Progress bar appears, climbs to 100%
- Image preview renders (from OSS URL — devtools Network should show GET `https://file-oss.putaocdn.com/file/...`)
- Toolbar shows `W × H px · X.XMB`
- A `POST /api/upload` 200 response in Network tab with `{ url, key, name, size }` body

- [ ] **Step 4: Verify detect happy path**

Click "开始检测".
Expected:
- `POST /api/detect` 200 with request body `{ "url": "https://file-oss.putaocdn.com/file/..." }`
- SSE stream with `progress` events, then a `complete` event
- Results render in the right sidebar

Note: actual detection requires a real `DASHSCOPE_API_KEY`. If `.env` still has the placeholder `sk-xxx`, the SSE will surface an error event — that's expected for this step's plumbing check, but the URL fetch step itself must succeed (verify via backend log `[Detect] 下载完成: ...`).

- [ ] **Step 5: Verify URL-fetch error path**

Open browser devtools, in the console run:
```js
// Force the state to a 404 URL — find React DevTools and set App state, OR:
// Easier: use curl against the running backend
```

Curl alternative:
```bash
curl -N -X POST http://localhost:3001/api/detect \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com/does-not-exist.jpg"}'
```
Expected: SSE stream ending with `event: error\ndata: {"error":"图片下载失败: HTTP 404"}`.

- [ ] **Step 6: Verify reset button**

Click "清空".
Expected: preview disappears, `imageUrl`/`imageSize`/`imageMeta` all null, results table empty.

- [ ] **Step 7: No commit needed**

This task is verification-only. If any step fails, file findings as new tasks.

---

## Summary of files changed

- `backend/src/index.ts` — added `express.json()` middleware, added `downloadImage` helper, rewrote `/api/detect` to consume `{ url }`.
- `frontend/src/api.ts` — `detectImage` signature changed from `File` to `string` (URL); body switched from FormData to JSON.
- `frontend/src/components/UploadButton.tsx` — added optional `disabled` prop.
- `frontend/src/App.tsx` — state collapse, toolbar switched to `UploadButton`, sidebar upload card removed, `runDetection` uses URL.
