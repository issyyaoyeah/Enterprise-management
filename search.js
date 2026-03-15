/**
 * ═══════════════════════════════════════════════════════════════
 *  CSU 企业管理复试 · 全站搜索增强系统
 *  search.js  v2.0
 *
 *  依赖:
 *    - search_index.js  (window.SEARCH_INDEX)  ← 由 build_search_index.js 生成
 *    - search.css
 *    - 宿主页已有 loadChapter(file, title) 函数
 *
 *  提供:
 *    1. 全文实时搜索 (< 50 ms for 200+ pages)
 *    2. 关键词高亮（搜索结果片段 + 章节页内）
 *    3. 逐个匹配导航 (1/N ↑↓)
 *    4. 知识点反向链接 [[概念]] → Obsidian 风格弹窗
 *
 *  集成方式 (在 index.html <body> 末尾添加):
 *    <link rel="stylesheet" href="search.css">
 *    <script src="search_index.js"></script>
 *    <script src="search.js"></script>
 * ═══════════════════════════════════════════════════════════════
 */

(function () {
  'use strict';

  /* ════════════════════════════════════════════════════════════
   *  A. 搜索引擎核心
   * ════════════════════════════════════════════════════════════ */
  const SearchEngine = (() => {
    let _index = [];
    let _ready = false;

    /** 初始化：读取 window.SEARCH_INDEX */
    function init() {
      if (typeof window.SEARCH_INDEX !== 'undefined') {
        _index = window.SEARCH_INDEX;
        _ready = true;
      } else {
        // 尝试 fetch (需要本地服务器 / 现代浏览器允许 file://)
        fetch('search_index.json')
          .then(r => r.json())
          .then(data => { _index = data; _ready = true; })
          .catch(() => console.warn('[Search] search_index.js 或 search_index.json 未找到，请先运行 build_search_index.js'));
      }
    }

    /**
     * 搜索主函数
     * @param {string} q       查询词
     * @param {number} limit   最大返回条数
     * @returns {SearchResult[]}
     */
    function search(q, limit = 30) {
      if (!_ready || !q || q.trim().length < 1) return [];
      const t0 = performance.now();

      const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);

      const results = [];
      for (const doc of _index) {
        const titleLow   = (doc.title   || '').toLowerCase();
        const contentLow = (doc.content || '').toLowerCase();
        const tagsLow    = (doc.tags    || []).join(' ').toLowerCase();

        let score = 0;
        let allMatch = true;

        for (const term of terms) {
          const inTitle   = titleLow.includes(term);
          const inContent = contentLow.includes(term);
          const inTags    = tagsLow.includes(term);
          if (!inTitle && !inContent && !inTags) { allMatch = false; break; }
          if (inTitle)   score += 10;
          if (inTags)    score += 5;
          if (inContent) score += countOccurrences(contentLow, term);
        }

        if (!allMatch) continue;

        // 生成片段
        const snippet = extractSnippet(doc.content, terms, 140);

        results.push({
          title:   doc.title,
          url:     doc.url,
          cat:     doc.cat   || 'other',
          catLbl:  doc.catLbl || '',
          snippet,
          score,
          count:   countOccurrences(contentLow, terms[0])
        });
      }

      results.sort((a, b) => b.score - a.score);
      const t1 = performance.now();
      // console.debug(`[Search] "${q}" → ${results.length} 条，耗时 ${(t1-t0).toFixed(1)} ms`);
      return results.slice(0, limit);
    }

    function countOccurrences(text, term) {
      if (!term) return 0;
      let n = 0, idx = 0;
      while ((idx = text.indexOf(term, idx)) !== -1) { n++; idx += term.length; }
      return n;
    }

    function extractSnippet(content, terms, maxLen) {
      if (!content) return '';
      const term  = terms[0];
      const lower = content.toLowerCase();
      const pos   = lower.indexOf(term);
      if (pos === -1) return content.slice(0, maxLen);
      const start = Math.max(0, pos - 40);
      const end   = Math.min(content.length, pos + maxLen - 40);
      let s = (start > 0 ? '…' : '') + content.slice(start, end) + (end < content.length ? '…' : '');
      return s;
    }

    return { init, search, get ready() { return _ready; }, get index() { return _index; } };
  })();


  /* ════════════════════════════════════════════════════════════
   *  B. 高亮工具函数
   * ════════════════════════════════════════════════════════════ */
  function highlightText(text, terms) {
    if (!text || !terms.length) return escapeHtml(text);
    const escaped  = escapeHtml(text);
    const pattern  = terms.map(t => escapeRegex(escapeHtml(t))).join('|');
    return escaped.replace(new RegExp(`(${pattern})`, 'gi'), '<mark>$1</mark>');
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }


  /* ════════════════════════════════════════════════════════════
   *  C. 搜索 UI（模态框）
   * ════════════════════════════════════════════════════════════ */
  const SearchUI = (() => {
    let _activeIdx  = -1;
    let _results    = [];
    let _debounce   = null;
    let _lastQuery  = '';

    function buildHTML() {
      /* 搜索触发按钮 */
      const trigger = document.createElement('button');
      trigger.id        = 'searchTrigger';
      trigger.innerHTML = `<span class="st-icon">🔍</span>
        <span class="st-text">搜索所有资料…</span>
        <span class="st-kbd">⌘K</span>`;
      trigger.addEventListener('click', open);

      /* 替换原来的 #si input（若存在） */
      const oldSi = document.getElementById('si');
      if (oldSi) oldSi.replaceWith(trigger);
      else {
        const navr = document.querySelector('.navr');
        if (navr) navr.insertBefore(trigger, navr.firstChild);
      }

      /* 模态框 */
      const overlay = document.createElement('div');
      overlay.id    = 'searchOverlay';
      overlay.innerHTML = `
        <div id="searchModal" role="dialog" aria-modal="true" aria-label="全站搜索">
          <div id="searchInputRow">
            <span class="si-icon">🔍</span>
            <input id="searchInput" type="text" placeholder="输入关键词搜索所有章节… (支持中英文)" autocomplete="off" spellcheck="false">
            <button id="searchClear" title="清空" aria-label="清空">✕</button>
            <button id="searchClose" title="关闭 (Esc)" aria-label="关闭">✕</button>
          </div>
          <div id="searchResults">
            <div id="searchHint">
              <span class="sh-icon">📖</span>
              输入关键词即可搜索<br>
              <span style="font-size:11px">支持：绩效管理、工作分析、激励理论、战略联盟…</span>
            </div>
          </div>
          <div id="searchFooter">
            <span id="searchCount" class="sf-count"></span>
            <div class="sf-keys">
              <span class="sf-key">↑↓</span> 导航
              <span class="sf-key">Enter</span> 打开
              <span class="sf-key">Esc</span> 关闭
            </div>
          </div>
        </div>`;
      overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
      document.body.appendChild(overlay);

      /* 事件绑定 */
      document.getElementById('searchInput').addEventListener('input', onInput);
      document.getElementById('searchInput').addEventListener('keydown', onKeydown);
      document.getElementById('searchClear').addEventListener('click', clearInput);
      document.getElementById('searchClose').addEventListener('click', close);
    }

    function open() {
      document.getElementById('searchOverlay').classList.add('open');
      setTimeout(() => document.getElementById('searchInput').focus(), 60);
    }

    function close() {
      document.getElementById('searchOverlay').classList.remove('open');
    }

    function clearInput() {
      const inp = document.getElementById('searchInput');
      inp.value = '';
      inp.focus();
      document.getElementById('searchClear').classList.remove('show');
      document.getElementById('searchResults').innerHTML =
        `<div id="searchHint"><span class="sh-icon">📖</span>输入关键词即可搜索</div>`;
      document.getElementById('searchCount').textContent = '';
      _results = []; _activeIdx = -1; _lastQuery = '';
    }

    function onInput(e) {
      const val = e.target.value;
      document.getElementById('searchClear').classList.toggle('show', val.length > 0);
      clearTimeout(_debounce);
      _debounce = setTimeout(() => runSearch(val), 80);
    }

    function onKeydown(e) {
      const items = document.querySelectorAll('.sr-item');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        _activeIdx = Math.min(_activeIdx + 1, items.length - 1);
        updateActiveItem(items);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        _activeIdx = Math.max(_activeIdx - 1, 0);
        updateActiveItem(items);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const active = document.querySelector('.sr-item.active');
        if (active) active.click();
      } else if (e.key === 'Escape') {
        close();
      }
    }

    function updateActiveItem(items) {
      items.forEach((item, i) => {
        item.classList.toggle('active', i === _activeIdx);
        if (i === _activeIdx) item.scrollIntoView({ block: 'nearest' });
      });
    }

    function runSearch(q) {
      if (!q.trim()) { clearInput(); return; }
      if (q === _lastQuery) return;
      _lastQuery = q;

      if (!SearchEngine.ready) {
        showMessage('⚠️', '搜索索引未加载，请先运行 build_search_index.js 生成索引文件');
        return;
      }

      const terms   = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
      _results      = SearchEngine.search(q);
      _activeIdx    = _results.length > 0 ? 0 : -1;

      renderResults(_results, terms, q);

      const countEl = document.getElementById('searchCount');
      if (countEl) countEl.textContent = _results.length > 0 ? `找到 ${_results.length} 条结果` : '';
    }

    function renderResults(results, terms, q) {
      const container = document.getElementById('searchResults');
      if (results.length === 0) {
        container.innerHTML = `<div id="searchHint">
          <span class="sh-icon">🔍</span>
          没有找到「${escapeHtml(q)}」的相关内容<br>
          <span style="font-size:11px">试试其他关键词，如：绩效、薪酬、战略、激励</span>
        </div>`;
        return;
      }

      /* 按 cat 分组 */
      const groups = {};
      const order  = ['strat', 'hr', 'other'];
      const labels = { strat: '📐 企业战略管理', hr: '👥 人力资源管理', other: '📄 综合资料' };

      for (const r of results) {
        const g = r.cat || 'other';
        if (!groups[g]) groups[g] = [];
        groups[g].push(r);
      }

      let html = '';
      for (const cat of order) {
        if (!groups[cat]) continue;
        html += `<div class="sr-group-title">${labels[cat]}</div>`;
        for (let i = 0; i < groups[cat].length; i++) {
          html += renderItem(groups[cat][i], terms, cat, i === 0 && cat === (Object.keys(groups)[0]));
        }
      }

      container.innerHTML = html;

      /* 绑定点击 */
      container.querySelectorAll('.sr-item').forEach(el => {
        el.addEventListener('click', () => {
          const file  = el.dataset.file;
          const title = el.dataset.title;
          const kw    = el.dataset.kw;
          close();
          openResult(file, title, kw);
        });
        el.addEventListener('mouseenter', () => {
          container.querySelectorAll('.sr-item').forEach(x => x.classList.remove('active'));
          el.classList.add('active');
        });
      });

      /* 首个高亮 */
      const first = container.querySelector('.sr-item');
      if (first) first.classList.add('active');
    }

    function renderItem(r, terms, cat, _isFirst) {
      const iconMap = { strat: '📐', hr: '👥', other: '📄' };
      const clsMap  = { strat: 'ic-strat', hr: 'ic-hr', other: 'ic-other' };
      const icon    = iconMap[cat] || '📄';
      const cls     = clsMap[cat] || 'ic-other';

      const titleHL   = highlightText(r.title,   terms);
      const snippetHL = highlightText(r.snippet, terms);

      return `<div class="sr-item" data-file="${escapeHtml(r.url)}" data-title="${escapeHtml(r.title)}" data-kw="${escapeHtml(terms.join(' '))}" role="option">
        <div class="sri-icon ${cls}">${icon}</div>
        <div class="sri-body">
          <div class="sri-title">${titleHL}</div>
          <div class="sri-snippet">${snippetHL}</div>
          <div class="sri-meta">${escapeHtml(r.catLbl)}</div>
        </div>
        ${r.count > 1 ? `<div class="sri-count">${r.count} 处</div>` : ''}
      </div>`;
    }

    function openResult(file, title, kw) {
      /* 通过 SPA 面板打开，并传递关键词用于页内高亮 */
      if (typeof window.loadChapter === 'function') {
        window._pendingHighlight = kw;
        window.loadChapter(file, title);
      } else {
        /* fallback: 新标签打开 */
        const url = `${file}${kw ? '?highlight=' + encodeURIComponent(kw) : ''}`;
        window.open(url, '_blank');
      }
    }

    /* 键盘快捷键 Ctrl+K / ⌘K */
    function initShortcut() {
      document.addEventListener('keydown', e => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
          e.preventDefault();
          const overlay = document.getElementById('searchOverlay');
          if (overlay && overlay.classList.contains('open')) close();
          else open();
        }
      });
    }

    function showMessage(icon, msg) {
      const el = document.getElementById('searchResults');
      el.innerHTML = `<div id="searchHint"><span class="sh-icon">${icon}</span>${escapeHtml(msg)}</div>`;
    }

    return { build: buildHTML, open, close, initShortcut };
  })();


  /* ════════════════════════════════════════════════════════════
   *  D. 页内高亮 + 匹配导航（注入 iframe）
   * ════════════════════════════════════════════════════════════ */
  const MatchNav = (() => {
    let _matches  = [];
    let _current  = 0;
    let _kw       = '';
    let _navEl    = null;
    let _iframe   = null;

    function build() {
      if (document.getElementById('matchNav')) return;
      const nav = document.createElement('div');
      nav.id    = 'matchNav';
      nav.className = 'hidden';
      nav.innerHTML = `
        <span class="mn-label">🔍 <span class="mn-kw"></span></span>
        <span class="mn-count">0 / 0</span>
        <button class="mn-btn" id="mnPrev" title="上一个 (↑)">↑</button>
        <button class="mn-btn" id="mnNext" title="下一个 (↓)">↓</button>
        <button class="mn-close" id="mnClose" title="关闭高亮">✕</button>`;
      document.body.appendChild(nav);
      _navEl = nav;

      document.getElementById('mnPrev').addEventListener('click', () => navigate(-1));
      document.getElementById('mnNext').addEventListener('click', () => navigate(1));
      document.getElementById('mnClose').addEventListener('click', clear);

      /* 快捷键：F3 / Shift+F3 */
      document.addEventListener('keydown', e => {
        if (_matches.length === 0) return;
        if (e.key === 'F3') { e.preventDefault(); navigate(e.shiftKey ? -1 : 1); }
      });
    }

    /**
     * 在目标文档上执行高亮（支持 iframe.contentDocument 或 document 自身）
     * @param {string} kw       关键词（空格分隔）
     * @param {Document} doc    目标文档（默认 window.document）
     * @param {HTMLIFrameElement} iframeEl 对应 iframe（用于滚动）
     */
    function highlight(kw, doc, iframeEl) {
      if (!kw) return;
      _kw     = kw;
      _iframe = iframeEl || null;

      const targetDoc = doc || document;
      clearHighlights(targetDoc);

      const terms   = kw.split(/\s+/).filter(Boolean);
      const pattern = new RegExp(`(${terms.map(escapeRegex).join('|')})`, 'gi');
      const walker  = targetDoc.createTreeWalker(targetDoc.body, NodeFilter.SHOW_TEXT, null, false);

      const nodes = [];
      let node;
      while ((node = walker.nextNode())) {
        // 跳过 script / style / 导航栏
        const parent = node.parentElement;
        if (!parent) continue;
        const tag = parent.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') continue;
        if (parent.closest('#nav, #matchNav, .search-hl-bar')) continue;
        if (pattern.test(node.textContent)) nodes.push(node);
      }

      _matches = [];
      for (const textNode of nodes) {
        const parts = textNode.textContent.split(pattern);
        if (parts.length <= 1) continue;
        const frag = targetDoc.createDocumentFragment();
        for (const part of parts) {
          if (pattern.test(part)) {
            const mark = targetDoc.createElement('mark');
            mark.className   = 'hl-match';
            mark.textContent = part;
            _matches.push(mark);
            frag.appendChild(mark);
          } else {
            frag.appendChild(targetDoc.createTextNode(part));
          }
          pattern.lastIndex = 0;
        }
        textNode.parentNode.replaceChild(frag, textNode);
      }

      _current = 0;
      updateNav();
      if (_matches.length > 0) scrollToCurrent();
    }

    function clearHighlights(doc) {
      const targetDoc = doc || document;
      targetDoc.querySelectorAll('mark.hl-match').forEach(m => {
        const parent = m.parentNode;
        parent.replaceChild(targetDoc.createTextNode(m.textContent), m);
        parent.normalize();
      });
      _matches = [];
    }

    function navigate(dir) {
      if (_matches.length === 0) return;
      _matches[_current].classList.remove('hl-current');
      _current = (_current + dir + _matches.length) % _matches.length;
      updateNav();
      scrollToCurrent();
    }

    function scrollToCurrent() {
      if (_matches.length === 0) return;
      const el = _matches[_current];
      el.classList.add('hl-current');
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    function updateNav() {
      if (!_navEl) return;
      const kwEl = _navEl.querySelector('.mn-kw');
      if (kwEl) kwEl.textContent = `"${_kw}"`;
      const countEl = _navEl.querySelector('.mn-count');
      if (countEl) countEl.textContent = `${_matches.length > 0 ? _current + 1 : 0} / ${_matches.length}`;

      if (_matches.length > 0) _navEl.classList.remove('hidden');
      else _navEl.classList.add('hidden');
    }

    function clear() {
      clearHighlights(document);
      if (_iframe) {
        try { clearHighlights(_iframe.contentDocument); } catch(e) {}
      }
      if (_navEl) _navEl.classList.add('hidden');
      _kw = ''; _matches = []; _current = 0; _iframe = null;
    }

    return { build, highlight, clear, navigate };
  })();


  /* ════════════════════════════════════════════════════════════
   *  E. iframe 高亮注入
   * ════════════════════════════════════════════════════════════ */
  function hookIframe() {
    const frame = document.getElementById('chapterFrame');
    if (!frame) return;

    frame.addEventListener('load', () => {
      const kw = window._pendingHighlight;
      if (!kw) return;
      window._pendingHighlight = null;

      try {
        const doc = frame.contentDocument;
        if (!doc || !doc.body) return;

        /* 注入高亮 CSS */
        if (!doc.getElementById('hl-style')) {
          const link = doc.createElement('link');
          link.id   = 'hl-style';
          link.rel  = 'stylesheet';
          link.href = '../search.css'; // 相对路径（子目录里的章节）
          doc.head.appendChild(link);
        }

        /* 延迟执行保证 CSS 加载 */
        setTimeout(() => {
          /* 在 iframe 文档内高亮 */
          MatchNav.highlight(kw, doc, frame);

          /* 在主窗口显示导航条 */
          MatchNav.build();
        }, 200);
      } catch (e) {
        console.warn('[Search] 无法注入高亮（跨域限制）:', e.message);
      }
    });
  }

  /* 从 URL 参数读取 highlight（章节页独立打开时）*/
  function handleURLHighlight() {
    const params = new URLSearchParams(window.location.search);
    const kw     = params.get('highlight');
    if (!kw) return;
    window.addEventListener('DOMContentLoaded', () => {
      setTimeout(() => {
        MatchNav.build();
        MatchNav.highlight(kw, document, null);
      }, 300);
    });
  }


  /* ════════════════════════════════════════════════════════════
   *  F. 知识点反向链接（Wikilinks）
   * ════════════════════════════════════════════════════════════ */
  const WikiLinks = (() => {
    let _popup     = null;
    let _popupKw   = '';

    function build() {
      /* 弹窗 */
      const popup = document.createElement('div');
      popup.id    = 'backlinkPopup';
      popup.innerHTML = `
        <div class="bp-header">
          <div class="bp-title">🔗 反向链接 — <span id="bpKw" class="bp-keyword"></span></div>
          <button class="bp-close" id="bpClose">✕</button>
        </div>
        <div id="bpList" class="bp-list"></div>
        <div class="bp-footer">
          <button class="bp-search-all" id="bpSearchAll">在搜索框中查看全部 →</button>
          <span id="bpCount" style="font-size:11px;color:var(--muted)"></span>
        </div>`;
      document.body.appendChild(popup);
      _popup = popup;

      document.getElementById('bpClose').addEventListener('click', closePopup);
      document.getElementById('bpSearchAll').addEventListener('click', () => {
        closePopup();
        SearchUI.open();
        setTimeout(() => {
          const inp = document.getElementById('searchInput');
          if (inp) { inp.value = _popupKw; inp.dispatchEvent(new Event('input')); }
        }, 100);
      });

      /* 点击页面其他地方关闭 */
      document.addEventListener('click', e => {
        if (_popup && _popup.classList.contains('open') && !_popup.contains(e.target) && !e.target.classList.contains('wikilink')) {
          closePopup();
        }
      });
    }

    /**
     * 扫描页面文本，将 [[关键词]] 转换为可点击的 wikilink span
     */
    function processWikilinks(container) {
      const walker = document.createTreeWalker(container || document.body, NodeFilter.SHOW_TEXT, null, false);
      const regex  = /\[\[([^\]]+)\]\]/g;
      const nodes  = [];
      let node;
      while ((node = walker.nextNode())) {
        if (regex.test(node.textContent)) nodes.push(node);
        regex.lastIndex = 0;
      }

      for (const textNode of nodes) {
        const parent = textNode.parentElement;
        if (!parent || parent.tagName === 'SCRIPT' || parent.tagName === 'STYLE') continue;

        const parts = textNode.textContent.split(/(\[\[[^\]]+\]\])/g);
        if (parts.length <= 1) continue;

        const frag = document.createDocumentFragment();
        for (const part of parts) {
          const m = part.match(/^\[\[([^\]]+)\]\]$/);
          if (m) {
            const span     = document.createElement('span');
            span.className = 'wikilink';
            span.textContent = m[1];
            span.dataset.kw  = m[1];
            span.addEventListener('click', e => { e.stopPropagation(); showBacklinks(m[1], span); });
            frag.appendChild(span);
          } else {
            frag.appendChild(document.createTextNode(part));
          }
        }
        parent.replaceChild(frag, textNode);
      }
    }

    function showBacklinks(kw, anchor) {
      if (!SearchEngine.ready) {
        alert('搜索索引未加载，请先运行 build_search_index.js');
        return;
      }

      _popupKw = kw;
      const results = SearchEngine.search(kw, 20);

      document.getElementById('bpKw').textContent     = kw;
      document.getElementById('bpCount').textContent  = `共 ${results.length} 条`;

      const list = document.getElementById('bpList');
      if (results.length === 0) {
        list.innerHTML = `<div class="bp-empty">📭 没有找到包含「${escapeHtml(kw)}」的章节</div>`;
      } else {
        list.innerHTML = results.map(r => {
          const catIcon = { strat: '📐', hr: '👥', other: '📄' }[r.cat] || '📄';
          const ctx = r.snippet ? highlightText(r.snippet, [kw.toLowerCase()]) : '';
          return `<div class="bp-item" data-file="${escapeHtml(r.url)}" data-title="${escapeHtml(r.title)}">
            <span class="bp-item-icon">${catIcon}</span>
            <div class="bp-item-body">
              <div class="bp-item-title">${escapeHtml(r.title)}</div>
              ${ctx ? `<div class="bp-item-ctx">${ctx}</div>` : ''}
            </div>
          </div>`;
        }).join('');

        list.querySelectorAll('.bp-item').forEach(el => {
          el.addEventListener('click', () => {
            const file  = el.dataset.file;
            const title = el.dataset.title;
            closePopup();
            window._pendingHighlight = kw;
            if (typeof window.loadChapter === 'function') window.loadChapter(file, title);
          });
        });
      }

      /* 定位弹窗 */
      const rect = anchor.getBoundingClientRect();
      const popup = _popup;
      popup.style.top  = `${Math.min(rect.bottom + window.scrollY + 6, window.innerHeight + window.scrollY - 320)}px`;
      popup.style.left = `${Math.min(rect.left + window.scrollX, window.innerWidth + window.scrollX - 340)}px`;
      popup.classList.add('open');
    }

    function closePopup() {
      if (_popup) _popup.classList.remove('open');
    }

    return { build, processWikilinks, showBacklinks };
  })();


  /* ════════════════════════════════════════════════════════════
   *  G. 初始化
   * ════════════════════════════════════════════════════════════ */
  function init() {
    /* 等待 DOM 就绪 */
    const run = () => {
      SearchEngine.init();
      SearchUI.build();
      SearchUI.initShortcut();
      MatchNav.build();
      WikiLinks.build();
      WikiLinks.processWikilinks(document.body);
      hookIframe();
      handleURLHighlight();

      // 暴露全局 API（方便外部调用）
      window.CSUSearch = {
        open:         SearchUI.open.bind(SearchUI),
        close:        SearchUI.close.bind(SearchUI),
        highlight:    MatchNav.highlight.bind(MatchNav),
        clearHL:      MatchNav.clear.bind(MatchNav),
        backlinks:    WikiLinks.showBacklinks.bind(WikiLinks),
        processWiki:  WikiLinks.processWikilinks.bind(WikiLinks),
        engine:       SearchEngine
      };
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
    else run();
  }

  /* ── 辅助函数 ────────────────────────────────────────────── */
  function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  /* ── 启动 ────────────────────────────────────────────────── */
  init();

})();
