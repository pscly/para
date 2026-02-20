import React from 'react';

import { Card } from '../../ui/Card';
import { AppShell } from '../shell/AppShell';

export function DevDiagnosticsPage() {
  return (
    <AppShell>
      <div className="ui-shell__content" data-testid="devDiagnostics">
        <Card>
          <h2>Dev Diagnostics</h2>
          <div style={{ color: 'var(--muted)', fontSize: 13 }}>
            Development-only page. Set PARA_DEV_MODE=1 to access.
          </div>
        </Card>
      </div>
    </AppShell>
  );
}
