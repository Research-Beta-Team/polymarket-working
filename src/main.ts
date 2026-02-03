import { MultiAssetStreamingPlatform } from './multi-asset-streaming-platform';
import './styles.css';

// Wait for DOM to be ready before initializing
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    initializeApp();
  });
} else {
  // DOM is already ready
  initializeApp();
}

function initializeApp(): void {
  const app = document.getElementById('app');
  if (!app) {
    console.error('App element not found! Make sure index.html has <div id="app"></div>');
    return;
  }

  const platform = new MultiAssetStreamingPlatform();
  platform.initialize().catch((error) => {
    console.error('Failed to initialize platform:', error);
  });
}

