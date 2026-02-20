import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

import { Button, TextInput } from '../src/renderer/ui';

describe('ui primitives', () => {
  it('Button defaults to type=button and calls onClick', () => {
    const onClick = vi.fn();

    render(<Button onClick={onClick}>Save</Button>);
    const btn = screen.getByRole('button', { name: 'Save' });

    expect(btn).toHaveAttribute('type', 'button');

    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('Button is disabled when loading', () => {
    const onClick = vi.fn();

    render(
      <Button loading onClick={onClick}>
        Save
      </Button>
    );
    const btn = screen.getByRole('button', { name: 'Save' });

    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(0);
  });

  it('TextInput sets aria-invalid and renders hint/error', () => {
    render(<TextInput label="Email" hint="We never spam" error="Required" />);

    const input = screen.getByLabelText('Email');
    expect(input).toHaveAttribute('aria-invalid', 'true');

    expect(screen.getByText('We never spam')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Required');
  });
});
