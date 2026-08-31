chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (message && message.type === "OPEN_URLS" && Array.isArray(message.urls)) {
    message.urls.forEach(function (url) {
      chrome.tabs.create({ url: url });
    });
  }
});
