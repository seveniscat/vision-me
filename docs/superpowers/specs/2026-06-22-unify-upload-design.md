# Unify Image Upload Entry — Design Spec

**Date:** 2026-06-22
**Status:** Pending implementation
**Goal:** Merge the two upload entries (top-toolbar local-only select + right-sidebar OSS upload) into a single OSS-upload path, with detection downstream consuming the OSS URL.

## Background

After merging `feat/signed-upload` (commit `0e4c19a`) into `main`, the app has two coexisting "upload" concepts:

1. **Top-toolbar "上传图片" button** — antd `Upload` with `beforeUpload` returning `false`; the file lives only in browser memory (`URL.createObjectURL`). When the user clicks "开始检测", the same file is POST'd as multipart to `/api/detect`, which processes it purely in memory.
2. **Right-sidebar "图片上传" card** — `UploadButton` component that performs the real signed upload via `POST /api/upload`, returning a persistent OSS URL. Independent from detection.

These two entries confuse users (two buttons labeled "上传图片", one actually uploads, one doesn't) and duplicate state (`imageFile` + `ossUrl`). The user wants a single entry that always goes through the OSS path.

## Decision

Adopt the "backend fetches from URL" flow. After unification, the file is transferred over the network exactly once — to OSS. Detection receives the OSS URL, the backend downloads it, and the existing two-stage pipeline runs on the downloaded buffer.

## Architecture

```
[User picks file]
    ↓
[POST /api/upload multipart] → signed OSS service → returns { url, key, name, size }
    ↓
[Frontend stores OSS URL, shows preview from URL]
    ↓
[User clicks "开始检测"]
    ↓
[POST /api/detect { url } JSON] → backend fetches URL → Buffer → existing two-stage pipeline → SSE results
```

Key invariants after the change:
- Frontend never holds the `File` object beyond the upload request.
- Backend `/api/detect` no longer parses multipart; it accepts JSON `{ url }`.
- Backend `/api/upload` is unchanged — still multipart, still the OSS uploader.
- The OSS URL is the single source of truth for "what to detect".

## Backend Changes (`backend/src/index.ts`)

### `/api/detect` rewrite

| Aspect | Before | After |
|--------|--------|-------|
| Body parser | `upload.single('image')` (multer) | `express.json()` |
| Payload | multipart `image` field | JSON `{ url: string }` |
| Validation | mimetype starts with `image/`, size ≤ 200MB | URL protocol `http`/`https`; downloaded buffer size ≤ 200MB |
| Image source | `req.file.buffer` | `downloadImage(url)` returns `Buffer` |
| Pipeline call | `detectTextOnLargeImage(req.file.buffer, res, opts)` | unchanged — same buffer, same opts |
| SSE contract | unchanged | unchanged |

### New helper (inline in `index.ts`)

```ts
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
    if (!res.ok) throw new Error(`下载失败: HTTP ${res.status}`);
    const ab = await res.arrayBuffer();
    const buf = Buffer.from(ab);
    if (buf.length > 200 * 1024 * 1024) {
      throw new Error(`图片过大 (${(buf.length / 1024 / 1024).toFixed(1)}MB > 200MB)`);
    }
    return buf;
  } finally {
    clearTimeout(timer);
  }
}
```

Inline (rather than a new `services/imageDownloader.ts`) — 10 lines, single caller, no test isolation benefit.

### Error handling

| Scenario | Behavior |
|----------|----------|
| Body missing `url` or not a string | `400 { error: '缺少 url' }` |
| URL parse / protocol fails | `400 { error: '非法 url' }` or `'url 必须是 http/https'` |
| Download timeout (30s) | SSE `error` event: `'图片下载超时(30s)'` (caught by inspecting `err.name === 'AbortError'` in a try/catch around `downloadImage`) |
| Download HTTP error | SSE `error` event: `'图片下载失败: HTTP <status>'` |
| Download network error (DNS, connection reset, etc.) | SSE `error` event: `'图片下载失败: <err.message>'` |
| Buffer > 200MB | SSE `error` event: `'图片过大 (...)'` |

For SSE-emitted errors, the existing `sendError(res, msg)` helper in `utils/sse.ts` is reused — same shape as today's pipeline errors.

### `/api/upload` — unchanged

Continues to accept multipart, calls `uploadImage(buffer, mime, originalName)` from `services/uploadClient.ts`, returns `{ url, key, name, size }`.

### `/api/info` — unchanged

Still returns `uploadEnabled: isUploadConfigured()`. Frontend uses this to gate the upload button.

### Removals

- `upload.single('image')` middleware on `/api/detect` (kept on `/api/upload`).
- Any reference to `req.file` inside the `/api/detect` handler.

## Frontend Changes

### `App.tsx` — state collapse

```diff
- const [imageFile, setImageFile] = useState<File | null>(null);
- const [imageUrl, setImageUrl] = useState<string>('');
+ const [imageUrl, setImageUrl] = useState<string | null>(null);  // OSS URL
- const [ossUrl, setOssUrl] = useState<string | null>(null);
```

Consequences:
- `handleFileSelect` (local file pick) is removed entirely.
- `resetAll` clears `imageUrl` to `null`; no more `URL.revokeObjectURL` calls.
- Image dimensions (`imageMeta`) are read by loading `new Image()` from the OSS URL — same pattern as today, just with the remote URL as `src`.

### Top toolbar

Replace the local-pick antd `Upload`:
```tsx
<Upload {...uploadProps}>
  <Button icon={<UploadOutlined />} disabled={isDetecting}>上传图片</Button>
</Upload>
```
with the existing `UploadButton` component:
```tsx
<UploadButton
  disabled={isDetecting || !uploadEnabled}
  onUploaded={(info) => {
    setImageUrl(info.url);
    const img = new Image();
    img.onload = () => setImageMeta({ width: img.width, height: img.height });
    img.src = info.url;
  }}
/>
```

`UploadButton` already handles size limit, progress, error toast. We may add an optional `disabled` prop to it (currently has none — minor addition).

The "上传图片" `Divider` + scroll-zoom / fit-window buttons in the toolbar stay untouched.

### Right sidebar — full removal

Delete the entire "图片上传" `Card` block (currently ~lines 311-335). This removes:
- The `<UploadButton>` instance there
- The `ossUrl` display block
- The `extra={uploadEnabled ? ...}` status tag (orphan after removal)

The `uploadEnabled` state stays — it's still used to disable the top-toolbar button when OSS isn't configured.

### `runDetection`

```diff
const runDetection = async () => {
-  if (!imageFile) { message.error('请先上传图片'); return; }
+  if (!imageUrl) { message.error('请先上传图片'); return; }
   ...
   await detectImage(
-    imageFile,
+    imageUrl,
     (p) => setProgress(p),
     ...
   );
};
```

### `api.ts` — `detectImage`

Signature changes from `(file: File, ...)` to `(url: string, ...)`.

```diff
export async function detectImage(
-  file: File,
+  url: string,
   onProgress: (p: DetectProgress) => void,
   onComplete: (result: DetectResult) => void,
   onError: (err: string) => void,
   debug = false
) {
-  const formData = new FormData();
-  formData.append('image', file);
   const urlPath = debug ? '/api/detect?debug=true' : '/api/detect';
   const response = await fetch(urlPath, {
     method: 'POST',
+    headers: { 'Content-Type': 'application/json' },
+    body: JSON.stringify({ url }),
-    body: formData,
   });
   ...
}
```

All downstream SSE parsing is unchanged.

### Things explicitly removed from frontend

- `imageFile` state + every reference. The toolbar's `· X.XMB` display switches to read from new `imageSize` state (set from `UploadResult.size` in the `onUploaded` callback).
- `ossUrl` state + its display block.
- `handleFileSelect` function.
- `uploadProps` object.

## Open Questions Resolved Upfront

- **Q: Keep multipart on `/api/detect` for backwards compat?** No — fully migrate. The project has no external API consumers, and the user explicitly said "only keep the OSS upload path".
- **Q: Show local preview before OSS upload completes?** No — preview comes from the OSS URL. Avoids maintaining two preview paths. Adds a small wait for large images but matches "URL is the single source of truth".
- **Q: Where does the `size` display in toolbar come from?** From `UploadResult.size` returned by `/api/upload`. Pass it into a new lightweight state `imageSize: number | null` (bytes) set alongside `imageUrl`. Render as `· ${(imageSize / 1024 / 1024).toFixed(1)}MB` when non-null.
- **Q: Host whitelist for the URL fetch?** Not in v1. The signed-service host (`file-oss.putaocdn.com`) is the expected source, but enforcing a whitelist now adds config surface without a clear threat model. SSRF is mitigated by the fact that URLs are only produced by our own `/api/upload` endpoint in the normal flow; a malicious caller could POST any URL, but this is an internal tool.

## Testing

The repo has no automated tests or lint (`AGENTS.md` confirms this). Verification plan:

1. `cd backend && npm run typecheck` — passes.
2. `cd frontend && npm run typecheck` — passes.
3. `make dev` — both servers start.
4. Browser: click "上传图片" → progress bar → preview appears from OSS URL → `Get info` shows `uploadEnabled: true`.
5. Click "开始检测" → SSE progress streams → detection results render.
6. Devtools: force-set `imageUrl` to `https://example.com/does-not-exist.jpg`, click detect → SSE error event surfaces as toast.
7. Curl `POST /api/detect` with `{ url: 'not-a-url' }` → 400 with `{ error: '非法 url' }`.
8. Curl `POST /api/detect` with `{ url: 'http://10.255.255.1/x.jpg' }` (unroutable) → SSE error after 30s timeout.

## Out of Scope

- Authentication / authorization on `/api/detect`.
- Download retries with backoff.
- Streaming the downloaded buffer through `sharp` before pipeline — pipeline already handles bytes.
- Multi-file batch upload.
- Switching upload providers away from the company signed service.
