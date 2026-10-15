#!/usr/bin/env python3
"""Dodaje samonaprawiające się selektory do workflow Automa.

Przed każdym blokiem z selektorem (CSS lub XPath) wstawia blok JavaScript
"[heal]", który szuka elementu kolejno: oryginalnym selektorem, wariantem bez
hashy, zapamiętanymi atrybutami, podobnym ułożeniem i podobnym tekstem, po czym
oznacza znaleziony element atrybutem data-automa-heal. Selektor bloku dostaje
alternatywę pasującą do tego oznaczenia, więc przy działającym oryginale
zachowanie się nie zmienia.

Z --upload-check za każdym upload-file dochodzi blok JS sprawdzający, czy plik
naprawdę trafił na stronę, i element-exists, który przy braku cofa do uploadu
(maks. 3 ponowienia).

Użycie:
  python3 tools/add_self_healing.py [--upload-check] --suffix _heal IN.json [IN2.json ...]
"""
import argparse
import copy
import hashlib
import json
import os
import random
import re
import string
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SEL_LABELS = {'event-click', 'forms', 'upload-file', 'press-key', 'save-assets', 'element-exists'}
HEAL_TAG = '[heal]'
UPCHECK_TAG = '[upload-check]'
MARK_ATTR = 'data-automa-heal'


def load_helper():
    with open(os.path.join(HERE, 'heal_helper.js'), encoding='utf-8') as fh:
        src = fh.read()
    out, in_block = [], False
    for line in src.split('\n'):
        s = line.strip()
        if in_block:
            if '*/' in s:
                in_block = False
            continue
        if s.startswith('/*'):
            in_block = '*/' not in s
            continue
        if not s or s.startswith('//'):
            continue
        out.append(s)
    code = '\n'.join(out)
    assert '{{' not in code, 'helper nie może zawierać {{'
    return code


def js_lit(value):
    """JSON jako literał JS bez sekwencji {{ (Automa traktuje ją jak szablon)."""
    return json.dumps(value, ensure_ascii=False).replace('{{', '{\\u007b')


def hashy(s):
    if len(s) < 5 or len(s) > 10:
        return False
    return bool((re.search(r'\d', s) and re.search(r'[a-z]', s, re.I)) or
                (re.search(r'[a-z]', s) and re.search(r'[A-Z]', s)))


CLASS_RE = re.compile(r'\.((?:[A-Za-z_][\w]*[-_])+?)([A-Za-z0-9]{5,10})(?![\w\\-])')
GENID_RE = re.compile(r'#((?:radix-|headlessui-|mui-|react-)[\w\\:-]*)')


def css_variants(sel):
    def cls(m):
        return '[class*="%s"]' % m.group(1) if hashy(m.group(2)) else m.group(0)

    def gid(m):
        prefix = re.match(r'(radix-|headlessui-|mui-|react-)', m.group(1)).group(1)
        return '[id^="%s"]' % prefix

    v = GENID_RE.sub(gid, CLASS_RE.sub(cls, sel.strip()))
    return [v] if v != sel.strip() else []


def is_xpath(data):
    return data.get('findBy') == 'xpath'


def new_selector(data, bid):
    sel = data['selector'].strip()
    if is_xpath(data):
        return "(%s) | //*[contains(concat(' ', normalize-space(@%s), ' '), ' %s ')]" % (sel, MARK_ATTR, bid)
    return ':is(%s, [%s~="%s"])' % (sel, MARK_ATTR, bid)


def basename(p):
    return re.split(r'[\\/]', str(p))[-1]


