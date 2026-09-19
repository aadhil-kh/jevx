/**
 * jevx: popup script.
 *
 * All privileged operations (key storage, testing, settings, cache) are routed
 * through the service worker so it stays the single owner of API-key
 * behavior. The saved key is never read back into this page's DOM.
 */

(() => {
  "use strict";

  const keyInput = document.getElementById("key-input");
  const saveButton = document.getElementById("save-button");
  const clearKeyButton = document.getElementById("clear-key-button");
  const enabledToggle = document.getElementById("enabled-toggle");
  const clearCacheButton = document.getElementById("clear-cache-button");
  const statusEl = document.getElementById("status");

  const FRIENDLY_ERRORS = {
    NOT_CONFIGURED: "No API key is saved yet.",
    AUTH: "TypeSafe rejected that key.",
    INVALID_REQUEST: "That key doesn't look right.",
    RATE_LIMIT: "TypeSafe rate-limited the request. Try again shortly.",
    OVERLOADED: "TypeSafe is busy right now. Try again shortly.",
    TIMEOUT: "TypeSafe timed out.",
    NETWORK: "Could not reach TypeSafe.",
    API: "TypeSafe returned an error.",
    INVALID_RESPONSE: "Unexpected response from TypeSafe.",
    DISABLED: "The extension is disabled.",
  };

  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.dataset.kind = kind || "";
  }

  function send(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(response);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  async function load() {
    const response = await send({ type: "JEVX_GET_SETTINGS" });
    if (!response || !response.ok) {
      setStatus("Could not read settings. Try reopening this popup.", "err");
      return;
    }
    const { hasApiKey, enabled, lastErrorCode } = response.settings;
    enabledToggle.checked = enabled !== false;
    if (hasApiKey) {
      keyInput.placeholder = "API key saved for this browser session";
      if (lastErrorCode === "AUTH") {
        setStatus("The saved key was rejected. Enter a new one.", "err");
      } else {
        setStatus("API key saved for this browser session.", "ok");
      }
    } else if (lastErrorCode === "AUTH") {
      setStatus("The last key used was rejected by TypeSafe.", "err");
    } else {
      setStatus("Paste a TypeSafe API key to get started.");
    }
  }

  saveButton.addEventListener("click", async () => {
    const apiKey = keyInput.value.trim();
    if (!apiKey) {
      setStatus("Enter a TypeSafe API key first.", "err");
      return;
    }
    saveButton.disabled = true;
    saveButton.textContent = "Testing…";
    setStatus("Testing the key against TypeSafe…");
    const response = await send({ type: "JEVX_SAVE_AND_TEST_KEY", apiKey });
    saveButton.disabled = false;
    saveButton.textContent = "Save & Test";
    keyInput.value = "";
    if (response && response.ok) {
      keyInput.placeholder = "API key saved for this browser session";
      setStatus("Connected to TypeSafe for this browser session.", "ok");
    } else {
      const code = response && response.error ? response.error.code : "NETWORK";
      setStatus(FRIENDLY_ERRORS[code] || "Could not verify the key.", "err");
    }
  });

  clearKeyButton.addEventListener("click", async () => {
    await send({ type: "JEVX_CLEAR_KEY" });
    keyInput.value = "";
    keyInput.placeholder = "Paste your TypeSafe API key";
    setStatus("Key cleared.");
  });

  enabledToggle.addEventListener("change", async () => {
    const response = await send({ type: "JEVX_SET_ENABLED", enabled: enabledToggle.checked });
    if (!response || !response.ok) {
      setStatus("Could not update the setting.", "err");
      enabledToggle.checked = !enabledToggle.checked;
    } else {
      setStatus(enabledToggle.checked ? "Enabled." : "Disabled: no classifications will run.");
    }
  });

  clearCacheButton.addEventListener("click", async () => {
    const response = await send({ type: "JEVX_CLEAR_CACHE" });
    setStatus(response && response.ok ? "Cached classifications cleared." : "Could not clear the cache.", response && response.ok ? "ok" : "err");
  });

  load();
})();
