import { APP_NAME } from "./model.ts";

/** Single-file landing page: live preview plus a copy-paste markdown generator. No external assets. */
export function landingPage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${APP_NAME}</title>
<meta name="description" content="Album-art themed now-playing cards for your GitHub profile, powered by Last.fm.">
<style>
:root{--bg:#fbf9ff;--fg:#1b1b24;--muted:#5c5b6b;--card:#efecfa;--accent:#5b4bd5;--on:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0f0e17;--fg:#ece9ff;--muted:#a19fb8;--card:#1a1827;--accent:#b4a9ff;--on:#15122b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}
main{max-width:860px;margin:0 auto;padding:40px 16px 64px}
h1{font-size:clamp(2rem,6vw,3rem);margin:0 0 4px;letter-spacing:-.02em}p.lead{color:var(--muted);margin:0 0 28px;font-size:1.1rem}
.preview{background:var(--card);border-radius:28px;padding:16px;margin-bottom:20px}.preview img{display:block;width:100%;height:auto}
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
<div class="preview"><img id="img" alt="Now playing card preview" src="/api/now?demo=playing"></div>
<div class="row">
<label>Last.fm username<input id="user" placeholder="leave empty to see the demo" autocomplete="off" spellcheck="false"></label>
<label>Theme<select id="theme"><option value="expressive">Expressive</option><option value="minimal">Minimal</option><option value="terminal">Terminal</option></select></label>
<label>Colour mode<select id="mode"><option value="auto">Follow system</option><option value="dark">Dark</option><option value="light">Light</option></select></label>
<label>Motion<select id="still"><option value="">Animated</option><option value="1">Still</option></select></label>
</div>
<pre id="md"></pre>
<button id="copy" type="button">Copy markdown</button>
<small>Covers are official artwork only (Last.fm, iTunes, Genius); a track with none gets a generated placeholder instead of a wrong cover. GitHub shows a new card when the page is reloaded. ${APP_NAME} is an independent project and is not affiliated with Last.fm or any music player.</small>
<script>
const $=id=>document.getElementById(id);
function url(abs){const p=new URLSearchParams();const u=$('user').value.trim();
if(u)p.set('user',u);else p.set('demo','playing');
if($('theme').value!=='expressive')p.set('theme',$('theme').value);
if($('mode').value!=='auto')p.set('mode',$('mode').value);
if($('still').value)p.set('still','1');
return (abs?location.origin:'')+'/api/now?'+p}
let shown='';
function update(){const src=url(false);if(src!==shown){shown=src;$('img').src=src}const u=$('user').value.trim();const img='!['+(u||'now playing')+' on Last.fm]('+url(true)+')';$('md').textContent=u?'[' + img + '](https://www.last.fm/user/'+encodeURIComponent(u)+')':img}
// Typing a username waits for a pause instead of loading a card per keystroke; the dropdowns apply at once.
let typing;$('user').addEventListener('input',()=>{clearTimeout(typing);typing=setTimeout(update,450)});
['theme','mode','still'].forEach(i=>$(i).addEventListener('input',update));
$('copy').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('md').textContent);$('copy').textContent='Copied'}catch{$('copy').textContent='Select the text and copy'}setTimeout(()=>$('copy').textContent='Copy markdown',1800)});
update();
</script></main></body></html>`;
}
