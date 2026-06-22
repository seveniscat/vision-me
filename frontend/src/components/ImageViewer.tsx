import React, { useRef, useState, useCallback, useEffect } from 'react';
import type { Detection } from '../types';

interface ImageViewerProps {
  imageUrl: string | null;
  imageWidth: number;
  imageHeight: number;
  detections: Detection[];
  selectedId?: string;
  onSelect: (id: string | undefined) => void;
}

interface Transform {
  scale: number;
  x: number;
  y: number;
}

export default function ImageViewer({
  imageUrl,
  imageWidth,
  imageHeight,
  detections,
  selectedId,
  onSelect,
}: ImageViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  const [transform, setTransform] = useState<Transform>({ scale: 1, x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  const [imgLoaded, setImgLoaded] = useState(false);

  // 根据容器大小计算初始适配比例
  const fitToContainer = useCallback(() => {
    const container = containerRef.current;
    if (!container || !imageWidth || !imageHeight) return;

    const cw = container.clientWidth - 40;
    const ch = container.clientHeight - 40;

    const scaleX = cw / imageWidth;
    const scaleY = ch / imageHeight;
    const scale = Math.min(scaleX, scaleY, 1); // 不放大

    const displayW = imageWidth * scale;
    const displayH = imageHeight * scale;

    const x = Math.max(0, (cw - displayW) / 2 + 20);
    const y = Math.max(0, (ch - displayH) / 2 + 20);

    setTransform({ scale, x, y });
  }, [imageWidth, imageHeight]);

  // 图片加载完成后自动适配
  const handleImageLoad = () => {
    setImgLoaded(true);
    setTimeout(fitToContainer, 50);
  };

  // 缩放（以鼠标位置为中心）
  const zoom = useCallback(
    (delta: number, clientX?: number, clientY?: number) => {
      const container = containerRef.current;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      const cx = clientX !== undefined ? clientX - rect.left : rect.width / 2;
      const cy = clientY !== undefined ? clientY - rect.top : rect.height / 2;

      setTransform((prev) => {
        const newScale = Math.max(0.05, Math.min(8, prev.scale * (delta > 0 ? 1.2 : 1 / 1.2)));

        // 计算鼠标在图片坐标系的位置
        const imgX = (cx - prev.x) / prev.scale;
        const imgY = (cy - prev.y) / prev.scale;

        // 新位置
        const newX = cx - imgX * newScale;
        const newY = cy - imgY * newScale;

        return { scale: newScale, x: newX, y: newY };
      });
    },
    []
  );

  // 鼠标滚轮缩放
  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    zoom(e.deltaY, e.clientX, e.clientY);
  };

  // 拖拽平移
  const handleMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).classList.contains('detection-box')) {
      return; // 点击的是检测框，不启动平移
    }
    setIsPanning(true);
    setPanStart({ x: e.clientX - transform.x, y: e.clientY - transform.y });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isPanning) return;
    setTransform((prev) => ({
      ...prev,
      x: e.clientX - panStart.x,
      y: e.clientY - panStart.y,
    }));
  };

  const handleMouseUp = () => setIsPanning(false);

  // 键盘快捷键
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'f' || e.key === 'F') {
        fitToContainer();
      }
      if (e.key === '0') {
        setTransform({ scale: 1, x: 40, y: 40 });
      }
      if (e.key === '+' || e.key === '=') {
        zoom(1);
      }
      if (e.key === '-') {
        zoom(-1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fitToContainer, zoom]);

  // 外部图片变化时重置
  useEffect(() => {
    setImgLoaded(false);
    setTransform({ scale: 1, x: 0, y: 0 });
  }, [imageUrl]);

  // 渲染检测框（按原始像素坐标，靠外层 transform 缩放）
  const renderBoxes = () => {
    if (!imgLoaded) return null;

    return detections.map((det) => {
      const [x1, y1, x2, y2] = det.bbox;
      const isSelected = det.id === selectedId;

      return (
        <div
          key={det.id}
          className={`detection-box ${isSelected ? 'selected' : ''}`}
          style={{
            left: x1,
            top: y1,
            width: Math.max(2, x2 - x1),
            height: Math.max(2, y2 - y1),
          }}
          onClick={(e) => {
            e.stopPropagation();
            onSelect(isSelected ? undefined : det.id);
          }}
          title={`${det.refinedText || det.text} (${det.bbox.join(', ')})`}
        >
          <div className={`box-label ${isSelected ? 'selected' : ''}`}>
            {(() => {
              const t = (det.refinedText || det.text) || '';
              const s = det.refinedStyle || det.style;
              const main = t.length > 16 ? t.slice(0, 14) + '…' : t;
              return s ? `${main} · ${s}` : main;
            })()}
          </div>
        </div>
      );
    });
  };

  const hasImage = !!imageUrl;

  return (
    <div
      ref={containerRef}
      className="image-viewer"
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onDoubleClick={fitToContainer}
    >
      {!hasImage && (
        <div className="upload-area">
          <div className="empty-state">
            <div style={{ fontSize: 48, marginBottom: 12 }}>🖼️</div>
            <div>请上传刀模图（支持 8000×8000+ 超大图）</div>
            <div style={{ fontSize: 12, marginTop: 8 }}>支持 JPG / PNG / WEBP</div>
          </div>
        </div>
      )}

      {hasImage && (
        <div
          className="image-container"
          style={{
            transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
          }}
        >
          <img
            ref={imgRef}
            src={imageUrl ?? undefined}
            alt="待检测图片"
            onLoad={handleImageLoad}
            style={{ display: 'block', maxWidth: 'none' }}
            draggable={false}
          />
          <div
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width: imageWidth,
              height: imageHeight,
              pointerEvents: 'none',
            }}
          >
            {renderBoxes()}
          </div>
        </div>
      )}

      {/* 右下角提示 */}
      {hasImage && imgLoaded && (
        <div
          style={{
            position: 'absolute',
            right: 12,
            bottom: 12,
            background: 'rgba(0,0,0,0.6)',
            color: '#fff',
            padding: '2px 8px',
            fontSize: 11,
            borderRadius: 3,
            pointerEvents: 'none',
          }}
        >
          {imageWidth} × {imageHeight} · 缩放 {transform.scale.toFixed(2)}x
        </div>
      )}
    </div>
  );
}
