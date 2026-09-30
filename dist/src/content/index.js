const H=["input","button","select","textarea","a","img",'[role="img"]','[role="button"]','[role="link"]','[role="textbox"]','[role="checkbox"]','[role="combobox"]','[role="menuitem"]','[contenteditable="true"]','[contenteditable=""]'].join(", "),G="span, div, p, li, td, th, h1, h2, h3, h4, h5, h6",K=300,Z={EMAIL:/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,PHONE:/\b(?:\+?[1-9]\d{0,2}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/,CREDIT_CARD:/\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b/,NATIONAL_ID:/\b[2-9]\d{3}\s?\d{4}\s?\d{4}\b/,ACCOUNT_NUM:/\b\d{9,18}\b/},J=["name","type","role","placeholder","aria-label","aria-labelledby","aria-describedby","aria-hidden","aria-expanded","aria-checked","aria-disabled","disabled","readonly","required","href","title","alt","value","data-testid"];function O(t){if(t.closest("#sih-privacy-overlay-root, #kw-detection-overlay-root, #kw-debug-highlights-container"))return{visible:!1,reason:"EXTENSION_OVERLAY",details:"Belongs to extension overlay"};const e=t.getBoundingClientRect();if(e.width===0||e.height===0)return{visible:!1,reason:"ZERO_DIMENSIONS",details:`width=${Math.round(e.width)}, height=${Math.round(e.height)}`};const o=window.innerWidth||document.documentElement.clientWidth,s=window.innerHeight||document.documentElement.clientHeight;if(e.bottom<=0||e.right<=0||e.top>=s||e.left>=o)return{visible:!1,reason:"OUT_OF_VIEWPORT",details:`top=${Math.round(e.top)}, bottom=${Math.round(e.bottom)}, vh=${s}`};const n=window.getComputedStyle(t);return n.display==="none"||n.visibility==="hidden"||n.visibility==="collapse"||n.opacity==="0"?{visible:!1,reason:"CSS_HIDDEN",details:`display=${n.display}, visibility=${n.visibility}, opacity=${n.opacity}`}:{visible:!0}}function Q(t){return O(t).visible}function Y(t){if(t.id&&t.id.trim()){const a=document.querySelector(`label[for="${CSS.escape(t.id.trim())}"]`);if(a){const r=(a.textContent||"").replace(/\s+/g," ").trim();if(r)return r}}const e=t.closest("label");if(e){const a=e.cloneNode(!0);a.querySelectorAll("input, button, select, textarea").forEach(d=>d.remove());const r=(a.textContent||"").replace(/\s+/g," ").trim();if(r)return r}const o=t.getAttribute("aria-label");if(o&&o.trim())return o.trim();const s=t.getAttribute("aria-labelledby");if(s){const a=document.getElementById(s);if(a){const r=(a.textContent||"").replace(/\s+/g," ").trim();if(r)return r}}const n=t.previousElementSibling;if(n&&!n.matches("input, button, select, textarea, a")){const a=(n.textContent||"").replace(/\s+/g," ").trim();if(a&&a.length<=80)return a}const i=t.parentElement;if(i){const a=i.cloneNode(!0);a.querySelectorAll("input, button, select, textarea").forEach(d=>d.remove());const r=(a.textContent||"").replace(/\s+/g," ").trim();if(r&&r.length<=80)return r}}function I(t){if(t.id&&typeof t.id=="string"&&t.id.trim()){const n=`#${CSS.escape(t.id.trim())}`;try{if(document.querySelectorAll(n).length===1)return n}catch{}}const e=[];let o=t;for(;o&&o.nodeType===Node.ELEMENT_NODE&&o!==document.documentElement;){const s=o.tagName.toLowerCase();if(o.id&&typeof o.id=="string"&&o.id.trim()){const d=`#${CSS.escape(o.id.trim())}`;try{if(document.querySelectorAll(d).length===1){e.unshift(d);break}}catch{}}const n=o.getAttribute("name");if(n&&o.parentElement){const r=`${s}[name="${CSS.escape(n)}"]`;if(o.parentElement.querySelectorAll(r).length===1){e.unshift(r),o=o.parentElement;continue}}let i=1,a=o.previousElementSibling;for(;a;)a.tagName.toLowerCase()===s&&i++,a=a.previousElementSibling;e.unshift(`${s}:nth-of-type(${i})`),o=o.parentElement}return e.join(" > ")}function L(t){const e=[];let o=t;for(;o&&o.nodeType===Node.ELEMENT_NODE;){let s=1,n=o.previousElementSibling;const i=o.tagName.toLowerCase();for(;n;)n.tagName.toLowerCase()===i&&s++,n=n.previousElementSibling;e.unshift(`${i}[${s}]`),o=o.parentElement}return"/"+e.join("/")}function S(t){const e=t.getAttribute("aria-label");if(e&&e.trim())return e.trim();const o=t.getAttribute("aria-labelledby");if(o){const r=document.getElementById(o);if(r&&r.textContent&&r.textContent.trim())return r.textContent.trim()}if(t instanceof HTMLInputElement||t instanceof HTMLTextAreaElement){if(t.placeholder&&t.placeholder.trim())return t.placeholder.trim();if(t.value&&t.value.trim()&&t.type!=="password")return t.value.trim()}const s=t.getAttribute("alt");if(s&&s.trim())return s.trim();const n=t.getAttribute("title");if(n&&n.trim())return n.trim();const a=((t instanceof HTMLElement?t.innerText:t.textContent)||"").replace(/\s+/g," ").trim();return a?a.length>120?a.slice(0,117)+"...":a:""}function q(t){const e={};for(const o of J){const s=t.getAttribute(o);s!==null&&s!==""&&(o==="value"&&t.getAttribute("type")==="password"?e[o]="[PROTECTED]":e[o]=s.trim())}return e}function tt(){const t=[];return document.querySelectorAll(H).forEach((o,s)=>{if(!(o instanceof Element)||!Q(o))return;const n=o.getBoundingClientRect(),i={x:Math.round(n.x),y:Math.round(n.y),width:Math.round(n.width),height:Math.round(n.height),top:Math.round(n.top),left:Math.round(n.left),right:Math.round(n.right),bottom:Math.round(n.bottom)},a=o.tagName.toLowerCase(),r=o.getAttribute("type")||(o instanceof HTMLInputElement||o instanceof HTMLButtonElement?o.type:void 0),d=o.getAttribute("role")||void 0,l=S(o),u=I(o),p=L(o),h=q(o);let b;["input","select","textarea"].includes(a)&&(b=Y(o)),t.push({id:o.id||`kw-el-${s}`,tagName:a,type:r||void 0,role:d||void 0,text:l,labelText:b,selector:u,xpath:p,bbox:i,attributes:h})}),t}function et(t){const e=[];for(const[o,s]of Object.entries(Z))new RegExp(s.source).test(t)&&e.push(o);return e}function V(){const t=[],e=new Set;return document.querySelectorAll(G).forEach((s,n)=>{if(!(s instanceof HTMLElement)||s.closest("#sih-privacy-overlay-root, #kw-detection-overlay-root, #kw-debug-highlights-container")||s.querySelector("input, button, select, textarea, a")||!O(s).visible)return;const a=(s.innerText||"").replace(/\s+/g," ").trim();if(!a||a.length<3||a.length>K)return;const r=a.toLowerCase().replace(/\s+/g,"");if(e.has(r))return;const d=et(a);if(d.length===0)return;e.add(r);const l=s.getBoundingClientRect(),u={x:Math.round(l.x),y:Math.round(l.y),width:Math.round(l.width),height:Math.round(l.height),top:Math.round(l.top),left:Math.round(l.left),right:Math.round(l.right),bottom:Math.round(l.bottom)};t.push({id:s.id||`kw-static-${n}`,tagName:s.tagName.toLowerCase(),text:a,selector:I(s),xpath:L(s),bbox:u,matchedPatterns:d})}),t}function A(){const t=document.querySelectorAll(H),e=[],o=[];t.forEach((n,i)=>{if(!(n instanceof Element))return;const a=O(n),r=n.getBoundingClientRect();if(!a.visible){o.push({element:n,tagName:n.tagName.toLowerCase(),text:S(n),reason:a.reason||"CSS_HIDDEN",details:a.details||"",rect:{width:Math.round(r.width),height:Math.round(r.height),top:Math.round(r.top),left:Math.round(r.left)}});return}const d={x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height),top:Math.round(r.top),left:Math.round(r.left),right:Math.round(r.right),bottom:Math.round(r.bottom)},l=n.tagName.toLowerCase(),u=n.getAttribute("type")||(n instanceof HTMLInputElement||n instanceof HTMLButtonElement?n.type:void 0),p=n.getAttribute("role")||void 0,h=S(n),b=I(n),E=L(n),g=q(n);let y;["input","select","textarea"].includes(l)&&(y=Y(n)),e.push({id:n.id||`kw-el-${i}`,tagName:l,type:u||void 0,role:p||void 0,text:h,labelText:y,selector:b,xpath:E,bbox:d,attributes:g})});const s=V();return{timestamp:Date.now(),viewport:W(),totalCandidates:t.length,extractedCount:e.length,skippedCount:o.length,staticTextNodeCount:s.length,extracted:e,skipped:o,staticTextNodes:s}}function W(){return{width:window.innerWidth||document.documentElement.clientWidth||0,height:window.innerHeight||document.documentElement.clientHeight||0,devicePixelRatio:window.devicePixelRatio||1}}const B="sih-privacy-overlay-root",P="kw-debug-highlights-container",D="kw-detection-overlay-root";function N(){let t=document.getElementById(B);return t||(t=document.createElement("div"),t.id=B,(document.body||document.documentElement).appendChild(t),ot(t)),t}function ot(t){if(t.querySelector(".sih-overlay-card"))return;const o=document.createElement("div");o.className="sih-overlay-card",o.setAttribute("role","status"),o.innerHTML=`
    <span class="sih-badge-shield">🛡️</span>
    <span class="sih-overlay-text">Keyboard Warriors: Privacy Guard</span>
  `,o.addEventListener("click",()=>{v("🔒 Active protection: Web content is sanitized locally before AI processing.")}),t.appendChild(o)}function v(t,e=3500){const o=N(),s=document.createElement("div");s.className="sih-toast",s.innerHTML=`
    <span style="font-size: 16px;">✨</span>
    <span>${t}</span>
  `,o.appendChild(s),setTimeout(()=>{s.style.opacity="0",s.style.transition="opacity 0.4s ease",setTimeout(()=>s.remove(),400)},e)}const m={face:{border:"#FF2D78",fill:"rgba(255, 45, 120, 0.16)",label:"#FF2D78"},person:{border:"#FFB020",fill:"rgba(255, 176, 32, 0.14)",label:"#FFB020"},pii:{border:"#E03131",fill:"rgba(224, 49, 49, 0.16)",label:"#E03131"},ocr:{border:"#0CA5E9",fill:"rgba(12, 165, 233, 0.08)",label:"#0CA5E9"},default:{border:"#7048E8",fill:"rgba(112, 72, 232, 0.12)",label:"#7048E8"}},M=300;function T(){var t;(t=document.getElementById(D))==null||t.remove()}function F(t,e,o,s,n){const i=m[o]??m.default,a=Math.max(0,Math.min(e.left,e.right)),r=Math.max(0,Math.min(e.top,e.bottom)),d=Math.max(a,Math.max(e.left,e.right)),l=Math.max(r,Math.max(e.top,e.bottom)),u=d-a,p=l-r;if(!isFinite(a)||!isFinite(r)||u<1||p<1)return!1;const h=document.createElement("div");h.style.cssText=`
    position: absolute;
    left: ${a}px;
    top: ${r}px;
    width: ${u}px;
    height: ${p}px;
    box-sizing: border-box;
    border: 2px solid ${i.border};
    background: ${i.fill};
    border-radius: 2px;
    pointer-events: none;
  `,h.title=n;const b=document.createElement("span");return b.style.cssText=`
    position: absolute;
    left: -2px;
    top: ${r<16?"-2px":"-15px"};
    transform: ${r<16?"translateY(0)":"translateY(-100%)"};
    max-width: 260px;
    overflow: hidden;
    text-overflow: ellipsis;
    background: ${i.label};
    color: #fff;
    font: 600 10px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    padding: 0 4px;
    border-radius: 2px;
    white-space: nowrap;
  `,b.textContent=s,h.appendChild(b),t.appendChild(h),!0}function X(t){var y,R,k;T();const{visionDetections:e=[],piiDetections:o=[],ocrTokens:s=[],viewport:n,layers:i}=t,a=(i==null?void 0:i.vision)!==!1,r=(i==null?void 0:i.pii)!==!1,d=(i==null?void 0:i.ocr)!==!1,l=document.createElement("div");l.id=D,l.style.cssText=`
    position: fixed;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    z-index: 2147483647;
    contain: layout style;
  `;let u=0,p=0;if(a)for(const c of e){const f=c.label==="face",x=`${Math.round((c.confidence??0)*100)}%`;F(l,c.bbox,f?"face":c.label==="person"?"person":"default",f?`FACE ${x}`:`${c.label.toUpperCase()} ${x}`,`${c.source} · ${c.label} · ${x}
box: ${Math.round(c.bbox.left)},${Math.round(c.bbox.top)} ${Math.round(c.bbox.width)}x${Math.round(c.bbox.height)}`)&&(f?u++:p++)}let h=0;if(r)for(const c of o){const f=(((y=c.sources)==null?void 0:y.length)??0)>1,x=f?m.person:m.pii,w=document.createElement("div"),z=Math.max(0,c.bbox.left),C=Math.max(0,c.bbox.top),U=Math.max(1,c.bbox.width),j=Math.max(1,c.bbox.height);w.style.cssText=`
        position: absolute;
        left: ${z}px;
        top: ${C}px;
        width: ${U}px;
        height: ${j}px;
        box-sizing: border-box;
        border: 2px ${f?"solid":"dashed"} ${x.border};
        background: ${x.fill};
        border-radius: 2px;
        pointer-events: none;
      `,w.title=`${c.type} · ${((R=c.sources)==null?void 0:R.join("+"))??c.source}
"${c.text}"`;const $=document.createElement("span");$.style.cssText=`
        position: absolute;
        left: -2px;
        top: ${C<16?"-2px":"-15px"};
        transform: ${C<16?"translateY(0)":"translateY(-100%)"};
        max-width: 260px;
        overflow: hidden;
        text-overflow: ellipsis;
        background: ${x.label};
        color: #fff;
        font: 600 10px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
        padding: 0 4px;
        border-radius: 2px;
        white-space: nowrap;
      `,$.textContent=`${c.type} · ${((k=c.sources)==null?void 0:k.join("+"))??c.source} · ${c.text.slice(0,6)}…`,w.appendChild($),l.appendChild(w),h++}let b=0;if(d){for(const c of s.slice(0,M))F(l,c.bbox,"ocr",c.text.slice(0,22),c.text)&&b++;if(s.length>M){const c=document.createElement("div");c.style.cssText=`
        position: absolute;
        left: 8px;
        bottom: 8px;
        background: ${m.ocr.label};
        color: #fff;
        font: 600 10px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
        padding: 2px 6px;
        border-radius: 2px;
      `,c.textContent=`OCR: showing ${M} of ${s.length} tokens`,l.appendChild(c)}}const E=document.createElement("div");E.style.cssText=`
    position: absolute;
    top: 8px;
    right: 8px;
    pointer-events: auto;
    background: rgba(15, 23, 42, 0.92);
    color: #E2E8F0;
    font: 600 11px/1.7 ui-monospace, SFMono-Regular, Menlo, monospace;
    padding: 6px 9px;
    border-radius: 6px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
    text-align: right;
  `;const g=(c,f)=>`<div><span style="color:${c}">■</span> ${f}</div>`;return E.innerHTML=[`<div style="opacity:.75;font-weight:500">detections @ ${Math.round((n==null?void 0:n.width)??0)}x${Math.round((n==null?void 0:n.height)??0)}</div>`,a?g(m.face.border,`face: ${u}`):"",a&&p?g(m.person.border,`objects: ${p}`):"",r?g(m.pii.border,`PII: ${h}`):"",r?g(m.person.border,"= DOM + OCR"):"",d?g(m.ocr.label,`OCR tokens: ${b}`):"",'<div style="opacity:.6;font-weight:500;margin-top:2px">Esc to dismiss</div>'].join(""),l.appendChild(E),(document.documentElement||document.body).appendChild(l),{faces:u,objects:p,pii:h,ocr:b}}function nt(){var r,d,l;const t=document.title||"Untitled Page",e=window.location.href,o=((d=(r=window.getSelection())==null?void 0:r.toString())==null?void 0:d.trim())||"",s=((l=document.querySelector('meta[name="description"]')||document.querySelector('meta[property="og:description"]'))==null?void 0:l.getAttribute("content"))||"",n=Array.from(document.querySelectorAll("h1, h2")).map(u=>{var p;return((p=u.textContent)==null?void 0:p.trim())||""}).filter(u=>u.length>0).slice(0,5),i=document.querySelector('main, article, #content, [role="main"]')||document.body,a=((i==null?void 0:i.textContent)||"").replace(/\s+/g," ").trim().slice(0,800);return{title:t,url:e,selectedText:o,metaDescription:s,headings:n,simplifiedContent:a,timestamp:Date.now()}}document.readyState==="loading"?document.addEventListener("DOMContentLoaded",()=>N()):N();document.addEventListener("keydown",t=>{t.key==="Escape"&&document.getElementById(D)&&T()});const _={audit(){const t=A();return console.group("%c🛡️ [Keyboard Warriors] DOM Extraction Audit Report","color: #4285F4; font-weight: bold; font-size: 13px;"),console.log(`%cViewport: ${t.viewport.width}x${t.viewport.height} (DPR: ${t.viewport.devicePixelRatio})`,"color: #9B72CF;"),console.log(`%cCandidates Scanned: ${t.totalCandidates} | Extracted (Visible): ${t.extractedCount} | Missed/Filtered: ${t.skippedCount}`,"color: #10B981; font-weight: bold;"),console.groupCollapsed(`%c✅ Extracted Elements (${t.extractedCount})`,"color: #10B981; font-weight: bold;"),console.table(t.extracted.map(e=>({id:e.id,tag:e.tagName,type:e.type||"-",role:e.role||"-",text:e.text||"(empty)",selector:e.selector,bbox:`[${e.bbox.x}, ${e.bbox.y}, ${e.bbox.width}x${e.bbox.height}]`}))),console.groupEnd(),console.groupCollapsed(`%c⚠️ Missed / Filtered Elements (${t.skippedCount})`,"color: #F59E0B; font-weight: bold;"),console.table(t.skipped.map(e=>({tag:e.tagName,text:e.text||"(empty)",reason:e.reason,details:e.details,dimensions:`${e.rect.width}x${e.rect.height}`,position:`top:${e.rect.top}, left:${e.rect.left}`}))),console.groupCollapsed(`%c🔤 Static PII Text Nodes (${t.staticTextNodeCount??0})`,"color: #F87171; font-weight: bold;"),console.table((t.staticTextNodes||[]).map(e=>({id:e.id,tag:e.tagName,text:e.text.length>60?e.text.slice(0,57)+"...":e.text,patterns:e.matchedPatterns.join(", "),selector:e.selector,bbox:`[${e.bbox.x}, ${e.bbox.y}, ${e.bbox.width}x${e.bbox.height}]`}))),console.groupEnd(),console.groupEnd(),t},highlight(t=1e4){_.clearHighlights();const e=A(),o=document.createElement("div");o.id=P,o.style.cssText="position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 2147483646;";const s=window.scrollX||window.pageXOffset,n=window.scrollY||window.pageYOffset;e.extracted.forEach((i,a)=>{const r=document.createElement("div");r.style.cssText=`
        position: absolute;
        left: ${i.bbox.left+s}px;
        top: ${i.bbox.top+n}px;
        width: ${i.bbox.width}px;
        height: ${i.bbox.height}px;
        border: 2px solid #10B981;
        background: rgba(16, 185, 129, 0.12);
        box-sizing: border-box;
        border-radius: 4px;
        pointer-events: none;
      `;const d=document.createElement("span");d.style.cssText=`
        position: absolute;
        top: -16px;
        left: 0;
        background: #10B981;
        color: #000;
        font-size: 10px;
        font-family: monospace;
        font-weight: bold;
        padding: 0 4px;
        border-radius: 2px;
        white-space: nowrap;
      `,d.textContent=`#${a+1} <${i.tagName}>`,r.appendChild(d),o.appendChild(r)}),document.body.appendChild(o),t>0&&setTimeout(()=>_.clearHighlights(),t)},clearHighlights(){const t=document.getElementById(P);t&&t.remove()},renderOverlay(t){const e=X(t);return console.group("%c🖼️ [Keyboard Warriors] Detection Overlay","color: #FF2D78; font-weight: bold;"),console.log("Drawn:",e),console.groupEnd(),e},clearOverlay(){T()},async getScreenAndDom(){return new Promise(t=>{chrome.runtime.sendMessage({type:"GET_SCREEN_AND_DOM"},e=>{var o;console.group("%c📸 [Keyboard Warriors] Screen & DOM Result","color: #4285F4; font-weight: bold;"),console.log("Result payload:",e),e!=null&&e.success&&((o=e==null?void 0:e.payload)!=null&&o.screenshotUrl)&&console.log("%cScreenshot captured successfully! (Open URL below or view in Sources)","color: #10B981;"),console.groupEnd(),t(e)})})}};window.__KW_DEBUG__=_;chrome.runtime.onMessage.addListener((t,e,o)=>{var n;switch(t==null?void 0:t.type){case"PING":return o({type:"PONG",payload:{ready:!0,url:window.location.href},sender:"content_script"}),!1;case"GET_TAB_CONTEXT":{const i=nt();return o({type:"TAB_CONTEXT_RESPONSE",payload:i,sender:"content_script"}),!1}case"EXTRACT_DOM":{try{if((n=t.payload)!=null&&n.includeAudit){const i=A();o({success:!0,payload:i,sender:"content_script"})}else{const i=tt(),a=W(),r=V();o({success:!0,payload:{elements:i,viewport:a,staticTextNodes:r},sender:"content_script"})}}catch(i){o({success:!1,error:String(i),sender:"content_script"})}return!1}case"RENDER_DETECTION_OVERLAY":{try{const i=X(t.payload);o({success:!0,drawn:i,sender:"content_script"})}catch(i){o({success:!1,error:(i==null?void 0:i.message)||String(i),sender:"content_script"})}return!1}case"CLEAR_DETECTION_OVERLAY":return T(),o({success:!0,sender:"content_script"}),!1;case"EXECUTE_ACTION":{const i=t.payload;if((i==null?void 0:i.actionType)==="SHOW_PRIVACY_TOAST")v(i.message||"Keyboard Warriors action executed"),o({success:!0,executed:"SHOW_PRIVACY_TOAST"});else if((i==null?void 0:i.actionType)==="INSPECT_PAGE_PRIVACY"){const r=document.querySelectorAll("input").length;v(`🔒 Privacy audit complete: ${r} input field(s) analyzed.`),o({success:!0,fieldCount:r})}else v((i==null?void 0:i.message)||"Action executed successfully."),o({success:!0});return!1}default:return!1}});
