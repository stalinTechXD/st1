/*
 * study-controls.js — shared, self-contained widget for all visualizer pages.
 *
 * Adds a floating dock with:
 *   1) Study music (gentle in-browser lo-fi tones, no internet needed) with play/pause + volume.
 *   2) Universal animation controls: Pause / Resume + Next (single step).
 *
 * The animation controls work by intercepting window.setTimeout / setInterval.
 * When paused, pending timers are held; "Next" fires only the earliest pending
 * timer, advancing step-based animations one step at a time.
 */
(function () {
  "use strict";
  if (window.__studyControlsInstalled) return;
  window.__studyControlsInstalled = true;

  /* ------------------------------------------------------------------ *
   * 1. Controllable timer engine (wraps setTimeout / setInterval)
   * ------------------------------------------------------------------ */
  var _setTimeout = window.setTimeout.bind(window);
  var _clearTimeout = window.clearTimeout.bind(window);
  var _setInterval = window.setInterval.bind(window);
  var _clearInterval = window.clearInterval.bind(window);

  var paused = false;
  var fakeId = 1;
  var timers = new Map(); // id -> record

  function now() { return Date.now(); }

  function scheduleReal(rec) {
    rec.startTs = now();
    var wait = rec.remaining != null ? rec.remaining : rec.delay;
    if (wait < 0) wait = 0;
    rec.currentWait = wait;
    rec.realId = _setTimeout(function () {
      if (rec.type === "timeout") {
        timers.delete(rec.id);
        fire(rec);
      } else {
        // interval: reschedule
        fire(rec);
        if (timers.has(rec.id)) {
          rec.remaining = null;
          if (!paused) scheduleReal(rec);
        }
      }
    }, wait);
  }

  function fire(rec) {
    try { rec.fn.apply(null, rec.args); } catch (e) { /* swallow to stay resilient */ }
  }

  window.setTimeout = function (fn, delay) {
    if (typeof fn !== "function") return _setTimeout.apply(window, arguments);
    var args = Array.prototype.slice.call(arguments, 2);
    var rec = { id: fakeId++, type: "timeout", fn: fn, args: args, delay: +delay || 0, remaining: null };
    timers.set(rec.id, rec);
    if (paused) { rec.remaining = rec.delay; } else { scheduleReal(rec); }
    return rec.id;
  };

  window.setInterval = function (fn, delay) {
    if (typeof fn !== "function") return _setInterval.apply(window, arguments);
    var args = Array.prototype.slice.call(arguments, 2);
    var rec = { id: fakeId++, type: "interval", fn: fn, args: args, delay: +delay || 0, remaining: null };
    timers.set(rec.id, rec);
    if (paused) { rec.remaining = rec.delay; } else { scheduleReal(rec); }
    return rec.id;
  };

  window.clearTimeout = function (id) {
    var rec = timers.get(id);
    if (rec) { if (rec.realId) _clearTimeout(rec.realId); timers.delete(id); return; }
    return _clearTimeout(id);
  };

  window.clearInterval = function (id) {
    var rec = timers.get(id);
    // Intervals are driven internally via _setTimeout, so clear with _clearTimeout.
    if (rec) { if (rec.realId) _clearTimeout(rec.realId); timers.delete(id); return; }
    return _clearInterval(id);
  };

  function pauseAnimations() {
    if (paused) return;
    paused = true;
    timers.forEach(function (rec) {
      if (rec.realId != null) {
        var elapsed = now() - rec.startTs;
        var rem = (rec.currentWait != null ? rec.currentWait : rec.delay) - elapsed;
        rec.remaining = rem > 0 ? rem : 0;
        _clearTimeout(rec.realId);
        rec.realId = null;
      }
    });
    updateButtons();
  }

  function resumeAnimations() {
    if (!paused) return;
    paused = false;
    var pending = [];
    timers.forEach(function (rec) { pending.push(rec); });
    pending.forEach(function (rec) { if (rec.realId == null) scheduleReal(rec); });
    updateButtons();
  }

  function nextStep() {
    if (!paused) pauseAnimations();
    var earliest = null;
    timers.forEach(function (rec) {
      var rem = rec.remaining != null ? rec.remaining : rec.delay;
      if (earliest == null || rem < earliest._rem) { earliest = rec; earliest._rem = rem; }
    });
    if (!earliest) { flash(btnNext); return; }
    if (earliest.type === "timeout") {
      timers.delete(earliest.id);
      fire(earliest);
    } else {
      earliest.remaining = earliest.delay; // keep interval alive, reset its wait
      fire(earliest);
    }
    flash(btnNext);
  }

  /* ------------------------------------------------------------------ *
   * 2. Study music (generative lo-fi via Web Audio API)
   * ------------------------------------------------------------------ */
  var audioCtx = null, master = null, musicOn = false, schedulerId = null;
  var nextNoteTime = 0, beat = 0, chordIndex = 0;
  var volume = 0.32;

  // C major pentatonic-ish, calm.
  var scale = [261.63, 293.66, 329.63, 392.00, 440.00, 523.25, 587.33];
  var chords = [
    [130.81, 164.81, 196.00], // C
    [146.83, 174.61, 220.00], // Dm
    [174.61, 220.00, 261.63], // F
    [196.00, 246.94, 293.66]  // G
  ];

  function initAudio() {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    audioCtx = new AC();
    master = audioCtx.createGain();
    master.gain.value = volume;
    var filter = audioCtx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 5200;
    filter.Q.value = 0.5;
    master.connect(filter);
    filter.connect(audioCtx.destination);
    return true;
  }

  function playNote(freq, time, dur, type, gain) {
    var o = audioCtx.createOscillator();
    var g = audioCtx.createGain();
    o.type = type || "sine";
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(gain, time + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    o.connect(g); g.connect(master);
    o.start(time);
    o.stop(time + dur + 0.05);
  }

  /* ---- Soundscapes (natural + generative) ---- */
  var soundscape = "lofi";
  var scapeNodes = [];  // AudioNodes to stop/disconnect on switch
  var scapeTimers = []; // original-interval ids used by soundscapes

  function makeNoiseBuffer(type) {
    var len = audioCtx.sampleRate * 2, buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
    var d = buf.getChannelData(0), i;
    if (type === "brown") {
      var last = 0;
      for (i = 0; i < len; i++) { var w = Math.random() * 2 - 1; last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
    } else if (type === "pink") {
      var b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (i = 0; i < len; i++) {
        var wn = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + wn * 0.0555179; b1 = 0.99332 * b1 + wn * 0.0750759;
        b2 = 0.96900 * b2 + wn * 0.1538520; b3 = 0.86650 * b3 + wn * 0.3104856;
        b4 = 0.55000 * b4 + wn * 0.5329522; b5 = -0.7616 * b5 - wn * 0.0168980;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + wn * 0.5362) * 0.11; b6 = wn * 0.115926;
      }
    } else {
      for (i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    return buf;
  }

  function noiseSource(type) {
    var s = audioCtx.createBufferSource();
    s.buffer = makeNoiseBuffer(type); s.loop = true; return s;
  }
  function biquad(type, freq, q) {
    var f = audioCtx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; if (q != null) f.Q.value = q; return f;
  }
  function gainNode(v) { var g = audioCtx.createGain(); g.gain.value = v; return g; }

  function stopSoundscape() {
    scapeTimers.forEach(function (id) { _clearInterval(id); });
    scapeTimers = [];
    if (schedulerId) { _clearInterval(schedulerId); schedulerId = null; }
    scapeNodes.forEach(function (n) {
      try { if (n.stop) n.stop(); } catch (e) {}
      try { if (n.disconnect) n.disconnect(); } catch (e) {}
    });
    scapeNodes = [];
  }

  function startLofi() {
    beat = 0; chordIndex = 0;
    nextNoteTime = audioCtx.currentTime + 0.1;
    schedulerId = _setInterval(function () {
      var lookahead = 0.2;
      while (nextNoteTime < audioCtx.currentTime + lookahead) {
        if (beat % 8 === 0) {
          var chord = chords[chordIndex % chords.length]; chordIndex++;
          for (var i = 0; i < chord.length; i++) playNote(chord[i], nextNoteTime, 4.2, "sine", 0.10);
        }
        if (beat % 2 === 0 && Math.random() > 0.35) {
          var n = scale[Math.floor(Math.random() * scale.length)];
          playNote(n, nextNoteTime, 1.4, "triangle", 0.08);
        }
        nextNoteTime += 0.55; beat++;
      }
    }, 40);
  }

  function startChimes() {
    // Sparse, long-decay bell tones — calm and natural.
    schedulerId = _setInterval(function () {
      if (Math.random() < 0.13) {
        var n = scale[Math.floor(Math.random() * scale.length)] * (Math.random() < 0.4 ? 2 : 1);
        playNote(n, audioCtx.currentTime + 0.02, 3.6, "sine", 0.09);
      }
    }, 260);
  }

  function startRain() {
    var src = noiseSource("pink"), hp = biquad("highpass", 700, 0.5), lp = biquad("lowpass", 9000, 0.5), g = gainNode(0.22);
    src.connect(hp); hp.connect(lp); lp.connect(g); g.connect(master); src.start();
    scapeNodes.push(src, hp, lp, g);
    var t = _setInterval(function () {
      if (Math.random() < 0.5) {
        var ds = noiseSource("white"), bp = biquad("bandpass", 1200 + Math.random() * 2500, 8), dg = gainNode(0.0001);
        ds.connect(bp); bp.connect(dg); dg.connect(master);
        var now = audioCtx.currentTime;
        dg.gain.setValueAtTime(0.0001, now);
        dg.gain.exponentialRampToValueAtTime(0.05, now + 0.005);
        dg.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
        ds.start(now); ds.stop(now + 0.16);
      }
    }, 140);
    scapeTimers.push(t);
  }

  function startOcean() {
    var src = noiseSource("brown"), lp = biquad("lowpass", 550, 0.4), g = gainNode(0.22);
    src.connect(lp); lp.connect(g); g.connect(master);
    var lfo = audioCtx.createOscillator(); lfo.frequency.value = 0.08;
    var lfoGain = gainNode(0.14); lfo.connect(lfoGain); lfoGain.connect(g.gain);
    src.start(); lfo.start();
    scapeNodes.push(src, lp, g, lfo, lfoGain);
  }

  function startWind() {
    var src = noiseSource("pink"), bp = biquad("bandpass", 500, 0.7), g = gainNode(0.2);
    src.connect(bp); bp.connect(g); g.connect(master);
    var lfo = audioCtx.createOscillator(); lfo.frequency.value = 0.05;
    var lfoGain = gainNode(350); lfo.connect(lfoGain); lfoGain.connect(bp.frequency);
    src.start(); lfo.start();
    scapeNodes.push(src, bp, g, lfo, lfoGain);
  }

  function startBrown() {
    var src = noiseSource("brown"), lp = biquad("lowpass", 1000, 0.5), g = gainNode(0.26);
    src.connect(lp); lp.connect(g); g.connect(master); src.start();
    scapeNodes.push(src, lp, g);
  }

  function startSoundscape(name) {
    stopSoundscape();
    switch (name) {
      case "rain": startRain(); break;
      case "ocean": startOcean(); break;
      case "wind": startWind(); break;
      case "brown": startBrown(); break;
      case "chimes": startChimes(); break;
      default: startLofi();
    }
  }

  function startMusic() {
    if (!audioCtx && !initAudio()) return;
    if (audioCtx.state === "suspended") audioCtx.resume();
    musicOn = true;
    startSoundscape(soundscape);
    updateMusicButton();
  }

  function stopMusic() {
    musicOn = false;
    stopSoundscape();
    if (audioCtx) audioCtx.suspend();
    updateMusicButton();
  }

  function toggleMusic() { musicOn ? stopMusic() : startMusic(); }

  function setSoundscape(name) {
    soundscape = name; save();
    if (musicOn) { if (audioCtx.state === "suspended") audioCtx.resume(); startSoundscape(name); }
  }

  /* ------------------------------------------------------------------ *
   * 2b. Theme configuration + persistence
   * ------------------------------------------------------------------ */
  var STORE_KEY = "sc-config-v1";
  var config = { bg: "#151a22", surface: "#1f2632", text: "#dfe5ee", accent: "#83b9c0", soundscape: "lofi", volume: 0.32 };
  var PRESETS = {
    slate:  { bg: "#151a22", surface: "#1f2632", text: "#dfe5ee", accent: "#83b9c0" },
    sepia:  { bg: "#211c17", surface: "#2b241d", text: "#efe6d6", accent: "#d3a87a" },
    forest: { bg: "#121a16", surface: "#1a2620", text: "#dfeee4", accent: "#8fca9f" },
    nord:   { bg: "#1b202a", surface: "#242b38", text: "#e5ecf5", accent: "#88c0d0" },
    rose:   { bg: "#1e1820", surface: "#29222c", text: "#f0e4ec", accent: "#d3a0b4" },
    light:  { bg: "#eef1f5", surface: "#ffffff", text: "#232a33", accent: "#3f7d86" }
  };

  function clampHex(h) { return /^#([0-9a-f]{6})$/i.test(h) ? h : null; }

  function shade(hex, pct) {
    var n = parseInt(hex.slice(1), 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    var t = pct < 0 ? 0 : 255, p = Math.abs(pct) / 100;
    r = Math.round((t - r) * p) + r; g = Math.round((t - g) * p) + g; b = Math.round((t - b) * p) + b;
    return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  }

  function isLight(hex) {
    var n = parseInt(hex.slice(1), 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) > 140;
  }

  function applyTheme(cfg) {
    var root = document.documentElement.style, light = isLight(cfg.bg);
    function set(name, val) { root.setProperty(name, val, "important"); }
    set("--bg", cfg.bg);
    set("--bg2", shade(cfg.bg, light ? -4 : 6));
    set("--card", cfg.surface); set("--panel", cfg.surface);
    set("--card2", shade(cfg.surface, light ? -5 : 8)); set("--panel2", shade(cfg.surface, light ? -5 : 8));
    set("--raise", shade(cfg.surface, light ? -8 : 14));
    set("--ink", cfg.text); set("--txt", cfg.text); set("--text", cfg.text);
    set("--muted", shade(cfg.text, light ? 40 : -28));
    set("--dim", shade(cfg.text, light ? 58 : -45));
    set("--faint", shade(cfg.text, light ? 62 : -50));
    set("--line", shade(cfg.surface, light ? -12 : 16));
    set("--line2", shade(cfg.surface, light ? -20 : 26));
    set("--border", shade(cfg.surface, light ? -12 : 16));
    set("--accent", cfg.accent); set("--lo", cfg.accent);
    set("--accent2", shade(cfg.accent, 14)); set("--hi", shade(cfg.accent, 14));
    set("--pivot", shade(cfg.accent, 22));
    root.setProperty("color-scheme", light ? "light" : "dark");
    // Ease the global desaturation for light themes so text stays crisp.
    root.setProperty("filter", light ? "saturate(.95)" : "saturate(.82) brightness(1.02)", "important");
  }

  function currentCfg() { return { bg: config.bg, surface: config.surface, text: config.text, accent: config.accent }; }

  function load() {
    try { var s = JSON.parse(localStorage.getItem(STORE_KEY)); if (s) for (var k in s) config[k] = s[k]; } catch (e) {}
    soundscape = config.soundscape || "lofi";
    volume = (config.volume != null) ? config.volume : 0.32;
  }
  function save() {
    config.soundscape = soundscape; config.volume = volume;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(config)); } catch (e) {}
  }

  function setThemeColor(key, val) {
    val = clampHex(val); if (!val) return;
    config[key] = val; save(); applyTheme(currentCfg());
  }
  function applyPreset(name) {
    var p = PRESETS[name]; if (!p) return;
    config.bg = p.bg; config.surface = p.surface; config.text = p.text; config.accent = p.accent;
    save(); applyTheme(currentCfg()); syncThemeInputs();
  }

  /* ------------------------------------------------------------------ *
   * 3. UI dock
   * ------------------------------------------------------------------ */
  var btnMusic, btnPause, btnNext, dock;

  function flash(el) {
    if (!el) return;
    el.classList.add("sc-flash");
    _setTimeout(function () { el.classList.remove("sc-flash"); }, 220);
  }

  function updateButtons() {
    if (!btnPause) return;
    btnPause.innerHTML = paused ? "▶ Resume" : "⏸ Pause";
    btnPause.setAttribute("aria-pressed", paused ? "true" : "false");
  }

  function updateMusicButton() {
    if (!btnMusic) return;
    btnMusic.innerHTML = musicOn ? "🎵 Music: On" : "🎧 Study music";
    btnMusic.classList.toggle("sc-active", musicOn);
  }

  function buildStyles() {
    var css = ""
      + ":root{color-scheme:dark;}"
      // Global readability nudge: smoother, higher-contrast text.
      + "html{-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;}"
      + "body{letter-spacing:.1px;}"
      + ".sc-dock{position:fixed;right:16px;bottom:16px;z-index:99999;display:flex;flex-direction:column;gap:8px;"
      + "font-family:'Segoe UI',system-ui,-apple-system,sans-serif;max-width:236px;}"
      + ".sc-panel{background:#141d33;border:1px solid #33436e;border-radius:14px;padding:10px;"
      + "box-shadow:0 10px 30px rgba(0,0,0,.5);color:#eaf0ff;max-height:82vh;overflow-y:auto;}"
      + ".sc-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}"
      + ".sc-btn{cursor:pointer;border:1px solid #3a4d80;background:#1d2a4d;color:#eaf0ff;font-weight:700;"
      + "font-size:13px;padding:8px 12px;border-radius:10px;transition:.18s;flex:1;white-space:nowrap;}"
      + ".sc-btn:hover{background:#26386a;border-color:#5aa9ff;transform:translateY(-1px);}"
      + ".sc-btn.sc-active{background:#123b30;border-color:#2fd39a;color:#8affd8;}"
      + ".sc-btn.sc-flash{background:#2fd39a;color:#08251c;border-color:#2fd39a;}"
      + ".sc-title{font-size:11px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:#9fb4e6;"
      + "margin:0 2px 2px;display:flex;align-items:center;gap:6px;justify-content:space-between;}"
      + ".sc-vol{width:100%;accent-color:#5aa9ff;cursor:pointer;}"
      + ".sc-sel{width:100%;background:#1d2a4d;color:#eaf0ff;border:1px solid #3a4d80;border-radius:10px;"
      + "padding:7px 8px;font-size:13px;font-weight:600;cursor:pointer;}"
      + ".sc-presets{gap:6px;}"
      + ".sc-chip{flex:1 1 30%;min-width:52px;font-size:11.5px;padding:6px 4px;border:1px solid #3a4d80;"
      + "background:#1d2a4d;color:#eaf0ff;border-radius:8px;cursor:pointer;font-weight:600;transition:.15s;}"
      + ".sc-chip:hover{border-color:#5aa9ff;transform:translateY(-1px);}"
      + ".sc-swatches{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:6px;}"
      + ".sc-sw{display:flex;align-items:center;justify-content:space-between;gap:6px;font-size:11.5px;"
      + "color:#c3cee6;background:#18223c;border:1px solid #33436e;border-radius:8px;padding:4px 7px;}"
      + ".sc-sw input[type=color]{width:28px;height:22px;border:none;background:none;padding:0;cursor:pointer;}"
      + ".sc-mini{background:none;border:none;color:#9fb4e6;cursor:pointer;font-size:14px;line-height:1;padding:2px;}"
      + ".sc-mini:hover{color:#eaf0ff;}"
      + ".sc-collapsed .sc-panel{display:none;}"
      + ".sc-fab{align-self:flex-end;width:48px;height:48px;border-radius:50%;border:1px solid #3a4d80;"
      + "background:#1d2a4d;color:#eaf0ff;font-size:20px;cursor:pointer;box-shadow:0 10px 30px rgba(0,0,0,.5);display:none;}"
      + ".sc-collapsed .sc-fab{display:block;}"
      + "@media(max-width:520px){.sc-dock{right:10px;bottom:10px;max-width:200px;}}";
    var s = document.createElement("style");
    s.id = "sc-styles";
    s.textContent = css;
    document.head.appendChild(s);
  }

  function buildDock() {
    dock = document.createElement("div");
    dock.className = "sc-dock";
    dock.innerHTML =
      '<button class="sc-fab" title="Show controls">🎛️</button>' +
      '<div class="sc-panel">' +
        '<div class="sc-title"><span>▶ Animation</span>' +
          '<button class="sc-mini" data-act="collapse" title="Hide">✕</button></div>' +
        '<div class="sc-row">' +
          '<button class="sc-btn" data-act="pause">⏸ Pause</button>' +
          '<button class="sc-btn" data-act="next" title="Advance one step">⏭ Next</button>' +
        '</div>' +
        '<div class="sc-title" style="margin-top:8px"><span>🎧 Study music</span></div>' +
        '<div class="sc-row">' +
          '<button class="sc-btn" data-act="music">🎧 Study music</button>' +
        '</div>' +
        '<div class="sc-row">' +
          '<select class="sc-sel" data-act="scape" title="Soundscape">' +
            '<option value="lofi">🎹 Lo-fi keys</option>' +
            '<option value="rain">🌧️ Rain</option>' +
            '<option value="ocean">🌊 Ocean waves</option>' +
            '<option value="wind">🍃 Wind</option>' +
            '<option value="chimes">🎐 Zen chimes</option>' +
            '<option value="brown">🟤 Brown noise</option>' +
          '</select>' +
        '</div>' +
        '<div class="sc-row">' +
          '<input class="sc-vol" type="range" min="0" max="100" value="' + Math.round(volume * 100) + '" title="Volume">' +
        '</div>' +
        '<div class="sc-title" style="margin-top:8px"><span>🎨 Theme</span></div>' +
        '<div class="sc-row sc-presets">' +
          '<button class="sc-chip" data-preset="slate">Slate</button>' +
          '<button class="sc-chip" data-preset="sepia">Sepia</button>' +
          '<button class="sc-chip" data-preset="forest">Forest</button>' +
          '<button class="sc-chip" data-preset="nord">Nord</button>' +
          '<button class="sc-chip" data-preset="rose">Rose</button>' +
          '<button class="sc-chip" data-preset="light">Light</button>' +
        '</div>' +
        '<div class="sc-swatches">' +
          '<label class="sc-sw"><span>Backdrop</span><input type="color" data-color="bg"></label>' +
          '<label class="sc-sw"><span>Surface</span><input type="color" data-color="surface"></label>' +
          '<label class="sc-sw"><span>Text</span><input type="color" data-color="text"></label>' +
          '<label class="sc-sw"><span>Accent</span><input type="color" data-color="accent"></label>' +
        '</div>' +
        '<div class="sc-row" style="margin-top:6px">' +
          '<button class="sc-btn" data-act="reset-theme" style="font-size:12px">↺ Reset theme</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(dock);

    btnPause = dock.querySelector('[data-act="pause"]');
    btnNext = dock.querySelector('[data-act="next"]');
    btnMusic = dock.querySelector('[data-act="music"]');
    var vol = dock.querySelector(".sc-vol");
    var fab = dock.querySelector(".sc-fab");

    btnPause.addEventListener("click", function () { paused ? resumeAnimations() : pauseAnimations(); });
    btnNext.addEventListener("click", nextStep);
    btnMusic.addEventListener("click", toggleMusic);
    vol.addEventListener("input", function () {
      volume = (+vol.value) / 100; save();
      if (master) master.gain.setTargetAtTime(volume, audioCtx.currentTime, 0.05);
    });
    dock.querySelector('[data-act="scape"]').addEventListener("change", function () {
      setSoundscape(this.value);
    });
    dock.querySelectorAll("[data-preset]").forEach(function (b) {
      b.addEventListener("click", function () { applyPreset(b.getAttribute("data-preset")); });
    });
    dock.querySelectorAll("input[data-color]").forEach(function (inp) {
      inp.addEventListener("input", function () { setThemeColor(inp.getAttribute("data-color"), inp.value); });
    });
    dock.querySelector('[data-act="reset-theme"]').addEventListener("click", function () { applyPreset("slate"); });
    dock.querySelector('[data-act="collapse"]').addEventListener("click", function () {
      dock.classList.add("sc-collapsed");
    });
    fab.addEventListener("click", function () { dock.classList.remove("sc-collapsed"); });

    updateButtons();
    updateMusicButton();
    syncThemeInputs();
  }

  function syncThemeInputs() {
    if (!dock) return;
    dock.querySelectorAll("input[data-color]").forEach(function (inp) {
      var v = config[inp.getAttribute("data-color")];
      if (v) inp.value = v;
    });
    var sel = dock.querySelector('[data-act="scape"]');
    if (sel) sel.value = soundscape;
  }

  /* ------------------------------------------------------------------ *
   * 4. Soothing study theme (recolors every page via CSS variables)
   * ------------------------------------------------------------------ */
  function injectTheme() {
    // Calm, low-glare dark palette. Overrides the neon variables used across
    // all pages (plus Blind75 / transmission / gate variants). A gentle
    // desaturation tames any remaining hard-coded neon glows.
    var theme = ""
      + ":root{"
      + "--bg:#151a22 !important;--bg2:#1a2029 !important;--card:#1f2632 !important;"
      + "--card2:#252e3b !important;--panel:#1f2632 !important;--panel2:#252e3b !important;"
      + "--raise:#2b3441 !important;"
      + "--ink:#dfe5ee !important;--txt:#dfe5ee !important;--text:#dfe5ee !important;"
      + "--muted:#a6b1c2 !important;--dim:#768395 !important;--faint:#6f7b8e !important;"
      + "--accent:#83b9c0 !important;--accent2:#c6a0c4 !important;"
      + "--lo:#7f9cd6 !important;--hi:#d3a0b4 !important;--mid:#e3c68d !important;"
      + "--found:#93cca4 !important;--good:#93cca4 !important;--pivot:#b89ad2 !important;"
      + "--warn:#e2ba82 !important;--bad:#df97a2 !important;"
      + "--line:#2d3644 !important;--line2:#394456 !important;--border:#2d3644 !important;"
      + "color-scheme:dark;"
      + "}"
      // Tame leftover hard-coded neon (glows/backgrounds) so it blends softly.
      + "html{filter:saturate(.82) brightness(1.02);}"
      // Soft, non-glary text selection + scrollbars.
      + "::selection{background:rgba(131,185,192,.35);}"
      + "::-webkit-scrollbar{width:12px;height:12px;}"
      + "::-webkit-scrollbar-thumb{background:#2d3644;border-radius:8px;}"
      + "::-webkit-scrollbar-track{background:#151a22;}";
    var s = document.createElement("style");
    s.id = "sc-theme";
    s.textContent = theme;
    document.head.appendChild(s);
  }

  function init() {
    load();
    injectTheme();
    applyTheme(currentCfg()); // inline vars win over the fallback stylesheet
    buildStyles();
    buildDock();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