class Builder:
    def __init__(self, wf, upload_check, helper):
        self.wf = wf
        self.upload_check = upload_check
        self.helper = helper
        self.nodes = wf['drawflow']['nodes']
        self.edges = wf['drawflow']['edges']
        self.ids = {n['id'] for n in self.nodes}
        self.by_id = {n['id']: n for n in self.nodes}
        self.wf_key = wf.get('name', 'workflow')
        self.rng = random.Random(hashlib.md5(self.wf_key.encode()).hexdigest())
        self.js_template = next((n for n in self.nodes if n['label'] == 'javascript-code'), None)
        self.ee_template = next((n for n in self.nodes if n['label'] == 'element-exists'), None)
        self.edge_template = copy.deepcopy(self.edges[0]) if self.edges else None
        self.stats = {'heal': 0, 'upload_check': 0, 'js_patched': 0}

    def new_id(self):
        while True:
            i = ''.join(self.rng.choice(string.ascii_lowercase + string.digits) for _ in range(7))
            if i not in self.ids:
                self.ids.add(i)
                return i

    def add_edge(self, src, src_handle, dst):
        e = copy.deepcopy(self.edge_template)
        sh = '%s-%s' % (src, src_handle)
        th = '%s-input-1' % dst
        sp, dp = self.by_id[src]['position'], self.by_id[dst]['position']
        e.update({'id': 'vueflow__edge-%s%s-%s%s' % (src, sh, dst, th), 'source': src, 'sourceHandle': sh,
                  'target': dst, 'targetHandle': th, 'sourceX': sp['x'] + 200, 'sourceY': sp['y'] + 40,
                  'targetX': dp['x'], 'targetY': dp['y'] + 40, 'data': {}, 'label': ''})
        self.edges.append(e)

    @staticmethod
    def reid(e):
        e['id'] = 'vueflow__edge-%s%s-%s%s' % (e['source'], e['sourceHandle'], e['target'], e['targetHandle'])

    def js_node(self, code, desc, timeout, pos):
        n = {'data': {'code': code, 'context': 'website', 'description': desc, 'disableBlock': False,
                      'everyNewTab': False,
                      'onError': {'dataToInsert': [], 'enable': True, 'errorMessage': '', 'insertData': False,
                                  'retry': False, 'retryInterval': 2, 'retryTimes': 1, 'toDo': 'continue'},
                      'preloadScripts': [], 'runBeforeLoad': False,
                      'settings': {'blockTimeout': 0, 'debugMode': False}, 'timeout': int(timeout)},
             'id': self.new_id(), 'initialized': False, 'label': 'javascript-code',
             'position': {'x': pos[0], 'y': pos[1]}, 'type': 'BlockBasic'}
        self.nodes.append(n)
        self.by_id[n['id']] = n
        return n

    def heal_cfg(self, n):
        d, label = n['data'], n['label']
        cfg = {'id': n['id'], 'wf': self.wf_key, 'label': label, 'sel': d['selector'].strip(),
               'xp': is_xpath(d), 'variants': [] if is_xpath(d) else css_variants(d['selector']),
               'multiple': bool(d.get('multiple')), 'markEl': bool(d.get('markEl')) and not is_xpath(d),
               'strict': label == 'element-exists', 'poll': 200, 'tail': 3}
        if label == 'element-exists':
            tries, gap = int(d.get('tryCount') or 1), int(d.get('timeout') or 500)
            cfg['wait'] = tries * (max(gap, 4) + 1)
            cfg['poll'] = max(gap, 100)
            d['tryCount'] = 1
        elif label == 'press-key':
            cfg['wait'] = 1000
        elif d.get('waitForSelector'):
            cfg['wait'] = int(d.get('waitSelectorTimeout') or 5000)
            d['waitSelectorTimeout'] = 1500
        else:
            cfg['wait'] = 0
        return cfg

    def process(self):
        targets = [n for n in self.nodes
                   if n['label'] in SEL_LABELS and (n['data'].get('selector') or '').strip()
                   and MARK_ATTR not in n['data']['selector']
                   and not n['data'].get('disableBlock')
                   and not str(n['data'].get('description', '')).startswith(UPCHECK_TAG)]
        for n in targets:
            self.heal_block(n)
        self.patch_custom_js()
        return self.stats

    def heal_block(self, n):
        cfg = self.heal_cfg(n)
        is_upload = self.upload_check and n['label'] == 'upload-file'
        files = [basename(p) for p in (n['data'].get('filePaths') or []) if p]
        limit = cfg['wait'] + cfg['tail'] * 700 + 25000
        body = 'var r = await AH.heal(%s);\n' % js_lit(cfg)
        if is_upload:
            body += 'AH.upBase(%s, %s);\n' % (js_lit(n['id']), js_lit([f.lower() for f in files]))
        code = '%s\nAH.run(%d, async function () {\n%sreturn { heal: r ? r.st : "BRAK" };\n});' % (
            self.helper, limit, body)
        x, y = n['position']['x'], n['position']['y']
        h = self.js_node(code, '%s %s' % (HEAL_TAG, n['label']), limit + 5000, (x, y - 110))
        for e in self.edges:
            if e['target'] == n['id']:
                e['target'], e['targetHandle'] = h['id'], '%s-input-1' % h['id']
                self.reid(e)
        self.add_edge(h['id'], 'output-1', n['id'])
        n['data']['selector'] = new_selector(n['data'], n['id'])
        self.stats['heal'] += 1
        if is_upload:
            self.add_upload_check(n, h, files)

    def add_upload_check(self, n, h, files):
        x, y = n['position']['x'], n['position']['y']
        vcfg = {'id': n['id'], 'wf': self.wf_key, 'files': [f.lower() for f in files], 'wait': 15000, 'max': 3}
        code = '%s\nAH.run(%d, function () {\nreturn AH.upCheck(%s);\n});' % (self.helper, 45000, js_lit(vcfg))
        v = self.js_node(code, '%s weryfikacja' % UPCHECK_TAG, 50000, (x, y + 110))
        ee = copy.deepcopy(self.ee_template)
        ee['id'] = self.new_id()
        ee['position'] = {'x': x, 'y': y + 220}
        ee['data'] = {'description': '%s ponow upload?' % UPCHECK_TAG, 'disableBlock': False,
                      'findBy': 'cssSelector', 'markEl': False,
                      'selector': '[data-automa-upload-retry="%s"]' % n['id'],
                      'throwError': False, 'timeout': 100, 'tryCount': 1}
        self.nodes.append(ee)
        self.by_id[ee['id']] = ee
        for e in self.edges:
            if e['source'] == n['id'] and e['sourceHandle'] == '%s-output-1' % n['id']:
                e['source'], e['sourceHandle'] = ee['id'], '%s-output-2' % ee['id']
                self.reid(e)
        self.add_edge(n['id'], 'output-1', v['id'])
        self.add_edge(v['id'], 'output-1', ee['id'])
        self.add_edge(ee['id'], 'output-1', h['id'])
        self.stats['upload_check'] += 1

    def patch_custom_js(self):
        for n in self.nodes:
            if n['label'] != 'javascript-code':
                continue
            code = n['data'].get('code', '')
            if 'var AH = (function' in code:
                continue
            for marker, patch in CUSTOM_PATCHES:
                if marker in code:
                    new = patch(code)
                    n['data']['code'] = self.helper + '\n' + new
                    self.stats['js_patched'] += 1
                    break


