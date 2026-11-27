import './zod-csp.js';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/layout.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App.js';
import { createApiClient } from './api/client.js';
import { withSettingsLoad } from './state/settings-load.js';

const root = document.getElementById('root');
if (!root) throw new Error('Luady could not start: #root is missing from index.html');

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <App api={withSettingsLoad(createApiClient())} />
    </BrowserRouter>
  </StrictMode>,
);
