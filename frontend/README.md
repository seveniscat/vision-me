# Vision-Me Frontend

基于 React 18 + Ant Design 5 的超大图文字检测交互界面。

## 特性

- 支持超高分辨率图片（实测 9000×9000+ 仍流畅）
- 鼠标滚轮缩放 + 拖拽平移 + 双击适配 + 快捷键（F 适配窗口）
- 检测框直接叠加在原始分辨率坐标系上，通过 CSS transform 缩放
- 实时 SSE 进度展示
- 结果表格 + 点击定位联动

## 开发

```bash
npm install
npm run dev
```

## 关键组件

- `ImageViewer.tsx`：核心大图交互（transform 缩放 + 绝对定位框）
- `ResultsTable.tsx`：检测结果列表
- `api.ts`：使用 `fetch` + `ReadableStream` 解析后端 SSE

## 构建

```bash
npm run build
```
