import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from '../src/renderer/app/App';
import { TEST_IDS } from '../src/renderer/app/testIds';

type PluginStatus = {
  enabled: boolean;
  installed: null;
  running: boolean;
  menuItems: Array<{ pluginId: string; id: string; label: string }>;
  lastError: null;
};

function makeStatus(enabled: boolean): PluginStatus {
  return {
    enabled,
    installed: null,
    running: false,
    menuItems: [],
    lastError: null
  };
}

describe('Plugins consent', () => {
  afterEach(() => {
    window.desktopApi = undefined;
  });

  it('requires explicit consent before enabling plugin execution', async () => {
    const setEnabled = vi.fn(async (next: boolean) => makeStatus(next));
    const getStatus = vi.fn(async () => makeStatus(false));

    const getMenuItems = vi.fn(async () => []);
    const clickMenuItem = vi.fn(async () => ({ ok: true }));
    const onOutput = vi.fn((_handler: unknown) => {
      return () => {};
    });

    window.desktopApi = ({
      plugins: {
        getStatus,
        setEnabled,
        listApproved: vi.fn(async () => []),
        install: vi.fn(async () => makeStatus(false)),
        getMenuItems,
        clickMenuItem,
        onOutput
      },
      versions: { node: 'test', chrome: 'test', electron: 'test' }
    } as unknown) as Window['desktopApi'];

    render(<App />);

    await waitFor(() => {
      expect(getStatus).toHaveBeenCalled();
    });

    const toggle = screen.getByTestId(TEST_IDS.pluginsToggle);
    fireEvent.click(toggle);

    expect(screen.getByTestId(TEST_IDS.pluginsConsentPanel)).toBeInTheDocument();
    expect(setEnabled).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId(TEST_IDS.pluginsConsentDecline));
    await waitFor(() => {
      expect(screen.queryByTestId(TEST_IDS.pluginsConsentPanel)).not.toBeInTheDocument();
    });
    expect(setEnabled).not.toHaveBeenCalled();

    fireEvent.click(toggle);
    expect(screen.getByTestId(TEST_IDS.pluginsConsentPanel)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId(TEST_IDS.pluginsConsentAccept));
    await waitFor(() => {
      expect(setEnabled).toHaveBeenCalledWith(true);
    });
    await waitFor(() => {
      expect(screen.queryByTestId(TEST_IDS.pluginsConsentPanel)).not.toBeInTheDocument();
    });

    expect(toggle).toHaveTextContent('已开启执行');
  });
});
