// scripts/views/live.mjs — the Live activity view (per-ticket agent activity).

export function render() {
  return `<div class="live"><div class="empty">Loading live activity…</div></div>`;
}

// CSS moved verbatim from serve.mjs (the .live / .livecard / .lc-* rules).
export const styles = `
  .live { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px; padding: 16px 20px; }
  .livecard { background: #161b22; border: 1px solid #21262d; border-left: 3px solid #444c56; border-radius: 10px; padding: 10px 12px; }
  .livecard.active { border-left-color: var(--blaze-orange); }
  .lc-top { display: flex; align-items: center; gap: 8px; }
  .lc-dot { width: 8px; height: 8px; border-radius: 999px; background: #444c56; }
  .lc-dot.on { background: var(--blaze-orange); box-shadow: 0 0 0 3px #ff7a0033; }
  .lc-age { margin-left: auto; color: #7d8590; font-size: 11px; }
  .lc-now { margin-top: 6px; color: #c9d1d9; }
  .lc-meta { margin-top: 6px; display: flex; gap: 8px; color: #7d8590; font-size: 11px; flex-wrap: wrap; }
  .lc-col { background: #21314a; color: #79c0ff; padding: 1px 6px; border-radius: 999px; }`;

// The pollLive script moved verbatim from serve.mjs (contents of the live <script>).
export const clientScript = `
    // Live view: poll /api/live and render cards. Runs only meaningful work when
    // the Live view is active; degrades to a no-data message on error/empty.
    function fmtAge(ms){var s=Math.floor(Math.max(0,ms)/1000);if(s<5)return"now";if(s<60)return s+"s ago";var m=Math.floor(s/60);if(m<60)return m+"m ago";var h=Math.floor(m/60);if(h<24)return h+"h ago";return Math.floor(h/24)+"d ago";}
    function esc(x){return String(x==null?"":x).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c];});}
    async function pollLive(){
      const el=document.querySelector(".live"); if(!el) return;
      if(document.documentElement.dataset.view!=="live") return;
      try{
        const {groups}=await (await fetch("/api/live")).json();
        if(!groups||!groups.length){ el.innerHTML='<div class="empty">No recent activity.</div>'; return; }
        el.innerHTML=groups.map(function(g){return '<article class="livecard '+(g.active?"active":"idle")+'">'
          +'<div class="lc-top"><span class="id">'+esc(g.key)+'</span><span class="lc-dot '+(g.active?"on":"")+'"></span><span class="lc-age">'+esc(fmtAge(g.ageMs))+'</span></div>'
          +'<div class="lc-now">now: <strong>'+esc(g.tool)+'</strong></div>'
          +'<div class="lc-meta">'+(g.column?'<span class="lc-col">'+esc(g.column)+'</span>':'')+'<span class="lc-branch">'+esc(g.branch)+'</span></div>'
          +'</article>';}).join("");
      }catch(e){ el.innerHTML='<div class="empty">live activity offline</div>'; }
    }
    document.querySelectorAll('.viewtoggle .pill[data-view="live"]').forEach(function(b){b.addEventListener("click", pollLive);});
    pollLive(); setInterval(pollLive, 3000);
  `;
