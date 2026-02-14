import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './app/App';
import PetApp from './pet/PetApp';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {new URLSearchParams(window.location.search).get('window') === 'pet' ? (
      <PetApp />
    ) : (
      <App />
    )}
  </React.StrictMode>
);
