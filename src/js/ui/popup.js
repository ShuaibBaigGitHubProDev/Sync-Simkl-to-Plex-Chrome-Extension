const restartLibrarySync = async (
  durationHours = DefaultSyncPeriod,
  runImmediately = true
) => {
  if (!durationHours) {
    durationHours = DefaultSyncPeriod;
  }
  if (await isSyncEnabled()) stopLibrarySync();
  console.debug("Starting library sync, duration", durationHours, "hrs");
  chrome.alarms.create(AlarmKey, {
    when: runImmediately
      ? Date.now() + 100
      : Date.now() + durationHours * 60 * 60 * 1000, // start immediately
    periodInMinutes: durationHours * 60,
    // periodInMinutes: 0.1,
  });
};

const stopLibrarySync = () => {
  console.debug("Stopping any running library sync");
  chrome.alarms.clear(AlarmKey);
  let message = {
    type: CallType.call,
    method: CallType.bg.sync.stop,
  };
  chrome.runtime.sendMessage(message);
};

const startLibrarySync = restartLibrarySync;

const isSyncEnabled = async () => {
  return !!(await chrome.alarms.get(AlarmKey));
};

const validateInputUrl = (inputUrl) => {
  // will always add a / at the end
  let url = inputUrl;
  try {
    url = new URL(inputUrl).href;
  } catch (error) {
    document.body.classList.add("error-url");
    return;
  }
  if (url.trim() != "") {
    if (
      (url.startsWith("http://") || url.startsWith("https://")) &&
      !!url.split("://")[1]
    ) {
      // remove any and all errors
      document.body.classList.remove("error-plex-url-unexpected");
      document.body.classList.remove("error-simkl-url-unexpected");
      document.body.classList.remove("sync-error-simkl");
      document.body.classList.remove("sync-error-plex");
      document.body.classList.remove("error-url");
      document.body.classList.add("url-added");
    } else {
      document.body.classList.add("error-url");
    }
  }
};

const handleHashRoutes = async () => {
  let windowHash = window.location.hash;
  if (windowHash == "") windowHash = "#"; // so that next line will result in ""
  // remove #plex-oauth or #simkl-oauth from url to be safe
  // remove #plex-perm or #simkl-perm from url to be safe
  if (windowHash.startsWith("#plex-") || windowHash.startsWith("#simkl-"))
    removeWindowHash();

  let loginType = windowHash.split("-")[0].split("#")[1];
  let permPromptFollowup = false;
  // #plexurl-perm
  if (windowHash == "#plexurl-perm") {
    permPromptFollowup = true;
    let parts = window.location.href.split("?");
    let plexUrl = decodeURIComponent(parts[parts.length - 1].split("=")[1]);
    removeWindowHash();
    removeWindowQueryParams();
    // Here chrome.permissions.contains always returns true
    // and is thus useless as we have *://* in host_permissions for the manifest
    // So we are keeping it tracked ourselves
    let { allowedOrigins } = await chrome.storage.local.get({
      allowedOrigins: [],
    });
    console.debug("Allowed origins", allowedOrigins);
    if (allowedOrigins.includes(plexUrl.originUrl())) {
      return;
    }
    iosAlert(
      `Access for: ${plexUrl} was denied by you but it is required for sync to work.`,
      "Attention"
    ); // no need to stall the UI here by using await
  }
  // if hash is #plex-oauth or #simkl-oauth
  if (loginType == "plex") {
    // this won't request new pin and code this time
    startPlexOauth();
  } else {
    // request service worker to validate and save plex oauth token
    checkPlexAuthTokenValidity();
  }
  if (loginType == "simkl") {
    startSimklOauth();
  } else {
    // request service worker to validate and save simkl oauth token
    checkSimklAuthTokenValidity();
  }
  if (permPromptFollowup) {
    // not required as not using chrome.tabs.update here
    // if (chromeTabsUpdateBugVerCheck()) {
    //   let t = await chrome.tabs.getCurrent();
    //   console.debug("Chrome tabs update bug is applicable: closing tab", t);
    //   await chrome.tabs.remove(t.id);
    // }
  }
};

// Orgin permission handling

const renewOrginPerms = async (oldPlexUrl, normalizedUrl) => {
  if (!oldPlexUrl || oldPlexUrl.originUrl() != normalizedUrl.originUrl()) {
    // url was modified while sync was running
    // remove permissions for old url
    console.debug(
      oldPlexUrl && oldPlexUrl.originUrl(),
      normalizedUrl.originUrl()
    );
    await removePlexURIPermissions(oldPlexUrl);
    await requestPlexURIPermissions(normalizedUrl);
  }
};

