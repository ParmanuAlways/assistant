import { browser } from 'wxt/browser';

export default defineBackground(() => {
  // Clicking the toolbar icon opens the side panel (Chrome). Firefox uses sidebar_action instead.
  (browser as any).sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
