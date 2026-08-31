(function () {
  "use strict";

  var THATSTHEM_BASE = "https://thatsthem.com/address/";
  var UNMASK_BASE = "https://unmask.com/address/";
  var ADVANCED_BASE = "https://www.advancedbackgroundchecks.com/find/address/";

  var THATSTHEM_NAME_BASE = "https://thatsthem.com/name/";
  var ADVANCED_NAME_BASE = "https://www.advancedbackgroundchecks.com/find/name/";

  var DEFAULT_SETTINGS = {
    openAddressUnmask: true,
    openAddressThatsThem: true,
    openAddressAdvanced: true,
    openNameThatsThem: true,
    openNameAdvanced: true,
  };

  var currentSettings = Object.assign({}, DEFAULT_SETTINGS);

  function applySettings(settings) {
    if (!settings) return;
    for (var key in DEFAULT_SETTINGS) {
      if (settings[key] !== undefined) {
        currentSettings[key] = !!settings[key];
      }
    }
  }

  // Initial load
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(null, function (items) {
      applySettings(items);
    });
  }

  // Listen for direct broadcast messages from popup
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
      if (message && message.type === "SETTINGS_UPDATED" && message.settings) {
        applySettings(message.settings);
        if (sendResponse) sendResponse({ ok: true });
      }
    });
  }

  // Listen for storage changes
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(function (changes) {
      for (var key in changes) {
        if (changes[key] && changes[key].newValue !== undefined) {
          currentSettings[key] = !!changes[key].newValue;
        }
      }
    });
  }

  var STREET_SUFFIXES = {
    alley: "Aly",
    annex: "Anx",
    avenue: "Ave",
    boulevard: "Blvd",
    circle: "Cir",
    court: "Ct",
    drive: "Dr",
    expressway: "Expy",
    freeway: "Fwy",
    highway: "Hwy",
    lane: "Ln",
    parkway: "Pkwy",
    place: "Pl",
    road: "Rd",
    street: "St",
    terrace: "Ter",
    trail: "Trl",
    turnpike: "Tpke",
    way: "Way",
  };

  var NAME_SUFFIXES = new Set([
    "jr",
    "jr.",
    "sr",
    "sr.",
    "ii",
    "iii",
    "iv",
    "v",
    "md",
    "dds",
    "esq",
    "phd",
    "dvm",
  ]);

  var SELECTOR_ADDRESS = 'a.address, a[href*="/address/"], a[class*="address"]';
  var SELECTOR_NAME =
    'a.name-link, a[class*="name-link"], a.relative, a.associate, a.btn[href*="/detail/"], a[href*="/detail/"]';

  function titleCase(word) {
    if (!word) return word;
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  }

  function titleCaseAll(str) {
    return str.split(/\s+/).map(titleCase).join(" ");
  }

  function slugify(str) {
    return str
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-");
  }

  function abbreviateAndTitle(words) {
    return words
      .split(/\s+/)
      .map(function (w) {
        var lower = w.toLowerCase().replace(/\.$/, "");
        return STREET_SUFFIXES[lower] || titleCase(w);
      })
      .join(" ");
  }

  // "900 County Road 310" -> "900-310-County-Rd"
  function buildStreetSlug(street) {
    street = street.replace(/\s+/g, " ").trim();
    var m = street.match(/^(\d+)\s+(.+?)\s+(\d+)\s*$/);
    if (m) {
      return m[1] + "-" + m[3] + "-" + slugify(abbreviateAndTitle(m[2]));
    }
    return slugify(abbreviateAndTitle(street));
  }

  function parseAddress(text) {
    if (!text) return null;
    var s = text
      .replace(/\[.*?\]|\(.*?\)/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    s = s.replace(/.*?associated with\s+/i, "").trim();

    // 1. Street, City, State Zip: "3840 Shelby Dr, Fort Worth, TX 76109 2735"
    var m = s.match(
      /(?:^|.*?)([0-9A-Za-z\s.#-]+?),\s*([A-Za-z\s.-]+?),\s*([A-Za-z]{2})\s+(\d{5})(?:[-\s]*\d{4})?/
    );
    if (m) {
      return {
        street: m[1].trim(),
        city: m[2].trim(),
        state: m[3].toUpperCase(),
        zip: m[4].trim(),
      };
    }

    // 2. City, State Zip: "Fort Worth, TX 76109"
    var mCity = s.match(
      /(?:^|.*?\bin\s+)?([A-Za-z\s.-]+?),\s*([A-Za-z]{2})\s+(\d{5})(?:[-\s]*\d{4})?/i
    );
    if (mCity) {
      return {
        street: "",
        city: mCity[1].trim(),
        state: mCity[2].toUpperCase(),
        zip: mCity[3].trim(),
      };
    }

    return null;
  }

  function parseName(rawName) {
    if (!rawName) return null;
    var cleaned = rawName.replace(/[^\w\s.-]/g, "").trim();
    var parts = cleaned.split(/\s+/).filter(Boolean);
    if (parts.length === 0) return null;

    // Filter out trailing suffixes (JR, SR, III, etc.)
    while (
      parts.length > 1 &&
      NAME_SUFFIXES.has(parts[parts.length - 1].toLowerCase().replace(/\.$/, ""))
    ) {
      parts.pop();
    }

    if (parts.length === 0) return null;

    var first = parts[0];
    var last = parts.length > 1 ? parts[parts.length - 1] : "";
    var fullWithoutSuffix = parts.map(titleCase).join("-");

    return {
      first: first,
      last: last,
      parts: parts,
      fullNameSlug: fullWithoutSuffix,
      firstLastSlug: last
        ? slugify(first).toLowerCase() + "-" + slugify(last).toLowerCase()
        : slugify(first).toLowerCase(),
    };
  }

  function findAddressFromContainer(el) {
    var curr = el.parentElement;
    while (curr && curr !== document.body) {
      if (
        curr.matches &&
        (curr.matches('.card, [class*="card"], [class*="result"], [class*="record"], [class*="person"]') ||
          curr.querySelector(".address-current, a.address, a[href*='/address/']"))
      ) {
        // 1. Try address links and containers
        var addrLinks = curr.querySelectorAll(
          ".address-current a.address, a.address, .address-current, .address-previous a.address, a[href*='/address/']"
        );
        for (var i = 0; i < addrLinks.length; i++) {
          var addrEl = addrLinks[i];
          var text = (addrEl.textContent || "").trim();
          var parsed = parseAddress(text);
          if (parsed && parsed.zip) return parsed;

          var title = (addrEl.getAttribute("title") || "").trim();
          parsed = parseAddress(title);
          if (parsed && parsed.zip) return parsed;

          var href = addrEl.getAttribute("href") || "";
          var unmaskMatch = href.match(/--([A-Za-z_]+)-([A-Za-z]{2})-(\d{5})/);
          if (unmaskMatch) {
            return {
              street: "",
              city: unmaskMatch[1].replace(/_/g, " "),
              state: unmaskMatch[2].toUpperCase(),
              zip: unmaskMatch[3],
            };
          }
          var ttMatch = href.match(/-([A-Za-z-]+)-([A-Za-z]{2})-(\d{5})/);
          if (ttMatch) {
            return {
              street: "",
              city: ttMatch[1].replace(/-/g, " "),
              state: ttMatch[2].toUpperCase(),
              zip: ttMatch[3],
            };
          }
        }

        // 2. Try View Details button title
        var viewDetails = curr.querySelector(
          'a[title*=" in "], a.btn[href*="/detail/"]'
        );
        if (viewDetails) {
          var parsedTitle = parseAddress(viewDetails.getAttribute("title") || "");
          if (parsedTitle && parsedTitle.zip) return parsedTitle;
        }

        // 3. Fallback to searching the container text
        var parsedContainer = parseAddress(curr.textContent || "");
        if (parsedContainer && parsedContainer.zip) return parsedContainer;
      }
      curr = curr.parentElement;
    }

    return null;
  }

  function getUnmaskUrl(parsed) {
    // "237 Reeves Ranch Rd, Victoria, TX 77905" -> "237-Reeves-Ranch-Rd--Victoria-TX-77905/"
    // "207 Finton Ave, San Antonio, TX 78204" -> "207-Finton-Ave--San_Antonio-TX-78204/"
    var streetSlug = slugify(abbreviateAndTitle(parsed.street));
    var citySlug = titleCaseAll(parsed.city).replace(/\s+/g, "_");
    return (
      UNMASK_BASE +
      streetSlug +
      "--" +
      citySlug +
      "-" +
      parsed.state +
      "-" +
      parsed.zip +
      "/"
    );
  }

  function getThatsThemUrl(parsed) {
    // "900 County Road 310, El Campo, TX 77437" -> "900-310-County-Rd-El-Campo-TX-77437"
    var streetSlug = buildStreetSlug(parsed.street);
    var citySlug = slugify(titleCaseAll(parsed.city));
    return (
      THATSTHEM_BASE +
      streetSlug +
      "-" +
      citySlug +
      "-" +
      parsed.state +
      "-" +
      parsed.zip
    );
  }

  function getAdvancedBackgroundChecksUrl(parsed) {
    // "237 Reeves Ranch Rd, Victoria, TX 77905" -> "237-reeves-ranch-rd/victoria-TX-77905"
    // "10715 Twyla Rd, San Antonio, TX 78224" -> "10715-twyla-rd/san-antonio-TX-78224"
    var streetSlug = slugify(abbreviateAndTitle(parsed.street)).toLowerCase();
    var citySlug = slugify(parsed.city).toLowerCase();
    return (
      ADVANCED_BASE +
      streetSlug +
      "/" +
      citySlug +
      "-" +
      parsed.state +
      "-" +
      parsed.zip
    );
  }

  function getThatsThemNameUrl(parsedName, parsedAddr) {
    // "Jack L Douglas JR" in "Fort Worth, TX 76109" -> "https://thatsthem.com/name/Jack-L-Douglas/Fort-Worth-TX-76109"
    var base = THATSTHEM_NAME_BASE + parsedName.fullNameSlug;
    if (parsedAddr && parsedAddr.city && parsedAddr.state && parsedAddr.zip) {
      var cityPart = slugify(titleCaseAll(parsedAddr.city));
      return base + "/" + cityPart + "-" + parsedAddr.state + "-" + parsedAddr.zip;
    } else if (parsedAddr && parsedAddr.city && parsedAddr.state) {
      var cityPart = slugify(titleCaseAll(parsedAddr.city));
      return base + "/" + cityPart + "-" + parsedAddr.state;
    }
    return base;
  }

  function getAdvancedNameUrl(parsedName, parsedAddr) {
    // "Jack L Douglas JR" in "Fort Worth, TX" -> "https://www.advancedbackgroundchecks.com/find/name/jack-douglas/in/TX/fort-worth"
    var base = ADVANCED_NAME_BASE + parsedName.firstLastSlug;
    if (parsedAddr && parsedAddr.state && parsedAddr.city) {
      var citySlug = slugify(parsedAddr.city).toLowerCase();
      return base + "/in/" + parsedAddr.state + "/" + citySlug;
    } else if (parsedAddr && parsedAddr.state) {
      return base + "/in/" + parsedAddr.state;
    }
    return base;
  }

  function openAll(urls) {
    if (!urls || urls.length === 0) return;
    if (
      typeof chrome !== "undefined" &&
      chrome.runtime &&
      chrome.runtime.sendMessage
    ) {
      try {
        chrome.runtime.sendMessage({
          type: "OPEN_URLS",
          urls: urls,
        });
        return;
      } catch (err) {
        // Fallback below
      }
    }
    urls.forEach(function (url) {
      window.open(url, "_blank", "noopener,noreferrer");
    });
  }

  function processAddressLink(a) {
    if (a.dataset && a.dataset.adsConverted) return;
    var text =
      (a.textContent || "").trim() || (a.getAttribute("title") || "").trim();
    if (!text) return;

    var parsed = parseAddress(text);
    if (!parsed) return;

    var unmaskUrl = getUnmaskUrl(parsed);
    var thatsThemUrl = getThatsThemUrl(parsed);
    var advancedUrl = getAdvancedBackgroundChecksUrl(parsed);

    a.href = unmaskUrl;
    a.target = "_blank";
    a.rel = "noopener noreferrer";

    function handleClick(e) {
      if (e.button === 0 || e.button === 1) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        var toOpen = [];
        if (currentSettings.openAddressUnmask) toOpen.push(unmaskUrl);
        if (currentSettings.openAddressThatsThem) toOpen.push(thatsThemUrl);
        if (currentSettings.openAddressAdvanced) toOpen.push(advancedUrl);

        if (toOpen.length > 0) {
          openAll(toOpen);
        }
      }
    }

    a.addEventListener("click", handleClick, true);
    a.addEventListener("auxclick", handleClick, true);

    if (a.dataset) a.dataset.adsConverted = "1";
  }

  function processNameLink(a) {
    if (a.dataset && a.dataset.adsConverted) return;

    var nameSpan = a.querySelector(".name-given, [class*='name']");
    var text = (nameSpan ? nameSpan.textContent : a.textContent) || "";
    text = text.trim();

    // If text is generic like "VIEW DETAILS", look for name in title attribute or card header
    if (!text || /^view\s+details/i.test(text)) {
      var title = a.getAttribute("title") || "";
      var nameMatch = title.match(
        /more for\s+(.+?)\s+in\s+[A-Za-z\s.-]+,\s*[A-Za-z]{2}/i
      );
      if (nameMatch) {
        text = nameMatch[1].trim();
      } else {
        var card = a.closest('.card, [class*="card"]');
        var cardNameSpan = card
          ? card.querySelector(".name-given, a.name-link")
          : null;
        if (cardNameSpan) {
          text = (cardNameSpan.textContent || "").trim();
        }
      }
    }

    if (!text) return;

    var parsedName = parseName(text);
    if (!parsedName) return;

    var parsedAddr = findAddressFromContainer(a);

    var thatsThemUrl = getThatsThemNameUrl(parsedName, parsedAddr);
    var advancedUrl = getAdvancedNameUrl(parsedName, parsedAddr);

    a.href = thatsThemUrl;
    a.target = "_blank";
    a.rel = "noopener noreferrer";

    function handleClick(e) {
      if (e.button === 0 || e.button === 1) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        var toOpen = [];
        if (currentSettings.openNameThatsThem) toOpen.push(thatsThemUrl);
        if (currentSettings.openNameAdvanced) toOpen.push(advancedUrl);

        if (toOpen.length > 0) {
          openAll(toOpen);
        }
      }
    }

    a.addEventListener("click", handleClick, true);
    a.addEventListener("auxclick", handleClick, true);

    if (a.dataset) a.dataset.adsConverted = "1";
  }

  function scan(root) {
    if (root.nodeType === Node.ELEMENT_NODE && root.matches) {
      if (root.matches(SELECTOR_ADDRESS)) processAddressLink(root);
      if (root.matches(SELECTOR_NAME)) processNameLink(root);
    }
    if (root.querySelectorAll) {
      root.querySelectorAll(SELECTOR_ADDRESS).forEach(processAddressLink);
      root.querySelectorAll(SELECTOR_NAME).forEach(processNameLink);
    }
  }

  scan(document);

  var observer = new MutationObserver(function (mutations) {
    mutations.forEach(function (mutation) {
      mutation.addedNodes.forEach(function (node) {
        if (node.nodeType === Node.ELEMENT_NODE) scan(node);
      });
    });
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
})();