const removePlexURIPermissions = async (plexUrl) => {
  if (!plexUrl) return;
  console.debug("Removing origin permissions for", plexUrl);
  let { allowedOrigins } = await chrome.storage.local.get({
    allowedOrigins: [],
  });
  await chrome.storage.local.set({
    allowedOrigins: removeItemOnce(allowedOrigins, plexUrl.originUrl()),
  });
};

const requestPlexURIPermissions = async (plexUrl) => {
  // return true;
  let { allowedOrigins } = await chrome.storage.local.get({
    allowedOrigins: [],
  });
  if (!allowedOrigins.includes(plexUrl.originUrl())) {
    let allowed = false;
    try {
      allowed = await chrome.permissions.request({
        origins: [plexUrl.originUrl()],
      });
      console.debug("Allowed?", allowed);
    } catch (error) {
      await iosAlert(`Invalid Url: ${plexUrl}\n${error}`);
    }
    if (inPopup()) {
      // check if in popup and open new tab and resume flow
      // Due to a bug in chrome: after permission is requested popup closes
      // https://crbug.com/952645
      let message = {
        method: CallType.bg.popupAfterPermissionPrompt,
        type: CallType.call,
        // TODO: refactor all hash routes in to a common.js enum
        hashRoute: "plexurl-perm",
        plexUrl: encodeURIComponent(plexUrl),
      };
      chrome.runtime.sendMessage(message);
      if (allowed) {
        allowedOrigins.push(plexUrl.originUrl());
        chrome.storage.local.set({ allowedOrigins });
      } else {
        return false;
      }
    } else {
      if (allowed) {
        allowedOrigins.push(plexUrl.originUrl());
        chrome.storage.local.set({ allowedOrigins });
      } else {
        await iosAlert(
          `Access for: ${plexUrl} was denied by you but it is required for sync to work.`,
          "Attention"
        );
        return false;
      }
    }
  }
  return true;
};

// Sync UI

const uiSyncEnabled = () => {
  document.body.classList.add("sync-enabled");
};

const uiSyncDisabled = () => {
  document.body.classList.remove("sync-enabled");
  document.body.classList.remove("sync-waiting-for-next-sync");
};

const uiBroadcastSyncState = (enabled = true) => {
  let message = {
    action: enabled ? ActionType.ui.sync.enabled : ActionType.ui.sync.disabled,
    type: ActionType.action,
  };
  chrome.runtime.sendMessage(message);
};

const uiSetPopupViewState = () => {
  if (inPopup()) {
    document.documentElement.classList.add("popupview");
  }
};

// Background image

const uiSetLandscapeUrl = async (url) => {
  if (!url) {
    let { landScapeUrl } = await chrome.storage.local.get({
      landScapeUrl: null,
    });
    url = landScapeUrl;
    if (!url) {
      return;
    }
  }
  // TODO: check if not 404 or reachable and set it.
  setCssVar("--background-image-url", `url('${url}')`);
};

const uiSetPortraitUrl = async (url) => {
  // read from local storage
  if (!url) {
    let { portraitUrl } = await chrome.storage.local.get({
      portraitUrl: null,
    });
    url = portraitUrl;
    if (!url) {
      return;
    }
  }

  setCssVar("--background-image-url", `url('${url}')`);
};

const updateBackgroundURL = async (
  plexApiBaseURL,
  plexRatingKey,
  plexToken
) => {
  let message = {
    type: CallType.call,
    method: CallType.apis.plex.getBgUrl,
    plexToken: plexToken,
    plexApiBaseURL: plexApiBaseURL,
    plexRatingKey: plexRatingKey,
  };
  chrome.storage.local.set({
    landScapeUrl: await chrome.runtime.sendMessage({
      ...message,
      portrait: false,
    }),
    portraitUrl: await chrome.runtime.sendMessage({
      ...message,
      portrait: true,
    }),
  });
};

const uiHandleBackgroundImg = () => {
  let aspectRatio = document.body.clientWidth / document.body.clientHeight;
  Math.round(aspectRatio - 0.5) >= 1 ? uiSetLandscapeUrl() : uiSetPortraitUrl();
};

// END: Background image

