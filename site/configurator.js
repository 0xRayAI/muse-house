/* Muse House configurator — wizard + live MCP integration (same-origin /mcp). */
(function () {
  "use strict";

  var state = {
    step: 1,
    name: "",
    timezone: "",
    rooms: [],          // room ids
    roomMeta: {},       // id -> {name, description}
    utilities: [],      // utility ids
    utilMeta: {},       // id -> {name, why}
    spendThreshold: 100,
    confirmSend: true,
    confirmShare: true,
    house: null,
  };

  var TOTAL_STEPS = 6;

  /* ---------- JSON API client (same-origin /api/*, structured data) ---------- */
  function api(path, params) {
    var qs = params
      ? "?" + Object.keys(params).map(function (k) {
          return encodeURIComponent(k) + "=" + encodeURIComponent(params[k]);
        }).join("&")
      : "";
    return fetch("/api/" + path + qs).then(function (res) {
      if (!res.ok) throw new Error("API HTTP " + res.status);
      return res.json();
    }).then(function (data) {
      if (data.error) throw new Error(data.error);
      return data;
    });
  }

  /* POST helper for endpoints that take personalization in the body
     (never in the URL — request-path logs must not see owner names). */
  function apiPost(path, body) {
    return fetch("/api/" + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    }).then(function (res) {
      if (!res.ok) throw new Error("API HTTP " + res.status);
      return res.json();
    }).then(function (data) {
      if (data.error) throw new Error(data.error);
      return data;
    });
  }
  function show(step) {
    state.step = step;
    document.querySelectorAll(".wstep").forEach(function (el) {
      el.classList.toggle("active", Number(el.dataset.step) === step);
    });
    var fill = document.getElementById("progressFill");
    var label = document.getElementById("progressLabel");
    if (step <= TOTAL_STEPS) {
      fill.style.width = Math.round((step / TOTAL_STEPS) * 100) + "%";
      label.textContent = "Step " + step + " of " + TOTAL_STEPS;
    } else {
      fill.style.width = "100%";
      label.textContent = "Done";
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
    if (step === 4) loadUtilities();
    if (step === 6) buildHouse();
  }
  document.addEventListener("click", function (e) {
    var next = e.target.closest("[data-next]");
    var back = e.target.closest("[data-back]");
    if (next) {
      if (state.step === 2) {
        state.name = document.getElementById("ownerName").value.trim();
        state.timezone = document.getElementById("timezone").value.trim() ||
          Intl.DateTimeFormat().resolvedOptions().timeZone;
      }
      show(state.step + 1);
    } else if (back) {
      show(state.step - 1);
    }
  });

  /* ---------- step 3: rooms (live from the connector) ---------- */
  var ROOM_ICONS = { money: "👛", travel: "✈️", home: "🏠", health: "❤️", game: "🎮", art: "🎨", dev: "💻", coach: "🎯", bling: "💎" };
  function ownedQuery() {
    try {
      var ids = JSON.parse(localStorage.getItem("museBlingOwned") || "[]");
      var q = {};
      if (ids && ids.length) q.owned = ids.join(",");
      var at = localStorage.getItem("museBlingPurchasedAt") || "";
      if (at) q.purchased_at = at;
      var voice = localStorage.getItem("museBlingVoice") || "";
      if (voice) q.voice = voice;
      return q;
    } catch (e) {
      return {};
    }
  }
  function loadRooms() {
    api("rooms", ownedQuery()).then(function (data) {
      var rooms = data.rooms || [];
      var grid = document.getElementById("roomGrid");
      grid.innerHTML = "";
      rooms.forEach(function (r) {
        state.roomMeta[r.id] = r;
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "pick-card" + (r.id === "money" ? " selected" : "");
        btn.dataset.room = r.id;
        var icon = r.icon || ROOM_ICONS[r.id] || "◦";
        var iconHtml = String(icon).charAt(0) === "/"
          ? '<img src="' + escapeHtml(icon) + '" alt="" width="44" height="44">'
          : escapeHtml(icon);
        btn.innerHTML =
          '<p class="room-icon">' + iconHtml + "</p>" +
          "<h3>" + escapeHtml(r.name) + "</h3><p>" + escapeHtml(r.description || "") + "</p>";
        btn.addEventListener("click", function () { btn.classList.toggle("selected"); });
        grid.appendChild(btn);
      });
      if (rooms.length === 0) {
        grid.innerHTML = '<p class="loading">Could not load rooms. Check your connection and reload.</p>';
      }
    }).catch(function () {
      document.getElementById("roomGrid").innerHTML =
        '<p class="loading">Could not reach the Foundry. Check your connection and reload.</p>';
    });
  }

  /* ---------- step 4: utilities (suggested by the Foundry) ---------- */
  var utilsLoaded = false;
  function loadUtilities() {
    if (utilsLoaded) return;
    utilsLoaded = true;
    var selectedRooms = Array.prototype.map.call(
      document.querySelectorAll("#roomGrid .pick-card.selected"),
      function (el) { return el.dataset.room; }
    );
    state.rooms = selectedRooms;
    var profile = selectedRooms.length
      ? "person setting up " + selectedRooms.join(", ") + " rooms"
      : "person setting up a personal operating house";
    api("utilities", { profile: profile, goal: "run my life on autopilot with approvals" })
      .then(function (data) {
        var list = document.getElementById("utilList");
        list.innerHTML = "";
        (data.utilities || []).forEach(function (u) {
          state.utilMeta[u.id] = u;
          var row = document.createElement("button");
          row.type = "button";
          row.className = "pick-row" + (u.recommended ? " selected" : "");
          row.dataset.util = u.id;
          row.innerHTML =
            "<input type='checkbox' tabindex='-1' " + (u.recommended ? "checked" : "") + ">" +
            '<span class="pick-body"><h3>' + escapeHtml(u.name) + "</h3><p>" +
            escapeHtml(u.why || "") + "</p></span>" +
            (u.recommended ? '<span class="tag">Suggested</span>' : "");
          row.addEventListener("click", function (ev) {
            if (ev.target.tagName !== "INPUT") {
              var cb = row.querySelector("input");
              cb.checked = !cb.checked;
            }
            row.classList.toggle("selected", row.querySelector("input").checked);
          });
          list.appendChild(row);
        });
      })
      .catch(function () {
        document.getElementById("utilList").innerHTML =
          '<p class="loading">Could not reach the Foundry. Check your connection and reload.</p>';
      });
  }

  /* ---------- step 6: build the house ---------- */
  function log(msg, cls) {
    var log = document.getElementById("buildLog");
    var div = document.createElement("div");
    if (cls) div.className = cls;
    div.textContent = msg;
    log.appendChild(div);
  }
  function buildHouse() {
    // re-read selections (user may have gone back)
    state.rooms = Array.prototype.map.call(
      document.querySelectorAll("#roomGrid .pick-card.selected"),
      function (el) { return el.dataset.room; }
    );
    state.utilities = Array.prototype.map.call(
      document.querySelectorAll("#utilList .pick-row.selected"),
      function (el) { return el.dataset.util; }
    );
    state.spendThreshold = Number(document.getElementById("spendThreshold").value) || 0;
    state.confirmSend = document.getElementById("confirmSend").checked;
    state.confirmShare = document.getElementById("confirmShare").checked;

    document.getElementById("buildLog").innerHTML = "";
    log("○ Connecting to the Foundry…", "run");

    var house = {
      version: "0.1.0",
      mintedAt: new Date().toISOString(),
      owner: { name: state.name || "friend", timezone: state.timezone },
      rooms: state.rooms,
      utilities: state.utilities,
      rules: {
        spendThreshold: state.spendThreshold,
        confirmBeforeSend: state.confirmSend,
        confirmBeforeShare: state.confirmShare,
        confirmBeforeSpend: true,
      },
    };

    apiPost("house-template", {
      owner_name: state.name || "",
      timezone: state.timezone || "",
      spend_threshold: String(state.spendThreshold != null ? state.spendThreshold : ""),
    }).then(function (tpl) {
      house.template = tpl;
      log("● House template minted", "ok");
      log("○ Minting " + state.rooms.length + " room blueprint(s)…", "run");
      return Promise.all(state.rooms.map(function (r) {
        return api("room-brief", Object.assign({ room: r }, ownedQuery())).then(function (b) {
          log("● " + (state.roomMeta[r] ? state.roomMeta[r].name : r) + " room ready", "ok");
          return [r, b];
        });
      }));
    }).then(function (pairs) {
      house.roomBriefs = {};
      pairs.forEach(function (p) { house.roomBriefs[p[0]] = p[1]; });
      log("○ Planning your mill…", "run");
      return api("steps", {
        goal: "run my " + (state.rooms.join(", ") || "life") + " on autopilot with approvals",
        utilities: state.utilities.join(","),
      });
    }).then(function (plan) {
      house.plan = plan;
      log("● Mill plan ready", "ok");
      log("○ Checking the Codex…", "run");
      return api("codex-check", { action: "send a payment without asking" });
    }).then(function (check) {
      house.codexCheck = check;
      log("● Codex check: " + (check.verdict || "done"), "ok");
      state.house = house;
      setTimeout(function () { finishBuild(); }, 500);
    }).catch(function (err) {
      log("✕ Build failed: " + err.message + " — reload and try again.", "run");
    });
  }

  /* ---------- step 7: done ---------- */
  function roomNames() {
    return state.rooms.map(function (r) {
      return state.roomMeta[r] ? state.roomMeta[r].name : r;
    });
  }
  function utilNames() {
    return state.utilities.map(function (u) {
      return state.utilMeta[u] ? state.utilMeta[u].name : u;
    });
  }
  function museSetupPrompt() {
    var h = state.house;
    return (
      "Please set up my Muse House.\n\n" +
      "1. Add the Muse House connector: " + location.origin + "/mcp\n" +
      "2. My name is " + h.owner.name + ", timezone " + h.owner.timezone + ".\n" +
      "3. My rooms: " + roomNames().join(", ") + ". For each room, call get_room_brief and create a dedicated side chat seeded with that brief.\n" +
      "4. My utilities: " + (utilNames().join(", ") || "none yet") + ".\n" +
      "5. House rules: confirm before any send, spend, share, or delete; ask me before spending over $" + h.rules.spendThreshold + ".\n" +
      "6. Set up the mill: morning briefing, bill watch, and evening wrap, per the room blueprints.\n\n" +
      "My full house pack (JSON) is attached below — use it as the source of truth:\n" +
      JSON.stringify(h, null, 2)
    );
  }
  function finishBuild() {
    document.getElementById("doneName").textContent = state.house.owner.name;
    var rows = [
      ["Owner", state.house.owner.name + " · " + state.house.owner.timezone],
      ["Rooms", roomNames().join(", ") || "—"],
      ["Utilities", utilNames().join(", ") || "—"],
      ["Spend threshold", "$" + state.house.rules.spendThreshold],
      ["Codex", "confirm before send / spend / share / delete"],
    ];
    document.getElementById("houseSummary").innerHTML = rows.map(function (r) {
      return '<div class="sum-row"><strong>' + r[0] + "</strong><span>" + escapeHtml(r[1]) + "</span></div>";
    }).join("");
    document.getElementById("musePrompt").textContent = museSetupPrompt();
    show(7);
  }

  document.getElementById("buildBtn").addEventListener("click", function () {
    state.name = document.getElementById("ownerName").value.trim();
    state.timezone = document.getElementById("timezone").value.trim() ||
      Intl.DateTimeFormat().resolvedOptions().timeZone;
    show(6);
  });
  document.getElementById("copyPrompt").addEventListener("click", function () {
    var btn = this;
    navigator.clipboard.writeText(document.getElementById("musePrompt").textContent).then(function () {
      btn.textContent = "Copied ✓";
      setTimeout(function () { btn.textContent = "Copy setup prompt"; }, 2000);
    });
  });
  document.getElementById("downloadBtn").addEventListener("click", function () {
    var blob = new Blob([JSON.stringify(state.house, null, 2)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "muse-house.json";
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* ---------- init ---------- */
  document.getElementById("timezone").value =
    Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  loadRooms();
  show(1);
})();
