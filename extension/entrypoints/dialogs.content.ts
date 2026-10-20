// Chrome: the alert()/confirm() hook in the page's own JavaScript world (see lib/page.ts installDialogHook).
import { installDialogHook } from '../lib/page';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  allFrames: true,
  world: 'MAIN',
  include: ['chrome'],
  main() {
    installDialogHook();
  },
});
