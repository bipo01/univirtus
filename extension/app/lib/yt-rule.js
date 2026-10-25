// A API do YouTube recusa (403) pedidos com Origin "chrome-extension://...". Esta regra de sessão
// troca o Origin só nas chamadas desta extensão à API do player — nada mais é alterado.

const RULE_ID = 1;

export async function ensureYouTubeRule() {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [RULE_ID],
    addRules: [
      {
        id: RULE_ID,
        priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: [{ header: 'origin', operation: 'set', value: 'https://www.youtube.com' }] },
        condition: { urlFilter: '||www.youtube.com/youtubei/', initiatorDomains: [chrome.runtime.id], resourceTypes: ['xmlhttprequest', 'other'] },
      },
    ],
  });
}
