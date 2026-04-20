// ui.js — DOM manipulation helpers: bottom sheet, swatches, tabs, toasts

import { COLOR_PRESETS, TRENDING_SHADES, BEARD_PRESETS, getRecommendationsByUndertone } from './colors.js';

// ─── Toast ────────────────────────────────────────────────────────────────────

export function showToast(msg, duration = 3000) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('visible');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('visible'), duration);
}

// ─── Bottom Sheet Drag ────────────────────────────────────────────────────────

export function openSheet() {
  const sheet = document.getElementById('bottom-sheet');
  if (!sheet) return;
  sheet.style.transition = '';
  sheet.style.top = Math.floor(window.innerHeight * 0.70) + 'px';
}

export function closeSheet() {
  const sheet = document.getElementById('bottom-sheet');
  if (!sheet) return;
  sheet.style.transition = '';
  sheet.style.top = (window.innerHeight + 2) + 'px';
}

export function initBottomSheet() {
  const sheet  = document.getElementById('bottom-sheet');
  const handle = document.getElementById('sheet-handle');
  if (!sheet || !handle) return;

  let startY = 0, startTop = 0, dragging = false;

  function onStart(e) {
    dragging = true;
    startY   = (e.touches ? e.touches[0].clientY : e.clientY);
    startTop = sheet.getBoundingClientRect().top;
    sheet.style.transition = 'none';
    e.preventDefault();
  }

  function onMove(e) {
    if (!dragging) return;
    const currentY = e.touches ? e.touches[0].clientY : e.clientY;
    const delta    = currentY - startY;
    // Allow dragging from near top all the way off-screen to close
    const newTop   = Math.max(60, Math.min(window.innerHeight + 50, startTop + delta));
    sheet.style.top = newTop + 'px';
    e.preventDefault();
  }

  function onEnd() {
    if (!dragging) return;
    dragging = false;
    sheet.style.transition = '';
    const top = sheet.getBoundingClientRect().top;
    // If dragged past 90% of screen height → close; otherwise snap open
    if (top > window.innerHeight * 0.90) {
      closeSheet();
    } else {
      sheet.style.top = Math.floor(window.innerHeight * 0.70) + 'px';
    }
  }

  handle.addEventListener('touchstart', onStart, { passive: false });
  handle.addEventListener('touchmove',  onMove,  { passive: false });
  handle.addEventListener('touchend',   onEnd);
  handle.addEventListener('mousedown',  onStart);
  window.addEventListener('mousemove',  onMove);
  window.addEventListener('mouseup',    onEnd);
}

// ─── Tabs ────────────────────────────────────────────────────────────────────

export function initTabs(onTabChange) {
  document.querySelectorAll('[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-tab]').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.hidden = true);
      btn.classList.add('active');
      const panel = document.getElementById('panel-' + btn.dataset.tab);
      if (panel) panel.hidden = false;
      if (onTabChange) onTabChange(btn.dataset.tab);

      // Expand bottom sheet when a tab is selected.
      // Use window.innerHeight (actual visible height) instead of 50vh,
      // which on iOS Safari equals the large viewport and can place the
      // sheet below the visible screen when the address bar is showing.
      const sheet = document.getElementById('bottom-sheet');
      if (sheet) sheet.style.top = Math.floor(window.innerHeight * 0.70) + 'px';
    });
  });
}

// ─── Color Swatches ──────────────────────────────────────────────────────────

export function renderSwatches(containerId, colors, onSelect, selectedHex) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';

  colors.forEach(color => {
    const btn = document.createElement('button');
    btn.className   = 'swatch';
    btn.title       = color.name;
    btn.style.background = color.hex;
    if (color.hex === selectedHex) btn.classList.add('selected');
    btn.addEventListener('click', () => {
      container.querySelectorAll('.swatch').forEach(s => s.classList.remove('selected'));
      btn.classList.add('selected');
      onSelect(color);
    });
    container.appendChild(btn);
  });
}

export function renderAllSwatches(onSelect, selectedHex = null) {
  // Wrap callback so clicking a regular swatch also clears trending selection
  renderSwatches('swatches-primary', COLOR_PRESETS, (color) => {
    document.querySelectorAll('#swatches-trending .trending-card')
      .forEach(c => c.classList.remove('selected'));
    onSelect(color);
  }, selectedHex);
}

export function renderTrendingSwatches(onSelect, selectedHex = null) {
  const container = document.getElementById('swatches-trending');
  if (!container) return;
  container.innerHTML = '';

  TRENDING_SHADES.forEach(color => {
    const btn = document.createElement('button');
    btn.className = 'trending-card';
    if (color.hex === selectedHex) btn.classList.add('selected');

    btn.innerHTML = `
      <div class="trending-swatch" style="background:${color.hex}"></div>
      <div class="trending-meta">
        <span class="trending-name">${color.name}</span>
        <span class="trending-badge">${color.badge}</span>
      </div>`;

    btn.addEventListener('click', () => {
      // Clear both trending and regular swatch selections
      container.querySelectorAll('.trending-card').forEach(c => c.classList.remove('selected'));
      document.querySelectorAll('#swatches-primary .swatch').forEach(s => s.classList.remove('selected'));
      btn.classList.add('selected');
      onSelect(color);
    });
    container.appendChild(btn);
  });
}

export function renderSecondarySwatches(onSelect, selectedHex = null) {
  renderSwatches('swatches-secondary', COLOR_PRESETS, onSelect, selectedHex);
}

export function renderBeardSwatches(onSelect, selectedHex = null) {
  renderSwatches('swatches-beard', BEARD_PRESETS, onSelect, selectedHex);
}

export function renderRecommendations(undertone, onSelect) {
  const colors = getRecommendationsByUndertone(undertone);
  renderSwatches('swatches-recommend', colors, onSelect);
  const label = document.getElementById('undertone-label');
  if (label) {
    const map = { warm: 'Warm ✦', cool: 'Cool ✦', neutral: 'Neutral ✦' };
    label.textContent = `Your undertone: ${map[undertone] || undertone}`;
    label.hidden = false;
  }
  const resultEl = document.getElementById('recommendation-result');
  if (resultEl) resultEl.hidden = false;
}

// ─── Before / After Slider ───────────────────────────────────────────────────

export function initCompareSlider(originalCanvas, renderCanvas) {
  const wrapper = document.getElementById('compare-wrapper');
  const slider  = document.getElementById('compare-slider');
  const origEl  = document.getElementById('compare-original-img');
  if (!wrapper || !slider || !origEl) return;

  let pct = 50;

  const update = (x) => {
    const rect = wrapper.getBoundingClientRect();
    pct = Math.max(0, Math.min(100, ((x - rect.left) / rect.width) * 100));
    origEl.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
    slider.style.left     = pct + '%';
  };

  let dragging = false;
  slider.addEventListener('mousedown',  () => dragging = true);
  slider.addEventListener('touchstart', () => dragging = true, { passive: true });
  window.addEventListener('mouseup',   () => dragging = false);
  window.addEventListener('touchend',  () => dragging = false);
  window.addEventListener('mousemove', e => { if (dragging) update(e.clientX); });
  window.addEventListener('touchmove', e => {
    if (dragging) update(e.touches[0].clientX);
  }, { passive: true });

  // Initialize at 50%
  update(wrapper.getBoundingClientRect().left + wrapper.getBoundingClientRect().width * 0.5);
}
