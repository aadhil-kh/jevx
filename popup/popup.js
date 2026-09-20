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
  // One switch per page mode; `surface` is the service worker's name for it.
  const toggles = [
    { input: document.getElementById("timeline-toggle"), surface: "timeline", setting: "timelineEnabled", name: "Timeline pills" },
    { input: document.getElementById("conversation-toggle"), surface: "conversation", setting: "conversationEnabled", name: "Tweet pages" },
  ];
  const clearCacheButton = document.getElementById("clear-cache-button");
  const slopToggle = document.getElementById("slop-toggle");
  const cutoffSelect = document.getElementById("cutoff-select");

  // Multiples of 5 from 5 to 95; keep in sync with the service worker.
  for (let value = 5; value <= 95; value += 5) {
    const option = document.createElement("option");
    option.value = String(value);
    option.textContent = `${value}%`;
    cutoffSelect.append(option);
  }
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
    const { hasApiKey, lastErrorCode, needsReplyCutoff, slopEnabled } = response.settings;
    for (const toggle of toggles) toggle.input.checked = response.settings[toggle.setting] !== false;
    slopToggle.checked = slopEnabled !== false;
    cutoffSelect.value = String(needsReplyCutoff);
    if (hasApiKey) {
      keyInput.placeholder = "API key saved in this Chrome profile";
      if (lastErrorCode === "AUTH") {
        setStatus("The saved key was rejected. Enter a new one.", "err");
      } else {
        setStatus("API key saved in this Chrome profile.", "ok");
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
      keyInput.placeholder = "API key saved in this Chrome profile";
      if (response.persisted === false) {
        setStatus("Key saved for this session only; it could not be stored for after a restart.", "err");
      } else {
        setStatus("Connected to TypeSafe. Key saved in this Chrome profile.", "ok");
      }
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

  for (const { input, surface, name } of toggles) {
    input.addEventListener("change", async () => {
      const response = await send({ type: "JEVX_SET_ENABLED", surface, enabled: input.checked });
      if (!response || !response.ok) {
        setStatus("Could not update the setting.", "err");
        input.checked = !input.checked;
      } else {
        setStatus(input.checked ? `${name}: on.` : `${name}: off. Nothing is sent from there.`);
      }
    });
  }

  // Display only: the question rides along in requests that are sent anyway,
  // so this changes what is shown, never what is sent or cached.
  slopToggle.addEventListener("change", async () => {
    const response = await send({ type: "JEVX_SET_SLOP_ENABLED", slopEnabled: slopToggle.checked });
    if (!response || !response.ok) {
      setStatus("Could not update the setting.", "err");
      slopToggle.checked = !slopToggle.checked;
    } else {
      setStatus(slopToggle.checked ? "AI slop score: on." : "AI slop score: hidden.");
    }
  });

  cutoffSelect.addEventListener("change", async () => {
    const response = await send({ type: "JEVX_SET_NEEDS_REPLY_CUTOFF", needsReplyCutoff: Number(cutoffSelect.value) });
    setStatus(
      response && response.ok ? `"Needs attention" cutoff set to ${cutoffSelect.value}%.` : "Could not update the cutoff.",
      response && response.ok ? "ok" : "err"
    );
  });

  clearCacheButton.addEventListener("click", async () => {
    const response = await send({ type: "JEVX_CLEAR_CACHE" });
    setStatus(response && response.ok ? "Cached classifications cleared." : "Could not clear the cache.", response && response.ok ? "ok" : "err");
  });

  load();
})();
