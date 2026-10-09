// Content script for Unmask.com DOB Discovery Automation
// Injected into https://unmask.com/* and https://*.unmask.com/*

(function () {
  "use strict";

  if (window.__unmaskAutomationLoaded) return;
  window.__unmaskAutomationLoaded = true;

  // Suffix mappings ported from link-opener
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

  function titleCase(word) {
    if (!word) return "";
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  }

  function titleCaseAll(str) {
    if (!str) return "";
    return str.split(/\s+/).map(titleCase).join(" ");
  }

  function slugify(str) {
    if (!str) return "";
    return str
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-");
  }

  function abbreviateAndTitle(words) {
    if (!words) return "";
    return words
      .split(/\s+/)
      .map(function (w) {
        var lower = w.toLowerCase().replace(/\.$/, "");
        return STREET_SUFFIXES[lower] || titleCase(w);
      })
      .join(" ");
  }

  function delay(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function randomDelay(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  // The session this frame is running. It is kept so that every message - and every "give me the
  // next step" request - can name the record card the run belongs to. A press on the other
  // record's card replaces the run, so a page that outlives its own run must keep reporting for
  // its own record instead of for whatever run happens to be in flight.
  var currentSession = null;

  function sessionRecord() {
    return (currentSession && currentSession.record) || "";
  }

  function sendProgress(step, totalSteps, message) {
    try {
      chrome.runtime.sendMessage({
        action: "DOB_LOOKUP_PROGRESS",
        step: step,
        totalSteps: totalSteps,
        message: message,
        record: sessionRecord(),
      });
    } catch (e) {}
  }

  function sendSuccess(dob, person, emails, options) {
    var opts = options || {};
    try {
      chrome.runtime.sendMessage({
        action: "DOB_LOOKUP_SUCCESS",
        dob: dob,
        emails: emails || [],
        person: person,
        source: "unmask.com",
        record: sessionRecord(),
        placeholder: !!opts.placeholder,
        continueSearch: !!opts.continueSearch
      });
    } catch (e) {}
  }

  function sendEmpty(message, person) {
    try {
      chrome.runtime.sendMessage({
        action: "DOB_LOOKUP_EMPTY",
        message: message || "No DOB found on Unmask",
        person: person,
        record: sessionRecord(),
      });
    } catch (e) {}
  }

  function copyToClipboard(text) {
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () {
        fallbackCopy(text);
      });
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    var textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand("copy");
    } catch (e) {}
    document.body.removeChild(textarea);
  }

  function focusThisTab() {
    try {
      chrome.runtime.sendMessage({ action: "FOCUS_LOOKUP_TAB" });
    } catch (e) {}
  }

  // Unmask normally runs in the offscreen document's hidden runner, which has no tab to bring
  // forward - the background promotes the run into a real one when the check appears. A tab that
  // is already in front just stays there.
  //
  // Tells the background the check is done with: the tab it was solved in is put back into the
  // background and the user is returned to where they started. The run carries on in that tab.
  function notifyChallengeCleared() {
    try {
      chrome.runtime.sendMessage({ action: "CHALLENGE_CLEARED" });
    } catch (e) {}
  }

  // Whether this frame is one the extension itself put on the page.
  //
  // A top-level tab is always fine. A subframe has to be confirmed by the background, because
  // there is no reliable way to tell from inside the frame who the parent is:
  //
  //   - `parent.location` throws across origins from the isolated world, so it cannot be read.
  //   - `document.referrer` is empty for an extension parent, so the offscreen runner looks
  //     exactly like a frame with no parent at all.
  //
  // The background can answer authoritatively: a content script in a normal tab always has
  // `sender.tab`, and the offscreen document is not a tab. A page that embeds unmask.com in a
  // frame of its own is in a tab, and is refused - it must not get a DOB run driven with
  // somebody else's saved search.
  function confirmRunnerIsOurs(callback) {
    if (window.parent === window) {
      callback(true);
      return;
    }
    try {
      chrome.runtime.sendMessage({ action: "RUNNER_HELLO" }, function (res) {
        if (chrome.runtime.lastError) {
          callback(false);
          return;
        }
        callback(!!(res && res.ok));
      });
    } catch (e) {
      callback(false);
    }
  }

  // Detects a genuine Cloudflare interstitial ("Just a moment...", the managed challenge) - NOT a
  // page that merely loads Cloudflare.
  //
  // That distinction matters because seeing a check is what hands the run over to a *visible* tab
  // so the user can solve it. A normal page behind Cloudflare carries bot-management scripts and
  // can embed a Turnstile widget of its own, and the old selector list treated any of those as a
  // challenge - which made every run promote itself into a visible tab the moment it loaded, with
  // nothing on screen for the user to solve.
  //
  // The markers kept here are the interstitial's own shell. Cloudflare serves it as
  //   <main class="challenge"> ... <h1 class="challenge__title">Performing security verification
  // and the script it injects comes from .../orchestrate/chl_page/... ("chl_page" = challenge
  // page). The broad src markers are deliberately gone: /cdn-cgi/challenge-platform/scripts/jsd/...
  // and the Turnstile widget both appear on perfectly normal pages.
  function isCloudflareChallengePage() {
    // If the page contains any Unmask search results, profile sections, or no-result dialogs,
    // it is a real Unmask results page, NOT a Cloudflare interstitial blocking page.
    // Note: Do NOT check header/footer/nav tags here because Cloudflare's custom
    // branded challenge pages for Unmask embed Unmask's <header class="header">!
    if (
      document.querySelector(
        "div.clickable.person, div[itemtype*='Person'].person, .person, " +
          ".um-dialog__title, .tz-dialog h2, .tz-dialog__inner h2, " +
          ".um-results__none, .no-results, .um-alert--warning, " +
          "#summary, .um-profile-summary, .um-results-profile__section, h1.um-profile-summary__name, " +
          "input[type='checkbox'][aria-label*='Search']"
      )
    ) {
      return false;
    }

    var title = (document.title || "").toLowerCase();
    var rawText = "";
    if (document.body) {
      rawText = (document.body.innerText || document.body.textContent || "").toLowerCase().replace(/\s+/g, " ");
    }

    if (title.startsWith("unmask") && !rawText && !document.querySelector("main.challenge, .challenge__content-wrapper, .challenge__hero, .challenge__title, .challenge__hero-image, script[src*='chl_page']")) {
      return false;
    }

    if (
      title.includes("just a moment") ||
      title.includes("security check") ||
      title.includes("attention required") ||
      title.includes("checking your browser") ||
      title.includes("verify you are human") ||
      title.includes("performing security verification")
    ) {
      return true;
    }

    if (rawText) {
      if (
        rawText.includes("performing security verification") ||
        (rawText.includes("uses a security service to protect against malicious bots") && rawText.includes("verifies you are not a bot")) ||
        rawText.includes("verify you are human")
      ) {
        return true;
      }
    }

    // The interstitial shell, plus the older challenge-page IDs Cloudflare still uses. `chl_page`
    // is the challenge-page script specifically - a normal page's bot-management script is not it.
    return !!document.querySelector(
      "main.challenge, .challenge__content-wrapper, .challenge__hero, .challenge__title, .challenge__hero-image, script[src*='chl_page']"
    );
  }

  // Realistic human click dispatcher, used for Unmask's own "unlock search results" toggle
  // (a plain in-page checkbox, not a security check).
  async function simulateHumanClick(el) {
    if (!el) return false;
    try {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    } catch (e) {}

    await delay(randomDelay(150, 300));
    try {
      el.focus();
    } catch (e) {}

    await delay(randomDelay(80, 180));

    try {
      el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    } catch (e) {}

    if (el.type === "checkbox") {
      el.checked = true;
      try {
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } catch (e) {}
    }

    // Also dispatch on parent label or wrapper if available
    var parentLabel = el.closest("label, .custom-checkbox, .checkbox-wrapper, .um-form__group");
    if (parentLabel && parentLabel !== el) {
      try {
        parentLabel.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      } catch (e) {}
    }

    if (typeof el.click === "function") {
      try {
        el.click();
      } catch (e) {}
    }

    return true;
  }

  // Detects an active Cloudflare Turnstile verification widget that is awaiting human interaction.
  // A page that already has search results, or where the Turnstile token is already submitted,
  // or a page still in the middle of normal loading, is NOT an active challenge.
  function isTurnstileChallengeActive(state) {
    // 1. If result cards, search summary, dialogs, no-results, or profile are already present,
    // Turnstile is NOT blocking.
    if (
      document.querySelector(
        "div.clickable.person, div[itemtype*='Person'].person, .person, " +
          ".um-dialog__title, .tz-dialog h2, .tz-dialog__inner h2, " +
          ".um-results__none, .no-results, .um-alert--warning, " +
          "#summary, .um-profile-summary, .um-results-profile__section, h1.um-profile-summary__name, " +
          "input[type='checkbox'][aria-label*='Search'], " +
          "input[aria-label*='Search']"
      )
    ) {
      return false;
    }

    // 2. If Turnstile response input exists and has a valid token, it has already been cleared.
    var tokenInput = document.querySelector("input[name='cf-turnstile-response']");
    if (tokenInput && tokenInput.value && tokenInput.value.trim().length > 10) {
      return false;
    }

    // 3. Allow an initial window for normal page elements to hydrate/render
    if (state && state.startedAt && Date.now() - state.startedAt < 1500) {
      return false;
    }

    // 4. An active challenge iframe must exist and be visibly rendered in layout.
    // Passive containers like div#cf-turnstile or [data-sitekey] in static HTML are NOT challenges.
    var turnstileIframe = document.querySelector(
      "iframe[src*='challenges.cloudflare.com'], iframe[src*='turnstile/if']"
    );
    if (turnstileIframe && isElementVisible(turnstileIframe)) {
      var rect = turnstileIframe.getBoundingClientRect();
      if (rect.width >= 100 && rect.height >= 40) {
        return true;
      }
    }

    return false;
  }

  function normalizeName(str) {
    return (str || "")
      .toLowerCase()
      .replace(/[^a-z\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function parseNameDetails(str) {
    if (!str) return { first: "", middle: "", middleInitial: "", last: "", full: "", raw: "" };
    var raw = String(str).replace(/\([^)]*\)/g, " ").trim();
    var first = "", middle = "", last = "";

    if (raw.includes(",")) {
      var commaParts = raw.split(",");
      last = normalizeName(commaParts[0]);
      var rest = normalizeName(commaParts.slice(1).join(" ")).split(" ").filter(Boolean);
      first = rest[0] || "";
      middle = rest.slice(1).join(" ");
    } else {
      var parts = normalizeName(raw).split(" ").filter(Boolean);
      if (parts.length === 1) {
        first = parts[0];
        last = parts[0];
      } else if (parts.length === 2) {
        first = parts[0];
        last = parts[1];
      } else if (parts.length >= 3) {
        first = parts[0];
        var lastPart = parts[parts.length - 1];
        if (["jr", "sr", "ii", "iii", "iv", "v"].includes(lastPart)) {
          last = parts[parts.length - 2];
          middle = parts.slice(1, parts.length - 2).join(" ");
        } else {
          last = lastPart;
          middle = parts.slice(1, parts.length - 1).join(" ");
        }
      }
    }
    var middleInitial = middle ? middle.charAt(0) : "";
    var cleanFull = [first, middle, last].filter(Boolean).join(" ");
    return {
      first: first,
      middle: middle,
      middleInitial: middleInitial,
      last: last,
      full: cleanFull,
      raw: raw,
    };
  }

  // Name scoring: evaluates first, last, and middle name / initials
  function matchNameScore(target, cand) {
    if (!target.first || !cand.first || !target.last || !cand.last) return -100;

    // Check last name
    var lastMatch = target.last === cand.last;
    if (!lastMatch) {
      if (
        (target.last.length > 3 && cand.last.includes(target.last)) ||
        (cand.last.length > 3 && target.last.includes(cand.last))
      ) {
        lastMatch = true;
      }
    }
    if (!lastMatch) return -100;

    var score = 50; // Base points for last name match

    // First name match
    if (target.first === cand.first) {
      score += 50;
    } else if (
      (target.first.length > 2 && cand.first.startsWith(target.first)) ||
      (cand.first.length > 2 && target.first.startsWith(cand.first))
    ) {
      score += 25;
    } else if (
      (target.first.length === 1 || cand.first.length === 1) &&
      target.first.charAt(0) === cand.first.charAt(0)
    ) {
      score += 25;
    } else {
      return -100;
    }

    // Middle name / initial match:
    // target: "Gloria Jean Grice" (middle: "jean", initial: "j")
    // cand: "Gloria J Grice" (middle: "j", initial: "j")
    if (target.middle && cand.middle) {
      if (target.middle === cand.middle) {
        score += 40; // Exact middle name match
      } else if (
        target.middleInitial === cand.middleInitial ||
        target.middle.startsWith(cand.middle) ||
        cand.middle.startsWith(target.middle)
      ) {
        score += 35; // Initial match (J for Jean!)
      } else {
        // Conflicting middle initial (e.g. 'E' vs 'G')
        return -100;
      }
    } else if (target.middle && !cand.middle) {
      score += 10;
    } else if (!target.middle && cand.middle) {
      score += 15; // Target has no middle name specified, candidate has middle name (e.g. Patrick Cates vs Patrick Allen Cates)
    }

    return score;
  }

  function isElementVisible(el) {
    if (!el) return false;
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    var style = window.getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  }

  function matchAliasScore(target, aliasStr) {
    if (!aliasStr) return 0;
    var a = parseNameDetails(aliasStr);
    if (!a.last || a.last !== target.last) return 0;

    // Check initials: "g j grice" for "gloria jean grice"
    if (a.first.length === 1 && a.first === target.first.charAt(0)) {
      if (
        (a.middle && a.middle.length === 1 && a.middle === target.middleInitial) ||
        !a.middle
      ) {
        return 30; // Perfect initials alias match!
      }
      return 15;
    }
    if (a.first === target.first) {
      return 20;
    }
    return 0;
  }

  function evaluateAliasMatch(target, aliasStr, targetAge, cardAge) {
    if (!aliasStr) return 0;
    var a = parseNameDetails(aliasStr);
    var ageKnown = !!(targetAge && cardAge);

    // If middle initials conflict, cannot be an alias for this target
    if (target.middleInitial && a.middleInitial && target.middleInitial !== a.middleInitial) {
      return 0;
    }

    // Case 1: Both First and Last match! (e.g. Alias has Kennedy Fulbright)
    var nameScore = matchNameScore(target, a);
    if (nameScore > 0) {
      // Name matches through an alias but the age says a different person
      if (ageKnown && !isAgeWithinTolerance(targetAge, cardAge)) return 0;
      return nameScore + 50; // 150+
    }

    // Case 2: First name matches exactly (e.g. Kennedy == Kennedy)
    if (target.first && a.first && target.first === a.first && target.last && a.last && target.last !== a.last) {
      var score = 65; // Base score for first name match in alias
      if (ageKnown) {
        var diff = Math.abs(targetAge - cardAge);
        if (diff === 0) score += 45; // Exact age match: 65 + 45 = 110 (>80 threshold!)
        else if (diff === 1) score += 35; // 65 + 35 = 100
        else if (diff === 2) score += 25; // 65 + 25 = 90
        else if (diff === 3) score += 20; // 65 + 20 = 85 (lowest confidence accepted)
        else score -= 60; // Beyond tolerance: 65 - 60 = 5 -> rejected
      }
      return score;
    }

    // Case 3: Last name matches exactly in alias
    if (target.last && a.last && target.last === a.last) {
      if (ageKnown && !isAgeWithinTolerance(targetAge, cardAge)) return 0;
      var score2 = 45;
      if (ageKnown && Math.abs(targetAge - cardAge) <= 1) {
        score2 += 40;
      }
      return score2;
    }

    return 0;
  }

  function matchAgeScore(targetAge, cardAge) {
    if (!targetAge || !cardAge) return 15; // Unknown age: neutral (cannot rule out)
    var diff = Math.abs(targetAge - cardAge);
    if (diff === 0) return 40; // Exact match
    if (diff === 1) return 35; // 1 year diff (e.g. 72 vs 73)
    if (diff === 2) return 25; // 2 years diff
    if (diff === 3) return 15; // 3 years diff: still acceptable, lowest confidence
    return -50; // Beyond tolerance: caller rejects the card outright
  }

  // Age agreement between the record and a search-result card. +/-3 years absorbs
  // off-by-one birthday/record lag; anything wider is a different person.
  // Record: 72 yrs -> 1954, so a card holding 1958 (age 68) is never a match.
  var MATCH_AGE_TOLERANCE = 3;

  function isAgeWithinTolerance(targetAge, cardAge) {
    if (!targetAge || !cardAge) return true; // Unknown age: cannot rule the card out
    return Math.abs(targetAge - cardAge) <= MATCH_AGE_TOLERANCE;
  }

  function isNameMatch(targetStr, candidateStr) {
    var target = parseNameDetails(targetStr);
    var cand = parseNameDetails(candidateStr);
    return matchNameScore(target, cand) >= 80;
  }

  function profileMatchesTarget(targetName, profileName, profileAliases, targetAliases) {
    var targetNames = [targetName].concat(Array.isArray(targetAliases) ? targetAliases : [])
      .filter(Boolean);
    var profileNames = [profileName].concat(Array.isArray(profileAliases) ? profileAliases : [])
      .filter(Boolean);
    return targetNames.some(function (targetNameValue) {
      var target = parseNameDetails(targetNameValue);
      return profileNames.some(function (profileNameValue) {
        return matchNameScore(target, parseNameDetails(profileNameValue)) >= 80;
      });
    });
  }

  function bestTargetNameScore(targetName, targetAliases, candidateName) {
    var targetNames = [targetName].concat(Array.isArray(targetAliases) ? targetAliases : [])
      .filter(Boolean);
    var candidate = parseNameDetails(candidateName);
    return targetNames.reduce(function (best, name) {
      return Math.max(best, matchNameScore(parseNameDetails(name), candidate));
    }, -100);
  }

  function hasStrongUnmaskIdentityEvidence(evidence, targetAge, profileAge) {
    if (!evidence) return false;
    return !!(
      evidence.phone ||
      evidence.address >= 80 ||
      (evidence.address >= 35 && targetAge && profileAge && targetAge === profileAge)
    );
  }

  function canInspectNameSearchCandidate(targetName, candidateName, targetAge, candidateAge, evidence, targetAliases) {
    if (evidence && (evidence.phone || evidence.address >= 80)) return true;
    if (!targetAge) return false;
    if (!candidateAge) {
      return bestTargetNameScore(targetName, targetAliases, candidateName) >= 80;
    }
    if (!isAgeWithinTolerance(targetAge, candidateAge)) return false;

    return bestTargetNameScore(targetName, targetAliases, candidateName) >= 80;
  }

  function unmaskProfileWasVisited(session, profileUrl) {
    var visited = session && Array.isArray(session.unmaskVisitedProfiles)
      ? session.unmaskVisitedProfiles
      : [];
    return visited.indexOf(profileUrl) !== -1;
  }

  function rememberUnmaskProfile(session, profileUrl, resultsUrl) {
    if (!session || !profileUrl) return;
    if (!Array.isArray(session.unmaskVisitedProfiles)) session.unmaskVisitedProfiles = [];
    if (!session.unmaskVisitedProfiles.includes(profileUrl)) {
      session.unmaskVisitedProfiles.push(profileUrl);
    }
    if (resultsUrl) session.unmaskSearchUrl = resultsUrl;
  }

  function parseAge(str) {
    if (!str) return null;
    if (/\b80\+/.test(String(str))) return null;
    var m = String(str).match(/\b(\d{2,3})\b/);
    return m ? parseInt(m[1], 10) : null;
  }

  // ---------------------------------------------------------------------------
  // Link safety: the run only ever follows an internal unmask.com person profile
  //
  // Unmask's own chrome (header, footer, "share" rows, app banners) carries anchors that leave
  // the site - Facebook, X, Instagram, YouTube, data brokers, ... A relative card can sit right
  // next to one of them, and a bare `a[href]` sweep matches both. So every link the run
  // considers is resolved first, and only a person profile on the host we are already on is
  // scrolled to or loaded. A social network, an external site, a mailto:/tel: link and the
  // site's own furniture pages (login, privacy, terms, ...) are dropped before they can pull
  // the run off the profile whose DOB is being read.
  // ---------------------------------------------------------------------------
  var SOCIAL_HOST_PATTERN =
    /^(?:[a-z0-9-]+\.)*(?:facebook|fb|fbcdn|twitter|x|instagram|linkedin|youtube|youtu|ytimg|tiktok|pinterest|reddit|tumblr|snapchat|whatsapp|telegram|discord|threads|nextdoor|trustpilot|yelp|zoominfo|spokeo|whitepages|beenverified|intelius|truthfinder|peoplefinders|fastpeoplesearch|radaris|mylife|nuwber|ancestry|myheritage|23andme|gravatar|maps|apple|amazon|paypal)\.[a-z]{2,}$/i;

  // The site's own furniture and listings: never a person, never worth a scroll or a load.
  // (An address or phone page is a listing of a person, not the person's profile - the old
  // scan skipped those two explicitly, and this is the same rule in one place.)
  var NON_PROFILE_PATH_PATTERN =
    /^\/(?:login|logout|signin|sign-in|signup|sign-up|register|account|privacy|terms|tos|legal|cookies|opt-out|do-not-sell|ccpa|gdpr|about|faq|help|support|contact|blog|news|pricing|plans|search|reviews|unlock|checkout|cart|app|mobile|sitemap|unsubscribe|address|addresses|phone|phones|email|emails)(?:[\/?#-]|$)/i;

  // Person profiles: /Name/ST-City/<id>, /Name/ST/<id>, /Name/<uuid>, /Name/ST-ChCity, and the
  // site's short name slug /First-Last/. Anything else that stays on the host is a listing.
  var PROFILE_UUID_PATTERN = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i;
  var PROFILE_PATH_PATTERN = /^\/[A-Za-z0-9_.'-]+\/[A-Za-z]{2}(?:-[A-Za-z0-9_.'-]+)?\/[a-f0-9-]{10,}\/?$/;
  var NAME_STATE_PATH_PATTERN = /^\/[A-Za-z0-9_.'-]+\/[A-Za-z]{2}(?:-[A-Za-z0-9_.'-]+)?\/?$/;
  var NAME_SLUG_PATH_PATTERN = /^\/[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+\/?$/;

  function isUnmaskNameSearchPath(pathname) {
    var path = String(pathname || "");
    return NAME_STATE_PATH_PATTERN.test(path) || NAME_SLUG_PATH_PATTERN.test(path);
  }

  function hostOf(name) {
    return String(name || "").toLowerCase().replace(/^www\./, "");
  }

  // Resolves a link to an absolute URL, but only when it stays on the site we are on.
  // Everything else - another host, a social network, mailto:/tel:/javascript:/data:, an
  // in-page "#" jump - resolves to null, so it is never scrolled to and never loaded.
  function resolveInternalUrl(rawHref, baseUrl) {
    if (!rawHref) return null;
    var raw = String(rawHref).trim();
    if (!raw || raw.charAt(0) === "#") return null;
    if (/^(?:mailto|tel|sms|callto|javascript|data|blob|file|ftp):/i.test(raw)) return null;

    var base = baseUrl || "";
    if (!base) {
      try {
        base = (typeof window !== "undefined" && window.location && window.location.href) || "";
      } catch (e) {
        base = "";
      }
    }
    var url = null;
    try {
      url = base ? new URL(raw, base) : new URL(raw);
    } catch (e) {
      return null;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;

    var baseHost = "";
    if (base) {
      try {
        baseHost = hostOf(new URL(base).hostname);
      } catch (e2) {
        baseHost = "";
      }
    }
    if (!baseHost) {
      try {
        baseHost = hostOf(typeof window !== "undefined" && window.location ? window.location.hostname : "");
      } catch (e3) {
        baseHost = "";
      }
    }

    var host = hostOf(url.hostname);
    if (!host || host !== baseHost) return null; // another site
    if (SOCIAL_HOST_PATTERN.test(host)) return null; // social network
    return url.href;
  }

  // The internal person profile a link points at, or null when it points anywhere else
  // (social network, external site, listing, address or phone page, furniture page).
  function isInternalProfileUrl(rawHref, baseUrl) {
    var abs = resolveInternalUrl(rawHref, baseUrl);
    if (!abs) return null;
    var path = "";
    try {
      path = new URL(abs).pathname || "";
    } catch (e) {
      return null;
    }
    if (NON_PROFILE_PATH_PATTERN.test(path)) return null;
    if (PROFILE_UUID_PATTERN.test(path)) return abs;
    if (PROFILE_PATH_PATTERN.test(path)) return abs;
    if (NAME_STATE_PATH_PATTERN.test(path)) return abs;
    if (NAME_SLUG_PATH_PATTERN.test(path)) return abs;
    return null;
  }

  // A "see all relatives" control is a button, or a link that stays on the site. An anchor
  // that leaves the site is never clicked, because a click is a navigation.
  function isExternalAnchor(el) {
    if (!el || !el.getAttribute) return false;
    if (String(el.tagName || "").toUpperCase() !== "A") return false;
    var href = el.getAttribute("href");
    if (!href || String(href).charAt(0) === "#") return false;
    return !resolveInternalUrl(href);
  }

  // The person name written on a relative card: the title element when the card has one,
  // otherwise the card's own text with the location line ("Blossom, TX") stripped off.
  function relativeLinkText(link) {
    if (!link) return "";
    var titleEl = link.querySelector ? link.querySelector(".wl-card-item__title") : null;
    var text = titleEl ? titleEl.textContent : "";
    if (!text && link.cloneNode) {
      var clone = link.cloneNode(true);
      var strip = clone.querySelectorAll
        ? clone.querySelectorAll(".wl-card-item__sub-text, .sub-text, span.location, span.address")
        : [];
      for (var s = 0; s < strip.length; s++) {
        if (strip[s] && strip[s].remove) strip[s].remove();
      }
      var head = clone.querySelector ? clone.querySelector("h2, h3, h4, span") : null;
      text = head ? head.textContent : clone.textContent;
    }
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  // The first relative card that belongs to the target person, together with the internal
  // profile URL it points at - or null. A card whose link is external, social or furniture is
  // skipped outright: it is neither matched by name, nor scrolled to, nor loaded.
  function pickRelativeProfileLink(links, targetName, baseUrl) {
    var targetSlug = String(targetName || "").toLowerCase().replace(/[^a-z0-9]+/g, "-");
    var list = links || [];
    for (var i = 0; i < list.length; i++) {
      var link = list[i];
      if (!link || !link.getAttribute) continue;

      var profileUrl = isInternalProfileUrl(link.getAttribute("href"), baseUrl);
      if (!profileUrl) continue;
      if (profileUrl.indexOf("/address/") !== -1 || profileUrl.indexOf("/phone/") !== -1) continue;

      var hrefLower = profileUrl.toLowerCase();
      var isSlugMatched = !!targetSlug && (
        hrefLower.indexOf("/" + targetSlug + "/") !== -1 ||
        hrefLower.indexOf("/" + targetSlug + "-") !== -1
      );

      var cardText = relativeLinkText(link);
      var cleanedRName = cardText.replace(/,\s*[A-Za-z\s]+$/, "").trim();

      if (
        isSlugMatched ||
        (cleanedRName && isNameMatch(targetName, cleanedRName)) ||
        (cardText && isNameMatch(targetName, cardText))
      ) {
        return { url: profileUrl, name: cleanedRName || cardText || targetName };
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Date of birth matching
  //
  // The record tells us how old the person is (e.g. "72 yrs (1954)"), so the only
  // birth years we may report are the ones that truly belong to that person.
  // DOB candidates may differ by one year from the record's birth year, but a
  // two-year gap is too large to trust as the same person's date of birth.
  // ---------------------------------------------------------------------------
  var DOB_YEAR_TOLERANCE = 1;
  var MIN_BIRTH_YEAR = 1912;
  var MAX_PLAUSIBLE_AGE = 110;
  // A matched profile without a DOB is abandoned after this settle time.
  var PROFILE_NO_DOB_SETTLE_MS = 500;
  // A rendered card list is given this long (per unchanged render) before we accept
  // that none of its cards is our person and move on.
  var CARDS_SETTLE_MS = 400;
  // How often the page state is re-checked (every step reacts within one tick).
  var TICK_MS = 150;
  // How long a Cloudflare check is left to the user before the run gives up on this address.
  // Nothing is ever clicked: the tab is brought forward once and simply watched, so this only
  // has to be long enough for a person to notice, switch over and tick the box.
  var CHALLENGE_WAIT_MS = 180000;

  var MONTH_NAMES = [
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december"
  ];

  function isMonthName(word) {
    if (!word) return false;
    var month = String(word).toLowerCase();
    return MONTH_NAMES.some(function (name) {
      return name === month || name.slice(0, 3) === month;
    });
  }

  function formatMonthName(word) {
    var lower = String(word).toLowerCase();
    var fullName = MONTH_NAMES.find(function (name) {
      return name === lower || name.slice(0, 3) === lower;
    }) || lower;
    return fullName.charAt(0).toUpperCase() + fullName.slice(1);
  }

  function parseDobMonthYear(value) {
    var text = String(value || "").trim();
    var month;
    var year;
    var numeric = text.match(/^(0?[1-9]|1[0-2])(?:\/\d{1,2})?\/(19\d{2}|20\d{2})$/);
    if (numeric) {
      month = parseInt(numeric[1], 10) - 1;
      year = parseInt(numeric[2], 10);
    } else {
      var named = text.match(/^([A-Za-z]{3,9})\.?\s+(?:(?:\d{1,2})(?:st|nd|rd|th)?,?\s+)?(19\d{2}|20\d{2})$/i);
      if (!named) return null;
      var shortMonth = named[1].toLowerCase().slice(0, 3);
      month = MONTH_NAMES.findIndex(function (name) { return name.slice(0, 3) === shortMonth; });
      year = parseInt(named[2], 10);
    }
    return month >= 0 ? { month: month, year: year } : null;
  }

  function extractExactMonthYearDob(text, expectedDob) {
    var expected = parseDobMonthYear(expectedDob);
    if (!expected) return null;
    var candidates = collectDobCandidates(text).filter(function (candidate) {
      var actual = parseDobMonthYear(candidate.text);
      return actual && actual.month === expected.month && actual.year === expected.year;
    });
    candidates.sort(function (a, b) {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.index - b.index;
    });
    return candidates.length ? candidates[0].text : null;
  }

  function currentYear() {
    return new Date().getFullYear();
  }

  // Birth year the record points at. Accepts the explicit year the record carries
  // ("72 yrs (1954)" or 1954), a plain age (72), or the raw age string.
  function getExpectedBirthYear(targetAge, targetYear) {
    var now = currentYear();
    var yearRaw = (targetYear === null || targetYear === undefined) ? "" : String(targetYear);
    var ageRaw = (targetAge === null || targetAge === undefined) ? "" : String(targetAge);

    var yearMatch = yearRaw.match(/\b(19\d{2}|20[0-1]\d)\b/) || ageRaw.match(/\b(19\d{2}|20[0-1]\d)\b/);
    if (yearMatch) {
      var yearNum = parseInt(yearMatch[1], 10);
      if (yearNum >= MIN_BIRTH_YEAR && yearNum <= now) return yearNum;
    }

    var ageMatch = ageRaw.match(/\b(\d{1,3})\b/);
    if (ageMatch) {
      var ageNum = parseInt(ageMatch[1], 10);
      if (ageNum > 0 && ageNum <= MAX_PLAUSIBLE_AGE) return now - ageNum;
    }

    return null;
  }

  function getDobYearTolerance(targetYear) {
    return /\b(?:19\d{2}|20[0-1]\d)\b/.test(String(targetYear || ""))
      ? 0
      : DOB_YEAR_TOLERANCE;
  }

  function getProfileDobYearTolerance(
    targetYear,
    targetName,
    profileName,
    evidence,
    targetAge,
    profileAge,
    profileAliases
  ) {
    var target = parseNameDetails(targetName);
    var profile = parseNameDetails(profileName);
    var exactCoreName = target.first && target.first === profile.first &&
      target.last && target.last === profile.last;
    if (!exactCoreName && target.first && target.last) {
      exactCoreName = (profileAliases || []).some(function (alias) {
        var aliasDetails = parseNameDetails(alias);
        return aliasDetails.first === target.first && aliasDetails.last === target.last;
      });
    }
    return exactCoreName && hasStrongUnmaskIdentityEvidence(evidence, targetAge, profileAge)
      ? DOB_YEAR_TOLERANCE
      : getDobYearTolerance(targetYear);
  }

  // "January 1954" / "January 1, 1954" / "01/01/1954" is the placeholder Unmask shows
  // when the real month and day are unknown: 50/50 real, so it is reported but never
  // trusted on its own.
  function isPlaceholderDob(dobText) {
    var text = String(dobText || "").trim();

    var numeric = text.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (numeric) {
      return parseInt(numeric[1], 10) === 1 && parseInt(numeric[2], 10) === 1;
    }

    var m = text.match(/^([A-Za-z]+)\.?\s+(?:(\d{1,2})(?:st|nd|rd|th)?,?\s+)?(\d{4})$/);
    if (!m) return false;
    var month = m[1].toLowerCase();
    if (month !== "january" && month !== "jan") return false;
    var day = m[2] ? parseInt(m[2], 10) : 1; // "January 1954" means January 1st
    return day === 1;
  }

  function cleanSummaryText(value) {
    return String(value === null || value === undefined ? "" : value)
      .replace(/\s+/g, " ")
      .trim();
  }

  // The profile summary is server rendered, so once the document has finished
  // loading and its text has stopped growing a missing DOB will never appear.
  function isProfileSummarySettled(snapshot) {
    if (!snapshot || snapshot.length < 20) return false;
    if (document.readyState !== "complete") return false;
    return true;
  }

  // Extracts the DOB of the person the record describes.
  // Dates that do not line up with the record's age (e.g. 1954 expected, 1958 on
  // the page) are ignored instead of reported - a wrong DOB is worse than none.
  function extractDobFromText(text, targetAge, targetYear, yearTolerance) {
    if (!text) return null;
    var best = pickBestDobCandidate(collectDobCandidates(text), targetAge, targetYear, yearTolerance);
    return best ? best.text : null;
  }

  // Collects every date-like string on the page that could be a birth date.
  // priority 4 = explicit wording   ("born on August 13, 1963", "DOB: 08/13/1963")
  // priority 3 = date followed by an age ("August 13, 1963 and is 62 years old")
  // priority 1 = bare "August 13, 1963"
  // priority 0 = bare "August 1963"
  function collectDobCandidates(text) {
    var list = [];
    if (!text) return list;

    function add(display, yearStr, priority, index) {
      var year = parseInt(yearStr, 10);
      var now = currentYear();
      if (!display || !year) return;
      if (year < MIN_BIRTH_YEAR || year > now) return;
      list.push({ text: display, year: year, priority: priority, index: index });
    }

    var m;

    // "born on August 13th, 1963", "was born August 13, 1963", "DOB: August 13, 1963"
    var reExplicitMonthDayYear = /\b(?:born|dob|date\s+of\s+birth|birth\s*date|birthday)\b\s*(?::|\s+on|\s+in|\s+is)?\s*([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/gi;
    while ((m = reExplicitMonthDayYear.exec(text)) !== null) {
      if (isMonthName(m[1])) {
        add(formatMonthName(m[1]) + " " + m[2] + ", " + m[3], m[3], 4, m.index);
      }
    }

    // "born in August 1963", "DOB: August 1963"
    var reExplicitMonthYear = /\b(?:born|dob|date\s+of\s+birth|birth\s*date|birthday)\b\s*(?::|\s+in|\s+on|\s+is)?\s*([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/gi;
    while ((m = reExplicitMonthYear.exec(text)) !== null) {
      if (isMonthName(m[1])) {
        add(formatMonthName(m[1]) + " " + m[2], m[2], 4, m.index);
      }
    }

    // "born on 08/15/1954", "DOB: 8-15-1954"
    var reExplicitNumeric = /\b(?:born|dob|date\s+of\s+birth|birth\s*date|birthday)\b\s*(?::|\s+on|\s+is)?\s*(0?[1-9]|1[0-2])[\/\-](0?[1-9]|[12]\d|3[01])[\/\-](\d{4})\b/gi;
    while ((m = reExplicitNumeric.exec(text)) !== null) {
      add(m[1] + "/" + m[2] + "/" + m[3], m[3], 4, m.index);
    }

    // "August 13th, 1963 and is 62 years old", "August 13, 1963 (62 yrs old)"
    var reMonthDayYearAge = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\s*[,;(]?\s*(?:and\s+)?(?:is\s+)?(?:age\s*)?(\d{1,3})\s*(?:years?(?:\s+old)?|yrs?|yo)\b/gi;
    while ((m = reMonthDayYearAge.exec(text)) !== null) {
      var hintAge = parseInt(m[4], 10);
      if (isMonthName(m[1]) && hintAge > 0 && hintAge <= MAX_PLAUSIBLE_AGE) {
        add(formatMonthName(m[1]) + " " + m[2] + ", " + m[3], m[3], 3, m.index);
      }
    }

    // Bare "August 13th, 1963"
    var reMonthDayYear = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/g;
    while ((m = reMonthDayYear.exec(text)) !== null) {
      if (isMonthName(m[1])) {
        add(formatMonthName(m[1]) + " " + m[2] + ", " + m[3], m[3], 1, m.index);
      }
    }

    // Bare "August 1963"
    var reMonthYear = /\b([A-Za-z]{3,9})\.?\s+(\d{4})\b/g;
    while ((m = reMonthYear.exec(text)) !== null) {
      if (isMonthName(m[1])) {
        add(formatMonthName(m[1]) + " " + m[2], m[2], 0, m.index);
      }
    }

    return list;
  }

  // An explicit record birth year must match exactly; age-only records allow the
  // existing one-year tolerance. Explicit "born ..." wording outranks a bare date.
  function pickBestDobCandidate(candidates, targetAge, targetYear, yearTolerance) {
    if (!candidates || candidates.length === 0) return null;

    var expectedYear = getExpectedBirthYear(targetAge, targetYear);
    var allowedYearDifference = yearTolerance === undefined
      ? getDobYearTolerance(targetYear)
      : yearTolerance;

    if (expectedYear) {
      var best = null;
      var bestScore = -Infinity;
      for (var i = 0; i < candidates.length; i++) {
        var c = candidates[i];
        var diff = Math.abs(c.year - expectedYear);
        if (diff > allowedYearDifference) continue;
        var score = (c.priority * 10) - diff;
        if (!best || score > bestScore || (score === bestScore && c.index < best.index)) {
          best = c;
          bestScore = score;
        }
      }
      return best;
    }

    // Record carries no age/year: trust an explicit birth phrase first, otherwise
    // the most specific date that still implies a lifelike age.
    var now = currentYear();
    var fallback = null;
    for (var j = 0; j < candidates.length; j++) {
      var cand = candidates[j];
      var impliedAge = now - cand.year;
      if (impliedAge < 5 || impliedAge > MAX_PLAUSIBLE_AGE) continue;
      if (cand.priority >= 3) return cand;
      if (
        !fallback ||
        cand.priority > fallback.priority ||
        (cand.priority === fallback.priority && cand.index < fallback.index)
      ) {
        fallback = cand;
      }
    }
    return fallback;
  }

  // Closest date that had to be rejected, so the UI can explain the skip instead
  // of silently reporting nothing.
  function describeClosestRejectedDob(text, targetAge, targetYear, yearTolerance) {
    var candidates = collectDobCandidates(text);
    var expectedYear = getExpectedBirthYear(targetAge, targetYear);
    if (!candidates.length || !expectedYear) return null;
    var allowedYearDifference = yearTolerance === undefined
      ? getDobYearTolerance(targetYear)
      : yearTolerance;

    var closest = null;
    var closestDiff = Infinity;
    for (var i = 0; i < candidates.length; i++) {
      var diff = Math.abs(candidates[i].year - expectedYear);
      if (diff < closestDiff) {
        closest = candidates[i];
        closestDiff = diff;
      }
    }
    if (!closest) return null;
    return {
      text: closest.text,
      year: closest.year,
      diff: closestDiff,
      outsideTolerance: closestDiff > allowedYearDifference
    };
  }

  // Cheap fingerprint of the rendered card list: any name/age/address that streams in
  // changes it, which is how the run knows the list has finished rendering.
  function cardsFingerprint(cards) {
    if (!cards || !cards.length) return "";
    var parts = [String(cards.length)];
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var text = card && card.textContent ? card.textContent : "";
      parts.push(text.length);
    }
    return parts.join(":");
  }

  function isUnmaskAddressNotFound() {
    // If person cards are already in the DOM, results ARE present! Never treat as not found!
    var cards = document.querySelectorAll("div.clickable.person, div[itemtype*='Person'].person, .person");
    if (cards && cards.length > 0) {
      return false;
    }

    // Check for an explicitly VISIBLE "Try Searching Another ..." dialog header.
    // Each page type uses its own wording: "Try Searching Another Address",
    // "Try Searching Another Phone Number", "Try Searching Another Name".
    var dialogHeaders = Array.from(
      document.querySelectorAll(".um-dialog__title, .tz-dialog h2, .tz-dialog__inner h2")
    );
    for (var i = 0; i < dialogHeaders.length; i++) {
      var h = dialogHeaders[i];
      if (isElementVisible(h) && /try searching another/i.test(h.textContent || "")) {
        return true;
      }
    }

    // Same dialog, matched by its body text ("We were unable to find any results
    // for that phone number. Try searching a different number.")
    var dialogBodies = Array.from(
      document.querySelectorAll(".um-dialog__text, .tz-dialog__inner p, .tz-dialog p")
    );
    for (var b = 0; b < dialogBodies.length; b++) {
      if (!isElementVisible(dialogBodies[b])) continue;
      var bodyText = (dialogBodies[b].textContent || "").toLowerCase();
      if (bodyText.includes("unable to find any results") || bodyText.includes("try searching a different")) {
        return true;
      }
    }

    // Check for an explicitly VISIBLE no-results banner/message
    var noneBoxes = Array.from(
      document.querySelectorAll(".um-results__none, .no-results, .um-alert--warning")
    );
    for (var j = 0; j < noneBoxes.length; j++) {
      var box = noneBoxes[j];
      if (isElementVisible(box)) {
        var boxText = (box.textContent || "").toLowerCase();
        if (
          boxText.includes("no records found") ||
          boxText.includes("couldn't find any records") ||
          boxText.includes("0 results found")
        ) {
          return true;
        }
      }
    }

    return false;
  }

  // Unmask shows this prompt when a name search (state / state+city) cannot be
  // narrowed down: "What age range best fits Charles?" with 18-29 / 30-49 / 50-99
  // buttons plus an "I don't know" cancel. No usable records sit behind it, so the
  // run has to move on to the next fallback instead of waiting for cards that will
  // never arrive.
  function looksLikeAgeRangePrompt(titleText, buttonValues) {
    if (/age\s+range/i.test(String(titleText || ""))) return true;

    var rangeButtons = 0;
    (buttonValues || []).forEach(function (value) {
      if (/^\s*\d{1,3}\s*-\s*\d{1,3}\s*\+?\s*$/.test(String(value || ""))) rangeButtons++;
    });
    return rangeButtons >= 2;
  }

  function isUnmaskAgeRangePrompt() {
    var modals = Array.from(
      document.querySelectorAll(
        ".tzModal[role='dialog'], .tzModal, .wl-modal-form, [role='dialog'][aria-modal='true']"
      )
    );

    for (var i = 0; i < modals.length; i++) {
      var modal = modals[i];
      if (!isElementVisible(modal)) continue;

      var titleEl = modal.querySelector(".wl-modal-form__title");
      var titleText = titleEl ? titleEl.textContent : modal.textContent;

      var valueEls = Array.from(
        modal.querySelectorAll(
          "input.wl-modal-form__input-field--button, input[type='button'][class*='input-field'], input[type='button']"
        )
      );
      var values = valueEls.map(function (el) {
        return el.value || el.textContent || "";
      });

      if (looksLikeAgeRangePrompt(titleText, values)) return true;
    }

    return false;
  }

  var TOP_EMAIL_DOMAINS = [
    "gmail.com",
    "yahoo.com",
    "ymail.com",
    "hotmail.com",
    "outlook.com",
    "icloud.com",
    "aol.com",
    "att.net",
    "comcast.net",
    "msn.com",
    "live.com",
    "sbcglobal.net",
    "verizon.net",
    "bellsouth.net",
    "charter.net",
    "cox.net"
  ];

  function selectBestEmails(rawEmails, personName) {
    if (!rawEmails || !rawEmails.length) return [];
    var unique = [];
    var seen = {};
    for (var i = 0; i < rawEmails.length; i++) {
      var em = String(rawEmails[i] || "").trim().toLowerCase();
      if (em && !seen[em]) {
        seen[em] = true;
        unique.push(em);
      }
    }

    if (unique.length <= 2) return unique;

    var firstEmail = unique[0];
    var candidates = unique.slice(1);

    // 1. Highest rank top domain
    var bestSecond = null;
    var bestDomainRank = 9999;
    for (var c = 0; c < candidates.length; c++) {
      var domain = (candidates[c].split("@")[1] || "").toLowerCase().trim();
      var rank = TOP_EMAIL_DOMAINS.indexOf(domain);
      if (rank !== -1 && rank < bestDomainRank) {
        bestDomainRank = rank;
        bestSecond = candidates[c];
      }
    }

    if (bestSecond) {
      return [firstEmail, bestSecond];
    }

    // 2. Contains person first or last name
    var nameParts = (personName || "").toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);
    var firstName = nameParts[0] || "";
    var lastName = nameParts.length > 1 ? nameParts[nameParts.length - 1] : "";

    for (var n = 0; n < candidates.length; n++) {
      var candLower = candidates[n].toLowerCase();
      if ((firstName.length >= 3 && candLower.includes(firstName)) ||
          (lastName.length >= 3 && candLower.includes(lastName))) {
        bestSecond = candidates[n];
        break;
      }
    }

    if (bestSecond) {
      return [firstEmail, bestSecond];
    }

    // 3. Fallback to any random/next email
    return [firstEmail, candidates[0]];
  }

  function extractEmailsFromPage(personName) {
    var emailSec =
      document.getElementById("email-addresses") ||
      document.querySelector(".wl-card--email, [data-section='email-addresses'], #email-addresses");

    if (emailSec) {
      var seeAllBtn = emailSec.querySelector(
        ".wl-card__cta-link, button.wl-card__cta-link, .um-btn-more, button[class*='more']"
      );
      if (seeAllBtn && !seeAllBtn.dataset.clicked) {
        seeAllBtn.dataset.clicked = "true";
        try { seeAllBtn.click(); } catch (e) {}
      }
    }

    var rawEmails = [];
    var emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

    var elements = emailSec
      ? Array.from(emailSec.querySelectorAll(".wl-card-item__title, .wl-card-item, span, a, button"))
      : Array.from(document.querySelectorAll("#email-addresses .wl-card-item__title, .wl-card--email .wl-card-item__title"));

    for (var i = 0; i < elements.length; i++) {
      var text = (elements[i].textContent || "").trim();
      var matches = text.match(emailRegex);
      if (matches) {
        for (var m = 0; m < matches.length; m++) {
          var em = matches[m].toLowerCase();
          if (!rawEmails.includes(em)) {
            rawEmails.push(em);
          }
        }
      }
    }

    if (rawEmails.length === 0 && emailSec) {
      var secText = emailSec.textContent || "";
      var m2 = secText.match(emailRegex);
      if (m2) {
        for (var k = 0; k < m2.length; k++) {
          var em2 = m2[k].toLowerCase();
          if (!rawEmails.includes(em2)) rawEmails.push(em2);
        }
      }
    }

    return selectBestEmails(rawEmails, personName);
  }

  function normalizeEvidenceDigits(value) {
    var digits = String(value || "").replace(/\D/g, "");
    return digits.length >= 10 ? digits.slice(-10) : "";
  }

  function normalizeEvidenceAddress(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/\b(?:avenue|ave)\b/g, "ave")
      .replace(/\b(?:boulevard|blvd)\b/g, "blvd")
      .replace(/\b(?:circle|cir)\b/g, "cir")
      .replace(/\b(?:court|ct)\b/g, "ct")
      .replace(/\b(?:drive|dr)\b/g, "dr")
      .replace(/\b(?:highway|hwy)\b/g, "hwy")
      .replace(/\b(?:lane|ln)\b/g, "ln")
      .replace(/\b(?:parkway|pkwy)\b/g, "pkwy")
      .replace(/\b(?:place|pl)\b/g, "pl")
      .replace(/\b(?:road|rd)\b/g, "rd")
      .replace(/\b(?:street|st)\b/g, "st")
      .replace(/\b(?:terrace|ter)\b/g, "ter")
      .replace(/\b(?:trail|trl)\b/g, "trl")
      .replace(/\b(?:turnpike|tpke)\b/g, "tpke")
      .replace(/[^a-z0-9]/g, "");
  }

  function matchUnmaskCardAddress(card, targetAddresses) {
    if (!card || !targetAddresses || !targetAddresses.length) return 0;
    var compactCardText = normalizeEvidenceAddress(card.textContent || "");
    var best = 0;

    targetAddresses.forEach(function (address) {
      if (!address) return;
      var street = normalizeEvidenceAddress(address.street || address.full);
      var zip = String(address.zip || "").replace(/\D/g, "").slice(0, 5);
      var city = normalizeEvidenceAddress(address.city);
      var state = normalizeEvidenceAddress(address.state);

      if (zip && compactCardText.includes(zip) && street && compactCardText.includes(street)) {
        best = Math.max(best, 80);
      } else if (zip && compactCardText.includes(zip) && city && state &&
        compactCardText.includes(city) && compactCardText.includes(state)) {
        best = Math.max(best, 35);
      } else if (
        city &&
        state &&
        compactCardText.includes(city) &&
        compactCardText.includes(state)
      ) {
        best = Math.max(best, 20);
      }
    });
    return best;
  }

  function matchUnmaskCardPhone(card, targetPhones) {
    if (!card || !targetPhones || !targetPhones.length) return false;
    var expected = targetPhones.map(normalizeEvidenceDigits).filter(Boolean);
    if (!expected.length) return false;

    var values = Array.from(card.querySelectorAll('[itemprop="telephone"], .person__data, a[href^="tel:"]'))
      .map(function (element) {
        return element.getAttribute && element.getAttribute("href")
          ? element.getAttribute("href")
          : element.textContent;
      });
    var phonePattern = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]+\d{3}[\s.-]+\d{4}/g;
    var found = (values.join(" ") + " " + (card.textContent || "")).match(phonePattern) || [];
    return found.some(function (phone) {
      return expected.indexOf(normalizeEvidenceDigits(phone)) !== -1;
    });
  }

  function unmaskNameCardEvidence(card, session) {
    var person = session && session.person ? session.person : {};
    var addresses = (session && session.addresses) || [];
    var phones = [
      session && session.phone,
      person.phone,
      person.phoneNumber
    ].concat(
      Array.isArray(person.phones) ? person.phones : [],
      Array.isArray(person.phoneNumbers) ? person.phoneNumbers : []
    ).filter(Boolean);
    return {
      address: matchUnmaskCardAddress(card, addresses),
      phone: matchUnmaskCardPhone(card, phones)
    };
  }

  // Automation runner
  function runUnmaskAutomation(session) {
    currentSession = session;
    if (session.exactDobSearch) {
      try {
        chrome.runtime.sendMessage({
          action: "DOB_LOOKUP_EXACT_PROGRESS",
          lookupId: session.lookupId
        });
      } catch (error) {
        console.error("[Unmask Automation] Could not report exact DOB search progress:", error);
      }
    }
    var targetName = session.targetName || "";
    var targetAge = session.targetAge || null;
    // Explicit birth year from the record (e.g. "72 yrs (1954)") when available.
    var targetYear = session.targetYear || null;
    var targetDob = session.targetDob || "";
    var currentUrl = window.location.href;
    var pathname = window.location.pathname;
    var isAddressPage = pathname.includes("/address/");
    var isPhonePage = pathname.includes("/phone/");
    var isProfilePage =
      !isAddressPage &&
      !isPhonePage &&
      (/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i.test(pathname) ||
       /\/[A-Za-z0-9_-]+\/[A-Za-z]{2}-[A-Za-z0-9_-]+\/[a-f0-9-]{10,}/i.test(pathname));
    var isNameSearchPage =
      !isAddressPage &&
      !isPhonePage &&
      !isProfilePage &&
      isUnmaskNameSearchPath(pathname);

    var state = {
      checkboxClicked: false,
      checkboxClickedAt: 0,
      cardsDetectedAt: 0,
      cardsSignature: "",
      cardsReported: -1,
      startedAt: Date.now(),
      processed: false,
      revisitingResults: false,
      dobExtractLogged: false,
      profileReadyAt: 0,
      profileSnapshot: "",
      // The security check belongs to the user: this only remembers when it appeared and that they
      // have already been pointed at it.
      challengeDetectedAt: 0,
      challengePrompted: false,
      // Set once the hand-back has been reported, so a promoted run does not report it every tick.
      challengeClearedSent: false
    };

    var interval = null;
    var watchdogTimer = null;

    function finishExactLookup(status, dob, message) {
      if (state.processed) return;
      state.processed = true;
      if (interval) clearInterval(interval);
      if (watchdogTimer) clearTimeout(watchdogTimer);
      try {
        chrome.runtime.sendMessage({
          action: "DOB_LOOKUP_EXACT_RESULT",
          lookupId: session.lookupId,
          status: status,
          dob: dob || "",
          message: message || ""
        });
      } catch (error) {
        console.error("[Unmask Automation] Could not report the exact DOB result:", error);
      }
    }

    function advanceToNextAddress(reason) {
      if (state.processed) return;
      if (session.exactDobSearch) {
        var searches = Array.isArray(session.searches) ? session.searches : [];
        var nextIndex = (Number(session.searchIndex) || 0) + 1;
        if (nextIndex < searches.length) {
          var nextSearch = searches[nextIndex];
          state.processed = true;
          if (interval) clearInterval(interval);
          if (watchdogTimer) clearTimeout(watchdogTimer);
          session.searchIndex = nextIndex;
          session.currentSearchType = nextSearch.type;
          session.searchUrl = nextSearch.url;
          session.unmaskSearchUrl = "";
          session.unmaskCandidateNeedsEvidence = false;
          sendProgress(
            2,
            4,
            (reason || "No exact match on this search.") +
              " Trying next " + nextSearch.type + " search (" +
              (nextIndex + 1) + " of " + searches.length + ")..."
          );
          chrome.storage.local.set({ unmask_pending_lookup: session }, function () {
            if (chrome.runtime.lastError) {
              console.error("[Unmask Automation] Could not save the next exact DOB search:", chrome.runtime.lastError.message);
              state.processed = false;
              finishExactLookup("error", "", "Could not continue to the next " + nextSearch.type + " search.");
              return;
            }
            window.location.href = nextSearch.url;
          });
          return;
        }
        finishExactLookup(
          "no_match",
          "",
          reason || "No exact month-and-year DOB match was found on address, phone, or name searches."
        );
        return;
      }
      state.processed = true;
      if (interval) clearInterval(interval);
      if (watchdogTimer) clearTimeout(watchdogTimer);

      sendProgress(2, 4, reason || "Moving to next address...");
      try {
        chrome.runtime.sendMessage({ action: "DOB_LOOKUP_NEXT_ADDRESS", record: sessionRecord() }, function (res) {
          if (res && res.nextUrl && !res.exhausted) {
            if (window.location.href !== res.nextUrl && !window.location.href.startsWith(res.nextUrl)) {
              window.location.href = res.nextUrl;
            }
          }
        });
      } catch (e) {}
    }

    async function revisitUnmaskSearchResults(reason) {
      if (!session.unmaskSearchUrl || window.location.href === session.unmaskSearchUrl) return false;
      state.revisitingResults = true;
      sendProgress(3, 4, reason || "Checking the next matching Unmask profile...");
      try {
        await chrome.storage.local.set({ unmask_pending_lookup: session });
      } catch (error) {
        console.error("[Unmask Automation] Could not resume Unmask search results:", error);
        state.revisitingResults = false;
        advanceToNextAddress("Could not resume Unmask results. Trying the next fallback...");
        return true;
      }
      state.processed = true;
      if (interval) clearInterval(interval);
      if (watchdogTimer) clearTimeout(watchdogTimer);
      window.location.href = session.unmaskSearchUrl;
      return true;
    }

    watchdogTimer = setTimeout(function () {
      if (!state.processed) {
        advanceToNextAddress("Address timed out (watchdog). Trying next address...");
      }
    }, 16000);

    sendProgress(1, 4, "Connecting to Unmask (" + (targetName || "Target") + ")...");

    interval = setInterval(async function () {
      if (state.processed || state.revisitingResults) return;
      try {
        // ==========================================
        // SCENARIO 0: Cloudflare Turnstile Challenge Intercept
        // ==========================================
        var isChallengePresent = isCloudflareChallengePage();
        if (isChallengePresent) {
          // The check is left entirely to the user. The extension does not click it - not with a
          // recorded click, not with a measured one: Cloudflare only accepts a real hand, and every
          // automated attempt only made the page start over. The background opens an inactive tab
          // and only shows it if that tab confirms this challenge; the user alone clears the check.
          if (!state.challengeDetectedAt) {
            state.challengeDetectedAt = Date.now();
            state.challengeClearedSent = false;
          }

          if (!state.challengePrompted) {
            state.challengePrompted = true;
            focusThisTab();
            sendProgress(
              1,
              4,
              "Security check on Unmask - please clear it in the verification tab when it appears. The lookup continues on its own once it clears."
            );
          }

          // The user may take as long as they like; only when they have clearly walked away does the
          // run give up on this address. Nothing is ever clicked, reloaded or fought with.
          if (Date.now() - state.challengeDetectedAt > CHALLENGE_WAIT_MS) {
            advanceToNextAddress("Security check was not cleared. Trying next address...");
            return;
          }

          return; // watch the page: the token (or the page going away) is what ends this branch
        }

        // If challenge cleared on this same page, reset challenge state so search gets a fresh window
        if (state.challengeDetectedAt && !isChallengePresent) {
          state.challengeDetectedAt = 0;
          state.challengePrompted = false;
          state.startedAt = Date.now();
          sendProgress(2, 4, "Security check passed. Reading Unmask results...");
        }

        // The run may have been promoted into this tab so the user could clear a check. Once there
        // is no check on the page any more, notify the background to return the user to their tab.
        if (session.promotedForChallenge && !state.challengeClearedSent) {
          state.challengeClearedSent = true;
          notifyChallengeCleared();
        }

        // ==========================================
        // SCENARIO 1: On Profile Page
        // ==========================================
        if (isProfilePage || document.getElementById("summary") || document.querySelector(".um-profile-summary")) {
          var summarySec =
            document.getElementById("summary") ||
            document.querySelector(".um-profile-summary, .um-results-profile__section");

          var profileNameEl = summarySec
            ? summarySec.querySelector(".um-profile-summary__name, h1.um-profile-summary__name, h1")
            : document.querySelector(".um-profile-summary__name, h1");
          var profileName = profileNameEl ? profileNameEl.textContent.trim() : "";
          var profileAliasEl = summarySec
            ? summarySec.querySelector(".um-profile-summary__aliases")
            : document.querySelector(".um-profile-summary__aliases");
          var profileAliases = profileAliasEl
            ? profileAliasEl.textContent
                .replace(/^\s*aliases\s*:\s*/i, "")
                .split(/[,;|]/)
                .map(function (alias) { return alias.trim(); })
                .filter(Boolean)
            : [];
          var profileLocationAgeEl = summarySec
            ? summarySec.querySelector(".um-profile-summary__location-age")
            : document.querySelector(".um-profile-summary__location-age");
          var profileAge = profileLocationAgeEl ? parseAge(profileLocationAgeEl.textContent) : null;
          var profileIdentityEvidence = unmaskNameCardEvidence(summarySec, session);

          var summaryTextEl = summarySec
            ? summarySec.querySelector(".um-profile-summary__text, .um-profile-summary__footer p")
            : null;
          var summaryText = summaryTextEl
            ? summaryTextEl.textContent
            : (summarySec ? summarySec.textContent : (document.body ? document.body.innerText : ""));

          // Check if this profile belongs to our target person
          var profileNameMatches = profileMatchesTarget(
            targetName,
            profileName,
            profileAliases,
            session.targetAliases
          );
          var isTargetProfile = profileNameMatches &&
            (!session.unmaskCandidateNeedsEvidence ||
             hasStrongUnmaskIdentityEvidence(profileIdentityEvidence, targetAge, profileAge));

          if (!isTargetProfile) {
            if (session.unmaskSearchUrl && await revisitUnmaskSearchResults(
              profileNameMatches
                ? "Name matched, but this profile lacked enough identity evidence. Checking the next Unmask profile..."
                : "Profile name did not match. Checking the next Unmask profile..."
            )) {
              return;
            }
            advanceToNextAddress(
              profileNameMatches
                ? "Unmask profile lacked enough identity evidence. Trying the next search..."
                : "Unmask profile name does not match " + (targetName || "the target") +
                  ". Trying the next search..."
            );
            return;
          }

          if (isTargetProfile) {
            if (!state.dobExtractLogged) {
              state.dobExtractLogged = true;
              sendProgress(4, 4, "Extracting DOB & Emails from profile...");
            }

            var profileDobYearTolerance = getProfileDobYearTolerance(
              targetYear,
              targetName,
              profileName,
              profileIdentityEvidence,
              targetAge,
              profileAge,
              profileAliases
            );
            var profileBodyText = document.body ? document.body.innerText : "";
            var dob =
              session.exactDobSearch
                ? extractExactMonthYearDob(summaryText, targetDob) ||
                  extractExactMonthYearDob(profileBodyText, targetDob)
                : extractDobFromText(summaryText, targetAge, targetYear, profileDobYearTolerance) ||
                  extractDobFromText(profileBodyText, targetAge, targetYear, profileDobYearTolerance);

            if (dob) {
              if (session.exactDobSearch) {
                finishExactLookup(
                  "match",
                  dob,
                  "Unmask found the same birth month and year."
                );
                return;
              }
              var isPlaceholder = isPlaceholderDob(dob);
              if (isPlaceholder && session.unmaskSearchUrl) {
                if (!session.unmaskPlaceholderDob) {
                  session.unmaskPlaceholderDob = dob;
                }
                state.processed = true;
                clearInterval(interval);
                if (watchdogTimer) clearTimeout(watchdogTimer);
                sendProgress(4, 5, "Unmask returned a month/day placeholder. Checking its other matching profiles...");
                try {
                  await chrome.storage.local.set({ unmask_pending_lookup: session });
                  window.location.href = session.unmaskSearchUrl;
                } catch (error) {
                  console.error("[Unmask Automation] Could not continue to the other matching profiles:", error);
                  copyToClipboard(dob);
                  sendSuccess(dob, session.person, [], {
                    placeholder: true,
                    continueSearch: true
                  });
                  sendProgress(5, 6, "Could not resume Unmask results. Checking ThatSthem...");
                }
                return;
              }

              var emails = extractEmailsFromPage(targetName);
              state.processed = true;
              clearInterval(interval);
              if (watchdogTimer) clearTimeout(watchdogTimer);
              copyToClipboard(dob);
              sendSuccess(dob, session.person, emails, {
                placeholder: isPlaceholder,
                // A January date is a 50/50 placeholder: report it right away, but keep
                // the run alive so ThatSthem can answer with a second, independent DOB.
                continueSearch: isPlaceholder
              });
              if (isPlaceholder) {
                sendProgress(5, 6, "Placeholder DOB " + dob + " found - checking ThatSthem for a second date...");
              } else {
                chrome.storage.local.remove("unmask_pending_lookup").catch(function () {});
              }
              return;
            }

            // A matched profile that shows no birth date is a dead end. The summary is
            // server rendered, so once the page has loaded and the text stopped growing
            // there is nothing left to wait for - move to the next fallback straight
            // away instead of burning the 12s profile timeout. Any date that contradicts
            // the record's age is named in the message so the skip stays visible.
            var profileSnapshot = cleanSummaryText(summaryText) + "|" + (profileBodyText || "").length;
            if (isProfileSummarySettled(profileSnapshot)) {
              if (state.profileSnapshot !== profileSnapshot) {
                // Still rendering: restart the short grace period
                state.profileSnapshot = profileSnapshot;
                state.profileReadyAt = Date.now();
                return;
              }
              if (Date.now() - state.profileReadyAt > PROFILE_NO_DOB_SETTLE_MS) {
                var noDobReason = "No DOB on " + (profileName || targetName || "this") + "'s profile";
                if (session.exactDobSearch) {
                  var observedDob =
                    extractDobFromText(summaryText, targetAge, targetYear, profileDobYearTolerance) ||
                    extractDobFromText(profileBodyText, targetAge, targetYear, profileDobYearTolerance);
                  noDobReason = observedDob
                    ? "Found " + observedDob + ", which does not exactly match " + targetDob
                    : "No birth month and year were available to compare with " + targetDob;
                }
                var rejected =
                  describeClosestRejectedDob(summaryText, targetAge, targetYear, profileDobYearTolerance) ||
                  describeClosestRejectedDob(profileBodyText, targetAge, targetYear, profileDobYearTolerance);
                if (rejected && rejected.outsideTolerance) {
                  noDobReason +=
                    " (ignored " + rejected.text + ", expected birth year " +
                    getExpectedBirthYear(targetAge, targetYear) +
                    (profileDobYearTolerance === 0 ? ")" : " within one year)");
                }
                if (session.unmaskSearchUrl && await revisitUnmaskSearchResults(
                  noDobReason + ". Checking the next matching Unmask profile..."
                )) {
                  return;
                }
                if (session.exactDobSearch) {
                  finishExactLookup("no_match", "", noDobReason);
                  return;
                }
                advanceToNextAddress(noDobReason + ". Trying next...");
                return;
              }
            }
          }

          // The target profile's own DOB is read to completion first. While that read is in
          // flight nothing else happens on this page - no scrolling, no relative-card scan, no
          // navigation - so a relative or footer link can never cut the DOB extraction short.
          if (!isTargetProfile) {
            sendProgress(3, 4, "Checking relatives for " + targetName + "...");

            // 1. Scroll down to relatives section so it renders into DOM
            var relativesSec =
              document.getElementById("relatives") ||
              document.querySelector(".um-results-profile__section#relatives, .wl-card#relatives, [data-section='relatives'], #relatives");

            if (relativesSec) {
              try {
                relativesSec.scrollIntoView({ behavior: "smooth", block: "center" });
              } catch (e) {}

              // Expand "See all relatives" if button present. A control that is an anchor to
              // another site is never clicked - the click itself would be a navigation.
              var seeAllBtn = relativesSec.querySelector(
                ".wl-card__cta-link, button.wl-card__cta-link, .um-btn-more, button[class*='more'], a[class*='more']"
              );
              if (seeAllBtn && !seeAllBtn.dataset.clicked && !isExternalAnchor(seeAllBtn)) {
                seeAllBtn.dataset.clicked = "true";
                seeAllBtn.click();
              }
            }

            // 2. Scan the relative cards (#relatives, .wl-card-items, .wl-card-item). Every
            //    candidate is resolved first and only an internal person profile can win, so a
            //    social or footer anchor is never matched, scrolled to or loaded.
            var relativeLinks = Array.from(
              document.querySelectorAll("#relatives a, .wl-card-items a, a.wl-card-item, a[href]")
            );

            var relativeMatch = pickRelativeProfileLink(relativeLinks, targetName, currentUrl);
            if (relativeMatch) {
              state.processed = true;
              clearInterval(interval);
              if (watchdogTimer) clearTimeout(watchdogTimer);
              session.status = "on_target_profile";
              chrome.storage.local.set({ unmask_pending_lookup: session }).catch(function () {});
              sendProgress(4, 4, "Found " + relativeMatch.name + " in relatives list. Loading profile...");
              window.location.href = relativeMatch.url;
              return;
            }
          }

          // Profile safety timeout after 9 seconds if DOB could not be extracted.
          if (Date.now() - state.startedAt > 9000) {
            if (session.unmaskSearchUrl && await revisitUnmaskSearchResults(
              "Could not extract a DOB from this profile. Checking the next Unmask profile..."
            )) {
              return;
            }
            advanceToNextAddress("Could not extract DOB from profile. Trying next address...");
            return;
          }

          return; // Stay on profile page while extracting
        }

        // Overall safety timeout per address (12 seconds).
        if (Date.now() - state.startedAt > 12000) {
          advanceToNextAddress("Address timed out. Trying next address...");
          return;
        }

        if (!isAddressPage && !isPhonePage && !isNameSearchPage && !isProfilePage) {
          if (Date.now() - state.startedAt > 4000) {
            advanceToNextAddress("Unrecognized search page. Trying next address...");
            return;
          }
        }

        if (isAddressPage || isPhonePage || isNameSearchPage) {
        // Priority 1: Look for person cards in DOM
        var personCards = Array.from(
          document.querySelectorAll('div.clickable.person, div[itemtype*="Person"].person, .person')
        );

        var pageTypeLabel = isPhonePage ? "phone" : (isNameSearchPage ? "name" : "address");

        if (personCards.length > 0) {
          if (!state.cardsDetectedAt) {
            state.cardsDetectedAt = Date.now();
          }

          // Only re-report when the number of cards changes (no per-tick message spam)
          if (state.cardsReported !== personCards.length) {
            state.cardsReported = personCards.length;
            sendProgress(
              3,
              4,
              "Scanning & ranking " + personCards.length + " card(s) on " + pageTypeLabel + " page..."
            );
          }

          var targetDetails = parseNameDetails(targetName);
          var candidates = [];

          for (var cIdx = 0; cIdx < personCards.length; cIdx++) {
            var card = personCards[cIdx];
            var nameEl = card.querySelector(
              '.person__header-title, [itemprop="name"], h2'
            );
            var cardName = "";
            if (nameEl) {
              var clone = nameEl.cloneNode(true);
              clone.querySelectorAll('.person__header-subtext, span, button, svg').forEach(function(el) { el.remove(); });
              cardName = (clone.textContent || "").replace(/\s+/g, " ").trim();
              if (!cardName) {
                cardName = (nameEl.textContent || "").split("\n")[0].replace(/\s+/g, " ").trim();
              }
            }

            var ageEl = card.querySelector(".person__age-amount, .person__age");
            var cardAge = ageEl ? parseAge(ageEl.textContent) : null;
            var cardEvidence = isNameSearchPage
              ? unmaskNameCardEvidence(card, session)
              : { address: 0, phone: false };
            var mayUseCandidate = !isNameSearchPage || canInspectNameSearchCandidate(
              targetName,
              cardName,
              targetAge,
              cardAge,
              cardEvidence,
              session.targetAliases
            );
            var reportLink =
              card.querySelector('a.person__header-text[href]') ||
              card.querySelector('a[href*="/"][class*="header"]') ||
              card.querySelector('.person__header a[href]') ||
              card.querySelector('a.person__button[href]') ||
              card.querySelector('a[href*="-"][href*="/"]') ||
              card.querySelector('a[href]');
            var reportHref = reportLink ? (reportLink.href || reportLink.getAttribute("href") || "") : "";
            if (reportHref && !reportHref.startsWith("http")) {
              reportHref = window.location.origin + (reportHref.startsWith("/") ? "" : "/") + reportHref;
            }

            if (!reportHref) continue;

            // Extract aliases
            var aliases = [];
            var aliasEls = Array.from(card.querySelectorAll('[itemprop="alternateName"]'));
            for (var a = 0; a < aliasEls.length; a++) {
              var aText = aliasEls[a].textContent.trim();
              if (aText && !aliases.includes(aText)) aliases.push(aText);
            }
            var infoRows = Array.from(card.querySelectorAll(".person__info"));
            for (var r = 0; r < infoRows.length; r++) {
              var rowTitle = (infoRows[r].querySelector(".person__title")?.textContent || "").toLowerCase();
              if (rowTitle.includes("alias")) {
                var spans = Array.from(infoRows[r].querySelectorAll(".person__data, span"));
                for (var s = 0; s < spans.length; s++) {
                  var sText = spans[s].textContent.trim();
                  if (sText && !sText.toLowerCase().includes("alias") && !aliases.includes(sText)) {
                    aliases.push(sText);
                  }
                }
              }
            }

            // Extract relatives
            var relatives = [];
            var relEls = Array.from(card.querySelectorAll('[itemprop="relatedTo"]'));
            for (var relIdx = 0; relIdx < relEls.length; relIdx++) {
              var rName = relEls[relIdx].textContent.trim();
              var rLink = relEls[relIdx].getAttribute("href") || (relEls[relIdx].closest("a") ? relEls[relIdx].closest("a").getAttribute("href") : "");
              if (rName) relatives.push({ name: rName, href: rLink });
            }
            for (var r2 = 0; r2 < infoRows.length; r2++) {
              var pt = infoRows[r2].querySelector(".person__title");
              var rTitle = (pt ? pt.textContent : "").toLowerCase();
              if (rTitle.includes("relative")) {
                var rLinks = Array.from(infoRows[r2].querySelectorAll("a.person__link, a[href]"));
                if (rLinks.length > 0) {
                  for (var rl = 0; rl < rLinks.length; rl++) {
                    var relNameText = rLinks[rl].textContent.trim();
                    var relLinkHref = rLinks[rl].getAttribute("href") || "";
                    if (relNameText && !relNameText.toLowerCase().includes("relative")) {
                      if (!relatives.some(function(item) { return item.name === relNameText; })) {
                        relatives.push({ name: relNameText, href: relLinkHref });
                      }
                    }
                  }
                } else {
                  // Comma-separated relative names
                  var dataEl = infoRows[r2].querySelector(".person__data") || infoRows[r2];
                  var textParts = (dataEl.textContent || "").split(/[,;\n]/);
                  for (var tp = 0; tp < textParts.length; tp++) {
                    var cleanPart = textParts[tp].trim();
                    if (cleanPart && !cleanPart.toLowerCase().includes("relative")) {
                      if (!relatives.some(function(item) { return item.name === cleanPart; })) {
                        relatives.push({ name: cleanPart, href: "" });
                      }
                    }
                  }
                }
              }
            }

            // Also check all links in card for target name or slug. Only an internal person
            // profile counts, so a social or external anchor inside the card is never followed.
            var cardTargetSlugs = [targetName].concat(
              Array.isArray(session.targetAliases) ? session.targetAliases : []
            ).filter(Boolean).map(function (name) {
              return name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
            });
            var cardLinks = Array.from(card.querySelectorAll("a[href]"));
            for (var cl = 0; cl < cardLinks.length; cl++) {
              var cLink = cardLinks[cl];
              var cText = cLink.textContent.trim();
              var cProfileUrl = isInternalProfileUrl(cLink.getAttribute("href"), currentUrl);
              var linkMatchesTarget = cardTargetSlugs.some(function (slug) {
                return cProfileUrl && (
                  cProfileUrl.toLowerCase().includes("/" + slug + "/") ||
                  cProfileUrl.toLowerCase().includes("/" + slug + "-")
                );
              });
              if (cProfileUrl && linkMatchesTarget) {
                if (!relatives.some(function(item) { return item.href === cProfileUrl; })) {
                  relatives.push({ name: cText || targetName, href: cProfileUrl });
                }
              }
            }

            // 1. Direct Evaluation (Card holder primary name matches)
            var cardNameDetails = parseNameDetails(cardName);
            var directNameScore = bestTargetNameScore(targetName, session.targetAliases, cardName);

            // If card text mentions target person anywhere, ensure it's tracked as a relative
            if (
              mayUseCandidate &&
              targetName && card.textContent &&
              card.textContent.toLowerCase().includes(targetName.toLowerCase())
            ) {
              if (!relatives.some(function(item) { return isNameMatch(targetName, item.name); })) {
                relatives.push({ name: targetName, href: "" });
              }
            }

            if (directNameScore > 0 && mayUseCandidate) {
              var score = directNameScore + 60; // Direct card holder bonus
              score += matchAgeScore(targetAge, cardAge);
              score += cardEvidence.address;
              if (cardEvidence.phone) score += 100;

              // Check aliases bonus
              var aliasBonus = 0;
              for (var al = 0; al < aliases.length; al++) {
                for (var targetAliasIndex = 0;
                  targetAliasIndex < (session.targetAliases || []).length + 1;
                  targetAliasIndex++
                ) {
                  var targetForAlias = targetAliasIndex === 0
                    ? targetDetails
                    : parseNameDetails(session.targetAliases[targetAliasIndex - 1]);
                  aliasBonus = Math.max(aliasBonus, matchAliasScore(targetForAlias, aliases[al]));
                }
              }
              score += aliasBonus;

              candidates.push({
                cardIndex: cIdx,
                score: score,
                reportUrl: reportHref,
                isDirect: true,
                name: cardName,
                age: cardAge,
                ageDiff: (targetAge && cardAge) ? Math.abs(targetAge - cardAge) : 999,
                identityEvidence: cardEvidence
              });
            }

            // 2. Alias Evaluation (Target person might be listed under Aliases)
            // e.g. Customer: "Kennedy Fulbright", Card Name: "Sabrina Tyres Everett", Aliases: "Kennedy T Everett", Age: 51
            var bestAliasMatchScore = 0;
            var matchedAliasName = "";
            for (var alIdx = 0; alIdx < aliases.length; alIdx++) {
              for (var targetAliasMatchIndex = 0;
                targetAliasMatchIndex < (session.targetAliases || []).length + 1;
                targetAliasMatchIndex++
              ) {
                var targetForMatch = targetAliasMatchIndex === 0
                  ? targetDetails
                  : parseNameDetails(session.targetAliases[targetAliasMatchIndex - 1]);
                var aScore = evaluateAliasMatch(targetForMatch, aliases[alIdx], null, null);
                if (aScore > bestAliasMatchScore) {
                  bestAliasMatchScore = aScore;
                  matchedAliasName = aliases[alIdx];
                }
              }
            }

            if (bestAliasMatchScore >= 80 && mayUseCandidate) {
              candidates.push({
                cardIndex: cIdx,
                score: bestAliasMatchScore + cardEvidence.address + (cardEvidence.phone ? 100 : 0),
                reportUrl: reportHref,
                isDirect: true, // It is the same person via alias!
                name: cardName + " (aka " + matchedAliasName + ")",
                age: cardAge,
                ageDiff: (targetAge && cardAge) ? Math.abs(targetAge - cardAge) : 999,
                identityEvidence: cardEvidence
              });
            }

            // 3. Relative Evaluation (Target person might be listed as a relative)
            for (var relI = 0; relI < relatives.length; relI++) {
              var relObj = relatives[relI];
              var relNameDetails = parseNameDetails(relObj.name);
              var relNameScore = bestTargetNameScore(targetName, session.targetAliases, relObj.name);
              if (relNameScore > 0 && mayUseCandidate) {
                var relScore = relNameScore + 25; // Relative base score (e.g. 100 + 25 = 125)
                relScore += cardEvidence.address;
                if (cardEvidence.phone) relScore += 100;
                // Only an internal person profile is worth the hop. A social, external or
                // furniture anchor that answered to the name falls back to the card's own
                // report link - which the candidate gate below checks as well.
                var relProfileUrl = isInternalProfileUrl(relObj.href, currentUrl);
                candidates.push({
                  cardIndex: cIdx,
                  score: relScore,
                  reportUrl: relProfileUrl || reportHref,
                  isDirect: !!relProfileUrl,
                  name: relObj.name + " (Relative of " + cardName + ")",
                  age: null,
                  ageDiff: 999,
                  identityEvidence: cardEvidence
                });
              }
            }
          }

          // Every candidate is resolved to an internal person profile before one can win: a
          // social or external anchor that answered to the name is dropped here, so the run is
          // never navigated off the site and away from the DOB it is after.
          var followableCandidates = [];
          for (var cf = 0; cf < candidates.length; cf++) {
            candidates[cf].reportUrl = isInternalProfileUrl(candidates[cf].reportUrl, currentUrl);
            if (
              candidates[cf].reportUrl &&
              !unmaskProfileWasVisited(session, candidates[cf].reportUrl)
            ) {
              followableCandidates.push(candidates[cf]);
            }
          }
          candidates = followableCandidates;

          // Sort candidates by score descending, then by closest age
          candidates.sort(function (a, b) {
            if (b.score !== a.score) return b.score - a.score;
            return a.ageDiff - b.ageDiff;
          });

          var bestCandidate = candidates.length > 0 ? candidates[0] : null;

          if (bestCandidate && bestCandidate.score >= 80 && bestCandidate.reportUrl) {
            session.status = bestCandidate.isDirect ? "on_target_profile" : "on_relative_profile";
            session.unmaskCandidateNeedsEvidence = isNameSearchPage &&
              !(bestCandidate.identityEvidence.phone || bestCandidate.identityEvidence.address >= 80);
            rememberUnmaskProfile(session, bestCandidate.reportUrl, window.location.href);
            try {
              await chrome.storage.local.set({ unmask_pending_lookup: session });
            } catch (error) {
              console.error("[Unmask Automation] Could not save the selected profile:", error);
              advanceToNextAddress("Could not save the selected Unmask profile. Trying the next fallback...");
              return;
            }
            state.processed = true;
            clearInterval(interval);
            if (watchdogTimer) clearTimeout(watchdogTimer);

            var matchLabel = bestCandidate.name + (bestCandidate.age ? " (Age " + bestCandidate.age + ")" : "");
            sendProgress(4, 4, "Matched ideal candidate: " + matchLabel + ". Loading profile...");
            window.location.href = bestCandidate.reportUrl;
            return;
          }

          // Cards are rendered but none of them is our person: move on as soon as the
          // card list has stopped changing. A list that is still filling in keeps
          // resetting the short settle window; a finished list is left immediately.
          var cardsSignature = cardsFingerprint(personCards);
          if (state.cardsSignature !== cardsSignature) {
            state.cardsSignature = cardsSignature;
            state.cardsDetectedAt = Date.now();
            return;
          }

          if (Date.now() - state.cardsDetectedAt > CARDS_SETTLE_MS) {
            if (session.unmaskPlaceholderDob) {
              state.processed = true;
              clearInterval(interval);
              if (watchdogTimer) clearTimeout(watchdogTimer);
              copyToClipboard(session.unmaskPlaceholderDob);
              sendSuccess(session.unmaskPlaceholderDob, session.person, [], {
                placeholder: true,
                continueSearch: true
              });
              sendProgress(5, 6, "No fuller DOB on the other Unmask profiles. Checking ThatSthem...");
              return;
            }
            advanceToNextAddress(
              "No corroborated name candidate on this " + pageTypeLabel + ". Checking next..."
            );
            return;
          }
        } else {
          // Priority 1: An "age range" prompt means Unmask could not resolve this name
          // search - there is nothing usable on the page, move to the next fallback.
          if (isUnmaskAgeRangePrompt()) {
            advanceToNextAddress(
              "Unmask asked for an age range on " + pageTypeLabel + " search (no usable records). Checking next..."
            );
            return;
          }

          // Priority 2: Only if NO cards are present, check if an actual "Address/Phone/Name Not Found" dialog is VISIBLE
          if (isUnmaskAddressNotFound()) {
            advanceToNextAddress("No records on this " + pageTypeLabel + ". Moving to next...");
            return;
          }

          // Priority 3: Only if NO cards are present, tick Unmask's own "unlock search
          // results" checkbox. This is a plain in-page toggle that reveals the results list,
          // not a security check - the selectors are deliberately narrow so a human-verification
          // widget can never be picked up here. Security checks are the user's to clear
          // (see isCloudflareChallengePage above).
          var checkbox =
            document.querySelector('input[type="checkbox"][aria-label*="View Address Search"]') ||
            document.querySelector('input[type="checkbox"][aria-label*="Address Search"]') ||
            document.querySelector('input[type="checkbox"][aria-label*="View Phone Search"]') ||
            document.querySelector('input[type="checkbox"][aria-label*="Phone Search"]') ||
            document.querySelector('input[type="checkbox"][aria-label*="View Name Search"]') ||
            document.querySelector('input[type="checkbox"][aria-label*="Name Search"]');

          if (checkbox && isElementVisible(checkbox) && !checkbox.checked && !state.checkboxClicked) {
            state.checkboxClicked = true;
            state.checkboxClickedAt = Date.now();
            sendProgress(2, 4, "Unlocking " + pageTypeLabel + " search results...");
            await simulateHumanClick(checkbox);
            await delay(randomDelay(250, 500));
            return;
          }

          // Priority 4: nothing rendered at all. Give sufficient grace time for AJAX
          // responses to complete and render person cards into the DOM.
          var elapsedSinceCheck = state.checkboxClickedAt ? (Date.now() - state.checkboxClickedAt) : (Date.now() - state.startedAt);
          var maxWait = document.readyState === "complete"
            ? (state.checkboxClickedAt ? 3500 : 4500)
            : 8000;
          if (elapsedSinceCheck > maxWait) {
            advanceToNextAddress("No records found on " + pageTypeLabel + " search. Checking next...");
            return;
          }
        }
      }
    } catch (err) {
      console.error("[Unmask Automation] Tick error:", err);
      if (!state.tickErrors) state.tickErrors = 0;
      state.tickErrors++;
      if (state.tickErrors > 15) {
        advanceToNextAddress("Search error. Trying next fallback...");
      }
    }
  }, TICK_MS);
  }

  // Initialize. The runner check is a message round-trip, so the whole start is deferred until the
  // background has answered - starting before then would drive a run in a frame that may not be
  // the extension's own.
  confirmRunnerIsOurs(function (isOurs) {
    if (!isOurs) return;

    chrome.storage.local.get(["unmask_pending_lookup"], function (res) {
      var session = res ? res.unmask_pending_lookup : null;
      if (!session) return;
      // Do not run automation on the warm-up homepage runner
      if (window.location.pathname === "/" || window.location.pathname === "") return;
      runUnmaskAutomation(session);
    });
  });
})();
