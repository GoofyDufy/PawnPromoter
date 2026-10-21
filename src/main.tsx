import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { DbClient } from './data/client';
import { App } from './ui/App';
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import './ui/styles.css';

const client = new DbClient();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App client={client} />
  </StrictMode>,
);
