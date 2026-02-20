import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterApp } from './app/RouterApp';
import PetApp from './pet/PetApp';
import { initTheme } from './services/theme';
import './styles.css';

initTheme();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {new URLSearchParams(window.location.search).get('window') === 'pet' ? (
      <PetApp />
    ) : (
      <RouterApp />
    )}
  </React.StrictMode>
);
