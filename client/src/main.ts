import { initApp } from './app';
import './style.css';

document.addEventListener('DOMContentLoaded', () => {
  const app = document.getElementById('app');
  if (app) initApp(app);
});