const onLoad = async () => {
  const plexBtn = document.querySelector("sync-buttons-button.Plex");
  const simklBtn = document.querySelector("sync-buttons-button.Simkl");
  const syncBtn = document.querySelector("sync-form-button");
  const urlInput = document.querySelector("sync-form-plex-url>input");
  const durationInput = document.querySelector("sync-form-select-time>select");
  const syncNowBtn = document.querySelector("sync-desc-line-2");

  plexBtn.addEventListener("click", async (_) => {
    let { plexOauthToken } = await chrome.storage.sync.get({
      plexOauthToken: null,
    });
    console.debug(`plexOauthToken is: ${plexOauthToken}`);
    if (!plexOauthToken) {
      startPlexOauth();
    } else {
      logoutPlex();
    }
  });
  simklBtn.addEventListener("click", async (_) => {
    let { simklOauthToken } = await chrome.storage.sync.get({
      simklOauthToken: null,
    });
    console.debug(`simklOauthToken is: ${simklOauthToken}`);
    if (!simklOauthToken) {
      startSimklOauth();
    } else {
      logoutSimkl();
    }
  });
  urlInput.addEventListener(
    "input",
    debounce(() => validateInputUrl(urlInput.value))
  );
  durationInput.addEventListener("change", async (_) => {
    chrome.storage.local.set({
      syncPeriod: durationInput.value,
    });
    if (await isSyncEnabled()) {
      restartLibrarySync(durationInput.value, false);
      startNextSyncTimer();
    }
  });
  syncBtn.addEventListener("click", async (_) => {
    if (
      document.body.classList.contains("connected-plex") &&
      document.body.classList.contains("connected-simkl") &&
      document.body.classList.contains("url-added") &&
      !document.body.classList.contains("error-url")
    ) {
      let normalizedUrl = new URL(urlInput.value).href;
      let { plexInstanceUrl: oldPlexUrl } = await chrome.storage.local.get({
        plexInstanceUrl: null,
      });
      await chrome.storage.local.set({
        plexInstanceUrl: normalizedUrl,
        syncPeriod: durationInput.value,
      });
      if (await isSyncEnabled()) {
        await renewOrginPerms(oldPlexUrl, normalizedUrl);
        // sync enabled; stop it
        uiSyncDisabled();
        stopLibrarySync();
        uiBroadcastSyncState(false);
      } else {
        // https://stackoverflow.com/questions/27669590/chrome-extension-function-must-be-called-during-a-user-gesture
        await renewOrginPerms(oldPlexUrl, normalizedUrl);
        uiSyncEnabled();
        // TODO: remove the sync-errors
        startLibrarySync(durationInput.value);
        uiBroadcastSyncState(true);
        await chrome.storage.local.set({
          doFullSync: true,
        });
      }
    }
  });
  syncNowBtn.addEventListener("click", async (_) => {
    if (!document.body.classList.contains("sync-waiting-for-next-sync")) {
      return;
    }
    // Force sync
    console.debug("starting syncing manually before next scheduled sync");
    let message = {
      type: CallType.call,
      method: CallType.bg.sync.start,
    };
    await chrome.runtime.sendMessage(message);
  });

  handleHashRoutes();
  // load settings from local storage and update UI
  (async () => {
    let { plexInstanceUrl, syncPeriod } = await chrome.storage.local.get({
      plexInstanceUrl: null,
      syncPeriod: DefaultSyncPeriod,
    });
    if (!!plexInstanceUrl) {
      urlInput.value = plexInstanceUrl;
      validateInputUrl(urlInput.value);
      // updateBackgroundURL(plexInstanceUrl, , 2681);
    }
    if (!!syncPeriod) {
      durationInput.value = syncPeriod;
    }
    if (await isSyncEnabled()) {
      uiSyncEnabled();
      // next sync timer
      startNextSyncTimer();
    }
  })();

  uiSetPopupViewState();
  uiHandleBackgroundImg();
};

window.addEventListener("load", onLoad);
window.addEventListener("resize", uiHandleBackgroundImg);

// Registering UI event handlers (actions)

