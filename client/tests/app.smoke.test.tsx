import React from 'react';
import { render, screen } from '@testing-library/react';
import { App } from '../src/renderer/app/App';
import { TEST_IDS } from '../src/renderer/app/testIds';

describe('App smoke', () => {
  it('renders debug panel and stable testids', () => {
    render(<App />);

    expect(screen.getByText('桌宠调试面板')).toBeInTheDocument();
    expect(screen.getByTestId(TEST_IDS.loginEmail)).toBeInTheDocument();
    expect(screen.getByTestId(TEST_IDS.chatInput)).toBeInTheDocument();
  });
});
