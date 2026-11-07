// deck-editor.js — edit sheets for the Agent Deck (v2 Slice C).
//
// Presentational only: builds a fixed overlay modal (mirrors deck-confirm.js's
// teardown pattern — Escape / click-outside / Cancel) for editing ONE button or
// ONE page. Persistence lives in deck-agent.js: the Save/Delete handlers call
// back into the caller with a ctx { close, error, busy } so the caller owns the
// PUT /api/deck round-trip and decides when to close (on success) or surface an
// inline error (on failure, keeping the form open).
//
// All user-supplied strings render through textContent (never innerHTML) — the
// deck config is user-editable data, so nothing here interpolates markup.
// i18n reads the same localStorage 'deck-lang' key as deck-agent / deck-confirm.
(function () {
  'use strict';

  function T(zh, en) {
    var en_ = false;
    try { en_ = localStorage.getItem('deck-lang') === 'en'; } catch (e) {}
    return en_ ? en : zh;
  }

  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }

  function teardown(overlay) {
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
  }

  // field builds a labeled control row (label above control). control is a DOM node.
  function field(labelTxt, control) {
    var wrap = el('div', 'dka-edit-field');
    wrap.appendChild(el('label', 'dka-edit-label', labelTxt));
    wrap.appendChild(control);
    return wrap;
  }

  function input(value) {
    var i = document.createElement('input');
    i.type = 'text'; i.className = 'dka-edit-input';
    i.value = value == null ? '' : String(value);
    return i;
  }
  function textarea(value) {
    var t = document.createElement('textarea');
    t.className = 'dka-edit-textarea'; t.rows = 3;
    t.value = value == null ? '' : String(value);
    return t;
  }
  function select(options, value) {
    var s = document.createElement('select');
    s.className = 'dka-edit-select';
    options.forEach(function (o) {
      var op = document.createElement('option');
      op.value = o.value; op.textContent = o.label;
      if (o.value === value) op.selected = true;
      s.appendChild(op);
    });
    return s;
  }
  function checkRow(labelTxt, checked) {
    var row = el('label', 'dka-edit-check');
    var c = document.createElement('input');
    c.type = 'checkbox'; c.checked = !!checked;
    row.appendChild(c);
    row.appendChild(el('span', null, labelTxt));
    row._input = c;
    return row;
  }

  // ── shared overlay shell ──────────────────────────────────────────────────
  function shell(titleTxt) {
    var overlay = el('div', 'dka-edit');
    var panel = el('div', 'dka-edit-panel');
    panel.appendChild(el('div', 'dka-edit-title', titleTxt));
    var bodyWrap = el('div', 'dka-edit-body');
    panel.appendChild(bodyWrap);
    var err = el('div', 'dka-edit-err');
    err.style.display = 'none';
    panel.appendChild(err);
    var btns = el('div', 'dka-edit-btns');
    panel.appendChild(btns);
    overlay.appendChild(panel);

    function close() { teardown(overlay); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });

    var ctx = {
      close: close,
      error: function (msg) {
        err.textContent = T('儲存失敗：', 'Save failed: ') + (msg || '');
        err.style.display = '';
        ctx.busy(false);
      },
      busy: function (on) {
        var bs = btns.querySelectorAll('button');
        for (var i = 0; i < bs.length; i++) bs[i].disabled = !!on;
      }
    };
    return { overlay: overlay, panel: panel, body: bodyWrap, btns: btns, err: err, ctx: ctx, close: close };
  }

  function footer(sh, opts, collect, isNew, allowDelete) {
    // Delete sits far-left (margin-right:auto), Cancel + Save far-right.
    if (allowDelete && !isNew && opts.onDelete) {
      var del = el('button', 'dka-edit-del', T('刪除', 'Delete'));
      del.type = 'button';
      del.addEventListener('click', function () {
        sh.err.style.display = 'none';
        sh.ctx.busy(true);
        opts.onDelete(sh.ctx);
      });
      sh.btns.appendChild(del);
    }

    var cancel = el('button', 'dka-edit-cancel', T('取消', 'Cancel'));
    cancel.type = 'button';
    cancel.addEventListener('click', sh.close);
    sh.btns.appendChild(cancel);

    var save = el('button', 'dka-edit-save', T('儲存', 'Save'));
    save.type = 'button';
    save.addEventListener('click', function () {
      sh.err.style.display = 'none';
      var data = collect();
      sh.ctx.busy(true);
      if (opts.onSave) opts.onSave(data, sh.ctx);
    });
    sh.btns.appendChild(save);
  }

  // ── button sheet ──────────────────────────────────────────────────────────
  // opts: { button, isNew, onSave(button, ctx), onDelete(ctx) }
  function showButton(opts) {
    var b = opts.button || {};
    var sh = shell(opts.isNew ? T('新增按鈕', 'New button') : T('編輯按鈕', 'Edit button'));

    var fLabel = input(b.label);
    var fLabelEn = input(b.label_en);
    var fIcon = input(b.icon);
    var fColor = select([
      { value: '', label: T('中性', 'neutral') },
      { value: 'accent', label: T('強調', 'accent') },
      { value: 'warn', label: T('警告', 'warn') },
      { value: 'danger', label: T('危險', 'danger') }
    ], b.color || '');
    var fConfirm = checkRow(T('滑動確認（不可逆動作）', 'Slide to confirm (irreversible)'),
      b.confirm === 'slide');

    sh.body.appendChild(field(T('標籤（繁中）', 'Label (中文)'), fLabel));
    sh.body.appendChild(field(T('標籤（英文，選填）', 'Label (English, optional)'), fLabelEn));
    sh.body.appendChild(field(T('圖示（emoji 或字元）', 'Icon (emoji or char)'), fIcon));
    sh.body.appendChild(field(T('色調', 'Tone'), fColor));
    sh.body.appendChild(fConfirm);

    // action editor
    var a = b.action || { type: 'macro' };
    var fType = select([
      { value: 'input', label: T('送出文字', 'Send text') },
      { value: 'key', label: T('按鍵', 'Key') },
      { value: 'macro', label: T('巨集（多步驟）', 'Macro (steps)') }
    ], a.type || 'macro');
    sh.body.appendChild(field(T('動作類型', 'Action type'), fType));

    var actWrap = el('div', 'dka-edit-action');
    sh.body.appendChild(actWrap);

    // input pane
    var inPayload = textarea(a.type === 'input' ? a.payload : '');
    var inPane = field(T('文字內容（結尾留空白＝填入不送出）', 'Text (trailing space = fill, not send)'), inPayload);

    // key pane
    var keyPayload = input(a.type === 'key' ? a.payload : 'Enter');
    var keyPane = field(T('按鍵名（如 Enter / Escape / Tab）', 'Key name (Enter / Escape / Tab)'), keyPayload);

    // macro pane
    var macroPane = el('div', 'dka-edit-macro');
    var stepsList = el('div', 'dka-edit-steps');
    var steps = (a.type === 'macro' && Array.isArray(a.steps))
      ? a.steps.map(function (s) { return { type: s.type || 'input', payload: s.payload || '' }; })
      : [{ type: 'input', payload: '' }, { type: 'key', payload: 'Enter' }];

    function renderSteps() {
      stepsList.innerHTML = '';
      steps.forEach(function (s, i) {
        var row = el('div', 'dka-edit-step');
        var st = select([
          { value: 'input', label: T('文字', 'text') },
          { value: 'key', label: T('按鍵', 'key') }
        ], s.type);
        st.addEventListener('change', function () { s.type = st.value; });
        var sp = input(s.payload);
        sp.className = 'dka-edit-input dka-edit-step-payload';
        sp.addEventListener('input', function () { s.payload = sp.value; });
        var up = el('button', 'dka-edit-mini', '↑'); up.type = 'button';
        up.addEventListener('click', function () {
          if (i > 0) { var tmp = steps[i - 1]; steps[i - 1] = steps[i]; steps[i] = tmp; renderSteps(); }
        });
        var dn = el('button', 'dka-edit-mini', '↓'); dn.type = 'button';
        dn.addEventListener('click', function () {
          if (i < steps.length - 1) { var tmp = steps[i + 1]; steps[i + 1] = steps[i]; steps[i] = tmp; renderSteps(); }
        });
        var rm = el('button', 'dka-edit-mini dka-edit-mini-del', '✕'); rm.type = 'button';
        rm.addEventListener('click', function () { steps.splice(i, 1); renderSteps(); });
        row.appendChild(st); row.appendChild(sp);
        row.appendChild(up); row.appendChild(dn); row.appendChild(rm);
        stepsList.appendChild(row);
      });
    }
    renderSteps();
    var addStep = el('button', 'dka-edit-addstep', T('＋ 新增步驟', '＋ Add step'));
    addStep.type = 'button';
    addStep.addEventListener('click', function () { steps.push({ type: 'input', payload: '' }); renderSteps(); });
    var interVal = (a.type === 'macro' && a.delays && typeof a.delays.inter === 'number') ? a.delays.inter : 300;
    var fInter = input(interVal);
    fInter.type = 'number'; fInter.min = 0;
    macroPane.appendChild(stepsList);
    macroPane.appendChild(addStep);
    macroPane.appendChild(field(T('步驟間隔（毫秒）', 'Inter-step delay (ms)'), fInter));

    function showPane() {
      actWrap.innerHTML = '';
      if (fType.value === 'input') actWrap.appendChild(inPane);
      else if (fType.value === 'key') actWrap.appendChild(keyPane);
      else actWrap.appendChild(macroPane);
    }
    fType.addEventListener('change', showPane);
    showPane();

    function collect() {
      var out = { label: fLabel.value.trim() };
      if (fLabelEn.value.trim()) out.label_en = fLabelEn.value.trim();
      if (fIcon.value.trim()) out.icon = fIcon.value.trim();
      if (fColor.value) out.color = fColor.value;
      if (fConfirm._input.checked) out.confirm = 'slide';
      if (fType.value === 'input') {
        out.action = { type: 'input', payload: inPayload.value };
      } else if (fType.value === 'key') {
        out.action = { type: 'key', payload: keyPayload.value.trim() };
      } else {
        var interN = parseInt(fInter.value, 10);
        out.action = {
          type: 'macro',
          steps: steps.map(function (s) { return { type: s.type, payload: s.payload }; }),
          delays: { inter: isNaN(interN) ? 300 : interN }
        };
      }
      return out;
    }

    footer(sh, opts, collect, opts.isNew, true);
    document.body.appendChild(sh.overlay);
    setTimeout(function () { fLabel.focus(); }, 0);
    return sh.overlay;
  }

  // ── page sheet ────────────────────────────────────────────────────────────
  // opts: { page, isNew, builtin, onSave(patch, ctx), onDelete(ctx) }
  // patch = { glyph, label, label_en, hidden }. Caller preserves id/type/buttons.
  function showPage(opts) {
    var p = opts.page || {};
    var sh = shell(opts.isNew ? T('新增頁面', 'New page') : T('編輯頁面', 'Edit page'));

    if (opts.builtin) {
      sh.body.appendChild(el('div', 'dka-edit-note',
        T('內建頁：只能改名稱、圖示與隱藏，不可刪除或改按鍵。',
          'Built-in page: name / glyph / hidden only — cannot delete or edit keys.')));
    }

    var fGlyph = input(p.glyph);
    var fLabel = input(p.label);
    var fLabelEn = input(p.label_en);
    var fHidden = checkRow(T('隱藏此頁', 'Hide this page'), p.hidden);

    sh.body.appendChild(field(T('標籤（繁中）', 'Label (中文)'), fLabel));
    sh.body.appendChild(field(T('標籤（英文，選填）', 'Label (English, optional)'), fLabelEn));
    sh.body.appendChild(field(T('圖示字（單一字元）', 'Glyph (single char)'), fGlyph));
    sh.body.appendChild(fHidden);

    function collect() {
      return {
        glyph: fGlyph.value.trim(),
        label: fLabel.value.trim(),
        label_en: fLabelEn.value.trim(),
        hidden: fHidden._input.checked
      };
    }

    // Only custom buttons pages may be deleted (built-in win/ctrl cannot).
    var allowDelete = !opts.builtin;
    footer(sh, opts, collect, opts.isNew, allowDelete);
    document.body.appendChild(sh.overlay);
    setTimeout(function () { fLabel.focus(); }, 0);
    return sh.overlay;
  }

  window.deckEditor = { showButton: showButton, showPage: showPage };
})();
