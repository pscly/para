import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { getDesktopApi } from '../../services/desktopApi';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { TextInput } from '../../ui/TextInput';
import { TEST_IDS } from '../testIds';
import { AppShell } from '../shell/AppShell';

function getErrorCode(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string') return msg;
  }
  return 'UNKNOWN';
}

function toReadableRegisterError(err: unknown): string {
  const code = getErrorCode(err);
  if (code.includes('invite_code_required')) return '需要邀请码';
  if (code.includes('invite_code_invalid')) return '邀请码无效';
  if (code.includes('invite_code_revoked')) return '邀请码已撤销';
  if (code.includes('invite_code_expired')) return '邀请码已过期';
  if (code.includes('invite_code_exhausted')) return '邀请码已用尽';
  if (code.includes('NETWORK_ERROR')) return '网络错误';
  if (code.includes('SAFE_STORAGE_UNAVAILABLE')) {
    return '本机安全存储不可用，无法安全保存登录态（已禁止明文保存 token）。请先修复系统密钥环/凭据服务或更换到受支持的桌面环境后重试。';
  }
  return '注册失败';
}

export function DevRegisterPage() {
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;

    const emailIn = email.trim();
    const passwordIn = password;
    const inviteIn = inviteCode.trim();

    if (!emailIn || !passwordIn) {
      setError('请输入邮箱与密码');
      return;
    }

    const register = getDesktopApi()?.auth?.register;
    if (typeof register !== 'function') {
      setError('注册失败');
      return;
    }

    setSubmitting(true);
    setError('');
    try {
      await register(emailIn, passwordIn, inviteIn || undefined);
      navigate('/chat');
    } catch (err: unknown) {
      setError(toReadableRegisterError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AppShell>
      <div className="ui-shell__content">
        <div style={{ width: 'min(520px, 100%)', margin: '0 auto', paddingTop: 32 }}>
          <Card as="main">
            <h2>注册（Dev Only）</h2>

            <form onSubmit={onSubmit} style={{ display: 'grid', gap: 10 }}>
              <TextInput
                label="邮箱"
                placeholder="邮箱"
                inputMode="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={submitting}
                data-testid={TEST_IDS.registerEmail}
              />
              <TextInput
                label="密码"
                placeholder="密码"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={submitting}
                data-testid={TEST_IDS.registerPassword}
              />
              <TextInput
                label="邀请码（可选）"
                placeholder="邀请码（可选）"
                autoComplete="off"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
                disabled={submitting}
                data-testid={TEST_IDS.registerInviteCode}
              />

              {error ? (
                <div className="ui-field__error" role="alert" data-testid={TEST_IDS.registerError}>
                  {error}
                </div>
              ) : null}

              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <Button data-testid={TEST_IDS.registerSubmit} type="submit" loading={submitting}>
                  {submitting ? '注册中…' : '注册'}
                </Button>
              </div>
            </form>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}
