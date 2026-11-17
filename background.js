const playerUrl = chrome.runtime.getURL('index.html');
const requestHeader = { header: 'referer', operation: 'set', value: 'https://www.bilibili.com/' };

// The site's Web API and media CDN expect a Bilibili referrer. Scope it to requests
// initiated by this extension, including playback in its own tab.
const refererRules = [
  { id: 1, domains: ['api.bilibili.com'], resourceType: 'xmlhttprequest' },
  { id: 2, domains: ['bilivideo.com', 'bilivideo.cn'], resourceType: 'media' },
].map(({ id, domains, resourceType }) => ({
  id,
  action: { type: 'modifyHeaders', requestHeaders: [requestHeader] },
  condition: {
    initiatorDomains: [chrome.runtime.id],
    requestDomains: domains,
    requestMethods: ['get', 'head'],
    resourceTypes: [resourceType],
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
