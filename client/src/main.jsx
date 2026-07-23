import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './index.css';
import { registerServiceWorker } from './lib/push.js';
import './lib/pwa.js'; // capture the install prompt as early as possible
import { installDomGuard } from './lib/domGuard.js';

// Before React mounts: make the DOM resilient to auto-translate / extensions that
// mutate text nodes, so a translated page doesn't crash the whole app.
installDomGuard();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Register the push-only service worker (makes the app installable + able to
// receive notifications). No-ops where unsupported; caches nothing.
registerServiceWorker();
