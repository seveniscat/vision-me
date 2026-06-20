import { useState } from 'react';
import {
  Layout,
  Button,
  Upload,
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
  UploadOutlined,
  PlayCircleOutlined,
  ClearOutlined,
  DownloadOutlined,
  ZoomInOutlined,
  CompressOutlined,
} from '@ant-design/icons';
import type { UploadProps } from 'antd';
import ImageViewer from './components/ImageViewer';
import ResultsTable from './components/ResultsTable';
import DebugViewer from './components/DebugViewer';
import { detectImage, fetchDebugManifest } from './api';
import type { Detection, DetectProgress, DetectResult, DebugManifest } from './types';

const { Header, Content } = Layout;
const { Text } = Typography;

export default function App() {
  const [imageUrl, setImageUrl] = useState<string>('');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imageMeta, setImageMeta] = useState<{ width: number; height: number } | null>(null);

  const [detections, setDetections] = useState<Detection[]>([]);
  const [selectedId, setSelectedId] = useState<string | undefined>();

  const [isDetecting, setIsDetecting] = useState(false);
  const [progress, setProgress] = useState<DetectProgress | null>(null);
  const [stats, setStats] = useState<DetectResult['stats'] | null>(null);

  const [debugMode, setDebugMode] = useState(false);
  const [debugBundle, setDebugBundle] = useState<{ runId: string; manifest: DebugManifest } | null>(null);

  const resetAll = () => {
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    setImageUrl('');
    setImageFile(null);
    setImageMeta(null);
    setDetections([]);
    setSelectedId(undefined);
    setProgress(null);
    setStats(null);
    setDebugBundle(null);
    setIsDetecting(false);
  };

  const handleFileSelect = (file: File) => {
    if (!file.type.startsWith('image/')) {
      message.error('请选择图片文件');
      return false;
    }
    // 超大图警告
    if (file.size > 80 * 1024 * 1024) {
      message.warning('图片体积较大（>80MB），检测时间会较长，请耐心等待');
    }

    const url = URL.createObjectURL(file);

    // 先用 Image 读取真实尺寸（不依赖 EXIF）
    const img = new Image();
    img.onload = () => {
      setImageMeta({ width: img.width, height: img.height });
    };
    img.src = url;

    setImageUrl(url);
    setImageFile(file);
    setDetections([]);
    setSelectedId(undefined);
    setProgress(null);
    setStats(null);

    return false; // 阻止 Upload 自动上传
  };

  const uploadProps: UploadProps = {
    accept: 'image/*',
    showUploadList: false,
    beforeUpload: handleFileSelect,
  };

  const runDetection = async () => {
    if (!imageFile) {
      message.error('请先上传图片');
      return;
    }

    setIsDetecting(true);
    setProgress({ stage: 'uploading', message: '正在上传并准备处理...' });
    setDetections([]);
    setSelectedId(undefined);
    setStats(null);

    await detectImage(
      imageFile,
      (p) => setProgress(p),
      async (result) => {
        setDetections(result.detections);
        setStats(result.stats);
        setProgress(null);
        setIsDetecting(false);

        // 调试模式：拉取中间产物 manifest，进入调试检视器
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
        // 自动选中第一条
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

  const handleSelect = (id: string | undefined) => {
    setSelectedId(id);
    // 如果有需要，可以在这里加入“滚动到结果列表对应行”的逻辑
  };

  const handleCopyText = (detOrText: Detection | string) => {
    const t = typeof detOrText === 'string'
      ? detOrText
      : (detOrText.refinedText || detOrText.text);
    navigator.clipboard.writeText(t);
    message.success('已复制文字');
  };

  const downloadResults = () => {
    if (!detections.length) return;

    const payload = {
      image: imageFile?.name || 'unknown',
      imageSize: imageMeta,
      stats,
      detections: detections.map((d) => ({
        text: d.text,
        bbox: d.bbox,
        confidence: d.confidence,
      })),
      exportedAt: new Date().toISOString(),
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `detections-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const selectedDetection = detections.find((d) => d.id === selectedId);
  const getDisplayText = (d: Detection) => d.refinedText || d.text;

  return (
    <Layout className="app-container">
      <Header style={{ background: '#001529', padding: '0 24px', display: 'flex', alignItems: 'center' }}>
        <div style={{ color: '#fff', fontSize: 18, fontWeight: 600 }}>
          Vision-Me <span style={{ fontSize: 13, opacity: 0.7 }}>超高分辨率刀模图文字检测</span>
        </div>
        <div style={{ flex: 1 }} />
        <Space>
          <Tag color="blue">Qwen-VL-Max</Tag>
          <Tag color="green">支持 9000×9000+</Tag>
        </Space>
      </Header>

      <Content className="main-content">
        {debugBundle ? (
          <DebugViewer
            runId={debugBundle.runId}
            manifest={debugBundle.manifest}
            onExit={() => setDebugBundle(null)}
          />
        ) : (
          <>
            {/* 左侧图片查看器 */}
            <div className="viewer-panel">
          <div className="controls">
            <Upload {...uploadProps}>
              <Button icon={<UploadOutlined />} disabled={isDetecting}>
                上传图片
              </Button>
            </Upload>

            <Button
              type="primary"
              icon={<PlayCircleOutlined />}
              onClick={runDetection}
              disabled={!imageFile || isDetecting}
              loading={isDetecting}
            >
              开始检测
            </Button>

            <Button icon={<ClearOutlined />} onClick={resetAll} disabled={isDetecting && !imageFile}>
              清空
            </Button>

            <Checkbox checked={debugMode} onChange={(e) => setDebugMode(e.target.checked)} disabled={isDetecting}>
              调试模式
            </Checkbox>

            <Divider type="vertical" />

            <Button
              icon={<ZoomInOutlined />}
              onClick={() => {
                /* 由 ImageViewer 内部键盘事件处理，这里仅提示 */
              }}
              disabled={!imageUrl}
            >
              滚轮缩放
            </Button>
            <Button icon={<CompressOutlined />} onClick={() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f' }))}>
              适配窗口 (F)
            </Button>

            <div style={{ flex: 1 }} />

            {imageMeta && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                {imageMeta.width} × {imageMeta.height} px
                {imageFile && ` · ${(imageFile.size / 1024 / 1024).toFixed(1)}MB`}
              </Text>
            )}
          </div>

          <ImageViewer
            imageUrl={imageUrl}
            imageWidth={imageMeta?.width || 0}
            imageHeight={imageMeta?.height || 0}
            detections={detections}
            selectedId={selectedId}
            onSelect={handleSelect}
          />

          {/* 进度条区域 */}
          {isDetecting && progress && (
            <div style={{ padding: 12, background: '#fff', borderTop: '1px solid #eee' }}>
              <Progress
                percent={
                  progress.total && progress.current
                    ? Math.round((progress.current / progress.total) * 100)
                    : 0
                }
                status="active"
                strokeColor="#1677ff"
              />
              <div style={{ marginTop: 6, fontSize: 12, color: '#666' }}>
                {progress.message || progress.stage}
                {progress.partialDetections != null && ` · 当前累计 ${progress.partialDetections} 处`}
              </div>
            </div>
          )}

          {stats && (
            <div className="stats-bar">
              <span>瓦片: {stats.tilesProcessed}</span>
              <span>原始检出: {stats.rawDetections}</span>
              <span>去重后: <b>{stats.afterDedup}</b></span>
              <span>耗时: {(stats.durationMs / 1000).toFixed(1)}s</span>
            </div>
          )}
        </div>

        {/* 右侧结果面板 */}
        <div className="sidebar">
          <div className="results-header">
            <span>检测结果 ({detections.length})</span>
            <Space>
              <Button
                size="small"
                icon={<DownloadOutlined />}
                disabled={!detections.length}
                onClick={downloadResults}
              >
                导出 JSON
              </Button>
            </Space>
          </div>

          {detections.length > 0 && (
            <div style={{ padding: '8px 16px', background: '#fafafa', fontSize: 12 }}>
              <Text type="secondary">点击表格行或图片上的红色框可高亮定位</Text>
            </div>
          )}

          <div className="results-list">
            <ResultsTable
              detections={detections}
              selectedId={selectedId}
              onSelect={handleSelect}
              onCopyText={(text) => {
                // 兼容旧签名，实际从 detections 找更好
                const found = detections.find(d => (d.refinedText || d.text) === text);
                handleCopyText(found || ({} as any));
              }}
            />
          </div>

          {selectedDetection && (
            <Card size="small" style={{ margin: 12, flexShrink: 0 }}>
              <div style={{ marginBottom: 4 }}>
                <b>选中文字（精炼）：</b>
                <Text copyable style={{ color: '#1677ff' }}>
                  {getDisplayText(selectedDetection)}
                </Text>
              </div>
              {(selectedDetection.refinedStyle || selectedDetection.style) && (
                <div style={{ fontSize: 12, color: '#888', marginBottom: 2 }}>
                  风格：{selectedDetection.refinedStyle || selectedDetection.style}
                </div>
              )}
              <div style={{ fontSize: 12, color: '#666' }}>
                原始坐标: [{selectedDetection.bbox.map((v) => Math.round(v)).join(', ')}]
              </div>
            </Card>
          )}

          {!detections.length && !isDetecting && (
            <div style={{ padding: 24, color: '#999', fontSize: 13, lineHeight: 1.7 }}>
              <Alert
                type="info"
                showIcon
                message="使用说明"
                description={
                  <>
                    1. 上传 8000×8000 及以上的包装刀模图<br />
                    2. 点击「开始检测」调用 Qwen VL 模型<br />
                    3. 系统会自动将大图切分为带重叠的瓦片并行识别<br />
                    4. 结果会自动去重并映射回原始坐标<br />
                    <br />
                    特别适合识别强艺术字、特效字。
                  </>
                }
              />
            </div>
          )}
        </div>
        </>
      )}
      </Content>
    </Layout>
  );
}
