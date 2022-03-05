const SimklRedirectURI = `${HttpCrxRedirectStub}/popup.html#simkl-oauth`;

(() => {
  importScripts("./env.js");

  const checkTokenValiditiy = async (responseChannel, token) => {
    responseChannel =
      responseChannel ||
      ((data) => {
        let message = {
          ...data,
          type: ActionType.action,
          action: ActionType.oauth.simkl.loginCheck,
        };
        chrome.runtime.sendMessage(message);
      });

    if (!!token) {
      let { valid } = await getLastActivity(token);
      responseChannel(makeSuccessResponse({ authToken: token, valid }));
      return;
    }
    let { simklOauthToken } = await chrome.storage.sync.get({
      simklOauthToken: null,
    });
    if (!!simklOauthToken) {
      let { valid } = await getLastActivity(simklOauthToken);
      consoledebug("Saved simkl token:", simklOauthToken)();
      responseChannel(
        makeSuccessResponse({ authToken: simklOauthToken, valid })
      );
      return;
    }
    // no token provided or found in localstorage
    responseChannel(makeErrorResponse({ authToken: null, valid: false }));
    return;
  };

  const getAuthToken = async (code) => {
    let req = {
      code: code,
      client_id: SimklClientID,
      client_secret: SimklClientSecret,
      redirect_uri: SimklRedirectURI,
      grant_type: "authorization_code",
    };
    // TODO(#15): API error handling
    return await (
      await fetch("https://api.simkl.com/oauth/token", {
        method: "POST",
        headers: {
          accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(req),
      })
    ).json();
  };

  const loginURI = () => {
    // Docs: https://simkl.docs.apiary.io/#reference/authentication-oauth-2.0/authorize-application?console=1
    return (
      "https://simkl.com/oauth/authorize?" +
      stringify({
        response_type: "code",
        client_id: SimklClientID,
        redirect_uri: SimklRedirectURI,
      })
    );
  };

  const oauthStart = async (responseChannel, inPopup) => {
    let { simklPinCode } = await chrome.storage.local.get();
    consoledebug("localStorage:", { simklPinCode })();

    if (!!simklPinCode) {
      // after redirect step
      let response = await getAuthToken(simklPinCode);
      consoledebug("Simkl access_token response:", response)();
      if ("error" in response) {
        // failed to authenticate the user
        // TODO(#16): this might be because code expired
        // it stayed in the local storage for too long
        responseChannel(makeErrorResponse(response));
        return;
      }
      if (response["access_token"] != null) {
        // got the plex authtoken
        // successfully logged in
        // code is one time use only forget it
        chrome.storage.local.remove("simklPinCode");
        responseChannel(
          makeSuccessResponse({ authToken: response["access_token"] })
        );
        return;
      }
      responseChannel(makeErrorResponse(response));
      return;
    }

    let appAuthorizeUrl = loginURI();
    consoledebug("Simkl application auth URL:", appAuthorizeUrl)();
    if (inPopup) {
      // open url in new tab
      chrome.tabs.create({ url: appAuthorizeUrl });
    } else {
      // open url in same tab
      // BUGLOC: chromeTabsUpdateBugVerCheck happens here
      chrome.tabs.update({ url: appAuthorizeUrl }, () => {
        // this debugging step printed nothing when chromeTabsUpdateBugVerCheck
        // bug was happening (when reaching this point)
        chrome.runtime.lastError && consoleerror(chrome.runtime.lastError)();
      });
    }
    return true;
  };

  const getAllItems = async ({ dates, token }, responseChannel, signal) => {
    consoledebug("getAllItems: ", dates)();
    let types =
      dates == null
        ? // dates will be null if full sync
          [MediaType.anime, MediaType.shows, MediaType.movies]
        : // only loop over provided date types
          Object.keys(dates);
    let serverTime;
    try {
      let responses = await Promise.all(
        types.map((type) =>
          fetch(
            `https://api.simkl.com/sync/all-items/${type}?` +
              "episode_watched_at=yes" +
              (dates && type in dates ? `&date_from=${dates[type]}` : "") +
              (type == "movies" ? "" : "&extended=full"),
            {
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
                "simkl-api-key": SimklClientID,
              },
              signal,
            }
          ).catch((err) => {
            throw err;
          })
        )
      );
      let data = {};
      await Promise.all(
        responses.map(async (resp, i) => {
          if (!serverTime) {
            serverTime = await _determineServerTime(resp);
          }
          if (resp.status == 200) {
            let items = await resp.json();
            if (items) {
              consoledebug("Got items for: ", types[i])();
              data[types[i]] = items[types[i]];
              return;
            }
            data[types[i]] = [];
          }
        })
      );
      if (!serverTime) {
        serverTime = await _determineServerTime(null);
      }
      if (!!responseChannel) {
        // TODO: remove this, responseChannel is unused
        Object.keys(data).length == types.length
          ? responseChannel(makeSuccessResponse(data))
          : responseChannel(makeErrorResponse(data));
      }
      return {
        success: Object.keys(data).length == types.length,
        data,
        serverTime,
      };
    } catch (error) {
      if (!serverTime) {
        serverTime = await _determineServerTime(null);
      }
      return { success: false, error: error, serverTime };
    }
  };

  const _determineServerTime = async (simklResp) => {
    let st = null;
    // get it from simkl date header
    if (simklResp && simklResp.headers.has("date")) {
      st = new Date(simklResp.headers.get("date")).toISOString();
      consoledebug("saving simkl api's response server time")();
      return st;
    }
    // fallback to simkl's date header
    try {
      // here don't send a request to a valid url
      // https://api.simkl.com redirects to apiary
      let simkltime = await fetch("https://api.simkl.com/invalid_url_route", {
        method: "HEAD",
      }).catch((err) => {
        throw err;
      });
      if (simkltime.headers.has("date")) {
        st = new Date(simkltime.headers.get("date")).toISOString();
        consoledebug("requesting simkl api's server time")();
        return st;
      }
    } catch (err) {
      // Can try plex.tv server's date
    }
    // worst case scenario: use client's clock time
    let now = new Date().toISOString();
    st = now;
    console.debug("Fallback to client's clock time", st, err);
    return st;
  };

  const getLastActivity = async (token, responseChannel = null) => {
    // TODO(#17): API error handling
    let resp = await fetch("https://api.simkl.com/sync/activities", {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "simkl-api-key": SimklClientID,
      },
    });
    if (resp.status == 200) {
      let data = await resp.json();
      !!responseChannel && responseChannel(makeSuccessResponse(data));
      return { valid: true, info: data };
    }
    let data = await resp.json();
    !!responseChannel && responseChannel(makeErrorResponse(data));
    return { valid: false, info: data, status: resp.status };
  };

  const getUserInfo = async (token) => {
    // TODO(#18): API error handling
    let resp = await fetch("https://api.simkl.com/users/settings", {
      headers: {
        "Content-Type": "application/json",
        "simkl-api-key": SimklClientID,
        Authorization: `Bearer ${token}`,
      },
    });
    if (resp.status == 200) {
      return await resp.json();
    }
  };

  const getShowEpisodeList = async (token, showID) => {
    let resp = await fetch(`https://api.simkl.com/tv/episodes/${showID}`, {
      headers: {
        "Content-Type": "application/json",
        "simkl-api-key": SimklClientID,
        Authorization: `Bearer ${token}`,
      },
    });
    if (resp.status == 200) {
      return await resp.json();
    }
  };

  __API__.simkl.oauth.oauthStart = oauthStart;
  __API__.simkl.oauth.checkTokenValiditiy = checkTokenValiditiy;

  __API__.simkl.apis.getLastActivity = getLastActivity;
  __API__.simkl.apis.getAllItems = getAllItems;
  __API__.simkl.apis.getUserInfo = getUserInfo;
  __API__.simkl.apis.getShowEpisodeList = getShowEpisodeList;
})();