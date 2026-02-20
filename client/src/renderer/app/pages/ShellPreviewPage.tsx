import React from 'react';

import { Card } from '../../ui/Card';
import { AppShell } from '../shell/AppShell';

export function ShellPreviewPage() {
  return (
    <AppShell>
      <div className="ui-shell__content">
        <Card>
          <h2>Shell Preview</h2>
          <div style={{ color: 'var(--muted)', fontSize: 13 }}>
            Router/AppShell scaffolding is in place. Main pages will migrate out of the legacy debug panel next.
          </div>
        </Card>
      </div>
    </AppShell>
  );
}
