function cancelParallelDobSearch(session, completedSource) {
  var cancelledSource = completedSource === "people" ? "unmask" : "people";

  var tabsToClose = [];
  if (typeof session.unmaskTabId === "number") tabsToClose.push(session.unmaskTabId);
  if (typeof session.peopleTabId === "number") tabsToClose.push(session.peopleTabId);

  tabsToClose.forEach(function (tabId) {
    chrome.tabs.remove(tabId, function () {
      if (chrome.runtime.lastError) {
        // Tab may have already been closed
      }
    });
  });

  if (typeof session.sourceTabId === "number") {
    chrome.tabs.sendMessage(
      session.sourceTabId,
      {
        action: "DOB_LOOKUP_CANCELLED",
        lookupId: session.lookupId,
        source: cancelledSource
      },
      function () {
        if (chrome.runtime.lastError) {
          console.warn("[Link Opener] Could not report the cancelled DOB search:", chrome.runtime.lastError.message);
        }
      }
    );
  }

  var keys = [
    "unmask_pending_lookup",
    "dob_lookup_" + session.lookupId,
    "dob_lookup_" + session.lookupId + "_peopleTabId",
    "dob_lookup_" + session.lookupId + "_unmaskTabId"
  ];
  chrome.storage.local.remove(keys);
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (message && message.type === "OPEN_URLS" && Array.isArray(message.urls)) {
    message.urls.forEach(function (url) {
      chrome.tabs.create({ url: url });
    });
    return;
  }

  if (message && message.action === "START_EXACT_DOB_LOOKUP") {
    var sourceUrl;
    var session = message.session;
    if (!session || typeof session !== "object") {
      sendResponse({ ok: false, error: "The profile details are missing." });
      return;
    }
    try {
      sourceUrl = new URL(sender.url);
    } catch (error) {
      sendResponse({ ok: false, error: "The source profile URL is invalid." });
      return;
    }

    var searches = Array.isArray(session.searches) ? session.searches : [];
    var peopleSearchUrl;
    try {
      peopleSearchUrl = new URL(session.peopleSearchUrl);
    } catch (error) {
      sendResponse({ ok: false, error: "The parallel people-search URL is invalid." });
      return;
    }
    var lastSearchOrder = -1;
    var nameSearchCount = 0;
    var validSearches = searches.length > 0 && searches.every(function (search) {
      if (!search || typeof search.url !== "string") return false;
      try {
        var url = new URL(search.url);
        if (url.protocol !== "https:" || url.hostname !== "unmask.com") return false;
        var order = search.type === "address" ? 0 : search.type === "phone" ? 1 : search.type === "name" ? 2 : -1;
        if (order < lastSearchOrder) return false;
        lastSearchOrder = order;
        if (search.type === "address") return /^\/address\/[A-Za-z0-9_%+.-]+--[A-Za-z0-9_%+.-]+-[A-Za-z]{2}-\d{5}\/?$/i.test(url.pathname);
        if (search.type === "phone") return /^\/phone\/\d{3}-\d{3}-\d{4}\/?$/i.test(url.pathname);
        if (search.type === "name") {
          nameSearchCount++;
          return /^\/[a-z0-9]+(?:-[a-z0-9]+)+\/?$/i.test(url.pathname);
        }
      } catch (error) {
        return false;
      }
      return false;
    }) && nameSearchCount >= 1 && searches[searches.length - 1].type === "name";

    if (
      sourceUrl.hostname.replace(/^www\./, "") !== "advancedbackgroundchecks.com" ||
      !sourceUrl.pathname.startsWith("/find/person/") ||
      !sender.tab ||
      !session ||
      !session.targetName ||
      !session.targetDob ||
      !session.lookupId ||
      !/^[a-z0-9-]+$/i.test(session.lookupId) ||
      peopleSearchUrl.protocol !== "https:" ||
      !/^(?:www\.)?menstoppingviolence\.org$/i.test(peopleSearchUrl.hostname) ||
      !/^\/people\/[a-z0-9-]+(?:\/|$)/i.test(peopleSearchUrl.pathname) ||
      !validSearches ||
      searches[0].type !== "address" && searches[0].type !== "phone" && searches[0].type !== "name"
    ) {
      sendResponse({ ok: false, error: "The profile details or ordered Unmask searches are invalid." });
      return;
    }

    session.exactDobSearch = true;
    session.searchIndex = 0;
    session.currentSearchType = searches[0].type;
    session.searchUrl = searches[0].url;
    session.sourceTabId = sender.tab.id;
    session.record = session.lookupId;
    session.startedAt = Date.now();
    var lookupStorageKey = "dob_lookup_" + session.lookupId;
    var state = { remaining: 2, opened: 0, responseSent: false };
    function handleTabCreated(tab, error, source) {
      if (!error && tab) {
        state.opened++;
        var tabIdKey = lookupStorageKey + "_" + source + "TabId";
        session[source + "TabId"] = tab.id;
        var toSave = {};
        toSave[tabIdKey] = tab.id;
        toSave[lookupStorageKey] = session;
        if (source === "unmask") {
          toSave["unmask_pending_lookup"] = session;
        }
        chrome.storage.local.set(toSave, function () {
          if (chrome.runtime.lastError) {
            console.warn("[Link Opener] Could not save a DOB lookup tab ID:", chrome.runtime.lastError.message);
          }
        });
      } else {
        console.error("[Link Opener] Could not open the " + source + " DOB lookup tab:", error || "No tab was returned.");
        chrome.tabs.sendMessage(
          session.sourceTabId,
          {
            action: source === "people"
              ? "DOB_LOOKUP_PEOPLE_RESULT"
              : "DOB_LOOKUP_EXACT_RESULT",
            lookupId: session.lookupId,
            status: "error",
            message: "Could not open the " + (source === "people" ? "parallel people-search" : "Unmask") + " tab."
          },
          function () {
            if (chrome.runtime.lastError) {
              console.warn("[Link Opener] Could not report a DOB tab error:", chrome.runtime.lastError.message);
            }
          }
        );
      }
      state.remaining--;
      if (state.remaining !== 0 || state.responseSent) return;
      state.responseSent = true;
      if (!state.opened) {
        chrome.storage.local.remove(["unmask_pending_lookup", lookupStorageKey]);
        sendResponse({ ok: false, error: "Could not open either lookup tab." });
      } else {
        sendResponse({ ok: true });
      }
    }

    chrome.storage.local.set({
      unmask_pending_lookup: session,
      [lookupStorageKey]: session
    }, function () {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      chrome.tabs.create({ url: session.searchUrl, active: false }, function (tab) {
        var error = chrome.runtime.lastError ? chrome.runtime.lastError.message : "";
        handleTabCreated(tab, error, "unmask");
      });
      chrome.tabs.create({ url: peopleSearchUrl.href, active: false }, function (tab) {
        var error = chrome.runtime.lastError ? chrome.runtime.lastError.message : "";
        handleTabCreated(tab, error, "people");
      });
    });
    return true;
  }

  if (message && message.action === "DOB_LOOKUP_EXACT_RESULT") {
    var senderHost = "";
    try {
      senderHost = new URL(sender.url).hostname;
    } catch (error) {}
    if (senderHost !== "unmask.com" && !senderHost.endsWith(".unmask.com")) return;

    var exactLookupKey = "dob_lookup_" + message.lookupId;
    chrome.storage.local.get([
      "unmask_pending_lookup",
      exactLookupKey,
      exactLookupKey + "_peopleTabId",
      exactLookupKey + "_unmaskTabId"
    ], function (items) {
      var session = (items && items.unmask_pending_lookup) || (items && items[exactLookupKey]);
      if (
        !session ||
        !session.exactDobSearch ||
        session.lookupId !== message.lookupId ||
        typeof session.sourceTabId !== "number"
      ) {
        sendResponse({ ok: false });
        return;
      }
      session.peopleTabId = items[exactLookupKey + "_peopleTabId"] || session.peopleTabId;
      session.unmaskTabId = (sender.tab && sender.tab.id) || items[exactLookupKey + "_unmaskTabId"] || session.unmaskTabId;

      chrome.tabs.sendMessage(
        session.sourceTabId,
        {
          action: "DOB_LOOKUP_EXACT_RESULT",
          lookupId: session.lookupId,
          status: message.status,
          dob: message.dob || "",
          expectedDob: session.targetDob,
          message: message.message || ""
        },
        function () {
          if (chrome.runtime.lastError) {
            console.warn("[Link Opener] Could not report the Unmask DOB result to the source profile:", chrome.runtime.lastError.message);
          }
        }
      );
      if (message.status === "match") {
        cancelParallelDobSearch(session, "unmask");
      } else if (typeof session.unmaskTabId === "number") {
        chrome.tabs.remove(session.unmaskTabId, function () {
          if (chrome.runtime.lastError) {}
        });
      }
      chrome.storage.local.remove("unmask_pending_lookup");
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message && message.action === "DOB_LOOKUP_EXACT_PROGRESS") {
    var progressHost = "";
    try {
      progressHost = new URL(sender.url).hostname;
    } catch (error) {}
    if (progressHost !== "unmask.com" && !progressHost.endsWith(".unmask.com")) return;

    chrome.storage.local.get("unmask_pending_lookup", function (items) {
      var session = items && items.unmask_pending_lookup;
      if (
        !session ||
        !session.exactDobSearch ||
        session.lookupId !== message.lookupId ||
        typeof session.sourceTabId !== "number"
      ) {
        sendResponse({ ok: false });
        return;
      }
      var searches = Array.isArray(session.searches) ? session.searches : [];
      var stageTotal = searches.filter(function (search) {
        return search.type === session.currentSearchType;
      }).length;
      var stageIndex = 0;
      for (var i = 0; i <= session.searchIndex && i < searches.length; i++) {
        if (searches[i].type === session.currentSearchType) stageIndex++;
      }
      chrome.tabs.sendMessage(
        session.sourceTabId,
        {
          action: "DOB_LOOKUP_EXACT_PROGRESS",
          lookupId: session.lookupId,
          searchType: session.currentSearchType,
          searchIndex: session.searchIndex,
          totalSearches: searches.length || 1,
          stageIndex: stageIndex,
          stageTotal: stageTotal || 1
        },
        function () {
          if (chrome.runtime.lastError) {
            console.warn("[Link Opener] Could not update DOB lookup progress on the source profile:", chrome.runtime.lastError.message);
          }
        }
      );
      sendResponse({ ok: true });
    });
    return true;
  }

  if (
    message &&
    message.action === "DOB_LOOKUP_PEOPLE_READY"
  ) {
    var readyHost = "";
    var readyPath = "";
    try {
      var readyUrl = new URL(sender.url);
      readyHost = readyUrl.hostname;
      readyPath = readyUrl.pathname.replace(/\/+$/, "").toLowerCase();
    } catch (error) {}
    if (
      !/^(?:www\.)?menstoppingviolence\.org$/i.test(readyHost) ||
      !/^\/people(?:\/|$)/i.test(readyPath) ||
      !sender.tab ||
      typeof sender.tab.id !== "number"
    ) {
      sendResponse({ ok: false });
      return;
    }

    chrome.storage.local.get(null, function (items) {
      var now = Date.now();
      var candidates = Object.keys(items || {}).filter(function (key) {
        if (
          key.indexOf("dob_lookup_") !== 0 ||
          key.endsWith("_peopleTabId") ||
          key.endsWith("_unmaskTabId")
        ) return false;
        var session = items[key];
        if (
          !session ||
          !session.exactDobSearch ||
          !session.peopleSearchUrl ||
          typeof session.sourceTabId !== "number" ||
          typeof session.startedAt !== "number" ||
          now - session.startedAt > 120000
        ) return false;
        try {
          var peopleUrl = new URL(session.peopleSearchUrl);
          var assignedTabId = items[key + "_peopleTabId"];
          return assignedTabId === sender.tab.id ||
            peopleUrl.pathname.replace(/\/+$/, "").toLowerCase() === readyPath;
        } catch (error) {
          return false;
        }
      }).map(function (key) {
        return items[key];
      }).sort(function (a, b) {
        return b.startedAt - a.startedAt;
      });

      if (!candidates.length) {
        sendResponse({ ok: false, error: "No active DOB lookup is assigned to this people-search tab." });
        return;
      }
      sendResponse({ ok: true, session: candidates[0] });
    });
    return true;
  }

  if (
    message &&
    message.action === "DOB_LOOKUP_PEOPLE_PROGRESS"
  ) {
    var progressHost = "";
    var progressPath = "";
    try {
      var progressUrl = new URL(sender.url);
      progressHost = progressUrl.hostname;
      progressPath = progressUrl.pathname;
    } catch (error) {}
    if (
      !/^(?:www\.)?menstoppingviolence\.org$/i.test(progressHost) ||
      !/^\/people(?:\/|$)/i.test(progressPath) ||
      !/^[a-z0-9-]+$/i.test(String(message.lookupId || ""))
    ) {
      return;
    }

    var progressStorageKey = "dob_lookup_" + message.lookupId;
    chrome.storage.local.get(progressStorageKey, function (items) {
      var session = items && items[progressStorageKey];
      if (
        !session ||
        !session.exactDobSearch ||
        session.lookupId !== message.lookupId ||
        typeof session.sourceTabId !== "number"
      ) {
        sendResponse({ ok: false });
        return;
      }
      chrome.tabs.sendMessage(session.sourceTabId, {
        action: "DOB_LOOKUP_PEOPLE_PROGRESS",
        lookupId: session.lookupId,
        message: message.message || "Scanning people-search result cards."
      }, function () {
        if (chrome.runtime.lastError) {
          console.warn("[Link Opener] Could not report people-search progress:", chrome.runtime.lastError.message);
        }
      });
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message && message.action === "DOB_LOOKUP_PEOPLE_RESULT") {
    var peopleHost = "";
    var peoplePath = "";
    try {
      var peopleSenderUrl = new URL(sender.url);
      peopleHost = peopleSenderUrl.hostname;
      peoplePath = peopleSenderUrl.pathname;
    } catch (error) {}
    if (
      !/^(?:www\.)?menstoppingviolence\.org$/i.test(peopleHost) ||
      !/^\/people(?:\/|$)/i.test(peoplePath) ||
      ["match", "no_match", "error"].indexOf(message.status) === -1
    ) {
      return;
    }

    if (!/^[a-z0-9-]+$/i.test(String(message.lookupId || ""))) {
      sendResponse({ ok: false });
      return;
    }
    var peopleStorageKey = "dob_lookup_" + message.lookupId;
    chrome.storage.local.get([
      peopleStorageKey,
      peopleStorageKey + "_unmaskTabId",
      peopleStorageKey + "_peopleTabId"
    ], function (items) {
      var session = items && items[peopleStorageKey];
      if (
        !session ||
        !session.exactDobSearch ||
        session.lookupId !== message.lookupId ||
        typeof session.sourceTabId !== "number"
      ) {
        sendResponse({ ok: false });
        return;
      }
      session.unmaskTabId = items[peopleStorageKey + "_unmaskTabId"] || session.unmaskTabId;
      session.peopleTabId = (sender.tab && sender.tab.id) || items[peopleStorageKey + "_peopleTabId"] || session.peopleTabId;
      chrome.tabs.sendMessage(
        session.sourceTabId,
        {
          action: "DOB_LOOKUP_PEOPLE_RESULT",
          lookupId: session.lookupId,
          status: message.status,
          dob: message.dob || "",
          name: message.name || "",
          message: message.message || ""
        },
        function () {
          if (chrome.runtime.lastError) {
            console.warn("[Link Opener] Could not report the parallel people-search result:", chrome.runtime.lastError.message);
          }
        }
      );
      if (message.status === "match") {
        cancelParallelDobSearch(session, "people");
      } else {
        if (typeof session.peopleTabId === "number") {
          chrome.tabs.remove(session.peopleTabId, function () {
            if (chrome.runtime.lastError) {}
          });
        }
        chrome.storage.local.remove(peopleStorageKey);
      }
      sendResponse({ ok: true });
    });
    return true;
  }
});
