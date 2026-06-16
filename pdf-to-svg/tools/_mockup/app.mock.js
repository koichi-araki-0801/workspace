(function () {
  var app = document.getElementById('app');
  var fileIcon = '<path d="M6 3.5A1.5 1.5 0 0 1 7.5 2h6L19 7.5v13A1.5 1.5 0 0 1 17.5 22h-10A1.5 1.5 0 0 1 6 20.5V3.5Z"/><path d="M13 2v6h6"/>';
  var xIcon = '<path d="m6 6 12 12M18 6 6 18"/>';
  var chevD = '<path d="m10 6 6 6-6 6"/>';
  var checkD = '<path d="m4.5 12.5 5 5 10-11"/>';
  function svg(p, w, sw) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + (sw || 1.7) + '" stroke-linecap="round" stroke-linejoin="round" style="width:' + (w || 18) + 'px;height:' + (w || 18) + 'px">' + p + '</svg>'; }
  var ckMark = svg(checkD, 11, 2.4);
  var checkDot = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m4.5 12.5 5 5 10-11"/></svg>';
  var skipDot = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 8l4 4-4 4M15 8v8"/></svg>';

  var FILES = [
    { name: '製品カタログ_2026.pdf', pages: 186, size: '8.4 MB' },
    { name: '価格表_全社版.pdf', pages: 48, size: '1.2 MB' },
    { name: '部品発注一覧表.pdf', pages: 14, size: '612 KB' },
  ];
  var PAGES = [];
  FILES.forEach(function (f, fi) {
    for (var p = 0; p < f.pages; p++) PAGES.push({ file: f, fileIndex: fi, pageInFile: p + 1, fileStart: 0 });
  });
  var TOTAL = PAGES.length;
  // 各ファイルの先頭グローバル index
  var FILE_START = []; (function () { var s = 0; FILES.forEach(function (f, i) { FILE_START[i] = s; s += f.pages; }); })();

  // 変更があるページ（辞書一致 / 削除対象）。多くは「変更なし」。
  function changedReplace(g) { return (g % 17 === 3) || (g % 29 === 10) || g < 4; }
  function changedTrim(g) { return (g % 23 === 5) || (g % 19 === 0); }
  var changed2 = PAGES.map(function (_, g) { return changedReplace(g); });
  var changed3 = PAGES.map(function (_, g) { return changedTrim(g); });

  // 状態：'none'(変更なし) | 'pending'(要確認) | 'reviewed'(確認済み) | 'skipped'(スキップ)
  function initStatus(ch) { return ch.map(function (c) { return c ? 'pending' : 'none'; }); }
  var status2 = initStatus(changed2);
  var status3 = initStatus(changed3);
  // 初期に変化をつけて状態の見え方を分かりやすく（最初の数件を確認済み/スキップに）
  (function () {
    var done = 0;
    for (var g = 0; g < TOTAL && done < 3; g++) {
      if (status2[g] === 'pending') { status2[g] = done < 2 ? 'reviewed' : 'skipped'; done++; }
    }
  })();

  // 選択画面のファイルカード
  document.getElementById('file-cards').innerHTML = FILES.map(function (f) {
    return '<div class="file-card"><div class="fic">' + svg(fileIcon, 20) +
      '</div><div class="fmeta"><div class="fname">' + f.name + '</div><div class="fsub">' +
      f.pages + ' ページ ・ ' + f.size + '</div></div>' +
      '<button class="iconbtn fx" title="一覧から外す">' + svg(xIcon, 18) + '</button></div>';
  }).join('');

  // トリミング用ドキュメント
  var master = document.getElementById('doc-master');
  var stage = document.getElementById('trim-stage');
  var clone = master.cloneNode(true);
  clone.removeAttribute('id');
  clone.querySelectorAll('.repl').forEach(function (c) { c.classList.remove('repl'); c.removeAttribute('id'); });
  var trows = clone.querySelectorAll('tbody tr');
  var last = trows[trows.length - 1];
  if (last) last.querySelectorAll('td').forEach(function (td) { td.classList.add('del-mark'); });
  stage.appendChild(clone);
  stage.insertAdjacentHTML('beforeend',
    '<div class="crop-frame"><span class="crop-handle tl"></span><span class="crop-handle tr"></span><span class="crop-handle bl"></span><span class="crop-handle br"></span></div>' +
    '<div class="crop-dim"><span>クロップ範囲外（書き出し時に破棄）</span></div>');

  // ②タブ
  var tabs = [].slice.call(app.querySelectorAll('.panel-tab'));
  var panes = [].slice.call(app.querySelectorAll('[data-screen="2"] .tabpane'));
  function selectTab(name) {
    tabs.forEach(function (t) { t.setAttribute('aria-selected', t.dataset.tab === name ? 'true' : 'false'); });
    panes.forEach(function (p) { p.classList.toggle('on', p.dataset.pane === name); });
  }
  app.querySelectorAll('[data-tab]').forEach(function (el) { el.addEventListener('click', function () { selectTab(el.dataset.tab); }); });

  // ③ 浮かぶツール
  var toolBtns = [].slice.call(app.querySelectorAll('.float-tools [data-tool]'));
  toolBtns.forEach(function (b) { b.addEventListener('click', function () { toolBtns.forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); }); }); });

  // ---- 状態 ----
  var steps = [].slice.call(app.querySelectorAll('#stepbar .step'));
  var screens = [].slice.call(app.querySelectorAll('.screen'));
  var ed2 = app.querySelector('[data-screen="2"] .editor');
  var ed3 = app.querySelector('[data-screen="3"] .editor');
  var btnBack = document.getElementById('btn-back');
  var btnNext = document.getElementById('btn-next');
  var btnExport = document.getElementById('btn-export');
  var navHint = document.getElementById('nav-hint');
  var ctxText = document.getElementById('ctx-text');
  var guard = document.getElementById('guard');
  var checkSeg = svg(checkD, 13, 2);

  var FILTERS = [
    { v: 'pending', t: '要確認' }, { v: 'all', t: 'すべて' },
    { v: 'reviewed', t: '確認済み' }, { v: 'skipped', t: 'スキップ' }, { v: 'none', t: '変更なし' },
  ];
  var STAT = { reviewed: '確認済み', skipped: 'スキップ', pending: '要確認', none: '変更なし' };

  var phase = 1, page = 0, guarding = false;
  var filterFor = { 2: 'pending', 3: 'pending' };
  var selFor = { 2: {}, 3: {} };          // global index -> true
  var collapsed = {};                     // step+':'+fileIndex -> true

  function statusArr() { return phase === 2 ? status2 : status3; }
  function changedArr() { return phase === 2 ? changed2 : changed3; }
  function selSet() { return selFor[phase]; }
  function counts(arr) {
    var c = { done: 0, skip: 0, pend: 0, none: 0 };
    arr.forEach(function (s) { if (s === 'reviewed') c.done++; else if (s === 'skipped') c.skip++; else if (s === 'pending') c.pend++; else c.none++; });
    return c;
  }
  function statusOfCur() { return statusArr()[page]; }
  function pageLabel() { var pg = PAGES[page]; return '<b>' + pg.file.name.replace('.pdf', '') + '</b> ・ ' + pg.pageInFile + ' ページ'; }
  function pass(st, filt) { return filt === 'all' ? true : st === filt; }
  function selKeys() { return Object.keys(selSet()).filter(function (k) { return selSet()[k]; }); }
  function selCount() { return selKeys().length; }

  // ---- 左：ページ一覧 ----
  function buildRail(navId) {
    var arr = statusArr(); var filt = filterFor[phase]; var sel = selSet(); var c = counts(arr);
    var fcount = function (v) { var n = 0; arr.forEach(function (s) { if (v === 'all' || s === v) n++; }); return n; };
    var html = '';
    html += '<div class="pl-head">';
    html += '<div class="pl-title">全 <b>' + TOTAL + '</b> ページ　要確認 <b>' + c.pend + '</b></div>';
    html += '<select class="pl-filter">' + FILTERS.map(function (f) { return '<option value="' + f.v + '"' + (f.v === filt ? ' selected' : '') + '>' + f.t + '（' + fcount(f.v) + '）</option>'; }).join('') + '</select>';
    // 表示中の選択可能ページ
    var visSelectable = [];
    PAGES.forEach(function (pg, g) { if (pass(arr[g], filt) && arr[g] !== 'none') visSelectable.push(g); });
    var allSel = visSelectable.length > 0 && visSelectable.every(function (g) { return sel[g]; });
    html += '<label class="pl-all"><span class="ck' + (allSel ? ' on' : '') + '" data-all="1">' + (allSel ? ckMark : '') + '</span>表示中をすべて選択</label>';
    html += '<button class="pl-skipall" data-skipall="1">' + svg('M9 8l4 4-4 4M15 8v8', 15, 1.9) + '未確認をまとめてスキップ</button>';
    var curFile = FILES[PAGES[page].fileIndex];
    html += '<div class="pl-range"><div class="rg-lab">範囲で指定（' + curFile.name.replace('.pdf', '') + '）</div>' +
      '<div class="rg-row"><input class="rg-from" type="number" min="1" max="' + curFile.pages + '" placeholder="1"> 〜 ' +
      '<input class="rg-to" type="number" min="1" max="' + curFile.pages + '" placeholder="' + curFile.pages + '"> ページを</div>' +
      '<div class="rg-row"><select class="rg-act"><option value="skipped">スキップ</option><option value="reviewed">確認済みに</option></select>' +
      '<button class="rg-go" data-rg="1">適用</button></div></div>';
    html += '</div>';
    if (selCount() > 0) {
      html += '<div class="pl-selbar"><span><b>' + selCount() + '</b> 件を選択中</span><div class="selrow">' +
        '<button data-bulk="done">確認済み</button><button data-bulk="skip">スキップ</button><button data-bulk="clear">解除</button></div></div>';
    }
    html += '<div class="pl-body">';
    var g = 0, anyRow = false;
    FILES.forEach(function (f, fi) {
      var idxs = [];
      for (var p = 0; p < f.pages; p++) { var gg = g + p; if (pass(arr[gg], filt)) idxs.push(gg); }
      if (idxs.length === 0) { g += f.pages; return; }
      anyRow = true;
      var key = phase + ':' + fi; var isColl = !!collapsed[key];
      var selectable = idxs.filter(function (i) { return arr[i] !== 'none'; });
      var fileSel = selectable.length > 0 && selectable.every(function (i) { return sel[i]; });
      html += '<div class="pl-file' + (isColl ? ' collapsed' : '') + '">' +
        '<span class="ck' + (fileSel ? ' on' : '') + '" data-fileck="' + fi + '">' + (fileSel ? ckMark : '') + '</span>' +
        '<span class="fname" data-fcoll="' + fi + '">' + svg(fileIcon, 13).replace('<svg', '<svg class="fic"') + f.name.replace('.pdf', '') + '</span>' +
        '<span class="fcount">' + idxs.length + '</span>' +
        '<span class="fchev" data-fcoll="' + fi + '">' + svg(chevD, 15) + '</span></div>';
      if (!isColl) {
        idxs.forEach(function (gg) {
          var off = gg - g; var st = arr[gg];
          var cls = st === 'reviewed' ? 'done' : (st === 'skipped' ? 'skipped' : (st === 'pending' ? 'pending' : 'none'));
          var dot = st === 'reviewed' ? checkDot : (st === 'skipped' ? skipDot : (off + 1));
          var ckbox = st !== 'none'
            ? '<span class="ck row-ck' + (sel[gg] ? ' on' : '') + '" data-ck="' + gg + '">' + (sel[gg] ? ckMark : '') + '</span>'
            : '<span style="width:17px;flex:none"></span>';
          html += '<div class="pg-row2 ' + cls + (gg === page ? ' current' : '') + '" data-g="' + gg + '">' +
            ckbox + '<span class="dot">' + dot + '</span><span class="lbl">' + (off + 1) + ' ページ</span>' +
            '<span class="tg t-' + cls + '">' + STAT[st] + '</span></div>';
        });
      }
      g += f.pages;
    });
    if (!anyRow) html += '<div class="empty-note" style="padding:48px 16px"><div class="ei">' + svg(checkD, 24, 2) + '</div><div class="et">このフィルタに該当するページはありません</div></div>';
    html += '</div>';
    document.getElementById(navId).innerHTML = html;
    wireRail(navId, visSelectable);
  }

  function wireRail(navId, visSelectable) {
    var nav = document.getElementById(navId);
    var arr = statusArr(); var sel = selSet();
    nav.querySelector('.pl-filter').addEventListener('change', function () { filterFor[phase] = this.value; render(); });
    nav.querySelector('[data-all]').addEventListener('click', function () {
      var allSel = visSelectable.length > 0 && visSelectable.every(function (g) { return sel[g]; });
      visSelectable.forEach(function (g) { if (allSel) delete sel[g]; else sel[g] = true; });
      render();
    });
    nav.querySelector('[data-skipall]').addEventListener('click', function () {
      for (var g = 0; g < TOTAL; g++) if (arr[g] === 'pending') arr[g] = 'skipped';
      render();
    });
    var rg = nav.querySelector('[data-rg]');
    if (rg) rg.addEventListener('click', function () {
      var fi = PAGES[page].fileIndex; var start = FILE_START[fi]; var fp = FILES[fi].pages;
      var from = parseInt(nav.querySelector('.rg-from').value, 10) || 1;
      var to = parseInt(nav.querySelector('.rg-to').value, 10) || fp;
      if (from > to) { var t = from; from = to; to = t; }
      from = Math.max(1, Math.min(fp, from)); to = Math.max(1, Math.min(fp, to));
      var act = nav.querySelector('.rg-act').value;
      for (var pp = from; pp <= to; pp++) { var gg = start + (pp - 1); if (arr[gg] !== 'none') arr[gg] = act; }
      render();
    });
    var selbar = nav.querySelector('.pl-selbar');
    if (selbar) selbar.querySelectorAll('[data-bulk]').forEach(function (b) {
      b.addEventListener('click', function () {
        var k = b.dataset.bulk;
        if (k === 'clear') { clearSel(); }
        else { selKeys().forEach(function (g) { arr[+g] = k === 'done' ? 'reviewed' : 'skipped'; }); clearSel(); }
        render();
      });
    });
    nav.querySelectorAll('[data-fileck]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.stopPropagation();
        var fi = +el.dataset.fileck; var start = FILE_START[fi];
        var idxs = []; for (var p = 0; p < FILES[fi].pages; p++) { var gg = start + p; if (pass(arr[gg], filterFor[phase]) && arr[gg] !== 'none') idxs.push(gg); }
        var allSel = idxs.length > 0 && idxs.every(function (g) { return sel[g]; });
        idxs.forEach(function (g) { if (allSel) delete sel[g]; else sel[g] = true; });
        render();
      });
    });
    nav.querySelectorAll('[data-fcoll]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.stopPropagation();
        var key = phase + ':' + el.dataset.fcoll; collapsed[key] = !collapsed[key]; render();
      });
    });
    nav.querySelectorAll('.row-ck').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.stopPropagation();
        var g = +el.dataset.ck; if (sel[g]) delete sel[g]; else sel[g] = true; render();
      });
    });
    nav.querySelectorAll('.pg-row2').forEach(function (r) {
      r.addEventListener('click', function () { page = +r.dataset.g; render(); });
    });
  }
  function clearSel() { var s = selSet(); Object.keys(s).forEach(function (k) { delete s[k]; }); }

  function renderSummary(id, arr) {
    var c = counts(arr);
    document.getElementById(id).innerHTML =
      '<span class="si"><span class="d pend"></span>要確認 <b>' + c.pend + '</b></span>' +
      '<span class="si"><span class="d done"></span>確認済み <b>' + c.done + '</b></span>' +
      '<span class="si"><span class="d skip"></span>スキップ <b>' + c.skip + '</b></span>' +
      '<span class="si"><span class="d pend" style="background:var(--border-strong)"></span>変更なし <b>' + c.none + '</b></span>';
  }

  // 確認ペイン（②）
  function renderConfirm() {
    var el = document.getElementById('confirm-dyn');
    if (!changed2[page]) {
      ed2.classList.add('nochange');
      el.innerHTML = '<div class="empty-note"><div class="ei">' + svg('<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>', 24) + '</div><div class="et">このページに置換対象の用語はありません</div><div style="font-size:12px">そのまま書き出されます</div></div>';
      return;
    }
    ed2.classList.remove('nochange');
    el.innerHTML =
      '<div class="confirm-banner"><span class="ic">' + svg(checkD, 22, 2.2) + '</span><div><div class="t">このページで 3 件を置換</div><div class="s">表ヘッダの用語を自動で統一しました</div></div></div>' +
      '<div style="display:flex;flex-direction:column;min-height:0;flex:1;"><div class="field-label">変更の一覧（クリックで該当箇所へ）</div><div class="change-list">' +
      chRow('cell-hin', 'Item No.', '品番') + chRow('cell-su', 'Q\u2019ty', '数量') + chRow('cell-kin', 'Amount', '金額') +
      '</div></div>';
    el.querySelectorAll('.change-row[data-target]').forEach(function (row) {
      row.addEventListener('click', function () {
        var cell = document.getElementById(row.dataset.target);
        if (!cell) return; cell.classList.remove('flash'); void cell.offsetWidth; cell.classList.add('flash');
      });
    });
  }
  function chRow(t, a, b) {
    return '<div class="change-row" data-target="' + t + '"><span class="loc">ヘッダ</span><span class="pair"><span class="from">' + a +
      '</span>' + svg('M4 12h15M13 6l6 6-6 6', 15) + '<span class="to">' + b + '</span></span>' + svg(chevD, 16).replace('currentColor', 'var(--faint)') + '</div>';
  }

  // 削除ペイン（③）
  function renderTrim() {
    var el = document.getElementById('trim-dyn');
    if (!changed3[page]) {
      ed3.classList.add('nochange');
      el.innerHTML = '<div class="empty-note"><div class="ei">' + svg('<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>', 24) + '</div><div class="et">このページに削除する要素はありません</div><div style="font-size:12px">そのまま書き出されます</div></div>';
      return;
    }
    ed3.classList.remove('nochange');
    el.innerHTML = '<div class="field-label">このページで削除した要素（2）</div><div class="change-list">' +
      '<div class="removed-row"><span class="ric">' + svg('M4 7h16M6 7v12.5A1.5 1.5 0 0 0 7.5 21h9a1.5 1.5 0 0 0 1.5-1.5V7', 15) + '</span><span class="rt">明細行「シリコンチューブ 5m」</span><span class="undo-x">戻す</span></div>' +
      '<div class="removed-row"><span class="ric">' + svg('<rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m5 17 5-4 9 6"/>', 15) + '</span><span class="rt">右上のロゴ画像</span><span class="undo-x">戻す</span></div></div>';
  }

  // ページ単位アクション
  function pageActHTML() {
    var st = statusOfCur();
    if (st === 'none')
      return '<div class="pa-prompt" style="margin:0">このページは変更がないため操作は不要です</div>';
    if (st === 'reviewed')
      return '<div class="pa-badge good">' + svg(checkD, 17) + 'このページは確認済み</div><button class="pa-link" data-pa="reset">取り消す</button>';
    if (st === 'skipped')
      return '<div class="pa-badge warn">' + svg('M9 8l4 4-4 4M15 8v8', 17) + 'このページはスキップ</div><button class="pa-link" data-pa="review">確認する</button>';
    return '<div class="pa-prompt">' + (phase === 2 ? 'このページの置換を確認、または不要ならスキップ' : 'このページの削除を確認、または不要ならスキップ') + '</div>' +
      '<div class="pa-btns"><button class="btn ghost" data-pa="skip">スキップ</button><button class="btn primary" data-pa="done">' + (phase === 2 ? '確認しました' : '完了') + '</button></div>';
  }
  function nextPending(arr) {
    for (var i = page + 1; i < TOTAL; i++) if (arr[i] === 'pending') return i;
    for (var j = 0; j < page; j++) if (arr[j] === 'pending') return j;
    return -1;
  }
  function onPageAct(actv) {
    var arr = statusArr();
    if (actv === 'done') { arr[page] = 'reviewed'; var n1 = nextPending(arr); if (n1 >= 0) page = n1; }
    else if (actv === 'skip') { arr[page] = 'skipped'; var n2 = nextPending(arr); if (n2 >= 0) page = n2; }
    else { arr[page] = 'pending'; }
    render();
  }
  function renderPageAct() {
    var el = document.getElementById(phase === 2 ? 'pageact-2' : 'pageact-3');
    el.innerHTML = pageActHTML();
    el.querySelectorAll('[data-pa]').forEach(function (b) { b.addEventListener('click', function () { onPageAct(b.dataset.pa); }); });
  }

  function render() {
    screens.forEach(function (s) { s.classList.toggle('on', +s.dataset.screen === phase); });
    steps.forEach(function (st) {
      var n = +st.dataset.step;
      var done = n < phase, active = n === phase;
      st.classList.toggle('done', done); st.classList.toggle('active', active);
      st.classList.toggle('future', !done && !active); st.classList.toggle('clickable', n <= phase);
      st.querySelector('.n').innerHTML = done ? checkSeg : n;
    });
    guard.hidden = !guarding;
    btnBack.style.visibility = phase === 1 ? 'hidden' : 'visible';
    btnNext.style.display = phase < 4 ? '' : 'none';
    btnExport.style.display = phase === 4 ? '' : 'none';
    btnNext.childNodes[0].nodeValue = phase === 3 ? '書き出しへ' : '次へ';

    if (phase === 1) {
      navHint.innerHTML = '変換するPDFを選びます';
      ctxText.textContent = FILES.length + ' ファイル・' + TOTAL + ' ページ';
    } else if (phase === 4) {
      navHint.innerHTML = '内容を確認して書き出します。';
      ctxText.textContent = FILES.length + ' ファイル・' + TOTAL + ' ページ';
      document.getElementById('exp-num').textContent = TOTAL;
      document.getElementById('exp-range').textContent = '全ページ（' + TOTAL + '枚）';
      var s2 = counts(status2), s3 = counts(status3);
      document.getElementById('export-summary').innerHTML =
        FILES.length + 'ファイル・全' + TOTAL + 'ページ<br/>用語：確認 ' + s2.done + ' / スキップ ' + s2.skip + '　削除：確認 ' + s3.done + ' / スキップ ' + s3.skip;
    } else {
      var task = phase === 2 ? '用語の置換' : '不要範囲の削除';
      var c = counts(statusArr());
      navHint.innerHTML = task + ' — 要確認 <b>' + c.pend + '</b> / 確認済み <b>' + c.done + '</b> / スキップ <b>' + c.skip + '</b>';
      var pg = PAGES[page];
      ctxText.textContent = pg.file.name + ' ・ ' + pg.pageInFile + '/' + pg.file.pages + ' ページ';
    }

    if (phase === 2) {
      buildRail('pagenav'); renderSummary('sum-2', status2); renderConfirm(); renderPageAct();
      document.getElementById('pgnav-2').innerHTML = pageLabel();
    }
    if (phase === 3) {
      buildRail('pagenav-3'); renderSummary('sum-3', status3); renderTrim(); renderPageAct();
      document.getElementById('pgnav-3').innerHTML = pageLabel();
    }
  }

  function firstPending(arr) { for (var i = 0; i < TOTAL; i++) if (arr[i] === 'pending') return i; return 0; }
  function advancePhase() { guarding = false; if (phase === 2) { phase = 3; page = 0; } else if (phase === 3) { phase = 4; } clearSel(); render(); }
  function tryNext() {
    if (phase === 1) { phase = 2; page = 0; guarding = false; render(); return; }
    if (phase === 2 || phase === 3) {
      var pend = counts(statusArr()).pend;
      if (pend > 0) { guarding = true; document.getElementById('guard-n').textContent = pend; render(); return; }
      advancePhase();
    }
  }
  function back() {
    guarding = false;
    if (phase === 2) phase = 1;
    else if (phase === 3) { phase = 2; page = 0; }
    else if (phase === 4) { phase = 3; page = 0; }
    render();
  }

  btnBack.addEventListener('click', back);
  btnNext.addEventListener('click', tryNext);
  btnExport.addEventListener('click', function () { navHint.innerHTML = '<b style="color:var(--good-ink)">' + TOTAL + '個のSVGを書き出しました。</b>'; });
  document.getElementById('guard-back').addEventListener('click', function () { guarding = false; page = firstPending(statusArr()); render(); });
  document.getElementById('guard-skip').addEventListener('click', function () {
    var arr = statusArr(); for (var i = 0; i < TOTAL; i++) if (arr[i] === 'pending') arr[i] = 'skipped'; advancePhase();
  });
  steps.forEach(function (st) {
    st.addEventListener('click', function () {
      var n = +st.dataset.step; if (n > phase) return;
      guarding = false; phase = n; if (n === 2 || n === 3) page = 0; clearSel(); render();
    });
  });

  render();
})();