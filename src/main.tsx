import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import CaptionWindow from './CaptionWindow';
import './style.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>{window.location.pathname === '/captions' ? <CaptionWindow /> : <App />}</StrictMode>,
);
