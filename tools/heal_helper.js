/*
 * Automa self-healing helper.
 * Wklejany przez tools/add_self_healing.py do bloków JavaScript workflow.
 * Zasady pliku (wymagane przez generator):
 *  - komentarze tylko w osobnych liniach (// albo blok w gwiazdkach),
 *  - nigdzie dwóch klamr otwierających obok siebie (Automa traktuje je jak szablon).
 *
 * Kolejność szukania elementu:
 *  S1 oryginalny selektor
 *  S2 wariant selektora bez hashy w klasach / wygenerowanych id
 *  S3 zapamiętane stabilne atrybuty (data-testid, name, aria-label...)
 *  S4 podobne ułożenie na stronie (pozycja, rozmiar, ścieżka DOM, klasy)
 *  S5 podobny tekst w środku
 * Odcisk elementu zapisywany w localStorage strony po każdym trafieniu S1-S3.
 */
var AH = (function () {
  var ATTR = 'data-automa-heal';
  var RETRY = 'data-automa-upload-retry';
  var LS = 'automaHeal:';
  var KEYS = ['data-testid', 'id', 'name', 'aria-label', 'placeholder', 'title', 'alt', 'type', 'role', 'accept', 'href'];
  var STABLE = ['data-testid', 'name', 'aria-label', 'placeholder', 'title', 'alt', 'id'];

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }
  function norm(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
  }
  function tick() {
    try { if (typeof automaResetTimeout === 'function') automaResetTimeout(); } catch (e) {}
  }
  function uniq(a) {
    return a.filter(function (x, i) { return a.indexOf(x) === i; });
  }
  function hashy(s) {
    if (s.length < 5 || s.length > 10) return false;
    return (/\d/.test(s) && /[a-z]/i.test(s)) || (/[a-z]/.test(s) && /[A-Z]/.test(s));
  }
  function stem(c) {
    var m = /^(.+?[-_])([A-Za-z0-9]{5,10})$/.exec(c);
    return m && hashy(m[2]) ? m[1] : c;
  }
  function genId(v) {
    return /^(radix-|headlessui-|mui-|react-|:r)|_r_|\d{4,}/.test(v || '');
  }
  function esc(v) {
    return String(v).replace(/["\\]/g, '\\$&');
  }
  function vis(el) {
    try {
      var r = el.getBoundingClientRect();
      if (!r.width && !r.height) return false;
      var s = getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none';
    } catch (e) { return false; }
  }
  function textOf(el) {
    var t = el.tagName;
    if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') return '';
    return norm(String(el.textContent || '').slice(0, 600)).slice(0, 200);
  }
  function nearOf(el) {
    try {
      if (el.labels && el.labels[0]) return norm(el.labels[0].textContent).slice(0, 80);
      var lb = el.getAttribute('aria-labelledby');
      var le = lb && document.getElementById(lb.split(' ')[0]);
      if (le) return norm(le.textContent).slice(0, 80);
      var p = el.previousElementSibling;
      if (p) return norm(String(p.textContent || '').slice(0, 300)).slice(0, 80);
      var par = el.parentElement;
      if (par) {
        var own = '';
        par.childNodes.forEach(function (n) { if (n.nodeType === 3) own += n.textContent; });
        return norm(own).slice(0, 80);
      }
    } catch (e) {}
    return '';
  }
  function pathOf(el) {
    var out = [];
    for (var n = el, i = 0; n && n.nodeType === 1 && i < 6; n = n.parentElement, i++) {
      var k = 1;
      var s = n;
      while ((s = s.previousElementSibling)) if (s.tagName === n.tagName) k++;
      out.push(n.tagName.toLowerCase() + k);
    }
    return out;
  }
  function fp(el) {
    var r = el.getBoundingClientRect();
    var W = window.innerWidth || 1;
    var H = window.innerHeight || 1;
    var a = {};
    KEYS.forEach(function (k) {
      var v = el.getAttribute(k);
      if (v != null && v !== '') a[k] = (k === 'href' ? v.split('?')[0] : v).slice(0, 200);
    });
    return {
      tag: el.tagName.toLowerCase(),
      a: a,
      c: uniq(Array.prototype.map.call(el.classList, stem)),
      t: textOf(el),
      n: nearOf(el),
      p: pathOf(el),
      x: (r.left + r.width / 2) / W,
      y: (r.top + r.height / 2) / H,
      w: r.width / W,
      h: r.height / H,
      v: vis(el),
      at: Date.now()
    };
  }
  function grams(s) {
    var g = Object.create(null);
    var n = 0;
    s = ' ' + s + ' ';
    for (var i = 0; i < s.length - 1; i++) {
      var k = s.substr(i, 2);
      g[k] = (g[k] || 0) + 1;
      n++;
    }
    return [g, n];
  }
  function dice(a, b) {
    if (!a && !b) return 1;
    if (!a || !b) return 0;
    if (a === b) return 1;
    var A = grams(a);
    var B = grams(b);
    var m = 0;
    for (var k in A[0]) if (B[0][k]) m += Math.min(A[0][k], B[0][k]);
    return (2 * m) / (A[1] + B[1]);
  }
  function jac(a, b) {
    if (!a.length && !b.length) return null;
    var s = 0;
    a.forEach(function (x) { if (b.indexOf(x) >= 0) s++; });
    return s / (a.length + b.length - s);
  }
  function attrSim(fa, ea) {
    var ks = Object.keys(fa).filter(function (k) { return k !== 'id' || !genId(fa[k]); });
    if (!ks.length) return null;
    var s = 0;
    ks.forEach(function (k) {
      if (ea[k] === fa[k]) s += 1;
      else if (ea[k] != null) s += 0.5 * dice(norm(ea[k]), norm(fa[k]));
    });
    return s / ks.length;
  }
  function pathSim(a, b) {
    var n = Math.max(a.length, b.length);
    var s = 0;
    for (var i = 0; i < n; i++) {
      if (a[i] === b[i]) s += 1;
      else if (a[i] && b[i] && a[i].replace(/\d+$/, '') === b[i].replace(/\d+$/, '')) s += 0.5;
    }
    return n ? s / n : null;
  }
  function posSim(f, g) {
    if (!f.v && !g.v) return null;
    var d = Math.sqrt(Math.pow(f.x - g.x, 2) + Math.pow(f.y - g.y, 2));
    var sz = Math.abs(f.w - g.w) + Math.abs(f.h - g.h);
    return Math.max(0, 1 - d / 0.35 - sz);
  }
  function wavg(parts) {
    var s = 0;
    var w = 0;
    parts.forEach(function (p) {
      if (p[0] != null) { s += p[0] * p[1]; w += p[1]; }
    });
    return w ? s / w : 0;
  }
  function layoutScore(f, g) {
    return wavg([
      [attrSim(f.a, g.a), 0.25],
      [jac(f.c, g.c), 0.15],
      [posSim(f, g), 0.3],
      [pathSim(f.p, g.p), 0.3],
      [f.n ? dice(f.n, g.n) : null, 0.1]
    ]);
  }
  function q(sel, xp) {
    try {
      if (xp) {
        var r = document.evaluate(sel, document, null, 7, null);
        var o = [];
        for (var i = 0; i < r.snapshotLength; i++) o.push(r.snapshotItem(i));
        return o;
      }
      return Array.prototype.slice.call(document.querySelectorAll(sel));
    } catch (e) { return []; }
  }
  function usable(cfg) {
    return function (el) {
      return !(cfg.markEl && el.hasAttribute('block--' + cfg.id));
    };
  }
  function load(k) {
    try { return JSON.parse(localStorage.getItem(LS + k) || 'null'); } catch (e) { return null; }
  }
  function save(k, v) {
    try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch (e) {}
  }
  function getVar(name) {
    try { if (typeof automaRefData === 'function') return automaRefData('variables', name); } catch (e) {}
    return (window.__automaHealVars || {})[name];
  }
  function setVar(name, value) {
    try { if (typeof automaSetVariable === 'function') automaSetVariable(name, value); } catch (e) {}
    window.__automaHealVars = window.__automaHealVars || {};
    window.__automaHealVars[name] = value;
  }
  function log(cfg, stage, info) {
    var msg = '[automa-heal] ' + (cfg.label || '') + ' ' + cfg.id + ' -> ' + stage + (info ? ' (' + info + ')' : '');
    if (stage === 'S1') { console.debug(msg); return; }
    console.warn(msg);
    var L = load('_log') || [];
    L.push([new Date().toISOString(), cfg.wf, cfg.id, stage, info || '']);
    save('_log', L.slice(-300));
    var prev = getVar('heal_log');
    setVar('heal_log', String(prev || '').split('\n').concat([msg]).filter(Boolean).slice(-50).join('\n'));
  }
  function unmark(id) {
    q('[' + ATTR + ']').forEach(function (el) {
      var v = (el.getAttribute(ATTR) || '').split(' ').filter(function (x) { return x && x !== id; });
      if (v.length) el.setAttribute(ATTR, v.join(' '));
      else el.removeAttribute(ATTR);
    });
  }
  function mark(els, id) {
    els.forEach(function (el) {
      var v = (el.getAttribute(ATTR) || '').split(' ').filter(Boolean);
      if (v.indexOf(id) < 0) v.push(id);
      el.setAttribute(ATTR, v.join(' '));
    });
  }
  function candidates(f, cfg) {
    var u = usable(cfg);
    return Array.prototype.filter.call(document.getElementsByTagName(f.tag), function (el) {
      if (!u(el) || el.closest('[data-automa-heal-ui]')) return false;
      if (f.v) {
        if (!vis(el)) return false;
        var r = el.getBoundingClientRect();
        var W = window.innerWidth || 1;
        var H = window.innerHeight || 1;
        var fw = f.w * W;
        var fh = f.h * H;
        if (fw > 0 && (r.width > fw * 4 + 20 || r.width * 4 + 20 < fw)) return false;
        if (fh > 0 && (r.height > fh * 4 + 20 || r.height * 4 + 20 < fh)) return false;
      }
      return true;
    }).slice(0, 3000);
  }
  function pick(scored, thr) {
    scored.sort(function (a, b) { return b[1] - a[1]; });
    if (!scored.length || scored[0][1] < thr) return null;
    if (scored[1] && scored[0][1] - scored[1][1] < 0.03) return null;
    return scored[0];
  }
  function quick(cfg, f) {
    var u = usable(cfg);
    var els = q(cfg.sel, cfg.xp).filter(u);
    if (els.length) return { st: 'S1', els: els };
    var vs = cfg.variants || [];
    for (var i = 0; i < vs.length; i++) {
      els = q(vs[i], false).filter(u);
      if (els.length) return { st: 'S2', els: cfg.multiple ? els : [els[0]], info: vs[i] };
    }
    if (f) {
      for (var j = 0; j < STABLE.length; j++) {
        var k = STABLE[j];
        var v = f.a[k];
        if (!v || (k === 'id' && genId(v))) continue;
        els = q(f.tag + '[' + k + '="' + esc(v) + '"]').filter(u);
        if (els.length === 1) return { st: 'S3', els: els, info: k + '=' + v };
      }
    }
    return null;
  }
  function fuzzy(cfg, f) {
    if (!f) return null;
    var cs = candidates(f, cfg);
    var gs = cs.map(fp);
    var lthr = cfg.strict ? 0.85 : 0.75;
    var b = pick(cs.map(function (el, i) { return [el, layoutScore(f, gs[i])]; }), lthr);
    if (b) return { st: 'S4', els: [b[0]], info: 'uklad ' + b[1].toFixed(2) };
    if (f.t && f.t.length >= 2) {
      var tthr = cfg.strict ? 0.9 : 0.8;
      b = pick(cs.map(function (el, i) {
        var ts = dice(f.t, gs[i].t);
        var ps = posSim(f, gs[i]);
        return [el, ts >= tthr ? ts * 0.85 + (ps == null ? 0.5 : ps) * 0.15 : 0];
      }), tthr * 0.85);
      if (b) return { st: 'S5', els: [b[0]], info: 'tekst ' + b[1].toFixed(2) };
    }
    return null;
  }

  /* Główna naprawa dla bloku z selektorem. Zwraca wynik albo null. */
  async function heal(cfg) {
    var key = cfg.wf + ':' + cfg.id;
    var f = load(key);
    var r = null;
    var end = Date.now() + (cfg.wait || 0);
    unmark(cfg.id);
    while (true) {
      r = quick(cfg, f);
      if (r || Date.now() >= end) break;
      tick();
      await sleep(cfg.poll || 200);
    }
    if (!r && f) {
      for (var i = 0; i < (cfg.tail == null ? 3 : cfg.tail) && !r; i++) {
        tick();
        r = quick(cfg, f) || fuzzy(cfg, f);
        if (!r) await sleep(500);
      }
    }
    if (r) {
      if (r.st !== 'S1') mark(r.els, cfg.id);
      if (r.st === 'S1' || r.st === 'S2' || r.st === 'S3') save(key, fp(r.els[0]));
      log(cfg, r.st, r.info);
    } else {
      log(cfg, 'BRAK', f ? 'nic podobnego' : 'brak zapamietanego odcisku');
    }
    return r;
  }

  /* Dla własnych bloków JS: zapamiętanie i odszukanie zestawu elementów. */
  function learnAll(key, els) {
    if (els && els.length) save(key, els.slice(0, 12).map(fp));
  }
  function healAll(key, cfg) {
    var fs = load(key);
    if (!fs || !fs.length) return [];
    var out = [];
    fs.forEach(function (f) {
      var c = { id: key, sel: '', variants: [], strict: cfg && cfg.strict };
      var r = quick(Object.assign({}, c, { sel: ':not(*)' }), f) || fuzzy(c, f);
      if (r) r.els.forEach(function (el) { if (out.indexOf(el) < 0) out.push(el); });
    });
    if (out.length) log({ id: key, wf: '', label: 'js' }, 'ZESTAW', out.length + ' el.');
    return out;
  }

  /* Kontrola wgrania pliku. */
  function countText(n) {
    if (!n) return 0;
    n = n.toLowerCase();
    var b = String((document.body && document.body.innerText) || '').toLowerCase();
    var c = 0;
    var i = 0;
    while ((i = b.indexOf(n, i)) >= 0) { c++; i += n.length; }
    c += q('[title*="' + esc(n) + '" i],[alt*="' + esc(n) + '" i],[aria-label*="' + esc(n) + '" i]').length;
    return c;
  }
  function blobSrcs() {
    var s = [];
    q('img,video,source').forEach(function (el) {
      var u = el.currentSrc || el.src || '';
      if (/^(blob|data):/.test(u)) s.push(u.slice(0, 120));
    });
    q('[style*="blob:"]').forEach(function (el) { s.push(String(el.getAttribute('style')).slice(0, 120)); });
    return s;
  }
  function inputHas(files) {
    return q('input[type=file]').some(function (inp) {
      return Array.prototype.some.call(inp.files || [], function (fl) {
        return !files.length || files.indexOf(String(fl.name).toLowerCase()) >= 0;
      });
    });
  }
  function upSnap(files) {
    return {
      img: q('img,canvas,video').length,
      blob: blobSrcs(),
      txt: files.map(countText)
    };
  }
  function upBase(id, files) {
    window.__automaUpBase = window.__automaUpBase || {};
    window.__automaUpBase[id] = upSnap(files || []);
    q('[' + RETRY + '="' + id + '"]').forEach(function (el) { el.remove(); });
  }
  async function upCheck(cfg) {
    var files = (cfg.files || []).map(function (s) { return String(s).toLowerCase(); });
    var base = (window.__automaUpBase || {})[cfg.id];
    var end = Date.now() + (cfg.wait || 15000);
    var why = '';
    q('[' + RETRY + '="' + cfg.id + '"]').forEach(function (el) { el.remove(); });
    while (true) {
      var s = upSnap(files);
      if (base) {
        if (s.blob.some(function (u) { return base.blob.indexOf(u) < 0; })) why = 'nowa miniatura';
        else if (s.img > base.img) why = 'nowy obrazek';
        else if (s.txt.some(function (c, i) { return c > base.txt[i]; })) why = 'nazwa pliku na stronie';
      } else if (s.txt.some(function (c) { return c > 0; }) || s.blob.length) {
        why = 'plik widoczny na stronie';
      }
      if (why || Date.now() >= end) break;
      tick();
      await sleep(500);
    }
    if (!why && inputHas(files)) why = 'plik tylko w polu input';
    var vname = 'upl_try_' + cfg.id;
    var tries = Number(getVar(vname) || 0);
    var c = { id: cfg.id, wf: cfg.wf, label: 'upload-check' };
    if (why) {
      setVar(vname, 0);
      log(c, why === 'plik tylko w polu input' ? 'UPLOAD_OK?' : 'UPLOAD_OK', why);
      return { ok: true, why: why };
    }
    if (tries < (cfg.max == null ? 3 : cfg.max)) {
      setVar(vname, tries + 1);
      var m = document.createElement('meta');
      m.setAttribute(RETRY, cfg.id);
      (document.head || document.documentElement).appendChild(m);
      log(c, 'UPLOAD_PONOW', 'proba ' + (tries + 1));
      return { ok: false, retry: tries + 1 };
    }
    setVar(vname, 0);
    log(c, 'UPLOAD_PODDAJE', 'po ' + tries + ' ponowieniach');
    return { ok: false, retry: 0 };
  }

  /* Uruchomienie z bezpiecznikiem: zawsze kończy blok przez automaNextBlock. */
  function run(limitMs, fn) {
    var done = false;
    function fin(d) {
      if (done) return;
      done = true;
      try { if (typeof automaNextBlock === 'function') automaNextBlock(d || {}, false); } catch (e) {}
    }
    setTimeout(function () { fin({ heal: 'watchdog' }); }, limitMs);
    Promise.resolve().then(fn).then(function (d) { fin(d); }, function (e) {
      console.warn('[automa-heal] blad', e);
      fin({ heal: 'error', message: String((e && e.message) || e) });
    });
  }

  return {
    heal: heal, healAll: healAll, learnAll: learnAll, fp: fp, load: load, save: save,
    upBase: upBase, upCheck: upCheck, run: run, stem: stem, q: q, log: log
  };
})();
