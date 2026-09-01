import React from 'react';
import ReactDOM from 'react-dom/client';

import { App } from './App';
import './styles.css';
import './themes/orion-blocksmith.tokens.css';
import './themes/orion-blocksmith.components.css';

const root = document.getElementById('root');

if (!root) throw new Error('Orion Web root element was not found.');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
