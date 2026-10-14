import { APP_NAME } from "./model.ts";

/**
 * Single-file landing page: a live preview plus a copy-paste snippet generator. No external assets.
 *
 * With a username (typed, from ?user=, or the instance owner by default) the preview is live: it checks the card's
 * key with a HEAD request every few seconds while the tab is visible and swaps the image only when what the card
 * shows has changed, so a new song appears without reloading the page.
 */
export function landingPage(owner?: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${APP_NAME}</title>
<meta name="description" content="Album-art themed now-playing cards for your GitHub profile, powered by Last.fm.">
<style>
:root{--bg:#fbf9ff;--fg:#1b1b24;--muted:#5c5b6b;--card:#efecfa;--accent:#5b4bd5;--on:#fff;--live:#1f7a4d;--live-bg:#d7f5e3}
@media (prefers-color-scheme:dark){:root{--bg:#0f0e17;--fg:#ece9ff;--muted:#a19fb8;--card:#1a1827;--accent:#b4a9ff;--on:#15122b;--live:#8ee0b0;--live-bg:#173326}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}
main{max-width:860px;margin:0 auto;padding:40px 16px 64px}
h1{font-size:clamp(2rem,6vw,3rem);margin:0 0 4px;letter-spacing:-.02em}p.lead{color:var(--muted);margin:0 0 28px;font-size:1.1rem}
.preview{position:relative;background:var(--card);border-radius:28px;padding:16px;margin-bottom:20px}
.preview img{display:block;width:100%;height:auto;aspect-ratio:480/150}
.chip{position:absolute;top:-14px;right:20px;display:inline-flex;align-items:center;gap:8px;padding:4px 14px 4px 12px;border-radius:999px;font-size:.8rem;font-weight:600;background:var(--card);color:var(--muted);border:2px solid var(--bg)}
.chip i{width:8px;height:8px;border-radius:50%;background:currentColor}
.chip.live{background:var(--live-bg);color:var(--live)}.chip.live i{animation:pulse 1.6s ease-in-out infinite}
@keyframes pulse{50%{opacity:.25}}@media (prefers-reduced-motion:reduce){.chip.live i{animation:none}}
.row{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:16px}
label{display:flex;flex-direction:column;gap:4px;font-size:.85rem;color:var(--muted);flex:1 1 160px}
input,select{font:inherit;color:var(--fg);background:var(--card);border:2px solid transparent;border-radius:14px;padding:10px 12px}
input:focus-visible,select:focus-visible,button:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
pre{background:var(--card);border-radius:18px;padding:16px;overflow:auto;font:14px/1.5 ui-monospace,Consolas,monospace;margin:0 0 12px;white-space:pre-wrap;word-break:break-all}
button{font:inherit;font-weight:600;background:var(--accent);color:var(--on);border:0;border-radius:999px;padding:10px 22px;cursor:pointer}
small{color:var(--muted);display:block;margin-top:28px}
</style></head><body><main>
<h1>${APP_NAME}</h1>
<p class="lead">A now-playing card for your GitHub profile. It borrows its colours from the album art, works with anything that scrobbles to Last.fm, and looks intentional even when nothing is playing.</p>
<div class="preview"><span id="live" class="chip" role="status"><i></i><span id="live-text">Demo</span></span><img id="img" alt="Now playing card preview" width="480" height="150"></div>
<div class="row">
<label>Last.fm username<input id="user" placeholder="leave empty to see the demo" autocomplete="off" spellcheck="false"></label>
<label>Theme<select id="theme"><option value="expressive">Expressive</option><option value="minimal">Minimal</option><option value="terminal">Terminal</option></select></label>
<label>Colour mode<select id="mode"><option value="auto">Follow system</option><option value="dark">Dark</option><option value="light">Light</option></select></label>
<label>Motion<select id="still"><option value="">Animated</option><option value="1">Still</option></select></label>
</div>
<pre id="md"></pre>
<button id="copy" type="button">Copy snippet</button>
<small>This preview updates by itself while the tab is open. On GitHub the card is fresh on every page load; the width and height in the snippet keep its space reserved while it loads, so the section never collapses. Covers are official artwork only (Last.fm, Genius, iTunes); a track with none gets a generated placeholder instead of a wrong cover. ${APP_NAME} is an independent project and is not affiliated with Last.fm or any music player.</small>
<script>
const $=id=>document.getElementById(id);
const HEIGHT={expressive:150,minimal:87,terminal:150};
const POLL_MS=4000;
const q=new URLSearchParams(location.search);
$('user').value=q.get('user')??${JSON.stringify(owner ?? "")};
for(const k of ['theme','mode'])if(q.get(k)&&[...$(k).options].some(o=>o.value===q.get(k)))$(k).value=q.get(k);
if(q.get('still')==='1')$('still').value='1';
function params(){const p=new URLSearchParams();const u=$('user').value.trim();
if(u)p.set('user',u);else p.set('demo','playing');
if($('theme').value!=='expressive')p.set('theme',$('theme').value);
if($('mode').value!=='auto')p.set('mode',$('mode').value);
if($('still').value)p.set('still','1');return p}
// The preview sits on this page's own background, so its corners stay clear; the snippet keeps GitHub's.
const cardUrl=abs=>{const p=params();if(!abs)p.set('corners','clear');return (abs?location.origin:'')+'/api/now?'+p};
function chip(state,text){$('live').className='chip'+(state==='live'?' live':'');$('live-text').textContent=text}
// Live preview: a HEAD request returns only the card's key; the image is fetched and swapped only when it changes.
let key=null,timer=0,fails=0,gen=0;
async function swap(src,g){const r=await fetch(src,{cache:'no-store'});if(!r.ok)throw new Error(String(r.status));
const blob=await r.blob();if(g!==gen)return;const next=URL.createObjectURL(blob);
await new Promise(done=>{const im=new Image();im.onload=im.onerror=done;im.src=next});
if(g!==gen){URL.revokeObjectURL(next);return}
const old=$('img').src;$('img').src=next;if(old.startsWith('blob:'))URL.revokeObjectURL(old);
key=r.headers.get('X-Tidemark-Key')}
async function poll(){clearTimeout(timer);const g=gen;
if(!$('user').value.trim())return;
if(document.hidden){chip('paused','Paused');return}
const src=cardUrl(false);
try{const r=await fetch(src,{method:'HEAD',cache:'no-store'});if(!r.ok)throw new Error(String(r.status));
// The first check only learns the key of the card already showing; later ones swap it when the key changes.
const k=r.headers.get('X-Tidemark-Key');if(g!==gen)return;if(key===null)key=k;else if(k&&k!==key)await swap(src,g)
if(g!==gen)return;fails=0;chip('live','Live')}
catch{if(g!==gen)return;fails++;chip('retry','Reconnecting')}
timer=setTimeout(poll,fails?Math.min(30000,POLL_MS*2**fails):POLL_MS)}
function show(src){const old=$('img').src;$('img').src=src;if(old.startsWith('blob:'))URL.revokeObjectURL(old)}
function update(){gen++;key=null;clearTimeout(timer);const u=$('user').value.trim();
const shown=new URLSearchParams(params());shown.delete('demo');history.replaceState(null,'',shown.toString()?'?'+shown:location.pathname);
const h=HEIGHT[$('theme').value]||150;$('img').style.aspectRatio='480/'+h;$('img').height=h;
// The card is shown at once by a normal image load (no empty frame while a first check runs).
show(cardUrl(false));if(u){chip('retry','Connecting');poll()}else chip('demo','Demo');
const alt=(u||'Now playing')+' on Last.fm';const img='<img src="'+cardUrl(true)+'" alt="'+alt+'" width="480" height="'+h+'">';
$('md').textContent=u?'<a href="https://www.last.fm/user/'+encodeURIComponent(u)+'">'+img+'</a>':img}
// Typing a username waits for a pause instead of loading a card per keystroke; the dropdowns apply at once.
let typing;$('user').addEventListener('input',()=>{clearTimeout(typing);typing=setTimeout(update,450)});
['theme','mode','still'].forEach(i=>$(i).addEventListener('input',update));
document.addEventListener('visibilitychange',()=>{if(!document.hidden)poll();else{clearTimeout(timer);if($('user').value.trim())chip('paused','Paused')}});
$('copy').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('md').textContent);$('copy').textContent='Copied'}catch{$('copy').textContent='Select the text and copy'}setTimeout(()=>$('copy').textContent='Copy snippet',1800)});
update();
</script></main></body></html>`;
}
