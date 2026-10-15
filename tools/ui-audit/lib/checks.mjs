// In-page checks. `pageChecks` runs inside the browser via page.evaluate and must be self-contained.

/** Runs before any page script: records layout shifts (CLS) and their source nodes. */
export const INIT_SCRIPT = `
(() => {
  window.__bhShifts = [];
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.hadRecentInput) continue;
        window.__bhShifts.push({ value: e.value, sources: (e.sources || []).map((s) => s.node && s.node.nodeType === 1 ? (s.node.tagName.toLowerCase() + (s.node.id ? '#' + s.node.id : '')) : (s.node ? s.node.nodeName : '?')) });
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch (e) {}
})();
`;

/** Large-text emulation: double the root font size (rem-based type scales; px-based type does not). */
export const LARGE_TEXT_CSS = 'html{font-size:200% !important}';

export function pageChecks({ touch, tapMin, tapMinAA }) {
  const vw = document.documentElement.clientWidth;
  const out = { docOverflow: 0, overflowing: [], clipped: [], tapSmall: [], tapSmallAA: [], unsizedImages: [], cls: 0, clsSources: [], coarse: matchMedia('(pointer: coarse)').matches, sheets: document.styleSheets.length };

  const sel = (el) => {
    const parts = [];
    let n = el;
    for (let i = 0; n && n.nodeType === 1 && i < 3; i++, n = n.parentElement) {
      let s = n.tagName.toLowerCase();
      if (n.id) s += '#' + n.id;
      const cls = (typeof n.className === 'string' ? n.className : n.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 4);
      if (cls.length) s += '.' + cls.join('.');
      parts.unshift(s);
      if (n.id) break;
    }
    return parts.join(' > ').slice(0, 220);
  };
  const text = (el) => (el.innerText || el.getAttribute('aria-label') || el.getAttribute('alt') || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const visible = (el, r) => {
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.01;
  };
  const srOnly = (el) => {
    const cs = getComputedStyle(el);
    return cs.position === 'absolute' && (parseFloat(cs.width) <= 1 || cs.clip === 'rect(0px, 0px, 0px, 0px)' || cs.clipPath === 'inset(50%)');
  };
  // An ancestor that clips or scrolls horizontally contains overflow on purpose.
  const clippedByAncestor = (el) => {
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (/(auto|scroll|hidden|clip)/.test(cs.overflowX)) return true;
      if (cs.position === 'fixed') return false;
    }
    return false;
  };

  // 1. Horizontal overflow.
  const se = document.scrollingElement || document.documentElement;
  out.docOverflow = Math.max(0, se.scrollWidth - se.clientWidth);
  const all = document.body ? document.body.querySelectorAll('*') : [];
  const offenders = [];
  for (const el of all) {
    if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue;
    const r = el.getBoundingClientRect();
    if (!visible(el, r)) continue;
    if (r.right > vw + 1 || r.left < -1) {
      if (srOnly(el) || clippedByAncestor(el)) continue;
      const cs = getComputedStyle(el);
      if (cs.position === 'fixed' && (r.left >= vw || r.right <= 0)) continue; // off-canvas drawers
      offenders.push(el);
    }
  }
  // Keep the outermost offenders only.
  const set = new Set(offenders);
  for (const el of offenders) {
    let p = el.parentElement;
    let nested = false;
    while (p) {
      if (set.has(p)) {
        nested = true;
        break;
      }
      p = p.parentElement;
    }
    if (!nested) out.overflowing.push({ sel: sel(el), text: text(el), left: Math.round(el.getBoundingClientRect().left), right: Math.round(el.getBoundingClientRect().right), vw });
  }

  // 2. Clipped text: overflow hidden/clip, content wider/taller than the box, no ellipsis or line clamp.
  for (const el of all) {
    const cs = getComputedStyle(el);
    const hx = /(hidden|clip)/.test(cs.overflowX);
    const hy = /(hidden|clip)/.test(cs.overflowY);
    if (!hx && !hy) continue;
    if (cs.textOverflow === 'ellipsis' || (cs.webkitLineClamp && cs.webkitLineClamp !== 'none')) continue;
    const hasText = [...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim().length > 1);
    if (!hasText) continue;
    const r = el.getBoundingClientRect();
    if (!visible(el, r) || srOnly(el)) continue;
    const overX = hx && el.scrollWidth > el.clientWidth + 2;
    const overY = hy && el.scrollHeight > el.clientHeight + 3 && cs.display !== 'inline';
    if (overX || overY) out.clipped.push({ sel: sel(el), text: text(el), axis: overX ? 'x' : 'y', by: overX ? el.scrollWidth - el.clientWidth : el.scrollHeight - el.clientHeight });
  }

  // 3. Tap targets (touch viewports only).
  if (touch) {
    const interactive = document.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=switch], [role=checkbox], [role=radio], [role=menuitem], [role=option], [tabindex]:not([tabindex="-1"])');
    for (const el of interactive) {
      const r = el.getBoundingClientRect();
      if (!visible(el, r) || srOnly(el)) continue;
      if (el.disabled) continue;
      // Inline links inside running text are exempt (WCAG 2.5.8 "inline" exception).
      if (el.tagName === 'A') {
        const cs = getComputedStyle(el);
        const parent = el.parentElement;
        if (cs.display === 'inline' && parent && /^(P|LI|SPAN|SMALL|LABEL|TD|DD)$/.test(parent.tagName) && (parent.innerText || '').trim().length > (el.innerText || '').trim().length + 10) continue;
      }
      // A control may extend its hit area via a positioned ::before/::after.
      const pseudo = getComputedStyle(el, '::after');
      const pseudoB = getComputedStyle(el, '::before');
      const pw = Math.max(parseFloat(pseudo.width) || 0, parseFloat(pseudoB.width) || 0);
      const ph = Math.max(parseFloat(pseudo.height) || 0, parseFloat(pseudoB.height) || 0);
      const w = Math.max(r.width, pw);
      const h = Math.max(r.height, ph);
      // Form controls wrapped in (or labelled by) a label of at least 44 px: the label is the target.
      // (Deliberately strict — a 40 px label still counts as a small target.)
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) {
        const lab = el.closest('label') || (/^(checkbox|radio)$/.test(el.type) && el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`));
        if (lab) {
          const lr = lab.getBoundingClientRect();
          if (lr.height >= tapMin - 0.5 && lr.width >= tapMin) continue;
        }
      }
      if (w < tapMin || h < tapMin) {
        const item = { sel: sel(el), text: text(el), w: Math.round(w), h: Math.round(h) };
        out.tapSmall.push(item);
        if (w < tapMinAA || h < tapMinAA) out.tapSmallAA.push(item);
      }
    }
  }

  // 4. Images without intrinsic size hints (cause layout shift while loading).
  for (const img of document.images) {
    const r = img.getBoundingClientRect();
    if (r.width < 2) continue;
    const cs = getComputedStyle(img);
    const sized = (img.hasAttribute('width') && img.hasAttribute('height')) || cs.aspectRatio !== 'auto' || cs.position === 'absolute' || (img.style.width && img.style.height) || (cs.objectFit !== 'fill' && cs.height !== 'auto');
    if (!sized) out.unsizedImages.push({ sel: sel(img), src: (img.currentSrc || img.src).slice(0, 120) });
  }

  // 5. Layout shift.
  const shifts = window.__bhShifts || [];
  out.cls = Math.round(shifts.reduce((a, s) => a + s.value, 0) * 1000) / 1000;
  out.clsSources = [...new Set(shifts.flatMap((s) => s.sources))].slice(0, 6);

  for (const k of ['overflowing', 'clipped', 'tapSmall', 'tapSmallAA', 'unsizedImages']) out[k] = out[k].slice(0, 40);
  return out;
}

/** Focus visibility: Tab through the first `max` stops and compare focused vs blurred styles. */
export async function focusCheck(page, max = 20) {
  const missing = [];
  let checked = 0;
  await page.evaluate(() => {
    document.activeElement && document.activeElement.blur && document.activeElement.blur();
    window.scrollTo(0, 0);
  });
  const seen = new Set();
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const res = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const key = el.outerHTML.slice(0, 160);
      const props = ['outlineStyle', 'outlineWidth', 'outlineColor', 'boxShadow', 'backgroundColor', 'borderColor', 'color', 'textDecorationLine'];
      const snap = (e) => {
        const cs = getComputedStyle(e);
        const own = props.map((p) => cs[p]).join('|');
        // Indicators are sometimes drawn by a wrapper (focus-within) or a pseudo element.
        const parent = e.parentElement ? getComputedStyle(e.parentElement) : null;
        const pa = parent ? [parent.outlineStyle, parent.boxShadow, parent.borderColor].join('|') : '';
        const after = getComputedStyle(e, '::after');
        return own + '#' + pa + '#' + after.outlineStyle + after.boxShadow + after.borderColor;
      };
      const focused = snap(el);
      const cs = getComputedStyle(el);
      const hasOutline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
      const r = el.getBoundingClientRect();
      const tag = el.tagName.toLowerCase();
      const label = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('name') || '').replace(/\s+/g, ' ').trim().slice(0, 50);
      const cls = (el.getAttribute('class') || '').split(/\s+/).slice(0, 5).join('.');
      el.setAttribute('data-bh-focus-probe', '1');
      return { key, focused, hasOutline, visible: r.width > 1 && r.height > 1, tag, label, cls };
    });
    if (!res) continue;
    if (seen.has(res.key)) break;
    seen.add(res.key);
    if (!res.visible) continue;
    checked++;
    if (res.hasOutline) continue;
    const blurred = await page.evaluate(() => {
      const el = document.querySelector('[data-bh-focus-probe]');
      if (!el) return null;
      el.removeAttribute('data-bh-focus-probe');
      const props = ['outlineStyle', 'outlineWidth', 'outlineColor', 'boxShadow', 'backgroundColor', 'borderColor', 'color', 'textDecorationLine'];
      el.blur();
      const cs = getComputedStyle(el);
      const own = props.map((p) => cs[p]).join('|');
      const parent = el.parentElement ? getComputedStyle(el.parentElement) : null;
      const pa = parent ? [parent.outlineStyle, parent.boxShadow, parent.borderColor].join('|') : '';
      const after = getComputedStyle(el, '::after');
      const s = own + '#' + pa + '#' + after.outlineStyle + after.boxShadow + after.borderColor;
      el.focus({ focusVisible: true });
      return s;
    });
    await page.evaluate(() => document.querySelector('[data-bh-focus-probe]')?.removeAttribute('data-bh-focus-probe'));
    if (blurred !== null && blurred === res.focused) missing.push({ sel: `${res.tag}${res.cls ? '.' + res.cls : ''}`, text: res.label });
  }
  return { checked, missing };
}
