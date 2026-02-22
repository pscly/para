import { Card } from '../../ui/Card';
import { AppShell } from '../shell/AppShell';

export function DevDiagnosticsPage() {
  return (
    <AppShell>
      <div className="ui-shell__content" data-testid="devDiagnostics">
        <Card>
          <h2>开发者诊断</h2>
          <div style={{ color: 'var(--muted)', fontSize: 13 }}>
            需要在 Settings 中开启“开发者选项（/dev）”后才能访问。正式包还需要先登录，并由后端为账号授权{' '}
            <code>debug_allowed</code>。
          </div>
        </Card>
      </div>
    </AppShell>
  );
}
