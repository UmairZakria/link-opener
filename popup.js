(function () {
  "use strict";

  var DEFAULT_SETTINGS = {
    openAddressUnmask: true,
    openAddressThatsThem: true,
    openAddressAdvanced: true,
    openNameThatsThem: true,
    openNameAdvanced: true,
  };

  var toggles = {
    openAddressUnmask: document.getElementById("openAddressUnmask"),
    openAddressThatsThem: document.getElementById("openAddressThatsThem"),
    openAddressAdvanced: document.getElementById("openAddressAdvanced"),
    openNameThatsThem: document.getElementById("openNameThatsThem"),
    openNameAdvanced: document.getElementById("openNameAdvanced"),
  };

  var addrCount = document.getElementById("addr-count");
  var nameCount = document.getElementById("name-count");

  function updateBadges() {
    var addrActive = 0;
    if (toggles.openAddressUnmask && toggles.openAddressUnmask.checked) addrActive++;
    if (toggles.openAddressThatsThem && toggles.openAddressThatsThem.checked) addrActive++;
    if (toggles.openAddressAdvanced && toggles.openAddressAdvanced.checked) addrActive++;
    if (addrCount) addrCount.textContent = addrActive + " active";

    var nameActive = 0;
    if (toggles.openNameThatsThem && toggles.openNameThatsThem.checked) nameActive++;
    if (toggles.openNameAdvanced && toggles.openNameAdvanced.checked) nameActive++;
    if (nameCount) nameCount.textContent = nameActive + " active";
  }

  function loadSettings(callback) {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(null, function (items) {
        var merged = Object.assign({}, DEFAULT_SETTINGS, items || {});
        callback(merged);
      });
    } else {
      var saved = localStorage.getItem("link_opener_settings");
      callback(saved ? Object.assign({}, DEFAULT_SETTINGS, JSON.parse(saved)) : DEFAULT_SETTINGS);
    }
  }

  function saveCurrentState() {
    var settings = {};
    for (var key in toggles) {
      if (toggles[key]) {
        settings[key] = toggles[key].checked;
      }
    }

    if (typeof chrome !== "undefined" && chrome.storage) {
      if (chrome.storage.local) chrome.storage.local.set(settings);
      if (chrome.storage.sync) chrome.storage.sync.set(settings);
    }
    try {
      localStorage.setItem("link_opener_settings", JSON.stringify(settings));
    } catch (e) {}

    // 1. Broadcast to background
    try {
      chrome.runtime.sendMessage({
        type: "SETTINGS_UPDATED",
        settings: settings,
      });
    } catch (e) {}

    // 2. Broadcast directly to all open tabs for instant live update
    try {
      chrome.tabs.query({}, function (tabs) {
        if (tabs && tabs.length) {
          tabs.forEach(function (tab) {
            if (tab && tab.id) {
              chrome.tabs.sendMessage(
                tab.id,
                {
                  type: "SETTINGS_UPDATED",
                  settings: settings,
                },
                function () {
                  if (chrome.runtime.lastError) {}
                }
              );
            }
          });
        }
      });
    } catch (e) {}

    updateBadges();
  }

  // Initialize UI
  loadSettings(function (settings) {
    for (var key in toggles) {
      if (toggles[key]) {
        toggles[key].checked =
          settings && settings[key] !== undefined ? !!settings[key] : DEFAULT_SETTINGS[key];
        toggles[key].addEventListener("change", saveCurrentState);
      }
    }
    updateBadges();
  });
})();
