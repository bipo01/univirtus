// Abre (ou traz para frente) a página da extensão, lembrando de qual aba do AVA ela veio,
// e mantém a regra que permite baixar vídeos do YouTube.

import { ensureYouTubeRule } from './app/lib/yt-rule.js';

chrome.runtime.onInstalled.addListener(() => ensureYouTubeRule().catch(() => {}));
chrome.runtime.onStartup.addListener(() => ensureYouTubeRule().catch(() => {}));

const APP_URL = chrome.runtime.getURL('app/app.html');
const AVA_PREFIX = 'https://univirtus.uninter.com/';

async function openApp(avaTabId) {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
  const open = contexts.find((c) => c.documentUrl?.startsWith(APP_URL));
  if (open) {
    await chrome.tabs.update(open.tabId, { active: true });
    await chrome.windows.update(open.windowId, { focused: true });
    if (avaTabId) chrome.runtime.sendMessage({ type: 'app:ava-tab', tabId: avaTabId }).catch(() => {});
    return;
  }
  await chrome.tabs.create({ url: avaTabId ? `${APP_URL}?tab=${avaTabId}` : APP_URL });
}

chrome.action.onClicked.addListener((tab) => {
  openApp(tab?.url?.startsWith(AVA_PREFIX) ? tab.id : null);
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'open-app' && sender.id === chrome.runtime.id) openApp(sender.tab?.id ?? null);
});