chrome.runtime.onMessage.addListener(async (message, sender) => {
  // console.debug("Got message:", message, "from:", sender);
  switch (message.type) {
    case ActionType.action:
      switch (message.action) {
        case ActionType.oauth.plex.login:
          finishPlexOauth(message);
          break;
        case ActionType.oauth.plex.logout:
          finishLogoutPlex(message);
          uiSyncDisabled();
          stopLibrarySync();
          break;
        case ActionType.oauth.simkl.login:
          finishSimklOauth(message);
          break;
        case ActionType.oauth.simkl.logout:
          uiSyncDisabled();
          stopLibrarySync();
          finishLogoutSimkl(message);
          break;
        case ActionType.ui.sync.enabled:
          uiSyncEnabled();
          break;
        case ActionType.ui.sync.disabled:
          uiSyncDisabled();
          break;
        case ActionType.ui.sync.plex.online:
          document.body.classList.remove("error-plex-url-offline");
          break;
        case ActionType.ui.sync.plex.offline:
          document.body.classList.add("error-plex-url-offline");
          // uiSyncDisabled();
          // stopLibrarySync();
          break;
        case ActionType.ui.sync.simkl.online:
          document.body.classList.remove("error-simkl-url-offline");
          break;
        case ActionType.ui.sync.simkl.offline:
          // TODO: max retries for offline?
          // better disable sync if offline immediately
          document.body.classList.add("error-simkl-url-offline");
          // uiSyncDisabled();
          // stopLibrarySync();
          break;
        case ActionType.ui.sync.plex.connecting:
          document.body.classList.add("sync-connecting-to-plex");
          break;
        case ActionType.ui.sync.plex.connectdone:
          document.body.classList.remove("sync-connecting-to-plex");
          break;
        case ActionType.ui.sync.plex.unexpected:
          document.body.classList.add("error-plex-url-unexpected");
          setTimeout(() => {
            // TODO: can this be avoided?
            // auto dismiss in 10 secs
            // the other way to dismiss is to modify the url
            document.body.classList.remove("error-plex-url-unexpected");
          }, 10000);
          break;
        case ActionType.ui.sync.plex.sessionexpired:
          document.body.classList.add("sync-error-plex");
          uiSyncDisabled();
          stopLibrarySync();
          break;
        case ActionType.ui.sync.simkl.connecting:
          document.body.classList.add("sync-connecting-to-simkl");
          break;
        case ActionType.ui.sync.simkl.connectdone:
          document.body.classList.remove("sync-connecting-to-simkl");
          break;
        case ActionType.ui.sync.simkl.unexpected:
          document.body.classList.add("error-simkl-url-unexpected");
          setTimeout(() => {
            // TODO: can this be avoided?
            // auto dismiss in 10 secs
            // the other way to dismiss is to modify the url
            document.body.classList.remove("error-simkl-url-unexpected");
          }, 10000);
          break;
        case ActionType.ui.sync.simkl.sessionexpired:
          document.body.classList.add("sync-error-simkl");
          uiSyncDisabled();
          stopLibrarySync();
          break;
        case ActionType.ui.sync.progress:
          // TODO: handle earch progress item
          if (message.value <= 0) {
            return;
          }
          document.body.classList.add("sync-in-progress-plex");
          document.body.classList.remove("sync-waiting-for-next-sync");
          // must be a string, css won't parse int type in var
          setCssVar("--plex-items-count", `"${message.value}"`);
          break;
        case ActionType.ui.sync.finished:
          // sync finished
          setCssVar("--plex-items-count", 0);
          document.body.classList.remove("sync-in-progress-plex");
          document.body.classList.add("sync-waiting-for-next-sync");
          startNextSyncTimer();
          break;
        default:
          console.debug("Unknown action", message);
      }
      break;
    case CallType.call:
      // ignore calls (they will be recieved by background.js)
      break;

    default:
      console.debug("Unknown message type", message);
  }
  // required if we don't use sendResponse
  return true;
});

const startNextSyncTimer = async () => {
  let signal = null;
  if (!!window.timerAbortC) {
    // TODO: to comibne multiple signals
    // https://github.com/whatwg/fetch/issues/905#issuecomment-491970649
    window.timerAbortC.abort();
    window.timerAbortC = null;
  }
  window.timerAbortC = new AbortController();
  signal = window.timerAbortC.signal;
  let { lastSynced, syncPeriod } = await chrome.storage.local.get({
    lastSynced: null,
    syncPeriod: DefaultSyncPeriod,
  });
  let now = () => new Date();
  let lastSyncedTime = new Date(lastSynced);
  let scheduledSyncTime = new Date(
    (await chrome.alarms.get(AlarmKey)).scheduledTime
  );
  let remainingMS = () => scheduledSyncTime.getTime() - now().getTime();
  // TODO: determine if sync is ongoing and don't show this
  if (now() > lastSyncedTime && now() < scheduledSyncTime) {
    document.body.classList.add("sync-waiting-for-next-sync");
    let totSecs = parseInt(syncPeriod) * 60 * 60;
    setCssVar("--plex-timer", `"${msToHMS(remainingMS())}"`);
    let interval = setInterval(() => {
      totSecs--;
      setCssVar("--plex-timer", `"${msToHMS(remainingMS())}"`);
      if (totSecs === 0 || (!!signal && signal.aborted)) {
        clearInterval(interval);
      }
    }, 1000);
  } else {
    document.body.classList.remove("sync-waiting-for-next-sync");
  }
};
