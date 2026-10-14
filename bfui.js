/* ============================================================
   刷题站 · 自建弹窗 bfui.js
   原生 prompt / confirm 在手机浏览器上体验很差（还会被部分
   WebView 屏蔽），分类改名、移动题库这些操作都要输入文字，
   所以这里自己做一套轻量弹窗：
     · bfPrompt({title, label, value, placeholder, ok, test, hint, multiline, choices})
         -> Promise<string | null>      取消返回 null
     · bfConfirm({title, html, ok, danger}) -> Promise<boolean>
   没有依赖，只用 style.css 里的 .mask / .sheet（bfMask / bfSheet）。
   ============================================================ */
(function () {
  'use strict';

  var CSS_HREF = 'style.css';

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  function mk(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  /* 弹窗打开时先把别的弹窗（设置、答题卡…）关掉，免得叠在一起 */
  function closeOthers() {
    var all = document.querySelectorAll('.mask.show');
    for (var i = 0; i < all.length; i++) all[i].classList.remove('show');
  }

  function makeBase(o) {
    closeOthers();
    var mask = mk('div', 'mask bfMask');
    var sheet = mk('div', 'sheet bfSheet');
    if (o.cls) sheet.className += ' ' + o.cls;
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    mask.appendChild(sheet);
    if (o.title) {
      var h = mk('h3', 'bfTitle', o.title);
      sheet.appendChild(h);
    }
    if (o.desc) sheet.appendChild(mk('div', 'hint bfDesc', o.desc));
    document.body.appendChild(mask);
    /* 强制一次 reflow 再显示，动画才会播 */
    void mask.offsetWidth;
    mask.classList.add('show');
    mask.addEventListener('click', function (e) { if (e.target === mask) close(null); });
    return { mask: mask, sheet: sheet };
  }

  var OPEN = [];
  function close(result) {
    var cur = OPEN.pop();
    if (!cur) return;
    try { cur.mask.remove(); } catch (e) {}
    try { document.removeEventListener('keydown', cur.onKey, true); } catch (e) {}
    if (cur.done) { var d = cur.done; cur.done = null; d(result); }
  }
  function dismiss(result) {
    if (!OPEN.length) return;
    var cur = OPEN[OPEN.length - 1];
    if (cur.done) cur.done(result);
    try { cur.mask.remove(); } catch (e) {}
    OPEN.pop();
  }
  function topIs(cur) { return OPEN.length && OPEN[OPEN.length - 1] === cur; }

  function onKeyFactory(cur) {
    return function (e) {
      if (!topIs(cur)) return;
      if (e.key === 'Escape') { e.preventDefault(); dismiss(null); }
    };
  }

  /* ---------- 输入框 ---------- */
  function bfPrompt(o) {
    o = o || {};
    return new Promise(function (resolve) {
      var b = makeBase(o);
      var cur = { mask: b.mask, done: resolve };
      cur.onKey = onKeyFactory(cur);
      document.addEventListener('keydown', cur.onKey, true);
      OPEN.push(cur);

      var field = mk('div', 'field');
      if (o.label) field.appendChild(mk('label', null, o.label));
      var input;
      if (o.multiline) { input = mk('textarea', 'ed-ta'); }
      else { input = mk('input'); input.type = o.type || 'text'; }
      input.id = 'bfInput';
      if (o.placeholder) input.placeholder = o.placeholder;
      input.value = o.value == null ? '' : o.value;
      field.appendChild(input);
      b.sheet.appendChild(field);

      if (o.choices && o.choices.length) {
        var box = mk('div', 'bfChips');
        for (var i = 0; i < o.choices.length; i++) {
          (function (c) {
            var chip = mk('button', 'btn bfChip', c.label == null ? c.value : c.label);
            chip.type = 'button';
            chip.onclick = function () { input.value = c.value; input.focus(); };
            box.appendChild(chip);
          })(o.choices[i]);
        }
        b.sheet.appendChild(box);
      }

      var msg = mk('div', 'bfMsg');
      b.sheet.appendChild(msg);
      if (o.hint) b.sheet.appendChild(mk('div', 'hint bfHint', o.hint));

      var acts = mk('div', 'actions');
      var cancel = mk('button', 'btn', o.cancelText || '取消');
      var ok = mk('button', 'btn primary', o.okText || '确定');
      cancel.type = 'button'; ok.type = 'button';
      acts.appendChild(ok);
      acts.appendChild(cancel);
      b.sheet.appendChild(acts);

      function submit() {
        var v = input.value;
        if (o.trim !== false) v = v.trim();
        if (o.test) {
          var t = o.test(v);
          if (t) { msg.textContent = t; input.focus(); return; }
        }
        dismiss(v);
      }
      ok.onclick = submit;
      cancel.onclick = function () { dismiss(null); };
      input.addEventListener('keydown', function (e) {
        if (o.multiline) return;
        if (e.key === 'Enter') { e.preventDefault(); submit(); }
      });
      setTimeout(function () { try { input.focus(); input.select(); } catch (e) {} }, 30);
    });
  }

  /* ---------- 确认框 ---------- */
  function bfConfirm(o) {
    o = o || {};
    return new Promise(function (resolve) {
      var b = makeBase(o);
      var cur = { mask: b.mask, done: resolve };
      cur.onKey = onKeyFactory(cur);
      document.addEventListener('keydown', cur.onKey, true);
      OPEN.push(cur);

      if (o.html) {
        var box = mk('div', 'bfBody');
        box.innerHTML = o.html;
        b.sheet.appendChild(box);
      }
      var acts = mk('div', 'actions');
      var cancel = mk('button', 'btn', o.cancelText || '取消');
      var ok = mk('button', 'btn ' + (o.danger ? 'danger' : 'primary'), o.okText || '确定');
      cancel.type = 'button'; ok.type = 'button';
      acts.appendChild(ok); acts.appendChild(cancel);
      b.sheet.appendChild(acts);
      ok.onclick = function () { dismiss(true); };
      cancel.onclick = function () { dismiss(false); };
      setTimeout(function () { try { ok.focus(); } catch (e) {} }, 30);
    });
  }

  /* ---------- 多选清单（选分类/移动到）就是它：单选模式 ---------- */
  function bfPick(o) {
    o = o || {};
    return new Promise(function (resolve) {
      var b = makeBase({ title: o.title, desc: o.desc });
      var cur = { mask: b.mask, done: resolve };
      cur.onKey = onKeyFactory(cur);
      document.addEventListener('keydown', cur.onKey, true);
      OPEN.push(cur);

      var list = mk('div', 'bfList');
      (o.items || []).forEach(function (it) {
        var row = mk('button', 'bfItem' + (it.disabled ? ' off' : ''));
        row.type = 'button';
        var lab = mk('span', 'bfItemT', it.label);
        row.appendChild(lab);
        if (it.note) row.appendChild(mk('span', 'bfItemN', it.note));
        if (it.disabled) row.disabled = true;
        else row.onclick = function () { dismiss(it.value); };
        list.appendChild(row);
      });
      if (!(o.items || []).length) list.appendChild(mk('div', 'empty', o.emptyText || '这里还没有可选项'));
      b.sheet.appendChild(list);

      var acts = mk('div', 'actions');
      var cancel = mk('button', 'btn', '取消');
      cancel.type = 'button';
      cancel.onclick = function () { dismiss(null); };
      acts.appendChild(cancel);
      b.sheet.appendChild(acts);
    });
  }

  /* 样式兜底：万一 bfui.css 没加载（例如只改了 index.html 忘了复制文件） */
  ready(function () {
    var ok = false;
    var sheets = document.querySelectorAll('link[rel="stylesheet"]');
    for (var i = 0; i < sheets.length; i++) {
      var href = sheets[i].getAttribute('href') || '';
      if (href.indexOf('bfui.css') >= 0) ok = true;
    }
    if (ok) return;
    var l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = CSS_HREF.replace('style.css', 'bfui.css');
    document.head.appendChild(l);
  });

  window.BFUI = { prompt: bfPrompt, confirm: bfConfirm, pick: bfPick, close: function () { dismiss(null); } };
})();
