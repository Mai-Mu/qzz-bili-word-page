importScripts('src/download-jobs.js');

const playerUrl = chrome.runtime.getURL('index.html');
const requestHeader = { header: 'referer', operation: 'set', value: 'https://www.bilibili.com/' };

// The site's Web API and media CDN expect a Bilibili referrer. Scope it to requests
// initiated by this extension, including playback in its own tab.
const refererRules = [
  { id: 1, domains: ['api.bilibili.com'], resourceTypes: ['xmlhttprequest'] },
  { id: 2, domains: ['bilivideo.com', 'bilivideo.cn'], resourceTypes: ['media', 'xmlhttprequest'] },
  { id: 3, domains: ['i0.hdslb.com', 'i1.hdslb.com', 'i2.hdslb.com'], resourceTypes: ['xmlhttprequest'] },
].map(({ id, domains, resourceTypes }) => ({
  id,
  action: { type: 'modifyHeaders', requestHeaders: [requestHeader] },
  condition: {
    initiatorDomains: [chrome.runtime.id],
    requestDomains: domains,
    requestMethods: ['get', 'head'],
    resourceTypes,
  },
}));

function installRefererRules() {
  return chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: refererRules.map(({ id }) => id),
    addRules: refererRules,
  });
}

chrome.runtime.onInstalled.addListener(() => {
  installRefererRules().catch(console.error);
});

let openingPlayer;

chrome.action.onClicked.addListener(() => {
  openingPlayer ??= openPlayer().catch(console.error).finally(() => {
    openingPlayer = undefined;
  });
});

async function openPlayer() {
  await installRefererRules();
  const [player] = await chrome.runtime.getContexts({
    contextTypes: ['TAB'],
    documentUrls: [playerUrl],
  });
  if (player) {
    const tab = await chrome.tabs.get(player.tabId).catch(() => null);
    if (tab) {
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return;
    }
  }

  await chrome.tabs.create({ url: playerUrl });
}
