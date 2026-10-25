/* IronDivi Wallet download page.
 * No innerHTML anywhere: every dynamic value goes in through textContent,
 * createElement or a validated attribute, so the page runs under a strict CSP. */
(function () {
  'use strict';

  var BROWSERS = ['chrome', 'brave', 'edge', 'opera', 'firefox', 'safari'];
  var NAMES = {
    chrome: 'Chrome', brave: 'Brave', edge: 'Edge',
    opera: 'Opera', firefox: 'Firefox', safari: 'Safari'
  };
  // Brave installs the Chrome build.
  var FILE_KEY = {
    chrome: 'chrome', brave: 'chrome', edge: 'edge',
    opera: 'opera', firefox: 'firefox', safari: 'safari'
  };
  var DOWNLOADS = '/downloads/';
  var RELEASES_URL = '/downloads/releases.json';

  var SAFE_FILE = /^[A-Za-z0-9._-]{1,128}$/;
  var SAFE_HASH = /^[0-9a-fA-F]{64}$/;
  var SAFE_VERSION = /^[0-9A-Za-z.+-]{1,32}$/;
  var SAFE_DATE = /^\d{4}-\d{2}-\d{2}$/;

  var state = {
    detected: null,   // browser key or null
    mobile: false,
    selected: 'chrome',
    release: null     // validated release, or null
  };

  function $(id) { return document.getElementById(id); }

  /* ---------- Detection ---------- */

  function isMobile() {
    var ua = navigator.userAgent || '';
    try {
      if (navigator.userAgentData && navigator.userAgentData.mobile) return true;
    } catch (e) { /* ignore */ }
    if (/Android|iPhone|iPad|iPod|Mobile|Silk|Kindle|Opera Mini|IEMobile/i.test(ua)) return true;
    // iPadOS reports itself as a Mac; a Mac has no touch points.
    if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return true;
    return false;
  }

  function detectFromUA() {
    var ua = navigator.userAgent || '';
    if (/Edg\//.test(ua)) return 'edge';
    if (/OPR\//.test(ua)) return 'opera';
    if (/Firefox\//.test(ua)) return 'firefox';
    if (/Safari\//.test(ua) && !/Chrome\/|Chromium\/|CriOS\/|Edg\/|OPR\//.test(ua)) return 'safari';
    if (/Chrome\/|Chromium\//.test(ua)) return 'chrome';
    return null;
  }

  function majorVersion(re) {
    var m = (navigator.userAgent || '').match(re);
    return m ? parseInt(m[1], 10) : null;
  }

  function checkBrave() {
    try {
      if (navigator.brave && typeof navigator.brave.isBrave === 'function') {
        return Promise.resolve(navigator.brave.isBrave()).then(function (v) { return v === true; }, function () { return false; });
      }
    } catch (e) { /* ignore */ }
    return Promise.resolve(false);
  }

  /* ---------- Tabs ---------- */

  var tabs = [];

  function selectTab(key, focus) {
    if (BROWSERS.indexOf(key) === -1) return;
    state.selected = key;
    tabs.forEach(function (tab) {
      var on = tab.getAttribute('data-browser') === key;
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.tabIndex = on ? 0 : -1;
      var panel = $(tab.getAttribute('aria-controls'));
      if (panel) panel.hidden = !on;
      if (on && focus) tab.focus();
    });
    updateCommands();
    highlightSumRow();
  }

  function initTabs() {
    var list = document.querySelector('[role="tablist"]');
    if (!list) return;
    tabs = Array.prototype.slice.call(list.querySelectorAll('[role="tab"]'));
    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () { selectTab(tab.getAttribute('data-browser'), false); });
    });
    list.addEventListener('keydown', function (ev) {
      var i = tabs.indexOf(document.activeElement);
      if (i === -1) return;
      var next = null;
      switch (ev.key) {
        case 'ArrowRight': case 'ArrowDown': next = (i + 1) % tabs.length; break;
        case 'ArrowLeft': case 'ArrowUp': next = (i - 1 + tabs.length) % tabs.length; break;
        case 'Home': next = 0; break;
        case 'End': next = tabs.length - 1; break;
        default: return;
      }
      ev.preventDefault();
      selectTab(tabs[next].getAttribute('data-browser'), true);
    });
  }

  function markDetected(key) {
    tabs.forEach(function (tab) {
      var old = tab.querySelector('.sr-only');
      if (old) tab.removeChild(old);
      tab.classList.remove('is-detected');
      if (tab.getAttribute('data-browser') === key) {
        tab.classList.add('is-detected');
        var sr = document.createElement('span');
        sr.className = 'sr-only';
        sr.textContent = ' (your browser)';
        tab.appendChild(sr);
      }
    });
  }

  /* ---------- Release data ---------- */

  function validateRelease(data) {
    if (!data || typeof data !== 'object' || !data.files || typeof data.files !== 'object') return null;
    var out = {
      version: (typeof data.version === 'string' && SAFE_VERSION.test(data.version)) ? data.version : null,
      date: (typeof data.date === 'string' && SAFE_DATE.test(data.date)) ? data.date : null,
      files: {}
    };
    ['chrome', 'edge', 'opera', 'firefox', 'safari'].forEach(function (k) {
      var f = data.files[k];
      if (!f || typeof f !== 'object') return;
      if (typeof f.file !== 'string' || !SAFE_FILE.test(f.file)) return;
      out.files[k] = {
        file: f.file,
        sha256: (typeof f.sha256 === 'string' && SAFE_HASH.test(f.sha256)) ? f.sha256.toLowerCase() : null,
        bytes: (typeof f.bytes === 'number' && isFinite(f.bytes) && f.bytes > 0) ? f.bytes : null
      };
    });
    return Object.keys(out.files).length ? out : null;
  }

  function fileFor(key) {
    if (!state.release) return null;
    return state.release.files[FILE_KEY[key]] || null;
  }

  function fileUrl(entry) { return DOWNLOADS + encodeURIComponent(entry.file); }

  function formatBytes(n) {
    if (n == null) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function setText(el, text) { if (el) el.textContent = text; }

  function link(href, text) {
    var a = document.createElement('a');
    a.href = href;
    a.textContent = text;
    return a;
  }

  function code(text) {
    var c = document.createElement('code');
    c.textContent = text;
    return c;
  }

  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

  function fillDownloads() {
    BROWSERS.forEach(function (key) {
      var entry = fileFor(key);
      document.querySelectorAll('[data-download="' + key + '"]').forEach(function (a) {
        if (entry) {
          a.href = fileUrl(entry);
          a.setAttribute('download', entry.file);
          a.textContent = 'Download for ' + NAMES[key];
          a.removeAttribute('aria-disabled');
        } else {
          a.href = DOWNLOADS;
          a.removeAttribute('download');
          a.textContent = 'Not in this release';
          a.setAttribute('aria-disabled', 'true');
        }
      });
      var meta = document.querySelector('[data-file-meta="' + key + '"]');
      if (meta) {
        clear(meta);
        if (entry) {
          meta.appendChild(document.createTextNode(key === 'brave' ? 'Uses the Chrome file: ' : 'File: '));
          meta.appendChild(code(entry.file));
          if (entry.bytes) meta.appendChild(document.createTextNode(' (' + formatBytes(entry.bytes) + ')'));
        } else {
          meta.appendChild(document.createTextNode('Not in this release. Check the '));
          meta.appendChild(link(DOWNLOADS, 'downloads folder'));
          meta.appendChild(document.createTextNode('.'));
        }
      }
    });
  }

  function fillSums() {
    var body = $('sums-body');
    if (!body) return;
    clear(body);
    BROWSERS.forEach(function (key) {
      var entry = fileFor(key);
      var tr = document.createElement('tr');
      tr.setAttribute('data-row', key);

      var th = document.createElement('td');
      th.className = 'sums__browser';
      th.textContent = NAMES[key];
      tr.appendChild(th);

      var tdFile = document.createElement('td');
      tdFile.className = 'sums__file';
      tdFile.setAttribute('data-label', 'File');
      var tdSize = document.createElement('td');
      tdSize.setAttribute('data-label', 'Size');
      var tdHash = document.createElement('td');
      tdHash.className = 'sums__hash';
      tdHash.setAttribute('data-label', 'SHA-256');

      if (entry) {
        tdFile.appendChild(link(fileUrl(entry), entry.file));
        if (key === 'brave') tdFile.appendChild(document.createTextNode(' (Chrome build)'));
        tdSize.textContent = entry.bytes ? formatBytes(entry.bytes) : 'Unknown';
        tdHash.textContent = entry.sha256 || 'Not published';
      } else {
        tdFile.textContent = 'Not in this release';
        tdSize.textContent = '-';
        tdHash.textContent = '-';
      }
      tr.appendChild(tdFile);
      tr.appendChild(tdSize);
      tr.appendChild(tdHash);
      body.appendChild(tr);
    });
    highlightSumRow();
  }

  function highlightSumRow() {
    document.querySelectorAll('#sums-body tr[data-row]').forEach(function (tr) {
      tr.classList.toggle('is-current', tr.getAttribute('data-row') === state.selected);
    });
  }

  function updateCommands() {
    var entry = fileFor(state.selected);
    var name = entry ? entry.file : 'irondivi-wallet-' + FILE_KEY[state.selected] + (state.selected === 'firefox' ? '.xpi' : '.zip');
    setText($('cmd-shasum'), 'shasum -a 256 ' + name);
    setText($('cmd-ps'), 'Get-FileHash ' + name + ' -Algorithm SHA256');
    var sums = state.release && state.release.version ? 'SHA256SUMS-v' + state.release.version : 'SHA256SUMS-v{version}';
    setText($('cmd-sig'), 'ssh-keygen -Y verify -f allowed_signers -I releases@browser.divi.domains -n file -s ' + sums + '.sig < ' + sums);
  }

  function showReleaseStatus() {
    var el = $('release-status');
    if (!el) return;
    clear(el);
    if (!state.release) {
      el.appendChild(document.createTextNode('The release list didn’t load. Get the files from the '));
      el.appendChild(link(DOWNLOADS, 'downloads folder'));
      el.appendChild(document.createTextNode(' instead.'));
      return;
    }
    var strong = document.createElement('strong');
    strong.textContent = state.release.version ? 'Version ' + state.release.version : 'Latest release';
    el.appendChild(strong);
    if (state.release.date) el.appendChild(document.createTextNode(', released ' + state.release.date));
    el.appendChild(document.createTextNode('. Check the file against its checksum under '));
    el.appendChild(link('#verify', 'Check your download'));
    el.appendChild(document.createTextNode('.'));
  }

  function releaseFailed() {
    state.release = null;
    showReleaseStatus();
    var fb = $('downloads-fallback');
    if (fb) fb.hidden = false;
    var body = $('sums-body');
    if (body) {
      clear(body);
      var tr = document.createElement('tr');
      var td = document.createElement('td');
      td.colSpan = 4;
      td.className = 'sums__empty';
      td.textContent = 'Checksums are unavailable right now.';
      tr.appendChild(td);
      body.appendChild(tr);
    }
    updateHero();
  }

  function loadRelease() {
    if (!window.fetch) { releaseFailed(); return; }
    fetch(RELEASES_URL, { cache: 'no-cache', credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        var rel = validateRelease(data);
        if (!rel) throw new Error('bad releases.json');
        state.release = rel;
        showReleaseStatus();
        fillDownloads();
        fillSums();
        updateCommands();
        updateHero();
      })
      .catch(function () { releaseFailed(); });
  }

  /* ---------- Hero ---------- */

  function updateHero() {
    var btn = $('hero-download');
    var label = $('hero-download-label');
    var icon = $('hero-browser-icon');
    var steps = $('hero-steps');
    if (!btn || !label) return;
    // When the main button already goes to the install steps, the second one would repeat it.
    if (steps) steps.hidden = state.mobile || !state.detected;

    if (state.mobile) {
      btn.href = '#install';
      btn.removeAttribute('download');
      label.textContent = 'See install steps';
      if (icon) icon.hidden = true;
      return;
    }
    if (!state.detected) {
      btn.href = '#install';
      btn.removeAttribute('download');
      label.textContent = 'Choose your browser';
      if (icon) icon.hidden = true;
      return;
    }

    var key = state.detected;
    if (icon) {
      icon.src = '/assets/browsers/' + key + '.svg';
      icon.hidden = false;
    }
    label.textContent = 'Download for ' + NAMES[key];
    var entry = fileFor(key);
    if (entry) {
      btn.href = fileUrl(entry);
      btn.setAttribute('download', entry.file);
    } else {
      btn.href = DOWNLOADS;
      btn.removeAttribute('download');
    }
    var meta = $('hero-meta');
    if (meta && entry) {
      clear(meta);
      var parts = [];
      if (state.release.version) parts.push('Version ' + state.release.version);
      if (entry.bytes) parts.push(formatBytes(entry.bytes));
      var lead = parts.length ? parts.join(', ') + '. ' : '';
      meta.appendChild(document.createTextNode(lead + 'Not in the browser stores yet, so follow the '));
      meta.appendChild(link('#install', NAMES[key] + ' install steps'));
      meta.appendChild(document.createTextNode(' after downloading.'));
    }
  }

  function initHero() {
    var btn = $('hero-download');
    if (!btn) return;
    btn.addEventListener('click', function () {
      if (state.detected) selectTab(state.detected, false);
    });
  }

  /* ---------- Notices ---------- */

  function showNotice(id, text) {
    var el = $(id);
    if (!el) return;
    el.textContent = text;
    el.hidden = false;
  }

  function versionNotes(key) {
    if (key === 'firefox') {
      var fx = majorVersion(/Firefox\/(\d+)/);
      if (fx && fx < 128) showNotice('browser-note', 'You’re on Firefox ' + fx + '. IronDivi Wallet needs Firefox 128 or newer, so update Firefox first.');
    } else if (key === 'safari') {
      var sf = majorVersion(/Version\/(\d+)/);
      if (sf && sf < 17) showNotice('browser-note', 'You’re on Safari ' + sf + '. IronDivi Wallet needs Safari 17 or newer, so update macOS or Safari first.');
    }
  }

  /* ---------- Copy buttons ---------- */

  function initCopy() {
    document.querySelectorAll('[data-copy-target]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var target = $(btn.getAttribute('data-copy-target'));
        if (!target) return;
        var text = target.textContent;
        var done = function (ok) {
          btn.textContent = ok ? 'Copied' : 'Selected';
          setTimeout(function () { btn.textContent = 'Copy'; }, 1800);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () { done(true); }, function () { selectText(target); done(false); });
        } else {
          selectText(target);
          done(false);
        }
      });
    });
  }

  function selectText(el) {
    try {
      var range = document.createRange();
      range.selectNodeContents(el);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) { /* ignore */ }
  }

  /* ---------- Start ---------- */

  function applyDetection(key) {
    state.detected = key;
    if (key) {
      markDetected(key);
      selectTab(key, false);
    }
    updateHero();
  }

  function init() {
    initTabs();
    initCopy();
    initHero();

    state.mobile = isMobile();
    if (state.mobile) {
      showNotice('mobile-notice', 'IronDivi Wallet is an extension for desktop browsers, so it can’t be installed on a phone or tablet. Open this page on a computer running Chrome, Brave, Edge, Opera, Firefox or Safari for macOS.');
    }

    var uaKey = detectFromUA();
    applyDetection(state.mobile ? null : uaKey);
    if (!state.mobile) versionNotes(uaKey);
    updateCommands();
    loadRelease();

    if (!state.mobile && uaKey === 'chrome') {
      checkBrave().then(function (isBrave) {
        if (isBrave) applyDetection('brave');
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
