import { useRef, useState, useCallback, useEffect } from 'react';
import { Switch, Button, Typography, Empty, Card, Space } from 'antd';
import { CloseOutlined, CompressOutlined, AimOutlined } from '@ant-design/icons';
import type { DebugManifest, BBox } from '../types';
import { debugFileUrl } from '../api';

const { Text, Paragraph } = Typography;

interface Props {
  runId: string;
  manifest: DebugManifest;
  onExit: () => void;
}

interface Transform {
  scale: number;
  x: number;
  y: number;
}

interface Layers {
  tiles: boolean;
  stage1Raw: boolean;
  suppressed: boolean;
  final: boolean;
}

/**
 * 调试检视器：跑完后加载某个运行包的 manifest，
 * 在原图上叠加各阶段框（瓦片网格 / Stage1 原始框 / NMS 抑制框 / 最终框），
 * 点击最终框可核对文案与位置，并查看对应的 Stage2 crop 小图。
 */
export default function DebugViewer({ runId, manifest, onExit }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [transform, setTransform] = useState<Transform>({ scale: 1, x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  const [imgLoaded, setImgLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [layers, setLayers] = useState<Layers>({
    tiles: false,
    stage1Raw: false,
    suppressed: false,
    final: true,
  });

  const W = manifest.imageWidth;
  const H = manifest.imageHeight;
  const imageUrl = debugFileUrl(runId, manifest.originalImage);

  const fit = useCallback(() => {
    const c = containerRef.current;
    if (!c || !W || !H) return;
    const cw = c.clientWidth - 40;
    const ch = c.clientHeight - 40;
    const scale = Math.min(cw / W, ch / H, 1);
    const dW = W * scale;
    const dH = H * scale;
    setTransform({
      scale,
      x: Math.max(0, (cw - dW) / 2 + 20),
      y: Math.max(0, (ch - dH) / 2 + 20),
    });
  }, [W, H]);

  useEffect(() => {
    setImgLoaded(false);
    setTransform({ scale: 1, x: 0, y: 0 });
  }, [runId]);

  const handleImageLoad = () => {
    setImgLoaded(true);
    setTimeout(fit, 50);
  };

  const zoom = useCallback((delta: number, clientX?: number, clientY?: number) => {
    const c = containerRef.current;
    if (!c) return;
    const rect = c.getBoundingClientRect();
    const cx = clientX !== undefined ? clientX - rect.left : rect.width / 2;
    const cy = clientY !== undefined ? clientY - rect.top : rect.height / 2;
    setTransform((prev) => {
      const newScale = Math.max(0.05, Math.min(8, prev.scale * (delta > 0 ? 1.2 : 1 / 1.2)));
      const ix = (cx - prev.x) / prev.scale;
      const iy = (cy - prev.y) / prev.scale;
      return { scale: newScale, x: cx - ix * newScale, y: cy - iy * newScale };
    });
  }, []);

  const focusBox = useCallback((bbox: BBox) => {
    const c = containerRef.current;
    if (!c) return;
    const cw = c.clientWidth - 40;
    const ch = c.clientHeight - 40;
    const [x1, y1, x2, y2] = bbox;
    const bw = Math.max(1, x2 - x1);
    const bh = Math.max(1, y2 - y1);
    const pad = Math.max(bw, bh) * 0.8;
    const scale = Math.min(cw / (bw + pad * 2), ch / (bh + pad * 2), 8);
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;
    setTransform({ scale, x: cw / 2 + 20 - cx * scale, y: ch / 2 + 20 - cy * scale });
  }, []);

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    zoom(e.deltaY, e.clientX, e.clientY);
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).classList.contains('dbg-box')) return;
    setIsPanning(true);
    setPanStart({ x: e.clientX - transform.x, y: e.clientY - transform.y });
  };
  const onMouseMove = (e: React.MouseEvent) => {
    if (!isPanning) return;
    setTransform((prev) => ({ ...prev, x: e.clientX - panStart.x, y: e.clientY - panStart.y }));
  };
  const onMouseUp = () => setIsPanning(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'f' || e.key === 'F') fit();
      if (e.key === '0') setTransform({ scale: 1, x: 40, y: 40 });
      if (e.key === '+' || e.key === '=') zoom(1);
      if (e.key === '-') zoom(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fit, zoom]);

  const selected = manifest.final.find((d) => d.id === selectedId);

  // 合并溯源：选中框若为合并目标，找出被合并进来的源框文字
  const mergeGroup = selected
    ? manifest.merge.mergedGroups.find((g) => g.intoId === selected.id)
    : undefined;
  const mergedFrom = mergeGroup
    ? mergeGroup.fromIds
        .map((id) => manifest.stage1Raw.find((s) => s.id === id))
        .filter((x): x is NonNullable<typeof x> => Boolean(x))
    : [];

  return (
    <div className="debug-viewer">
      {/* 工具栏：图层开关 */}
      <div className="dbg-toolbar">
        <Space size="middle" wrap>
          <Space size="small">
            <Switch size="small" checked={layers.tiles} onChange={(v) => setLayers((l) => ({ ...l, tiles: v }))} />
            <span className="legend sw-tile" /> <Text type="secondary">瓦片网格</Text>
          </Space>
          <Space size="small">
            <Switch size="small" checked={layers.stage1Raw} onChange={(v) => setLayers((l) => ({ ...l, stage1Raw: v }))} />
            <span className="legend sw-s1" /> <Text type="secondary">Stage1原始框 ({manifest.stage1Raw.length})</Text>
          </Space>
          <Space size="small">
            <Switch size="small" checked={layers.suppressed} onChange={(v) => setLayers((l) => ({ ...l, suppressed: v }))} />
            <span className="legend sw-sup" /> <Text type="secondary">NMS抑制 ({manifest.merge.suppressed.length})</Text>
          </Space>
          <Space size="small">
            <Switch size="small" checked={layers.final} onChange={(v) => setLayers((l) => ({ ...l, final: v }))} />
            <span className="legend sw-fin" /> <Text type="secondary">最终框 ({manifest.final.length})</Text>
          </Space>
        </Space>
        <Space>
          <Button size="small" icon={<CompressOutlined />} onClick={fit}>
            适配(F)
          </Button>
          <Button size="small" icon={<CloseOutlined />} onClick={onExit} danger>
            退出调试
          </Button>
        </Space>
      </div>

      <div className="dbg-body">
        {/* 画布 */}
        <div
          ref={containerRef}
          className="dbg-canvas"
          onWheel={onWheel}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseUp}
          onDoubleClick={fit}
        >
          {!imgLoaded && <div className="dbg-loading">加载大图中…</div>}
          {W > 0 && (
            <div
              className="dbg-stage"
              style={{ transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})` }}
            >
              <img
                src={imageUrl}
                alt="original"
                onLoad={handleImageLoad}
                style={{ display: 'block', maxWidth: 'none' }}
                draggable={false}
              />
              <div className="dbg-overlay" style={{ width: W, height: H }}>
                {layers.tiles &&
                  manifest.tiles.map((t) => (
                    <div
                      key={`tile-${t.index}`}
                      className="dbg-tile"
                      style={{ left: t.x, top: t.y, width: t.width, height: t.height }}
                      title={`瓦片 ${t.index} (${t.x},${t.y})`}
                    />
                  ))}

                {layers.stage1Raw &&
                  manifest.stage1Raw.map((d) => (
                    <div
                      key={`s1-${d.id}`}
                      className="dbg-box dbg-s1"
                      style={{
                        left: d.bbox[0],
                        top: d.bbox[1],
                        width: Math.max(2, d.bbox[2] - d.bbox[0]),
                        height: Math.max(2, d.bbox[3] - d.bbox[1]),
                      }}
                      title={`Stage1: ${d.text}`}
                    />
                  ))}

                {layers.suppressed &&
                  manifest.merge.suppressed.map((d) => (
                    <div
                      key={`sup-${d.id}`}
                      className="dbg-box dbg-sup"
                      style={{
                        left: d.bbox[0],
                        top: d.bbox[1],
                        width: Math.max(2, d.bbox[2] - d.bbox[0]),
                        height: Math.max(2, d.bbox[3] - d.bbox[1]),
                      }}
                      title={`NMS抑制 (${d.phase}, iou=${d.iou.toFixed(2)}): ${d.text}`}
                    />
                  ))}

                {layers.final &&
                  manifest.final.map((d) => {
                    const isSel = d.id === selectedId;
                    const label = (d.refinedText || d.text || '').slice(0, 16);
                    return (
                      <div
                        key={`fin-${d.id}`}
                        className={`dbg-box dbg-fin ${isSel ? 'selected' : ''}`}
                        style={{
                          left: d.bbox[0],
                          top: d.bbox[1],
                          width: Math.max(2, d.bbox[2] - d.bbox[0]),
                          height: Math.max(2, d.bbox[3] - d.bbox[1]),
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedId(isSel ? undefined : d.id);
                        }}
                        title={d.refinedText || d.text}
                      >
                        <span className="dbg-label">{label}</span>
                      </div>
                    );
                  })}
              </div>
            </div>
          )}
          <div className="dbg-hud">
            {W} × {H} · 缩放 {transform.scale.toFixed(2)}x
          </div>
        </div>

        {/* 右侧钻取面板 */}
        <div className="dbg-side">
          {selected ? (
            <Card
              size="small"
              title="选中框详情"
              extra={
                <Button size="small" type="primary" icon={<AimOutlined />} onClick={() => focusBox(selected.bbox)}>
                  聚焦此框
                </Button>
              }
            >
              <Paragraph style={{ marginBottom: 8 }}>
                <Text strong>精炼文字：</Text>
                <Text style={{ color: '#1677ff' }}> {selected.refinedText || selected.text}</Text>
              </Paragraph>
              {selected.refinedText && selected.refinedText !== selected.text && (
                <div style={{ fontSize: 12, color: '#888', marginBottom: 6 }}>
                  Stage1 粗识：<Text type="secondary">{selected.text}</Text>
                </div>
              )}
              <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>
                坐标：[{selected.bbox.map((v) => Math.round(v)).join(', ')}]
              </div>
              <div style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>
                {(selected.refinedStyle || selected.style) && <>风格：{selected.refinedStyle || selected.style} · </>}
                置信度：{(((selected.refinedConfidence ?? selected.confidence) ?? 0) * 100).toFixed(0)}%
              </div>

              {selected.cropFile && (
                <div style={{ marginBottom: 8 }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    Stage2 crop（精识输入）：
                  </Text>
                  <img
                    src={debugFileUrl(runId, selected.cropFile)}
                    alt="crop"
                    style={{
                      maxWidth: '100%',
                      border: '1px solid #eee',
                      borderRadius: 4,
                      marginTop: 4,
                      display: 'block',
                    }}
                  />
                </div>
              )}

              {mergedFrom.length > 0 && (
                <div style={{ fontSize: 12, color: '#888', background: '#fafafa', padding: 6, borderRadius: 4 }}>
                  <Text type="secondary">合并来源（{mergedFrom.length}）：</Text>
                  <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                    {mergedFrom.map((m) => (
                      <li key={m.id}>{m.text}</li>
                    ))}
                  </ul>
                </div>
              )}
            </Card>
          ) : (
            <Empty description="点击图上的红色框，核对文案与位置" style={{ marginTop: 60 }} />
          )}

          <Card size="small" title="本次运行参数" style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12, color: '#666', lineHeight: 1.9 }}>
              <div>
                瓦片：{manifest.params.tileSize}px · 重叠 {manifest.params.overlapRatio}（{manifest.params.overlapPx}px）
              </div>
              <div>crop 外扩：{manifest.params.contextPadding}px</div>
              <div>并发：{manifest.params.maxConcurrency}</div>
              <div>模型：{manifest.params.stage1Model}</div>
              <div>时间：{manifest.createdAt}</div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
