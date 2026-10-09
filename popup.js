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
  var refreshButton = document.getElementById("btn-refresh");
  var enableAllButton = document.getElementById("btn-enable-all");
  var saveButton = document.getElementById("btn-save");

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
        if (chrome.runtime.lastError) {
          callback(null, chrome.runtime.lastError.message);
          return;
        }
        var merged = Object.assign({}, DEFAULT_SETTINGS, items || {});
        callback(merged);
      });
    } else {
      try {
        var saved = localStorage.getItem("link_opener_settings");
        callback(saved ? Object.assign({}, DEFAULT_SETTINGS, JSON.parse(saved)) : DEFAULT_SETTINGS);
      } catch (error) {
        callback(null, error.message);
      }
    }
  }

  function applySettingsToToggles(settings) {
    for (var key in toggles) {
      if (toggles[key]) {
        toggles[key].checked =
          settings && settings[key] !== undefined ? !!settings[key] : DEFAULT_SETTINGS[key];
      }
    }
    updateBadges();
  }

  function saveCurrentState(callback) {
    var settings = {};
    for (var key in toggles) {
      if (toggles[key]) {
        settings[key] = toggles[key].checked;
      }
    }

    function broadcastSettings() {
      try {
        localStorage.setItem("link_opener_settings", JSON.stringify(settings));
      } catch (error) {
        if (callback) callback(error);
        return;
      }

      try {
        chrome.runtime.sendMessage({
          type: "SETTINGS_UPDATED",
          settings: settings,
        });
      } catch (error) {
        if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.lastError) {
          if (callback) callback(new Error(chrome.runtime.lastError.message));
          return;
        }
      }

      try {
        chrome.tabs.query({}, function (tabs) {
          if (chrome.runtime.lastError) {
            if (callback) callback(new Error(chrome.runtime.lastError.message));
            return;
          }
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
          updateBadges();
          if (callback) callback(null);
        });
      } catch (error) {
        if (callback) callback(error);
      }
    }

    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set(settings, function () {
        if (chrome.runtime.lastError) {
          if (callback) callback(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (chrome.storage.sync) {
          chrome.storage.sync.set(settings, function () {
            if (chrome.runtime.lastError) {
              if (callback) callback(new Error(chrome.runtime.lastError.message));
              return;
            }
            broadcastSettings();
          });
        } else {
          broadcastSettings();
        }
      });
    } else {
      broadcastSettings();
    }
  }

  if (refreshButton) {
    refreshButton.addEventListener("click", function () {
      refreshButton.disabled = true;
      refreshButton.classList.add("is-refreshing");
      refreshButton.title = "Saving settings and restarting extension...";
      saveCurrentState(function (error) {
        if (error) {
          refreshButton.disabled = false;
          refreshButton.classList.remove("is-refreshing");
          refreshButton.title = "Refresh failed: " + error.message;
          return;
        }
        if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.reload) {
          chrome.runtime.reload();
        } else {
          window.location.reload();
        }
      });
    });
  }

  if (enableAllButton) {
    enableAllButton.addEventListener("click", function () {
      Object.keys(toggles).forEach(function (key) {
        if (toggles[key]) toggles[key].checked = true;
      });
      saveCurrentState(function (error) {
        if (error) enableAllButton.title = "Could not save settings: " + error.message;
      });
    });
  }

  if (saveButton) {
    saveButton.addEventListener("click", function () {
      saveButton.disabled = true;
      saveButton.textContent = "Saving...";
      saveCurrentState(function (error) {
        if (error) {
          saveButton.disabled = false;
          saveButton.textContent = "Save & Close";
          saveButton.title = "Could not save settings: " + error.message;
          return;
        }
        window.close();
      });
    });
  }

  // Initialize UI
  loadSettings(function (settings) {
    applySettingsToToggles(settings || DEFAULT_SETTINGS);
    for (var key in toggles) {
      if (toggles[key]) {
        toggles[key].addEventListener("change", function () {
          saveCurrentState();
        });
      }
    }
  });
})();
