import { useState } from 'react';
import { Upload, message, Progress, Button } from 'antd';
import { CloudUploadOutlined } from '@ant-design/icons';
import type { UploadProps } from 'antd';
import { uploadImage, type UploadResult } from '../api';

export interface UploadButtonProps {
  accept?: string;
  maxSize?: number; // MB
  onUploaded?: (info: UploadResult) => void;
  text?: string;
}

/**
 * 可复用的上传组件：选择图片 → 经后端 /api/upload 传到签名上传服务 → 通过 onUploaded 回调返回 URL 等信息。
 * 镜像 vision-me 既有约定（axios 实例 + antd），未引入新依赖。
 */
export default function UploadButton(props: UploadButtonProps) {
  const { accept = 'image/*', maxSize = 200, onUploaded, text = '上传图片' } = props;
  const [progress, setProgress] = useState(0);

  const handleUpload: UploadProps['customRequest'] = async (options) => {
    const { file, onSuccess, onError } = options;
    if ((file as File).size / 1024 / 1024 > maxSize) {
      message.error(`文件不能超过 ${maxSize}MB`);
      onError?.(new Error('文件过大'));
      return;
    }
    setProgress(0);
    // axios 未在此处暴露上传进度，用模拟进度兜底；如需真实进度可改用 onUploadProgress
    const timer = setInterval(() => setProgress((p) => (p >= 90 ? p : p + 10)), 200);
    try {
      const info = await uploadImage(file as File);
      clearInterval(timer);
      setProgress(100);
      onUploaded?.(info);
      onSuccess?.({}, file as any);
    } catch (e: any) {
      clearInterval(timer);
      const msg = e?.response?.data?.error || e?.message || '上传失败';
      message.error('上传失败：' + msg);
      onError?.(e as Error);
    } finally {
      setTimeout(() => setProgress(0), 800);
    }
  };

  return (
    <>
      <Upload accept={accept} showUploadList={false} customRequest={handleUpload}>
        <Button icon={<CloudUploadOutlined />} block>
          {text}
        </Button>
      </Upload>
      {progress > 0 && progress < 100 && (
        <Progress percent={progress} size="small" style={{ marginTop: 8 }} />
      )}
    </>
  );
}
