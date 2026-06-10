import { Table, Button, Space, Typography } from 'antd';
import { CopyOutlined, AimOutlined } from '@ant-design/icons';
import type { Detection } from '../types';

const { Text } = Typography;

interface ResultsTableProps {
  detections: Detection[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onCopyText: (text: string) => void;
}

export default function ResultsTable({
  detections,
  selectedId,
  onSelect,
  onCopyText,
}: ResultsTableProps) {
  const columns = [
    {
      title: '#',
      dataIndex: 'index',
      width: 48,
      render: (_: any, __: any, index: number) => index + 1,
    },
    {
      title: '文字内容（Stage2 精炼）',
      dataIndex: 'text',
      ellipsis: true,
      render: (_: any, record: Detection) => {
        const displayText = record.refinedText || record.text;
        const style = record.refinedStyle || record.style;
        return (
          <div>
            <Text copyable={{ text: displayText }} style={{ maxWidth: 180 }}>
              {displayText}
            </Text>
            {style && (
              <div style={{ fontSize: 11, color: '#888', marginTop: 1 }}>
                风格：{style}
              </div>
            )}
          </div>
        );
      },
    },
    {
      title: '位置 (x1,y1,x2,y2)',
      dataIndex: 'bbox',
      width: 155,
      render: (bbox: number[]) => (
        <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#666' }}>
          [{bbox.map((v) => Math.round(v)).join(', ')}]
        </span>
      ),
    },
    {
      title: '操作',
      width: 90,
      render: (_: any, record: Detection) => (
        <Space size="small">
          <Button
            type={record.id === selectedId ? 'primary' : 'default'}
            size="small"
            icon={<AimOutlined />}
            onClick={() => onSelect(record.id)}
          >
            定位
          </Button>
          <Button size="small" icon={<CopyOutlined />} onClick={() => onCopyText(record as any)} />
        </Space>
      ),
    },
  ];

  return (
    <Table
      size="small"
      dataSource={detections.map((d, i) => ({ ...d, index: i }))}
      columns={columns as any}
      rowKey="id"
      pagination={{ pageSize: 12, size: 'small', showSizeChanger: false }}
      scroll={{ y: 'calc(100vh - 340px)' }}
      onRow={(record) => ({
        onClick: () => onSelect(record.id),
        style: {
          background: record.id === selectedId ? '#f6ffed' : undefined,
          cursor: 'pointer',
        },
      })}
      locale={{ emptyText: '暂无检测结果' }}
    />
  );
}
