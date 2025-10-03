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

const shouldRegisterSqliteSW = () => {
  const flag = String(process.env.REACT_APP_DISABLE_SQLITE_SW || '').trim().toLowerCase();
  return !(flag === '1' || flag === 'true' || flag === 'yes');
};

if ('serviceWorker' in navigator && shouldRegisterSqliteSW()) {
  window.addEventListener('load', () => {
    const publicUrl = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
    const swUrl = `${publicUrl}/sqlite-sw.js`;
    navigator.serviceWorker.register(swUrl).catch(() => {
      // eslint-disable-next-line no-console
      console.warn('Service worker registration failed.');
    });
  });
}

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals();
