import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';

const rootElement = document.getElementById('root');
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      {/* Without this, any render error unmounts the whole panel and the side panel
          simply goes black, with no indication that the extension crashed. */}
      <ErrorBoundary label="Keyboard Warriors">
        <App />
      </ErrorBoundary>
    </React.StrictMode>
  );
}
