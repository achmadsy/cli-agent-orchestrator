/**
 * metrics.js — System metrics + LLM usage rendering
 *
 * LLM groups are rendered dynamically from backend `llm` dict.
 * Provider/metric labels have known mappings with uppercase fallback,
 * so new providers or metrics from agent-metrics appear automatically.
 */

(function() {
  const tmuxStatusEl = document.getElementById('tmux-status');

  // Display labels — unknown keys fall back to UPPERCASED key
  const PROVIDER_LABELS = { cc: 'CLAUDE', cx: 'CODEX', gm: 'GEMINI' };
  const METRIC_LABELS = { '5h': '5H', '7d': '7D', 'ex': 'EX', 'pro': 'Pro', 'flash': 'Flash',
    '5h_resets_at': '↺5H', '7d_resets_at': '↺7D', 'daily_resets_at': '↺1D' };
  // Render order: providers first, then metrics within each provider; unknowns appended
  const PROVIDER_ORDER = ['cc', 'cx', 'gm'];
  const METRIC_ORDER = ['flash', '5h', '5h_resets_at', '7d', '7d_resets_at', 'ex', 'pro', 'daily_resets_at'];

  // *_resets_at values arrive as full ISO timestamps (UTC) — unreadable in a
  // status bar. Render as local-time 月/日 時:分, hidden by default; a
  // double-click or ~600ms long-press on the bar toggles them (all providers).
  function fmtReset(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    const p = n => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function renderMetrics(m) {
    if (!m) { tmuxStatusEl.style.display = 'none'; return; }
    tmuxStatusEl.style.display = '';
    const sep = '<span class="ms-sep">|</span>';
    const parts = [];

    // System metrics
    if (m.net) parts.push(`<span class="ms-net"><span class="ms-label">NET</span><span class="ms-val">${escHtml(m.net)}</span></span>`);
    if (m.cpu) parts.push(`<span class="ms-cpu"><span class="ms-label">CPU</span><span class="ms-val">${escHtml(m.cpu)}</span></span>`);
    if (m.mem) parts.push(`<span class="ms-mem"><span class="ms-label">MEM</span><span class="ms-val">${escHtml(m.mem)}</span></span>`);
    if (m.disk) parts.push(`<span class="ms-disk"><span class="ms-label">DISK</span><span class="ms-val">${escHtml(m.disk)}</span></span>`);

    // LLM Usage — dynamic rendering
    if (m.llm && typeof m.llm === 'object') {
      const providers = Object.keys(m.llm);
      providers.sort((a, b) => {
        const ia = PROVIDER_ORDER.indexOf(a), ib = PROVIDER_ORDER.indexOf(b);
        if (ia >= 0 && ib >= 0) return ia - ib;
        if (ia >= 0) return -1;
        if (ib >= 0) return 1;
        return a.localeCompare(b);
      });

      for (const provider of providers) {
        const metrics = m.llm[provider];
        if (!metrics || typeof metrics !== 'object') continue;
        const entries = Object.entries(metrics).filter(([k, v]) => {
          if (!v || v === '?') return false;
          // Claude Ex: 餘額耗盡（off / 0% / 負值）時不顯示
          if (provider === 'cc' && k === 'ex' && (v === 'off' || v === '0%' || /余\$-/.test(v) || /余\$0\.00/.test(v))) return false;
          return true;
        });
        if (!entries.length) continue;
        entries.sort((a, b) => {
          const ia = METRIC_ORDER.indexOf(a[0]), ib = METRIC_ORDER.indexOf(b[0]);
          if (ia >= 0 && ib >= 0) return ia - ib;
          if (ia >= 0) return -1;
          if (ib >= 0) return 1;
          return a[0].localeCompare(b[0]);
        });

        const label = PROVIDER_LABELS[provider] || provider.toUpperCase();
        let g = `<span class="usage-group" data-provider="${escHtml(provider)}"><span class="usage-group-label">${escHtml(label)}</span>`;
        for (const [metric, value] of entries) {
          const mLabel = METRIC_LABELS[metric] || metric.toUpperCase();
          const isReset = /_resets_at$/.test(metric);
          const cls = isReset ? ' ms-reset' : '';
          const val = isReset ? fmtReset(value) : value;
          g += `<span class="ms-llm${cls} ms-${escHtml(provider)}-${escHtml(metric)}"><span class="ms-label">${escHtml(mLabel)}</span><span class="ms-val">${escHtml(val)}</span></span>`;
        }
        g += '</span>';
        parts.push(g);
      }
    }

    tmuxStatusEl.innerHTML = parts.join(sep);
  }

  // Reset-time visibility toggle: double-click or long-press on the bar.
  function toggleResets() { tmuxStatusEl.classList.toggle('show-resets'); }
  let pressT = null;
  tmuxStatusEl.addEventListener('dblclick', toggleResets);
  tmuxStatusEl.addEventListener('pointerdown', () => { clearTimeout(pressT); pressT = setTimeout(toggleResets, 600); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev =>
    tmuxStatusEl.addEventListener(ev, () => clearTimeout(pressT)));

  // Expose
  window.renderMetrics = renderMetrics;
})();
