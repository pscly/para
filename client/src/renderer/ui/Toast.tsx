import React from 'react';

import { cx } from './cx';

export type ToastTone = 'info' | 'success' | 'error';

export type ToastItem = {
  id: string;
  title?: string;
  message: string;
  tone: ToastTone;
};

type ToastContextValue = {
  push: (toast: Omit<ToastItem, 'id'> & { id?: string }) => string;
  dismiss: (id: string) => void;
};

const ToastContext = React.createContext<ToastContextValue | null>(null);

function makeId() {
  return `t_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<ToastItem[]>([]);

  const value = React.useMemo<ToastContextValue>(() => {
    return {
      push: (toast) => {
        const id = toast.id ?? makeId();
        setToasts((prev) => [...prev, { id, title: toast.title, message: toast.message, tone: toast.tone }]);
        return id;
      },
      dismiss: (id) => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }
    };
  }, []);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="ui-toasts" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cx('ui-toast', `ui-toast--${t.tone}`)}
            role={t.tone === 'error' ? 'alert' : 'status'}
          >
            <div className="ui-toast__row">
              <div className="ui-toast__content">
                {t.title ? <div className="ui-toast__title">{t.title}</div> : null}
                <div className="ui-toast__message">{t.message}</div>
              </div>
              <button
                type="button"
                className="ui-toast__close"
                aria-label="Dismiss"
                onClick={() => value.dismiss(t.id)}
              >
                X
              </button>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = React.useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within ToastProvider');
  }
  return ctx;
}
