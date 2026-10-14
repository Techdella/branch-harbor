// <bh-topbar active="hq"> — shared global bar across all BranchHarbor surfaces (shadow DOM)
(function () {
  const APPS = [
    ['hub', 'Hub', 'BranchHarbor Hub.dc.html', 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z'],
    ['hq', 'HQ console', 'BranchHarbor HQ.dc.html', 'M4 21V4h16v17M9 8h2M13 8h2M9 12h2M13 12h2M10 21v-4h4v4'],
    ['location', 'Location console', 'BranchHarbor Location.dc.html', 'M3 9l2-5h14l2 5M3 9a3 3 0 006 0 3 3 0 006 0 3 3 0 006 0M5 12v9h14v-9'],
    ['marketing', 'Marketing & sales', 'BranchHarbor Marketing.dc.html', 'M3 11v2h4l6 4V7L7 11H3zM17 8a5 5 0 010 8'],
    ['business', 'Business suite', 'BranchHarbor Business.dc.html', 'M3 7h18v13H3zM9 7V5h6v2M3 13h18'],
    ['newloc', 'Open a location', 'BranchHarbor New Location.dc.html', 'M5 21V4M5 4h11l-2 4 2 4H5'],
    ['staff', 'Staff app', 'BranchHarbor Staff.dc.html', 'M7 2.5h10v19H7zM11 18h2'],
    ['mobile', 'Mobile consoles', 'BranchHarbor Mobile Consoles.dc.html', 'M7 2.5h10v19H7zM10 6h4'],
    ['sites', 'Customer websites', 'BranchHarbor Location Sites.dc.html', 'M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3a14 14 0 010 18'],
    ['custapp', 'Customer app', 'BranchHarbor Customer App.dc.html', 'M7 2.5h10v19H7zM9 15h6'],
    ['ops', 'Operations app', 'BranchHarbor App.dc.html', 'M3 12h4l3-8 4 16 3-8h4'],
    ['web', 'BranchHarbor.com', 'BranchHarbor Website.dc.html', 'M4 6h16v12H4zM4 9h16'],
    ['brand', 'Brand sheet', 'BranchHarbor Brand Sheet.dc.html', 'M12 3a9 9 0 000 18c1.5 0 2-1 2-2s-1-1.5-1-2.5 1-1.5 2-1.5h2a4 4 0 004-4c0-4.4-4-8-9-8z'],
  ];
  const IND = { studios: 'Studios', sports: 'Sports', health: 'Health & Wellness', commerce: 'Commerce', foods: 'Foods', realty: 'Real Estate' };
  const get = () => { let st = {}; try { st = JSON.parse(localStorage.getItem('bh.state') || '{}'); } catch (e) {} try { const h = new URLSearchParams(location.hash.slice(1)); ['ind', 'loc'].forEach(k => { if (h.get(k)) st[k] = h.get(k); }); } catch (e) {} st.ind = st.ind || 'studios'; return st; };
  const save = st => { try { localStorage.setItem('bh.state', JSON.stringify(st)); } catch (e) {} };
  window.BH_STATE = { get, set: p => { const st = { ...get(), ...p }; save(st); return st; } };
  const NOTES = [['HQ', 'Brand standards v4.0 needs your confirmation', '2h'], ['Finance', 'October royalty statement is ready', '5h'], ['Support', 'Ticket #482 was answered by HQ', '1d'], ['Marketing', 'Local ad request approved', '1d']];
  class Bar extends HTMLElement {
    connectedCallback() { this.st = get(); save(this.st); this.open = ''; this.render(); window.addEventListener('hashchange', () => { this.st = get(); save(this.st); this.render(); }); }
    link(href) { const p = new URLSearchParams(); p.set('ind', this.st.ind); if (this.st.loc) p.set('loc', this.st.loc); return href + '#' + p.toString(); }
    render() {
      const act = this.getAttribute('active') || '';
      const cur = APPS.find(a => a[0] === act) || APPS[0];
      const ico = (d, s) => `<svg width="${s || 16}" height="${s || 16}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
      const r = this.shadowRoot || this.attachShadow({ mode: 'open' });
      r.innerHTML = `<style>
        :host{display:block;position:relative;z-index:100;font-family:'Plus Jakarta Sans',system-ui,sans-serif}
        .bar{height:44px;background:#0B0B0B;color:#E6E6E3;display:flex;align-items:center;gap:8px;padding:0 12px;font-size:12px}
        button,a{font:inherit;color:inherit}
        .pill{display:flex;align-items:center;gap:6px;height:30px;padding:0 10px;border-radius:999px;border:1px solid #2A2A2A;background:transparent;cursor:pointer;text-decoration:none;font-weight:700;white-space:nowrap}
        .pill:hover{background:#1C1C1C}
        .logo{display:flex;align-items:center;gap:8px;font-weight:800;font-size:13px;text-decoration:none;color:#fff;margin-right:4px}
        .dot{width:18px;height:18px;border-radius:6px;background:#fff;display:flex;align-items:center;justify-content:center}.dot i{width:6px;height:6px;border-radius:3px;background:#D6F26B}
        .menu{position:absolute;top:48px;background:#fff;color:#141414;border-radius:20px;box-shadow:0 20px 60px rgba(0,0,0,.25);padding:10px;z-index:200}
        .grid{display:grid;grid-template-columns:repeat(3,150px);gap:4px}
        .app{display:flex;flex-direction:column;gap:6px;padding:12px;border-radius:14px;text-decoration:none;font-weight:700;font-size:12px}
        .app:hover{background:#F3F2EE}.app.on{background:#D6F26B}
        .app span{width:30px;height:30px;border-radius:10px;background:#F3F2EE;display:flex;align-items:center;justify-content:center}
        .row{display:flex;gap:10px;padding:10px;border-radius:12px;font-size:12px;line-height:1.4;width:300px}.row:hover{background:#F3F2EE}
        .tag{font-size:10px;font-weight:800;padding:2px 7px;border-radius:999px;background:#F3F2EE;height:fit-content}
        .opt{display:block;width:100%;text-align:left;padding:9px 12px;border-radius:10px;border:none;background:none;cursor:pointer;font-weight:600;font-size:13px}.opt:hover{background:#F3F2EE}.opt.on{background:#D6F26B}
        .sp{flex:1}
        @media (max-width:700px){.hide-s{display:none}}
      </style>
      <div class="bar">
        <a class="logo" href="${this.link('BranchHarbor Hub.dc.html')}"><span class="dot"><i></i></span><span class="hide-s">BranchHarbor</span></a>
        <button class="pill" data-m="apps">${ico(cur[3], 14)}${cur[1]}<span style="opacity:.6">▾</span></button>
        <button class="pill" data-m="ind">${IND[this.st.ind] || 'Studios'}<span style="opacity:.6">▾</span></button>
        <span class="sp"></span>
        <a class="pill hide-s" href="${this.link('BranchHarbor Business.dc.html')}&screen=support">${ico('M12 3a9 9 0 100 18 9 9 0 000-18zM9.5 9.5a2.5 2.5 0 014.9.7c0 1.7-2.4 2.3-2.4 3.8M12 17h.01', 14)}Help</a>
        <button class="pill" data-m="notes" aria-label="Notifications">${ico('M6 8a6 6 0 0112 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 003.4 0', 14)}<span style="background:#D6F26B;color:#141414;border-radius:999px;padding:0 6px;font-size:10px">${NOTES.length}</span></button>
      </div>
      ${this.open === 'apps' ? `<div class="menu" style="left:110px"><div class="grid">${APPS.map(a => `<a class="app ${a[0] === act ? 'on' : ''}" href="${this.link(a[2])}"><span>${ico(a[3], 15)}</span>${a[1]}</a>`).join('')}</div></div>` : ''}
      ${this.open === 'ind' ? `<div class="menu" style="left:260px;width:220px">${Object.entries(IND).map(([k, v]) => `<button class="opt ${k === this.st.ind ? 'on' : ''}" data-ind="${k}">${v}</button>`).join('')}</div>` : ''}
      ${this.open === 'notes' ? `<div class="menu" style="right:12px">${NOTES.map(n => `<div class="row"><span class="tag">${n[0]}</span><span style="flex:1">${n[1]}</span><span style="color:#5D5D58">${n[2]}</span></div>`).join('')}</div>` : ''}`;
      r.querySelectorAll('[data-m]').forEach(b => b.onclick = e => { e.stopPropagation(); this.open = this.open === b.dataset.m ? '' : b.dataset.m; this.render(); });
      r.querySelectorAll('[data-ind]').forEach(b => b.onclick = () => { this.st = { ...this.st, ind: b.dataset.ind, loc: '' }; save(this.st); const p = new URLSearchParams(location.hash.slice(1)); p.set('ind', b.dataset.ind); p.delete('loc'); location.hash = p.toString(); location.reload(); });
      if (!this._doc) { this._doc = true; document.addEventListener('click', () => { if (this.open) { this.open = ''; this.render(); } }); }
    }
  }
  if (!customElements.get('bh-topbar')) customElements.define('bh-topbar', Bar);
})();
