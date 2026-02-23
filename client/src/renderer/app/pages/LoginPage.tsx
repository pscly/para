import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

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

function toReadableLoginError(err: unknown): string {
  const code = getErrorCode(err);
  if (code.includes('BAD_CREDENTIALS')) return '用户名或邮箱或密码错误';
  if (code.includes('NETWORK_ERROR')) return '网络错误';
  if (code.includes('SAFE_STORAGE_UNAVAILABLE')) {
    return '本机安全存储不可用，无法安全保存登录态（已禁止明文保存 token）。请先修复系统密钥环/凭据服务或更换到受支持的桌面环境后重试。';
  }
  return '登录失败';
}

export function LoginPage() {
  const navigate = useNavigate();

  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;

    if (!identifier || !password) {
      setError('请输入用户名或邮箱与密码');
      return;
    }

    const login = getDesktopApi()?.auth?.login;
    if (typeof login !== 'function') {
      setError('登录失败');
      return;
    }

    setSubmitting(true);
    setError('');
    try {
      await login(identifier, password);
      navigate('/chat');
    } catch (err: unknown) {
      setError(toReadableLoginError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AppShell>
      <div className="ui-shell__content">
        <div style={{ width: 'min(520px, 100%)', margin: '0 auto', paddingTop: 32 }}>
          <Card as="main">
            <h2>登录</h2>

            <form onSubmit={onSubmit} style={{ display: 'grid', gap: 10 }}>
              <TextInput
                label="用户名或邮箱"
                placeholder="用户名或邮箱"
                inputMode="text"
                autoComplete="username"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                data-testid={TEST_IDS.loginEmail}
              />
              <TextInput
                label="密码"
                placeholder="密码"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                data-testid={TEST_IDS.loginPassword}
              />

              {error ? (
                <div className="ui-field__error" role="alert" data-testid={TEST_IDS.loginError}>
                  {error}
                </div>
              ) : null}

              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <Button data-testid={TEST_IDS.loginSubmit} type="submit" loading={submitting}>
                  {submitting ? '登录中…' : '登录'}
                </Button>
              </div>
            </form>

            <div className="row" style={{ justifyContent: 'center', marginTop: 10 }}>
              <Link
                to="/register"
                style={{ color: 'var(--accent)', textDecoration: 'underline', fontSize: 13 }}
              >
                没有账号？去注册
              </Link>
            </div>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}