def replace_once(code, old, new):
    assert code.count(old) == 1, 'wzorzec nie występuje dokładnie raz: %r' % old[:60]
    return code.replace(old, new)


def patch_calendar(code):
    code = replace_once(code, "    const start = Date.now();\n    let przycisk = znajdzPrzycisk();", r"""    /* naprawa: gdy dokładna etykieta nie pasuje, szukaj daty inaczej */
    const healKalendarz = () => {
      const miesiac = data.toLocaleDateString('en-US', { month: 'long' });
      const rok = data.getFullYear();
      const iso = rok + '-' + String(data.getMonth() + 1).padStart(2, '0') + '-' + String(dzien).padStart(2, '0');
      const wzorce = [
        miesiac + ' ' + dzien + koncowka(dzien) + ', ' + rok,
        miesiac + ' ' + dzien + ', ' + rok,
        dzien + ' ' + miesiac + ' ' + rok,
      ].map((s) => s.toLowerCase());
      const przyciski = AH.q('button, [role="button"], [role="gridcell"]').filter(klikalny);
      let el = przyciski.find((b) => {
        const t = (b.getAttribute('aria-label') || '').toLowerCase();
        return wzorce.some((w) => t.indexOf(w) !== -1);
      });
      if (el) return { el, sposob: 'aria-label w innym formacie' };
      el = AH.q('[data-day="' + iso + '"], [data-date="' + iso + '"], [data-value="' + iso + '"], [datetime="' + iso + '"]')
        .map((x) => x.closest('button, [role="button"], [role="gridcell"]') || x)
        .find(klikalny);
      if (el) return { el, sposob: 'atrybut daty ' + iso };
      const dni = AH.q('[role="grid"] button, [role="grid"] [role="gridcell"], table button, td button, button[name="day"]')
        .filter(klikalny)
        .filter((b) => (b.textContent || '').trim() === String(dzien) && !/outside|disabled|muted/i.test(String(b.className)));
      if (dni.length === 1) return { el: dni[0], sposob: 'tekst dnia ' + dzien };
      return null;
    };

    const start = Date.now();
    let przycisk = znajdzPrzycisk();""")
    code = replace_once(code, "    if (!przycisk) {\n      // diagnostyka", """    if (!przycisk) {
      const naprawa = healKalendarz();
      if (naprawa) {
        przycisk = naprawa.el;
        diagnostyka.naprawa = naprawa.sposob;
        AH.log({ id: 'kalendarz', wf: '', label: 'js' }, 'KALENDARZ', naprawa.sposob);
      }
    }
    if (!przycisk) {
      // diagnostyka""")
    return code


