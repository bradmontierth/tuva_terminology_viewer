import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import reportWebVitals from './reportWebVitals';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

const isTruthy = (v) => {
  const flag = String(v || '').trim().toLowerCase();
  return flag === '1' || flag === 'true' || flag === 'yes';
};

const disableSqliteSW = isTruthy(process.env.REACT_APP_DISABLE_SQLITE_SW);
const forceUnregisterAllSW = isTruthy(process.env.REACT_APP_FORCE_SW_UNREGISTER_ALL);

if ('serviceWorker' in navigator) {
  if (disableSqliteSW || forceUnregisterAllSW) {
    // Attempt to unregister previously registered service workers
    window.addEventListener('load', () => {
      try {
        navigator.serviceWorker.getRegistrations().then((registrations) => {
          registrations.forEach((registration) => {
            const scriptURL = registration?.active?.scriptURL || registration?.installing?.scriptURL || registration?.waiting?.scriptURL || '';
            if (forceUnregisterAllSW || (/\/sqlite-sw\.js(\?.*)?$/.test(scriptURL))) {
              registration.unregister().catch(() => {});
            }
          });
        });
      } catch (e) { /* ignore */ }
    });
  } else {
    window.addEventListener('load', () => {
      const publicUrl = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
      const swUrl = `${publicUrl}/sqlite-sw.js`;
      navigator.serviceWorker.register(swUrl).catch(() => {
        // eslint-disable-next-line no-console
        console.warn('Service worker registration failed.');
      });
    });
  }
}

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals();
