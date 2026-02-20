import React from 'react';

import { getDesktopApi } from '../../services/desktopApi';
import { getErrorCode, isMdFile, pollMaterialUntilDone, toReadableKnowledgeError } from '../../services/knowledgeFeed';
import { Card } from '../../ui/Card';
import { AppShell } from '../shell/AppShell';
import { TEST_IDS } from '../testIds';

type FeedPhase = 'idle' | 'uploading' | 'indexing' | 'done' | 'error';

export function KnowledgePage() {
  const [feedPhase, setFeedPhase] = React.useState<FeedPhase>('idle');
  const [feedFilename, setFeedFilename] = React.useState('');
  const [feedError, setFeedError] = React.useState('');
  const abortRef = React.useRef<AbortController | null>(null);

  React.useEffect(() => {
    return () => {
      try {
        abortRef.current?.abort();
      } catch {
      }
    };
  }, []);

  async function onFeedDrop(e: React.DragEvent<HTMLButtonElement>) {
    e.preventDefault();
    e.stopPropagation();

    setFeedError('');

    const file = e.dataTransfer.files?.item(0);
    if (!file) {
      setFeedPhase('error');
      setFeedError('未检测到文件');
      return;
    }

    if (!isMdFile(file)) {
      setFeedPhase('error');
      setFeedError('仅支持 .md 文件');
      return;
    }

    const knowledge = getDesktopApi()?.knowledge;
    if (!knowledge) {
      setFeedPhase('error');
      setFeedError('投喂接口不可用');
      return;
    }

    try {
      abortRef.current?.abort();
    } catch {
    }
    const controller = new AbortController();
    abortRef.current = controller;

    const filename = file.name;
    setFeedFilename(filename);
    setFeedPhase('uploading');

    try {
      const bytes = await file.arrayBuffer();
      const uploaded = await knowledge.uploadMaterial({
        bytes,
        filename,
        mimeType: file.type || 'text/markdown',
        saveId: 'default'
      });

      if (uploaded.status === 'indexed') {
        setFeedPhase('done');
        return;
      }
      if (uploaded.status === 'failed') {
        setFeedPhase('error');
        setFeedError(uploaded.error || '索引失败');
        return;
      }

      setFeedPhase('indexing');
      const finalM = await pollMaterialUntilDone(knowledge, uploaded.id, controller.signal);
      if (finalM.status === 'indexed') {
        setFeedPhase('done');
        return;
      }

      setFeedPhase('error');
      setFeedError(finalM.error || '索引失败');
    } catch (err: unknown) {
      if (getErrorCode(err).includes('ABORTED')) return;
      setFeedPhase('error');
      setFeedError(toReadableKnowledgeError(err));
    }
  }

  function onFeedDragOver(e: React.DragEvent<HTMLButtonElement>) {
    e.preventDefault();
  }

  return (
    <AppShell>
      <div className="ui-shell__content">
        <div style={{ width: 'min(980px, 100%)', margin: '0 auto', paddingTop: 24, display: 'grid', gap: 12 }}>
          <Card as="main">
            <h2>Knowledge</h2>
            <div style={{ color: 'var(--muted)', fontSize: 13 }}>拖拽 .md 文件到下方区域，自动上传并等待索引完成。</div>
          </Card>

          <button
            data-testid={TEST_IDS.feedDropzone}
            onDragEnter={onFeedDragOver}
            onDragOver={onFeedDragOver}
            onDrop={(e) => void onFeedDrop(e)}
            type="button"
            aria-label="知识投喂拖拽区"
            className="card"
            style={{
              background: 'linear-gradient(180deg, var(--card), rgba(255, 255, 255, 0.03))',
              border: '1px dashed var(--line)',
              borderRadius: 'var(--radius-lg)',
              padding: 14,
              boxShadow: 'var(--shadow-card)',
              backdropFilter: 'blur(10px)',
              minHeight: 132,
              display: 'grid',
              placeItems: 'center',
              cursor: 'copy',
              userSelect: 'none'
            }}
          >
            <div style={{ textAlign: 'center', display: 'grid', gap: 8 }}>
              <div style={{ fontWeight: 650 }}>拖拽 .md 文件到此处</div>
              <div style={{ color: 'var(--muted)', fontSize: 13 }}>支持单文件；会先上传，再轮询索引状态</div>

              {feedPhase === 'uploading' || feedPhase === 'indexing' ? (
                <div data-testid={TEST_IDS.feedProgress} style={{ display: 'flex', justifyContent: 'center' }}>
                  <span style={{ color: 'var(--muted)', fontSize: 13 }}>
                    {feedPhase === 'uploading' ? '上传中…' : '索引中…'} {feedFilename ? `(${feedFilename})` : ''}
                  </span>
                </div>
              ) : null}

              {feedPhase === 'done' ? (
                <div data-testid={TEST_IDS.feedDone} style={{ display: 'flex', justifyContent: 'center' }}>
                  <span style={{ color: 'var(--muted)', fontSize: 13 }}>已完成 {feedFilename ? `(${feedFilename})` : ''}</span>
                </div>
              ) : null}

              {feedPhase === 'error' && feedError ? (
                <div style={{ color: 'var(--danger)', fontSize: 13, maxWidth: 520 }}>{feedError}</div>
              ) : null}
            </div>
          </button>
        </div>
      </div>
    </AppShell>
  );
}
