import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import CaptionWindow from './CaptionWindow';
import Workspace from './Workspace';
import './style.css';
import './controller.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>{window.location.pathname === '/captions' ? <CaptionWindow /> : window.location.pathname === '/workspace' ? <Workspace /> : <App />}</StrictMode>,
);