def patch_rotation(code):
    return replace_once(code, "    if (!dostepne.length) {\n      let znalezionoWszystkich = 0;", r"""    /* naprawa: zapamiętaj przyciski, a gdy selektor przestanie działać, szukaj zastępczo */
    const KLUCZ_HEAL = 'js:' + KLUCZ_LICZNIKA + ':' + SELEKTOR;
    if (dostepne.length) {
      AH.learnAll(KLUCZ_HEAL, dostepne);
    } else {
      const m = /\[([\w-]+)="([^"]+)"\]/.exec(SELEKTOR);
      if (m) dostepne = AH.q('[' + m[1] + '="' + m[2] + '" i]').filter(klikalny);
      if (!dostepne.length && m) {
        const czlon = m[2].split(/[-_]/).pop();
        if (czlon.length >= 3) {
          dostepne = AH.q('button[' + m[1] + '*="' + czlon + '" i], [role="button"][' + m[1] + '*="' + czlon + '" i]').filter(klikalny);
        }
      }
      if (!dostepne.length) dostepne = AH.healAll(KLUCZ_HEAL).filter(klikalny);
      if (dostepne.length) AH.log({ id: 'rotacja', wf: '', label: 'js' }, 'ROTACJA', dostepne.length + ' przyciskow');
    }
    if (!dostepne.length) {
      let znalezionoWszystkich = 0;""")


def patch_tree(code):
    code = replace_once(code, "return { wiersze, koncowe: wiersze.filter(koncowy) };",
                        "return { wiersze, koncowe: wiersze.filter(koncowy), kontener: najlepszy };")
    return replace_once(code, "    let lista = TYLKO_KONCOWE ? st.koncowe : st.wiersze;", r"""    /* naprawa: zapamiętaj kontener listy, a gdy selektor przestanie działać, odszukaj go */
    const KLUCZ_HEAL = 'js:drzewko:' + KONTENER;
    if (st.wiersze.length && st.kontener) {
      AH.learnAll(KLUCZ_HEAL, [st.kontener]);
    } else {
      const k = AH.healAll(KLUCZ_HEAL).filter(widoczny)[0];
      if (k) {
        let w = [];
        try {
          w = Array.prototype.slice.call(k.querySelectorAll(WIERSZ + ', [role="option"], [role="treeitem"]')).filter(widoczny);
        } catch (_) {}
        if (!w.length) {
          w = Array.prototype.slice.call(k.querySelectorAll('*'))
            .filter((x) => widoczny(x) && getComputedStyle(x).cursor === 'pointer' && !x.closest('button'));
          w = w.filter((x) => !w.some((y) => y !== x && y.contains(x)));
        }
        if (w.length) {
          st = { wiersze: w, koncowe: w.filter(koncowy), kontener: k };
          AH.log({ id: 'drzewko', wf: '', label: 'js' }, 'DRZEWKO', w.length + ' wierszy');
        }
      }
    }

    let lista = TYLKO_KONCOWE ? st.koncowe : st.wiersze;""")


CUSTOM_PATCHES = [
    ('klika przycisk dnia w kalendarzu', patch_calendar),
    ('ROTACJA PRZYCISKÓW', patch_rotation),
    ("const KONTENER = 'div.overflow-y-auto.p-1, div.p-1'", patch_tree),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--upload-check', action='store_true')
    ap.add_argument('--suffix', required=True)
    ap.add_argument('--outdir', default=None)
    ap.add_argument('files', nargs='+')
    a = ap.parse_args()
    helper = load_helper()
    for path in a.files:
        with open(path, encoding='utf-8') as fh:
            wf = json.load(fh)
        stats = Builder(wf, a.upload_check, helper).process()
        tag = ' [heal+upload]' if a.upload_check else ' [heal]'
        wf['name'] = wf.get('name', '') + tag
        base = os.path.basename(path)
        stem = base[:-len('.automa.json')] if base.endswith('.automa.json') else os.path.splitext(base)[0]
        out = os.path.join(a.outdir or os.path.dirname(path) or '.', stem + a.suffix + '.automa.json')
        with open(out, 'w', encoding='utf-8') as fh:
            json.dump(wf, fh, ensure_ascii=False)
        print(os.path.basename(out), stats)


if __name__ == '__main__':
    sys.exit(main())
