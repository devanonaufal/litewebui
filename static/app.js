(() => {

  const $ = (s) => document.querySelector(s);

  const loginEl = $("#login");

  const appEl = $("#app");

  const loginForm = $("#login-form");

  const loginErr = $("#login-err");

  const convList = $("#conv-list");

  const pinnedList = $("#pinned-list");

  const pinnedBlock = $("#pinned-block");

  const archivedList = $("#archived-list");

  const archivedBlock = $("#archived-block");

  const convMenu = $("#conv-menu");

  const messagesEl = $("#messages");

  const emptyEl = $("#empty");

  const input = $("#input");

  const modelSel = $("#model");

  const chatTitle = $("#chat-title");

  const backdrop = $("#sidebar-backdrop");

  const sidebar = document.querySelector(".sidebar");



  function systemPrefersLight() {

    try {

      return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;

    } catch {

      return false;

    }

  }



  function resolveTheme(pref) {

    const p = pref || "light";

    if (p === "system") return systemPrefersLight() ? "light" : "dark";

    return p === "light" ? "light" : "dark";

  }



  function syncThemeCards(pref) {

    document.querySelectorAll(".theme-card").forEach((btn) => {

      btn.classList.toggle("active", btn.getAttribute("data-theme") === pref);

    });

  }



  function applyTheme(pref) {

    let p = pref || "light";

    if (p !== "light" && p !== "dark" && p !== "system") p = "light";

    try { localStorage.setItem("litewebui_theme", p); } catch { /* ignore */ }

    const resolved = resolveTheme(p);

    document.documentElement.classList.remove("theme-dark", "theme-light", "dark", "light");

    document.documentElement.classList.add(resolved === "light" ? "theme-light" : "theme-dark");

    document.documentElement.classList.add(resolved);

    const meta = document.querySelector('meta[name="theme-color"]');

    if (meta) meta.setAttribute("content", resolved === "light" ? "#f4f5f7" : "#212121");

    syncThemeCards(p);

  }



  function initTheme() {

    let p = "light";

    try {

      p = localStorage.getItem("litewebui_theme") || "light";

    } catch { /* ignore */ }

    applyTheme(p);

    try {

      const mq = window.matchMedia("(prefers-color-scheme: light)");

      const onChange = () => {

        try {

          if ((localStorage.getItem("litewebui_theme") || "light") === "system") applyTheme("system");

        } catch { /* ignore */ }

      };

      if (mq.addEventListener) mq.addEventListener("change", onChange);

      else if (mq.addListener) mq.addListener(onChange);

    } catch { /* ignore */ }

  }

  initTheme();

  let menuOpen = false;



  function setChatTitle(t) {

    if (!chatTitle) return;

    let title = (t || "Chat").trim() || "Chat";

    if (/^komboku$/i.test(title)) title = "New chat";

    chatTitle.textContent = title;

  }

  let convs = [];

  let currentId = null;

  let streaming = false;



  /** @type {{id:string,name:string,content_type:string,size:number,url:string,preview?:string}[]} */

  let pendingFiles = [];

  const fileInput = $("#file-input");

  const attachPreview = $("#attach-preview");

  const btnAttach = $("#btn-attach");

  const btnSend = $("#btn-send");

  let privateMode = false;

  let currentIsPrivate = false;

  let dictationOn = false;

  let voiceModeOn = false;

  let recDict = null;

  let recVoice = null;

  let dictBase = "";

  let voiceListenArmed = false;

  let recMedia = null;

  let mediaStream = null;

  let mediaChunks = [];

  let mediaMode = null;

  let mediaMime = "";



  function renderAttachPreview() {

    if (!attachPreview) return;

    if (!pendingFiles.length) {

      attachPreview.classList.add("hidden");

      attachPreview.innerHTML = "";

      return;

    }

    attachPreview.classList.remove("hidden");

    attachPreview.innerHTML = "";

    pendingFiles.forEach((f, idx) => {

      const chip = document.createElement("div");

      chip.className = "attach-chip";

      if (f.content_type && f.content_type.startsWith("image/") && f.preview) {

        const img = document.createElement("img");

        img.src = f.preview;

        img.alt = f.name;

        chip.appendChild(img);

      }

      const name = document.createElement("span");

      name.className = "name";

      name.textContent = f.name;

      name.title = f.name;

      chip.appendChild(name);

      const rm = document.createElement("button");

      rm.type = "button";

      rm.className = "rm";

      rm.setAttribute("aria-label", "Remove");

      rm.innerHTML = "&times;";

      rm.onclick = () => {

        if (f.preview) URL.revokeObjectURL(f.preview);

        pendingFiles.splice(idx, 1);

        renderAttachPreview();

      };

      chip.appendChild(rm);

      attachPreview.appendChild(chip);

    });

    syncSendEnabled();

  }



  async function uploadFile(file) {

    const fd = new FormData();

    fd.append("file", file, file.name || "paste.png");

    const r = await api("/api/files", { method: "POST", body: fd });

    if (!r.ok) {

      const t = await r.text();

      throw new Error(t || "upload failed");

    }

    return r.json();

  }



  async function addLocalFiles(fileList) {

    const files = [...(fileList || [])].filter(Boolean);

    if (!files.length) return;

    for (const file of files) {

      try {

        const meta = await uploadFile(file);

        if (meta.content_type && meta.content_type.startsWith("image/")) {

          meta.preview = URL.createObjectURL(file);

        }

        pendingFiles.push(meta);

        renderAttachPreview();

      } catch (e) {

        alert("Upload gagal: " + (e && e.message ? e.message : e));

      }

    }

    syncSendEnabled();

  }

  if (btnAttach && fileInput) {

    btnAttach.onclick = () => fileInput.click();

    fileInput.onchange = async () => {

      const files = [...(fileInput.files || [])];

      fileInput.value = "";

      await addLocalFiles(files);

    };

  }

  // Paste screenshot / drag-drop (bind once on .composer so paste does not double-fire)



  function onComposerPaste(e) {

    const cd = e.clipboardData;

    if (!cd) return;

    const fromItems = [];

    if (cd.items && cd.items.length) {

      for (const it of cd.items) {

        if (it.kind === "file") {

          const f = it.getAsFile();

          if (f) fromItems.push(f);

        }

      }

    }

    const fromFiles = cd.files && cd.files.length ? [...cd.files] : [];

    const files = fromItems.length ? fromItems : fromFiles;

    const images = files.filter((f) => f && (f.type || "").startsWith("image/"));

    if (!images.length) return;

    e.preventDefault();

    const named = images.map((f, i) => {

      if (f.name) return f;

      const ext = (f.type.split("/")[1] || "png").replace(/[^a-z0-9]/gi, "") || "png";

      return new File([f], `paste-${Date.now()}-${i}.${ext}`, { type: f.type || "image/png" });

    });

    addLocalFiles(named);

  }

  const composerEl = document.querySelector(".composer");

  if (composerEl) {

    const onDragOver = (e) => {

      if (![...e.dataTransfer.types].includes("Files")) return;

      e.preventDefault();

      composerEl.classList.add("drag-over");

    };

    const onDragLeave = (e) => {

      if (e.target === composerEl || !composerEl.contains(e.relatedTarget)) {

        composerEl.classList.remove("drag-over");

      }

    };

    const onDrop = (e) => {

      composerEl.classList.remove("drag-over");

      const files = e.dataTransfer && e.dataTransfer.files;

      if (!files || !files.length) return;

      e.preventDefault();

      addLocalFiles(files);

    };

    composerEl.addEventListener("paste", onComposerPaste);

    composerEl.addEventListener("dragenter", onDragOver);

    composerEl.addEventListener("dragover", onDragOver);

    composerEl.addEventListener("dragleave", onDragLeave);

    composerEl.addEventListener("drop", onDrop);

  }



  function clearPending() {

    for (const f of pendingFiles) {

      if (f.preview) URL.revokeObjectURL(f.preview);

    }

    pendingFiles = [];

    renderAttachPreview();

  }



  async function api(path, opts = {}) {

    const headers = { ...(opts.headers || {}) };

    if (opts.body != null && typeof opts.body === "string" && !headers["Content-Type"]) {

      headers["Content-Type"] = "application/json";

    }

    const res = await fetch(path, {

      credentials: "same-origin",

      ...opts,

      headers,

    });

    // 401 from /api/v1/* is often upstream (bad API key), not our session

    const isAppAuth =

      res.status === 401 &&

      !path.includes("/api/login") &&

      !path.startsWith("/api/v1/");

    if (isAppAuth) {

      showLogin();

      throw new Error("unauthorized");

    }

    return res;

  }



  function showLogin() {

    clearPending();

    currentId = null;

    closeConvMenu();

    if (loginEl) loginEl.classList.remove("hidden");

    if (appEl) appEl.classList.add("hidden");

  }



  function showApp() {

    if (loginEl) loginEl.classList.add("hidden");

    if (appEl) appEl.classList.remove("hidden");

  }



  function escapeHtml(s) {

    return String(s)

      .replace(/&/g, "&amp;")

      .replace(/</g, "&lt;")

      .replace(/>/g, "&gt;")

      .replace(/"/g, "&quot;");

  }



  function safeUrl(u) {

    const s = String(u || "").trim();

    if (/^https?:\/\//i.test(s) || s.startsWith("/api/files/")) return s;

    return "";

  }



  function attrEsc(s) {

    return String(s)

      .replace(/&/g, "&amp;")

      .replace(/"/g, "&quot;")

      .replace(/</g, "&lt;")

      .replace(/>/g, "&gt;");

  }



  function inlineMd(s) {

    // protect inline code so bold/italic/links don't rewrite inside

    const codes = [];

    s = s.replace(/`([^`\n]+)`/g, (_, code) => {

      const i = codes.length;

      codes.push(`<code>${code}</code>`);

      return `@@CODE${i}@@`;

    });

    // images first so link regex doesn't steal them

    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, alt, url) => {

      const href = safeUrl(url);

      if (!href) return alt || "";

      return `<img class="md-img" src="${attrEsc(href)}" alt="${attrEsc(alt)}" loading="lazy" />`;

    });

    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

    s = s.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");

    s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");

    // italic *x* — avoid eating **

    s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");

    // italic _x_ — not snake_case (word chars around _)

    s = s.replace(/(^|[^A-Za-z0-9_])_([^_\n]+)_(?![A-Za-z0-9_])/g, "$1<em>$2</em>");

    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, text, url) => {

      const href = safeUrl(url);

      if (!href) return text;

      return `<a href="${attrEsc(href)}" target="_blank" rel="noopener noreferrer">${text}</a>`;

    });

    // bare urls after whitespace / open paren / line start — stop at quotes/angles

    s = s.replace(/(^|[\s(>])(https?:\/\/[^\s<>"']+)/g, (m, pre, url) => {

      let u = url;

      let trail = "";

      while (u.length > 8 && /[.,;:!?]$/.test(u)) {

        trail = u.slice(-1) + trail;

        u = u.slice(0, -1);

      }

      if (u.endsWith(")")) {

        const opens = (u.match(/\(/g) || []).length;

        const closes = (u.match(/\)/g) || []).length;

        if (closes > opens) {

          trail = ")" + trail;

          u = u.slice(0, -1);

        }

      }

      if (!safeUrl(u)) return m;

      return `${pre}<a href="${attrEsc(u)}" target="_blank" rel="noopener noreferrer">${u}</a>${trail}`;

    });

    s = s.replace(/@@CODE(\d+)@@/g, (_, n) => codes[+n] || "");

    return s;

  }



  function isTableSep(line) {

    const t = line.trim();

    if (!t.includes("-") || !t.includes("|")) return false;

    return /^\|?[\s:|-]+\|[\s:|-]*\|?$/.test(t);

  }



  function splitTableRow(line) {

    let t = line.trim();

    if (t.startsWith("|")) t = t.slice(1);

    if (t.endsWith("|")) t = t.slice(0, -1);

    return t.split("|").map((c) => c.trim());

  }



  function fenceHtml(lang, code) {

    const l = String(lang || "")

      .trim()

      .toLowerCase()

      .replace(/[^a-z0-9_+#-]/g, "")

      .slice(0, 32);

    const label = l || "code";

    // hljs looks at language-* or class list

    const langClass = l ? `language-${l}` : "";

    return (

      `<div class="code-block">` +

      `<div class="code-head"><span class="code-lang">${label}</span>` +

      `<button type="button" class="code-copy" title="Copy code">Copy</button></div>` +

      `<pre><code class="${langClass}">${code.replace(/\n$/, "")}</code></pre></div>`

    );

  }



  /** @param {string} src @param {{streaming?: boolean}} [opts] */



  function renderMd(src, opts) {

    const streaming = !!(opts && opts.streaming);

    let s = String(src || "").replace(/\r\n/g, "\n");

    if (streaming) {

      const ticks = s.match(/```/g);

      if (ticks && ticks.length % 2 === 1) s += "\n```";

    }

    // 1) pull fences from raw so $ inside code is untouched

    const fences = [];

    s = s.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (_, lang, code) => {

      const i = fences.length;

      fences.push({ lang, code });

      return `\n\n@@FENCE${i}@@\n\n`;

    });

    s = s.replace(/```([^\n`]+?)```/g, (_, code) => {

      const i = fences.length;

      fences.push({ lang: "", code });

      return `\n\n@@FENCE${i}@@\n\n`;

    });

    // 2) math from remaining text

    const maths = [];

    s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => {

      const i = maths.length;

      maths.push({ tex: tex.trim(), display: true });

      return `\n\n@@MATH${i}@@\n\n`;

    });

    s = s.replace(/\\\[([\s\S]+?)\\\]/g, (_, tex) => {

      const i = maths.length;

      maths.push({ tex: tex.trim(), display: true });

      return `\n\n@@MATH${i}@@\n\n`;

    });

    s = s.replace(/(^|[^$\\])\$([^\n$]+?)\$(?!\$)/g, (_, pre, tex) => {

      const i = maths.length;

      maths.push({ tex: tex.trim(), display: false });

      return `${pre}@@MATH${i}@@`;

    });

    s = s.replace(/\\\(([\s\S]+?)\\\)/g, (_, tex) => {

      const i = maths.length;

      maths.push({ tex: tex.trim(), display: false });

      return `@@MATH${i}@@`;

    });

    s = escapeHtml(s);

    const lines = s.split("\n");

    const out = [];

    let i = 0;

    while (i < lines.length) {

      const line = lines[i];

      const t = line.trim();

      if (/^@@FENCE\d+@@$/.test(t) || /^@@MATH\d+@@$/.test(t)) {

        out.push(t);

        i++;

        continue;

      }

      if (!t) {

        i++;

        continue;

      }

      if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(t)) {

        out.push("<hr>");

        i++;

        continue;

      }

      const hm = t.match(/^(#{1,6})\s+(.+)$/);

      if (hm) {

        const lvl = hm[1].length;

        out.push(`<h${lvl}>${inlineMd(hm[2])}</h${lvl}>`);

        i++;

        continue;

      }

      if (t.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {

        const headers = splitTableRow(line);

        i += 2;

        const rows = [];

        while (i < lines.length && lines[i].includes("|") && lines[i].trim() && !isTableSep(lines[i])) {

          rows.push(splitTableRow(lines[i]));

          i++;

        }

        let html = '<div class="md-table-wrap"><table class="md-table"><thead><tr>';

        headers.forEach((h) => {

          html += `<th>${inlineMd(h)}</th>`;

        });

        html += "</tr></thead><tbody>";

        rows.forEach((row) => {

          html += "<tr>";

          headers.forEach((_, ci) => {

            html += `<td>${inlineMd(row[ci] || "")}</td>`;

          });

          html += "</tr>";

        });

        html += "</tbody></table></div>";

        out.push(html);

        continue;

      }

      if (/^\s*([-*+]|\d+\.)\s+/.test(line) || /^\s*([-*+]|\d+\.)\s+/.test(t)) {

        // nested lists (indent by spaces/tabs)

        const block = [];

        while (i < lines.length) {

          const raw = lines[i];

          if (!raw.trim()) break;

          const m = raw.match(/^(\s*)([-*+]|\d+\.)\s+(.+)$/);

          if (!m) break;

          const indent = m[1].replace(/\t/g, "  ").length;

          block.push({

            indent,

            ordered: /^\d+\./.test(m[2]),

            text: m[3],

          });

          i++;

        }

        out.push(renderNestedList(block));

        continue;

      }

      if (/^&gt;\s?/.test(t) || t === "&gt;") {

        const qs = [];

        while (i < lines.length) {

          const lt = lines[i].trim();

          if (!lt) break;

          if (!/^&gt;/.test(lt)) break;

          qs.push(inlineMd(lt.replace(/^&gt;\s?/, "")));

          i++;

        }

        out.push(`<blockquote>${qs.join("<br>")}</blockquote>`);

        continue;

      }

      const para = [line];

      i++;

      while (i < lines.length) {

        const n = lines[i];

        const nt = n.trim();

        if (!nt) break;

        if (/^@@FENCE\d+@@$/.test(nt)) break;

        if (/^@@MATH\d+@@$/.test(nt)) break;

        if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(nt)) break;

        if (/^#{1,6}\s+/.test(nt)) break;

        if (/^\s*([-*+]|\d+\.)\s+/.test(n)) break;

        if (nt.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) break;

        if (/^&gt;/.test(nt)) break;

        para.push(n);

        i++;

      }

      out.push(`<p>${inlineMd(para.join("\n")).replace(/\n/g, "<br>")}</p>`);

    }

    return out

      .join("")

      .replace(/@@FENCE(\d+)@@/g, (_, n) => {

        const f = fences[+n];

        if (!f) return "";

        return fenceHtml(f.lang, escapeHtml(f.code));

      })

      .replace(/@@MATH(\d+)@@/g, (_, n) => {

        const m = maths[+n];

        if (!m) return "";

        const disp = m.display ? "1" : "0";

        return `<span class="md-math" data-display="${disp}">${escapeHtml(m.tex)}</span>`;

      });

  }



  function listItemInner(text) {

    const task = text.match(/^\[([ xX])\]\s+(.+)$/);

    if (task) {

      const checked = task[1] !== " " ? " checked" : "";

      return `<span class="task-li"><input type="checkbox" disabled${checked}/> ${inlineMd(task[2])}</span>`;

    }

    return inlineMd(text);

  }



  function renderNestedList(items) {

    if (!items.length) return "";

    function build(idx, minIndent) {

      if (idx >= items.length || items[idx].indent < minIndent) {

        return { html: "", idx };

      }

      // normalize this level indent

      const levelIndent = items[idx].indent;

      const ordered = items[idx].ordered;

      const tag = ordered ? "ol" : "ul";

      let html = `<${tag} class="md-${tag}">`;

      while (idx < items.length && items[idx].indent === levelIndent) {

        if (items[idx].ordered !== ordered) break;

        const body = listItemInner(items[idx].text);

        idx++;

        let child = "";

        if (idx < items.length && items[idx].indent > levelIndent) {

          const nest = build(idx, items[idx].indent);

          child = nest.html;

          idx = nest.idx;

        }

        html += `<li>${body}${child}</li>`;

      }

      html += `</${tag}>`;

      // same indent but different list type continues as sibling list

      if (idx < items.length && items[idx].indent === levelIndent) {

        const more = build(idx, levelIndent);

        html += more.html;

        idx = more.idx;

      }

      return { html, idx };

    }

    return build(0, items[0].indent).html;

  }



  function loadCssOnce(href, id) {

    if (id && document.getElementById(id)) return;

    const link = document.createElement("link");

    link.rel = "stylesheet";

    link.href = href;

    if (id) link.id = id;

    document.head.appendChild(link);

  }



  function loadScriptOnce(src, id) {

    const existing =

      (id && document.getElementById(id)) ||

      document.querySelector(`script[src="${src}"]`);

    if (existing) {

      if (existing.dataset.loaded === "1") return Promise.resolve();

      // already executed (e.g. cached + load event already fired)

      const rs = existing.readyState;

      if (rs === "complete" || rs === "loaded") {

        existing.dataset.loaded = "1";

        return Promise.resolve();

      }

      return new Promise((resolve, reject) => {

        existing.addEventListener("load", () => {

          existing.dataset.loaded = "1";

          resolve();

        });

        existing.addEventListener("error", () => reject(new Error("load " + src)));

      });

    }

    return new Promise((resolve, reject) => {

      const s = document.createElement("script");

      s.src = src;

      s.async = true;

      if (id) s.id = id;

      s.onload = () => {

        s.dataset.loaded = "1";

        resolve();

      };

      s.onerror = () => reject(new Error("load " + src));

      document.head.appendChild(s);

    });

  }

  let _hljsReady = null;



  function ensureHljs() {

    if (window.hljs) return Promise.resolve(window.hljs);

    if (_hljsReady) return _hljsReady;

    const isLight =

      document.documentElement.classList.contains("theme-light") ||

      document.documentElement.classList.contains("light");

    const theme = isLight

      ? "https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/styles/github.min.css"

      : "https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/styles/github-dark.min.css";

    loadCssOnce(theme, "hljs-theme");

    _hljsReady = loadScriptOnce(

      "https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/highlight.min.js",

      "hljs-script"

    )

      .then(() => window.hljs)

      .catch(() => null);

    return _hljsReady;

  }

  let _katexReady = null;



  function ensureKatex() {

    if (window.katex) return Promise.resolve(window.katex);

    if (_katexReady) return _katexReady;

    loadCssOnce(

      "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css",

      "katex-css"

    );

    _katexReady = loadScriptOnce(

      "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js",

      "katex-script"

    )

      .then(() => window.katex)

      .catch(() => null);

    return _katexReady;

  }



  function enhanceCodeBlocks(root) {

    if (!root) return;

    root.querySelectorAll(".code-copy").forEach((btn) => {

      if (btn.dataset.wired) return;

      btn.dataset.wired = "1";

      btn.onclick = (e) => {

        e.stopPropagation();

        const block = btn.closest(".code-block");

        const code = block && block.querySelector("code");

        copyText(code ? code.textContent : "", btn);

        const prev = btn.textContent;

        btn.textContent = "Copied";

        setTimeout(() => {

          btn.textContent = prev || "Copy";

        }, 1200);

      };

    });

  }



  function highlightCodeBlocks(root) {

    if (!root) return;

    const nodes = root.querySelectorAll("pre code");

    if (!nodes.length) return;

    ensureHljs().then((hljs) => {

      if (!hljs) return;

      nodes.forEach((el) => {

        if (el.dataset.hljs) return;

        try {

          hljs.highlightElement(el);

          el.dataset.hljs = "1";

        } catch {

          /* ignore */

        }

      });

    });

  }



  function typesetMath(root) {

    if (!root) return;

    const nodes = root.querySelectorAll(".md-math");

    if (!nodes.length) return;

    ensureKatex().then((katex) => {

      if (!katex) return;

      nodes.forEach((el) => {

        if (el.dataset.done) return;

        const tex = el.textContent || "";

        const display = el.getAttribute("data-display") === "1";

        try {

          katex.render(tex, el, {

            throwOnError: false,

            displayMode: display,

            output: "html",

          });

          el.dataset.done = "1";

        } catch {

          /* leave raw */

        }

      });

    });

  }



  function setBubbleMd(bubble, text, isStreaming) {

    if (!bubble) return;

    bubble.innerHTML = renderMd(text || "", { streaming: !!isStreaming });

    bubble.classList.toggle("streaming", !!isStreaming);

    if (isStreaming) {

      const caret = document.createElement("span");

      caret.className = "stream-caret";

      caret.setAttribute("aria-hidden", "true");

      bubble.appendChild(caret);

    }

    enhanceCodeBlocks(bubble);

    typesetMath(bubble);

    // highlight is heavier — skip mid-stream

    if (!isStreaming) highlightCodeBlocks(bubble);

  }

  



  function syncSendEnabled() {

    if (!btnSend) return;

    if (streaming) {

      btnSend.disabled = true;

      document.body.classList.add("is-streaming");

      return;

    }

    document.body.classList.remove("is-streaming");

    const hasText = input && input.value.trim().length > 0;

    const hasFiles = pendingFiles && pendingFiles.length > 0;

    btnSend.disabled = !(hasText || hasFiles);

  }



  function autoGrow() {

    if (!input) return;

    input.style.height = "auto";

    input.style.height = Math.min(input.scrollHeight, 160) + "px";

    syncSendEnabled();

  }



  async function boot() {

    try {

      const r = await api("/api/me");

      if (!r.ok) return showLogin();

      showApp();

      await loadModels();

      await refreshConvs();

      const q = new URLSearchParams(location.search).get("c");

      if (q && /^[0-9a-fA-F]{16,64}$/.test(q)) {

        try {

          await openConv(q);

        } catch {

          /* ignore bad id */

        }

      }

    } catch {

      showLogin();

    }

  }

  if (loginForm) loginForm.addEventListener("submit", async (e) => {

    e.preventDefault();

    if (loginErr) loginErr.textContent = "";

    const username = $("#username").value.trim();

    const password = $("#password").value;

    try {

      const r = await api("/api/login", {

        method: "POST",

        body: JSON.stringify({ username, password }),

      });

      if (!r.ok) {

        if (loginErr) loginErr.textContent = "Username atau password salah";

        return;

      }

      showApp();

      try {

        await loadModels();

      } catch {

        if (modelSel) modelSel.innerHTML = `<option value="">gagal load model - cek Settings</option>`;

      }

      try {

        await refreshConvs();

      } catch {

        /* empty list ok */

      }

      const q = new URLSearchParams(location.search).get("c");

      if (q && /^[0-9a-fA-F]{16,64}$/.test(q)) {

        try { await openConv(q); } catch { /* ignore */ }

      }

    } catch (err) {

      if (err.message === "unauthorized") {

        if (loginErr) loginErr.textContent = "Username atau password salah";

      } else {

        if (loginErr) loginErr.textContent = "Gagal koneksi";

      }

    }

  });

  const btnLogout = $("#btn-logout");

  if (btnLogout) btnLogout.onclick = async () => {

    try {

      await api("/api/logout", { method: "POST", body: "{}" });

    } catch {

      /* ignore */

    }

    showLogin();

  };

  const btnNew = $("#btn-new");

  if (btnNew) btnNew.onclick = () => newChat();

  const btnDel = $("#btn-del"); if (btnDel) btnDel.onclick = () => deleteCurrent();

  if (btnSend) btnSend.onclick = () => send();



  function isMobileSidebar() {

    return !!(window.matchMedia && window.matchMedia("(max-width: 768px)").matches);

  }



  function setSidebarCollapsed(collapsed) {

    try { syncChromeClasses(); } catch (e) {}

    const app = document.getElementById("app");

    if (!app) return;

    app.classList.toggle("sidebar-collapsed", !!collapsed);

    try {

      localStorage.setItem("litewebui_sidebar", collapsed ? "0" : "1");

    } catch { /* ignore */ }

    const openBtn = $("#btn-menu");

    const closeBtn = $("#btn-sidebar-close");

    if (openBtn) {

      openBtn.title = "Open sidebar";

      openBtn.setAttribute("aria-label", "Open sidebar");

    }

    if (closeBtn) {

      closeBtn.title = "Close sidebar";

      closeBtn.setAttribute("aria-label", "Close sidebar");

    }

  }



  function openSidebar() {

    if (isMobileSidebar()) {

      if (sidebar) sidebar.classList.add("open");

      if (backdrop) backdrop.classList.remove("hidden");

    } else {

      setSidebarCollapsed(false);

    }

  }



  function closeMobileSidebar() {

    if (sidebar) sidebar.classList.remove("open");

    if (backdrop) backdrop.classList.add("hidden");

    closeConvMenu();

  }



  function closeSidebar() {

    if (isMobileSidebar()) {

      closeMobileSidebar();

    } else {

      setSidebarCollapsed(true);

      closeConvMenu();

    }

  }

  // restore desktop collapsed state

  try {

    if (!isMobileSidebar() && localStorage.getItem("litewebui_sidebar") === "0") {

      setSidebarCollapsed(true);

    }

  } catch { /* ignore */ }



  function syncShellForViewport() {

    const app = document.getElementById("app");

    if (!app) return;

    if (isMobileSidebar()) {

      // desktop collapse class must not hide drawer width on mobile

      app.classList.remove("sidebar-collapsed");

      // leave .open as user left it

    } else {

      // leaving mobile: close drawer chrome

      if (sidebar) sidebar.classList.remove("open");

      if (backdrop) backdrop.classList.add("hidden");

      try {

        if (localStorage.getItem("litewebui_sidebar") === "0") {

          app.classList.add("sidebar-collapsed");

        } else {

          app.classList.remove("sidebar-collapsed");

        }

      } catch {

        app.classList.remove("sidebar-collapsed");

      }

    }

  }

  let __shellResizeT = 0;

  window.addEventListener("resize", () => {

    clearTimeout(__shellResizeT);

    __shellResizeT = setTimeout(syncShellForViewport, 120);

  });

  window.addEventListener("orientationchange", () => {

    setTimeout(syncShellForViewport, 180);

  });

  // run once after handlers exist

  try { syncShellForViewport(); } catch { /* ignore */ }

  // Mobile keyboard: keep layout stable with visualViewport

  if (window.visualViewport) {

    const applyVV = () => {

      const app = document.getElementById("app");

      if (!app) return;

      const h = window.visualViewport.height;

      if (h && isMobileSidebar()) {

        app.style.height = h + "px";

      } else {

        app.style.height = "";

      }

    };

    window.visualViewport.addEventListener("resize", applyVV);

    window.visualViewport.addEventListener("scroll", applyVV);

  }

  const btnMenu = $("#btn-menu");

  if (btnMenu) btnMenu.onclick = () => openSidebar();

  const btnSidebarClose = $("#btn-sidebar-close");

  if (btnSidebarClose) btnSidebarClose.onclick = () => closeSidebar();

  if (backdrop) {

    backdrop.onclick = () => closeSidebar();

  }

  const settingsModal = $("#settings-modal");

  const settingsForm = $("#settings-form");

  const settingsMsg = $("#settings-msg");

  const setBase = $("#set-base");

  const setKey = $("#set-key");

  const setKeyHint = $("#set-key-hint");



  async function openSettings() {

    if (!settingsModal || !setBase || !setKey) return;

    if (settingsMsg) {

      settingsMsg.textContent = "";

      settingsMsg.classList.remove("ok");

    }

    setKey.value = "";

    try {

      const r = await api("/api/settings");

      if (!r.ok) throw new Error("gagal load");

      const s = await r.json();

      setBase.value = s.api_base_url || "";

      if (setKeyHint) {

        setKeyHint.textContent = s.api_key_set

          ? "Key tersimpan: " + (s.api_key_masked || "****") + " - isi field untuk ganti"

          : "Belum ada API key - wajib diisi";

      }

      setKey.placeholder = s.api_key_set ? "kosongkan = tetap pakai key lama" : "API key";

      setKey.required = !s.api_key_set;

    } catch {

      setBase.value = "http://127.0.0.1:20128/v1";

      if (setKeyHint) setKeyHint.textContent = "";

      setKey.required = true;

    }

    // default to General panel

    document.querySelectorAll(".settings-nav-btn").forEach((b) => {

      b.classList.toggle("active", b.getAttribute("data-panel") === "general");

    });

    document.querySelectorAll(".settings-panel").forEach((p) => {

      p.classList.toggle("hidden", p.getAttribute("data-panel") !== "general");

    });

    try {

      syncThemeCards(localStorage.getItem("litewebui_theme") || "light");

    } catch {

      syncThemeCards("dark");

    }

    settingsModal.classList.remove("hidden");

    // mobile drawer only - jangan collapse sidebar desktop

    if (isMobileSidebar()) {

      if (sidebar) sidebar.classList.remove("open");

      if (backdrop) backdrop.classList.add("hidden");

    }

  }



  function closeSettings() {

    if (settingsModal) settingsModal.classList.add("hidden");

  }

  

  document.querySelectorAll(".settings-nav-btn").forEach((btn) => {

    btn.addEventListener("click", () => {

      const panel = btn.getAttribute("data-panel");

      document.querySelectorAll(".settings-nav-btn").forEach((b) => {

        b.classList.toggle("active", b === btn);

      });

      document.querySelectorAll(".settings-panel").forEach((p) => {

        p.classList.toggle("hidden", p.getAttribute("data-panel") !== panel);

      });

    });

  });

  document.querySelectorAll(".theme-card").forEach((btn) => {

    btn.addEventListener("click", () => {

      applyTheme(btn.getAttribute("data-theme"));

    });

  });

  const btnSettings = $("#btn-settings");

  if (btnSettings) btnSettings.onclick = () => openSettings();

  const btnSettingsClose = $("#btn-settings-close");

  if (btnSettingsClose) btnSettingsClose.onclick = () => closeSettings();

  if (settingsModal) settingsModal.addEventListener("click", (e) => {

    if (e.target === settingsModal) closeSettings();

  });

  if (settingsForm) settingsForm.addEventListener("submit", async (e) => {

    e.preventDefault();

    if (!setBase || !setKey) return;

    if (settingsMsg) {

      settingsMsg.textContent = "";

      settingsMsg.classList.remove("ok");

    }

    const body = { api_base_url: setBase.value.trim() };

    const k = setKey.value.trim();

    if (k) body.api_key = k;

    try {

      const r = await api("/api/settings", { method: "PUT", body: JSON.stringify(body) });

      if (!r.ok) {

        const t = await r.text();

        if (settingsMsg) settingsMsg.textContent = t || "Gagal simpan";

        return;

      }

      if (settingsMsg) {

        settingsMsg.classList.add("ok");

        settingsMsg.textContent = "Tersimpan";

      }

      setKey.value = "";

      // reload key hint without forcing General tab

      try {

        const r2 = await api("/api/settings");

        if (r2.ok) {

          const s2 = await r2.json();

          if (setKeyHint) {

            setKeyHint.textContent = s2.api_key_set

              ? "Key tersimpan: " + (s2.api_key_masked || "****") + " - isi field untuk ganti"

              : "Belum ada API key - wajib diisi";

          }

          setKey.required = !s2.api_key_set;

          setKey.placeholder = s2.api_key_set ? "kosongkan = tetap pakai key lama" : "API key";

        }

      } catch { /* ignore */ }

      await loadModels();

    } catch (err) {

      if (settingsMsg) settingsMsg.textContent = "Gagal: " + err.message;

    }

  });

  const btnTest = $("#btn-test-conn");

  if (btnTest) {

    btnTest.onclick = async () => {

      if (settingsMsg) { settingsMsg.textContent = ""; settingsMsg.classList.remove("ok"); }

      btnTest.disabled = true;

      const prev = btnTest.textContent;

      btnTest.textContent = "Testing...";

      try {

        if (!setBase) return;

        const body = { api_base_url: setBase.value.trim() };

        const k = setKey.value.trim();

        if (k) body.api_key = k;

        const r = await api("/api/settings/test", {

          method: "POST",

          body: JSON.stringify(body),

        });

        const j = await r.json().catch(() => ({}));

        if (j.ok) {

          if (settingsMsg) {

            settingsMsg.classList.add("ok");

            settingsMsg.textContent =

              "Connected - " + (j.models ?? 0) + " model(s) - HTTP " + (j.status || 200);

          }

        } else {

          if (settingsMsg) {

            settingsMsg.textContent =

              "Gagal" +

              (j.status ? " (" + j.status + ")" : "") +

              ": " +

              (j.error || r.statusText || "unknown");

          }

        }

      } catch (err) {

        if (settingsMsg) settingsMsg.textContent = "Gagal: " + err.message;

      } finally {

        btnTest.disabled = false;

        btnTest.textContent = prev;

      }

    };

  }

  if (input) {

    input.addEventListener("input", autoGrow);

    input.addEventListener("keydown", (e) => {

      if (e.key === "Enter" && !e.shiftKey) {

        e.preventDefault();

        send();

      }

    });

  }



  async function loadModels() {

    if (!modelSel) return;

    modelSel.innerHTML = "";

    try {

      const r = await api("/api/v1/models");

      if (!r.ok) {

        modelSel.innerHTML = `<option value="">gagal load model (${r.status})</option>`;

        return;

      }

      const data = await r.json();

      const list = (data.data || data.models || [])

        .map((m) => m.id || m.name)

        .filter(Boolean);

      if (!list.length) {

        modelSel.innerHTML = `<option value="">(tidak ada model)</option>`;

        return;

      }

      for (const id of list) {

        const o = document.createElement("option");

        o.value = id;

        o.textContent = id;

        o.title = id;

        modelSel.appendChild(o);

      }

      const saved = localStorage.getItem("litewebui_model");

      if (saved && list.includes(saved)) modelSel.value = saved;

      syncEmptyTitle();

      refreshModelMenu();

    } catch (e) {

      modelSel.innerHTML = `<option value="">gagal load model</option>`;

    }

  }

  if (modelSel) modelSel.onchange = () => {

    localStorage.setItem("litewebui_model", modelSel.value);

    syncEmptyTitle();

    refreshModelMenu();

  };

  let lastArchived = [];



  async function refreshConvs() {

    const [r, ra] = await Promise.all([

      api("/api/conversations"),

      api("/api/conversations?archived=1"),

    ]);

    if (!r.ok) throw new Error("conversations");

    convs = await r.json();

    if (!Array.isArray(convs)) convs = [];

    let archived = [];

    if (ra.ok) {

      archived = await ra.json();

      if (!Array.isArray(archived)) archived = [];

    }

    lastArchived = archived;

    renderConvList(archived);

  }



  function closeConvMenu() {

    if (!convMenu) return;

    convMenu.classList.add("hidden");

    convMenu.innerHTML = "";

    menuOpen = false;

  }



  function icon(path) {

    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">${path}</svg>`;

  }



  function openConvMenu(e, c) {

    e.preventDefault();

    e.stopPropagation();

    if (!convMenu) return;

    const pinLabel = c.pinned ? "Unpin" : "Pin chat";

    const archLabel = c.archived ? "Unarchive" : "Archive";

    convMenu.innerHTML = "";

    const items = [

      {

        label: "Share",

        html: icon('<path stroke-linecap="round" stroke-linejoin="round" d="M7.5 12.5l9-5m-9 10l9-5M8 12a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0zm13-5a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0zm0 10a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0z"/>'),

        fn: () => shareConv(c),

      },

      {

        label: "Rename",

        html: icon('<path stroke-linecap="round" stroke-linejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zM16.862 4.487L19.5 7.125"/>'),

        fn: () => renameConv(c),

      },

      {

        label: pinLabel,

        html: icon('<path stroke-linecap="round" stroke-linejoin="round" d="M16 3l-1 6 4 3v2H5v-2l4-3-1-6h8zM12 14v7"/>'),

        fn: () => patchConv(c.id, { pinned: !c.pinned }),

      },

      {

        label: archLabel,

        html: icon('<path stroke-linecap="round" stroke-linejoin="round" d="M3.75 6.75h16.5M4.5 6.75V18a2.25 2.25 0 002.25 2.25h10.5A2.25 2.25 0 0019.5 18V6.75M9 11.25h6"/>'),

        fn: () => patchConv(c.id, { archived: !c.archived }),

      },

      { sep: true },

      {

        label: "Delete",

        danger: true,

        html: icon('<path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.67a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.1 48.1 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.96 51.96 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.67 48.67 0 00-7.5 0"/>'),

        fn: () => deleteConv(c.id),

      },

    ];

    for (const it of items) {

      if (it.sep) {

        const s = document.createElement("div");

        s.className = "sep";

        convMenu.appendChild(s);

        continue;

      }

      const b = document.createElement("button");

      b.type = "button";

      b.setAttribute("role", "menuitem");

      if (it.danger) b.className = "danger";

      b.innerHTML = it.html + `<span></span>`;

      b.querySelector("span").textContent = it.label;

      b.onclick = async (ev) => {

        ev.stopPropagation();

        closeConvMenu();

        try {

          await it.fn();

        } catch (err) {

          if (err && err.message === "unauthorized") return;

          alert((err && err.message) || "gagal");

        }

      };

      convMenu.appendChild(b);

    }

    convMenu.classList.remove("hidden");

    menuOpen = true;

    const rect = e.currentTarget.getBoundingClientRect();

    const mw = Math.max(convMenu.offsetWidth || 216, 216);

    let left = rect.right - mw;

    let top = rect.bottom + 6;

    if (left < 8) left = 8;

    if (left + mw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - mw - 8);

    const mh = convMenu.offsetHeight || 280;

    if (top + mh > window.innerHeight - 8) top = Math.max(8, rect.top - mh - 6);

    if (top < 8) top = 8;

    convMenu.style.left = left + "px";

    convMenu.style.top = top + "px";

    convMenu.style.minWidth = "13.5rem";

  }

  document.addEventListener("click", (e) => {

    if (!menuOpen || !convMenu) return;

    if (convMenu.contains(e.target)) return;

    if (e.target.closest && e.target.closest(".conv-more")) return;

    closeConvMenu();

  });

  document.addEventListener("keydown", (e) => {

    if (e.key === "Escape") {

      closeConvMenu();

      if (settingsModal && !settingsModal.classList.contains("hidden")) closeSettings();

    }

  });

  window.addEventListener("resize", () => closeConvMenu());

  window.addEventListener("scroll", () => closeConvMenu(), true);



  async function patchConv(id, body) {

    const r = await api("/api/conversations/" + encodeURIComponent(id), {

      method: "PATCH",

      body: JSON.stringify(body),

    });

    if (!r.ok) throw new Error((await r.text()) || "patch failed");

    if (body.archived === true && id === currentId) {

      currentId = null;

      clearPending();

      renderMessages([]);

      setChatTitle("New chat");

    }

    await refreshConvs();

  }



  async function renameConv(c) {

    const t = await promptDialog({

      title: "Rename chat",

      value: c.title || "New chat",

      okLabel: "Rename",

      cancelLabel: "Cancel",

      placeholder: "Chat title",

    });

    if (t == null) return;

    const title = t.trim() || "New chat";

    await patchConv(c.id, { title });

    if (c.id === currentId) setChatTitle(title);

  }



  async function shareConv(c) {

    const url = location.origin + "/?c=" + encodeURIComponent(c.id);

    try {

      if (navigator.clipboard && navigator.clipboard.writeText) {

        await navigator.clipboard.writeText(url);

        alert("Link disalin:\n" + url);

      } else {

        prompt("Salin link:", url);

      }

    } catch {

      prompt("Salin link:", url);

    }

  }

  



  function confirmDialog(opts) {

    const modal = document.getElementById("confirm-modal");

    const titleEl = document.getElementById("confirm-title");

    const subEl = document.getElementById("confirm-sub");

    const inputEl = document.getElementById("confirm-input");

    const btnCancel = document.getElementById("confirm-cancel");

    const btnOk = document.getElementById("confirm-ok");

    if (!modal || !btnCancel || !btnOk) {

      return Promise.resolve(

        window.confirm((opts && opts.title) || "Are you sure you want to delete this?")

      );

    }

    const title = (opts && opts.title) || "Are you sure you want to delete this?";

    const sub = (opts && opts.sub) || "This chat can't be recovered.";

    const okLabel = (opts && opts.okLabel) || "Delete chat";

    const cancelLabel = (opts && opts.cancelLabel) || "Cancel";

    const danger = opts && opts.danger === false ? false : true;

    if (titleEl) titleEl.textContent = title;

    if (subEl) {

      subEl.textContent = sub;

      subEl.classList.toggle("hidden", !sub);

    }

    if (inputEl) {

      inputEl.classList.add("hidden");

      inputEl.value = "";

    }

    btnOk.textContent = okLabel;

    btnCancel.textContent = cancelLabel;

    btnOk.classList.toggle("btn-confirm-danger", danger);

    btnOk.classList.toggle("btn-confirm-primary", !danger);

    modal.classList.remove("hidden");

    closeConvMenu();

    return new Promise((resolve) => {

      const finish = (val) => {

        modal.classList.add("hidden");

        btnCancel.onclick = null;

        btnOk.onclick = null;

        modal.onclick = null;

        document.removeEventListener("keydown", onKey);

        resolve(val);

      };

      const onKey = (e) => {

        if (e.key === "Escape") {

          e.preventDefault();

          finish(false);

        } else if (e.key === "Enter") {

          e.preventDefault();

          finish(true);

        }

      };

      btnCancel.onclick = () => finish(false);

      btnOk.onclick = () => finish(true);

      modal.onclick = (e) => {

        if (e.target === modal) finish(false);

      };

      document.addEventListener("keydown", onKey);

      try { btnOk.focus(); } catch { /* ignore */ }

    });

  }



  /** @returns {Promise<string|null>} null if cancelled */



  function promptDialog(opts) {

    const modal = document.getElementById("confirm-modal");

    const titleEl = document.getElementById("confirm-title");

    const subEl = document.getElementById("confirm-sub");

    const inputEl = document.getElementById("confirm-input");

    const btnCancel = document.getElementById("confirm-cancel");

    const btnOk = document.getElementById("confirm-ok");

    if (!modal || !btnCancel || !btnOk || !inputEl) {

      const t = window.prompt((opts && opts.title) || "Rename chat", (opts && opts.value) || "");

      return Promise.resolve(t);

    }

    const title = (opts && opts.title) || "Rename chat";

    const sub = (opts && opts.sub) || "";

    const okLabel = (opts && opts.okLabel) || "Rename";

    const cancelLabel = (opts && opts.cancelLabel) || "Cancel";

    if (titleEl) titleEl.textContent = title;

    if (subEl) {

      subEl.textContent = sub;

      subEl.classList.toggle("hidden", !sub);

    }

    inputEl.classList.remove("hidden");

    inputEl.value = (opts && opts.value) != null ? String(opts.value) : "";

    inputEl.placeholder = (opts && opts.placeholder) || "";

    btnOk.textContent = okLabel;

    btnCancel.textContent = cancelLabel;

    btnOk.classList.remove("btn-confirm-danger");

    btnOk.classList.add("btn-confirm-primary");

    modal.classList.remove("hidden");

    closeConvMenu();

    return new Promise((resolve) => {

      const finish = (val) => {

        modal.classList.add("hidden");

        inputEl.classList.add("hidden");

        btnCancel.onclick = null;

        btnOk.onclick = null;

        modal.onclick = null;

        document.removeEventListener("keydown", onKey);

        resolve(val);

      };

      const onKey = (e) => {

        if (e.key === "Escape") {

          e.preventDefault();

          finish(null);

        } else if (e.key === "Enter") {

          e.preventDefault();

          finish(inputEl.value);

        }

      };

      btnCancel.onclick = () => finish(null);

      btnOk.onclick = () => finish(inputEl.value);

      modal.onclick = (e) => {

        if (e.target === modal) finish(null);

      };

      document.addEventListener("keydown", onKey);

      try {

        inputEl.focus();

        inputEl.select();

      } catch { /* ignore */ }

    });

  }



  async function deleteConv(id) {

    const ok = await confirmDialog({

      title: "Are you sure you want to delete this?",

      sub: "This chat can't be recovered.",

      okLabel: "Delete chat",

      cancelLabel: "Cancel",

    });

    if (!ok) return;

    const r = await api("/api/conversations/" + encodeURIComponent(id), { method: "DELETE" });

    if (!r.ok) throw new Error((await r.text()) || "delete failed");

    if (id === currentId) {

      currentId = null;

      clearPending();

      renderMessages([]);

      setChatTitle("New chat");

    }

    await refreshConvs();

  }

  const CHAT_ICO = '<svg class="conv-ico" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M8.5 19.5l-3.2 1.1c-.7.24-1.4-.42-1.2-1.12l.9-3.08A8.25 8.25 0 1112 20.25a8.2 8.2 0 01-3.5-.75z"/></svg>';

  const PIN_ICO = '<svg class="status-ico" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M16 3H8l-1 6 3.5 2.5V21h3v-9.5L17 9l-1-6z"/></svg>';

  const ARCH_ICO = '<svg class="status-ico" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 6.75h16.5M4.5 6.75V18a2.25 2.25 0 002.25 2.25h10.5A2.25 2.25 0 0019.5 18V6.75M9 11.25h6"/></svg>';



  function groupCollapsed(key) {

    try {

      return localStorage.getItem("litewebui_grp_" + key) === "0";

    } catch {

      return false;

    }

  }



  function setGroupCollapsed(key, collapsed) {

    try {

      localStorage.setItem("litewebui_grp_" + key, collapsed ? "0" : "1");

    } catch {

      /* ignore */

    }

  }



  function applyGroupState(block, key) {

    if (!block) return;

    const collapsed = groupCollapsed(key);

    block.classList.toggle("is-collapsed", collapsed);

    const btn = block.querySelector(".group-toggle");

    if (btn) btn.setAttribute("aria-expanded", collapsed ? "false" : "true");

  }



  function wireGroupToggles() {

    document.querySelectorAll(".group-toggle").forEach((btn) => {

      if (btn.dataset.wired) return;

      btn.dataset.wired = "1";

      btn.addEventListener("click", (e) => {

        e.preventDefault();

        e.stopPropagation();

        const key = btn.getAttribute("data-group") || "recents";

        const block = btn.closest(".chat-group");

        if (!block) return;

        const next = !block.classList.contains("is-collapsed");

        block.classList.toggle("is-collapsed", next);

        btn.setAttribute("aria-expanded", next ? "false" : "true");

        setGroupCollapsed(key, next);

      });

    });

  }

  wireGroupToggles();



  function makeConvRow(c) {

    const row = document.createElement("div");

    row.className = "conv-row" + (c.id === currentId ? " active" : "");

    row.dataset.id = c.id;

    const b = document.createElement("button");

    b.type = "button";

    b.className = "conv-item";

    b.title = c.title || "Chat";

    b.onclick = () => openConv(c.id);

    // Pinned: chat bubble icon | Archived: archive icon | Recents: text only

    if (c.archived) {

      const ico = document.createElement("span");

      ico.className = "conv-ico-wrap is-arch";

      ico.innerHTML = ARCH_ICO;

      ico.title = "Archived";

      b.appendChild(ico);

    } else if (c.pinned) {

      const ico = document.createElement("span");

      ico.className = "conv-ico-wrap is-pin";

      ico.innerHTML = CHAT_ICO;

      b.appendChild(ico);

    }

    const label = document.createElement("span");

    label.className = "conv-title";

    label.textContent = c.title || "Chat";

    b.appendChild(label);

    row.appendChild(b);

    // no extra status column - icons live next to title only when pin/archive

    const more = document.createElement("button");

    more.type = "button";

    more.className = "conv-more";

    more.setAttribute("aria-label", "Chat options");

    more.title = "Options";

    more.textContent = "\u22EE";

    more.onclick = (e) => {

      e.preventDefault();

      e.stopPropagation();

      openConvMenu(e, c);

    };

    row.appendChild(more);

    return row;

  }



  function renderConvList(archived) {

    closeConvMenu();

    const arch = Array.isArray(archived) ? archived : [];

    const pinned = convs.filter((c) => c.pinned && !c.archived);

    const recent = convs.filter((c) => !c.pinned && !c.archived);

    if (pinnedList) {

      pinnedList.innerHTML = "";

      for (const c of pinned) pinnedList.appendChild(makeConvRow(c));

    }

    if (pinnedBlock) {

      if (pinned.length) pinnedBlock.classList.remove("hidden");

      else pinnedBlock.classList.add("hidden");

    }

    if (convList) {

      convList.innerHTML = "";

      for (const c of recent) convList.appendChild(makeConvRow(c));

    }

    if (archivedList) {

      archivedList.innerHTML = "";

      for (const c of arch) archivedList.appendChild(makeConvRow(c));

    }

    if (archivedBlock) {

      if (arch.length) archivedBlock.classList.remove("hidden");

      else archivedBlock.classList.add("hidden");

    }

    applyGroupState(pinnedBlock, "pinned");

    applyGroupState(document.getElementById("recents-block"), "recents");

    applyGroupState(archivedBlock, "archived");

    wireGroupToggles();

  }



  async function newChat() {

    if (voiceModeOn) exitVoiceMode();

    if (dictationOn) stopDictationRec();

    const isPriv = privateMode === true;

    const r = await api("/api/conversations", {

      method: "POST",

      body: JSON.stringify({

        title: isPriv ? "Private chat" : "New chat",

        model: modelSel ? modelSel.value : "",

        private: isPriv,

      }),

    });

    if (!r.ok) { alert("Gagal buat chat"); return; }

    const c = await r.json();

    currentId = c.id;

    currentIsPrivate = isPriv || !!c.private;

    privateMode = currentIsPrivate;

    clearPending();

    if (!currentIsPrivate) {

      try { await refreshConvs(); } catch (e) {}

    } else {

      renderConvList(typeof lastArchived !== "undefined" ? lastArchived : []);

    }

    renderMessages([]);

    setChatTitle(c.title || (currentIsPrivate ? "Private chat" : "New chat"));

    syncPrivateUI();

    if (input) input.focus();

    closeMobileSidebar();

  }



  async function openConv(id) {

    if (voiceModeOn) exitVoiceMode();

    if (dictationOn) stopDictationRec();

    currentId = id;

    clearPending();

    renderConvList(lastArchived);

    const r = await api("/api/conversations/" + encodeURIComponent(id));

    if (!r.ok) return;

    const c = await r.json();

    currentIsPrivate = !!c.private;

    privateMode = currentIsPrivate;

    syncPrivateUI();

    setChatTitle(c.title);

    if (c.model && modelSel) {

      const opts = [...modelSel.options].map((o) => o.value);

      if (opts.includes(c.model)) modelSel.value = c.model;

    }

    refreshModelMenu();

    renderMessages(c.messages || []);

    closeMobileSidebar();

  }



  async function deleteCurrent() {

    if (!currentId) return;

    try {

      await deleteConv(currentId);

    } catch (e) {

      if (e && e.message !== "unauthorized") alert(e.message || "gagal hapus");

    }

  }



  function renderMessages(msgs) {

    if (!messagesEl) return;

    messagesEl.querySelectorAll(".msg").forEach((n) => n.remove());

    if (!msgs || !msgs.length) {

      if (emptyEl) {

        emptyEl.classList.remove("hidden");

        emptyEl.removeAttribute("hidden");

        emptyEl.style.display = "";

      }

      syncShellChatClass();

      return;

    }

    if (emptyEl) {

      emptyEl.classList.add("hidden");

      emptyEl.setAttribute("hidden", "");

      emptyEl.style.display = "none";

    }

    for (const m of msgs) appendMsg(m.role, m.content, false, m.attachments || [], m.id);

    messagesEl.scrollTop = messagesEl.scrollHeight;

    syncEmptyVisibility();

  }



  function renderAtts(container, atts) {

    if (!atts || !atts.length) return;

    const wrap = document.createElement("div");

    wrap.className = "msg-atts";

    for (const a of atts) {

      const url = a.url || "/api/files/" + a.id;

      if (a.content_type && a.content_type.startsWith("image/")) {

        const img = document.createElement("img");

        img.className = "att-img";

        img.src = url;

        img.alt = a.name || "image";

        wrap.appendChild(img);

      } else {

        const link = document.createElement("a");

        link.className = "att-file";

        link.href = url;

        link.target = "_blank";

        link.rel = "noopener";

        link.textContent = a.name || "file";

        wrap.appendChild(link);

      }

    }

    container.appendChild(wrap);

  }



  function msgPlainText(bubble) {

    if (!bubble) return "";

    // skip code-copy chrome

    const clone = bubble.cloneNode(true);

    clone.querySelectorAll(".code-head, .stream-caret, .thinking").forEach((n) => n.remove());

    return (clone.innerText || clone.textContent || "").trim();

  }



  function msgCopySource(wrap, bubble) {

    if (wrap && wrap.dataset && wrap.dataset.raw != null && wrap.dataset.raw !== "") {

      return wrap.dataset.raw;

    }

    return msgPlainText(bubble);

  }



  async function copyText(text, btn) {

    const t = text == null ? "" : String(text);

    if (!t.trim()) return;

    try {

      await navigator.clipboard.writeText(t);

    } catch {

      const ta = document.createElement("textarea");

      ta.value = t;

      document.body.appendChild(ta);

      ta.select();

      try { document.execCommand("copy"); } catch { /* ignore */ }

      ta.remove();

    }

    if (btn) {

      const prev = btn.getAttribute("data-label") || btn.title || "Copy";

      btn.classList.add("copied");

      btn.title = "Copied";

      setTimeout(() => {

        btn.classList.remove("copied");

        btn.title = prev;

      }, 1200);

    }

  }



  function iconCopy() {

    return '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 012-2h10" stroke-linecap="round"/></svg>';

  }



  function iconCopyPlain() {

    return '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path stroke-linecap="round" d="M8 6h11M8 12h11M8 18h7"/><path stroke-linecap="round" d="M5 6h.01M5 12h.01M5 18h.01"/></svg>';

  }



  function iconEdit() {

    return '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M16.5 3.5l4 4L8 20H4v-4L16.5 3.5z"/></svg>';

  }



  function iconRegen() {

    return '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M4 12a8 8 0 0113.66-5.66M20 12a8 8 0 01-13.66 5.66"/><path stroke-linecap="round" stroke-linejoin="round" d="M17 3v4h4M7 21v-4H3"/></svg>';

  }



  function buildMsgActions(role, wrap, bubble) {

    const bar = document.createElement("div");

    bar.className = "msg-actions";

    const btnCopy = document.createElement("button");

    btnCopy.type = "button";

    btnCopy.className = "msg-act";

    btnCopy.title = "Copy markdown";

    btnCopy.setAttribute("data-label", "Copy markdown");

    btnCopy.innerHTML = iconCopy();

    btnCopy.onclick = (e) => {

      e.stopPropagation();

      copyText(msgCopySource(wrap, bubble), btnCopy);

    };

    bar.appendChild(btnCopy);

    if (role !== "user") {

      const btnPlain = document.createElement("button");

      btnPlain.type = "button";

      btnPlain.className = "msg-act";

      btnPlain.title = "Copy plain text";

      btnPlain.setAttribute("data-label", "Copy plain text");

      btnPlain.innerHTML = iconCopyPlain();

      btnPlain.onclick = (e) => {

        e.stopPropagation();

        copyText(msgPlainText(bubble), btnPlain);

      };

      bar.appendChild(btnPlain);

    }

    if (role === "user") {

      const btnEdit = document.createElement("button");

      btnEdit.type = "button";

      btnEdit.className = "msg-act";

      btnEdit.title = "Edit";

      btnEdit.innerHTML = iconEdit();

      btnEdit.onclick = (e) => {

        e.stopPropagation();

        startEditUser(wrap);

      };

      bar.appendChild(btnEdit);

    } else {

      const btnRegen = document.createElement("button");

      btnRegen.type = "button";

      btnRegen.className = "msg-act";

      btnRegen.title = "Regenerate";

      btnRegen.innerHTML = iconRegen();

      btnRegen.onclick = (e) => {

        e.stopPropagation();

        regenerateFrom(wrap);

      };

      bar.appendChild(btnRegen);

    }

    return bar;

  }



  function appendMsg(role, content, rawStreaming, atts, msgId) {

    if (emptyEl) {

      emptyEl.classList.add("hidden");

      emptyEl.setAttribute("hidden", "");

      emptyEl.style.display = "none";

    }

    syncShellChatClass();

    const wrap = document.createElement("div");

    wrap.className = "msg " + role;

    if (msgId) wrap.dataset.mid = msgId;

    wrap.dataset.raw = content || "";

    const inner = document.createElement("div");

    inner.className = "msg-inner";

    let bubble;

    if (role === "user") {

      const col = document.createElement("div");

      col.className = "msg-col user-col";

      bubble = document.createElement("div");

      bubble.className = "bubble";

      renderAtts(bubble, atts);

      if (content) {

        const t = document.createElement("div");

        t.className = "bubble-text";

        t.textContent = content;

        bubble.appendChild(t);

      } else if (!atts || !atts.length) {

        bubble.textContent = "";

      }

      col.appendChild(bubble);

      if (!rawStreaming) col.appendChild(buildMsgActions("user", wrap, bubble));

      inner.appendChild(col);

    } else {

      const av = document.createElement("div");

      av.className = "avatar";

      av.setAttribute("aria-label", "brengseek");

      av.innerHTML = '<img class="avatar-logo" src="/favicon.svg" alt="" width="20" height="20" />';

      const body = document.createElement("div");

      body.className = "body";

      const roleEl = document.createElement("div");

      roleEl.className = "role";

      roleEl.textContent = displayModelName(modelSel && modelSel.value) || "brengseek";

      bubble = document.createElement("div");

      bubble.className = "bubble";

      if (rawStreaming) {

        bubble.classList.add("streaming");

        wrap.classList.add("is-streaming");

        if (!content) {

          bubble.innerHTML =

            '<span class="thinking" aria-live="polite" aria-label="Generating...">' +

            '<span class="thinking-orb" aria-hidden="true">' +

            '<img class="thinking-logo" src="/favicon.svg" alt="" />' +

            '<span class="thinking-ring"></span></span>' +

            '<span class="thinking-label">Generating...</span></span>';

        } else {

          bubble.dataset.hasToken = "1";

          setBubbleMd(bubble, content, true);

        }

      } else {

        setBubbleMd(bubble, content, false);

      }

      body.appendChild(roleEl);

      body.appendChild(bubble);

      if (!rawStreaming) body.appendChild(buildMsgActions("assistant", wrap, bubble));

      inner.appendChild(av);

      inner.appendChild(body);

    }

    wrap.appendChild(inner);

    if (!messagesEl) return bubble;

    messagesEl.appendChild(wrap);

    messagesEl.scrollTop = messagesEl.scrollHeight;

    return bubble;

  }

  



  function setStreamingBubble(bubble, on) {

    if (!bubble) return;

    bubble.classList.toggle("streaming", !!on);

    const wrap = bubble.closest(".msg");

    if (wrap) wrap.classList.toggle("is-streaming", !!on);

    if (on && !bubble.dataset.hasToken) {

      bubble.innerHTML =

      '<span class="thinking" aria-live="polite" aria-label="Generating...">' +

      '<span class="thinking-orb" aria-hidden="true">' +

      '<img class="thinking-logo" src="/favicon.svg" alt="" />' +

      '<span class="thinking-ring"></span></span>' +

      '<span class="thinking-label">Generating...</span></span>';

    }

    if (!on) {

      delete bubble.dataset.hasToken;

      // caret removed on next setBubbleMd; ensure class gone even if error path uses textContent

      const caret = bubble.querySelector(".stream-caret");

      if (caret) caret.remove();

    }

  }

  // throttle live markdown re-render during stream

  let _streamRaf = 0;

  let _streamPending = null;



  function flushStreamDelta() {

    if (_streamRaf) {

      cancelAnimationFrame(_streamRaf);

      _streamRaf = 0;

    }

    const p = _streamPending;

    _streamPending = null;

    if (!p || !p.bubble) return;

    setBubbleMd(p.bubble, p.full, true);

    const wrap = p.bubble.closest(".msg");

    if (wrap) wrap.dataset.raw = p.full || "";

  }



  function appendStreamDelta(bubble, full) {

    if (!bubble) return;

    bubble.dataset.hasToken = "1";

    _streamPending = { bubble, full };

    if (_streamRaf) return;

    _streamRaf = requestAnimationFrame(() => {

      _streamRaf = 0;

      flushStreamDelta();

    });

  }



  function wireActionsAfterStream(bubble, full) {

    // drop any pending partial paint so final HTML wins

    if (_streamRaf) {

      cancelAnimationFrame(_streamRaf);

      _streamRaf = 0;

    }

    _streamPending = null;

    const wrap = bubble && bubble.closest ? bubble.closest(".msg") : null;

    if (!wrap) return;

    wrap.dataset.raw = full || "";

    setBubbleMd(bubble, full || "(kosong)", false);

    enhanceCodeBlocks(bubble);

    if (wrap.querySelector(".msg-actions")) return;

    const body = wrap.querySelector(".body");

    if (body) body.appendChild(buildMsgActions("assistant", wrap, bubble));

  }



  function startEditUser(wrap) {

    if (streaming) return;

    if (!wrap || wrap.classList.contains("editing")) return;

    const bubble = wrap.querySelector(".bubble");

    if (!bubble) return;

    const raw = wrap.dataset.raw || msgPlainText(bubble);

    wrap.classList.add("editing");

    const actions = wrap.querySelector(".msg-actions");

    if (actions) actions.classList.add("hidden");

    const editor = document.createElement("div");

    editor.className = "msg-editor";

    const ta = document.createElement("textarea");

    ta.className = "msg-edit-ta";

    ta.value = raw;

    ta.rows = Math.min(12, Math.max(3, (raw.match(/\n/g) || []).length + 2));

    const row = document.createElement("div");

    row.className = "msg-edit-actions";

    const btnCancel = document.createElement("button");

    btnCancel.type = "button";

    btnCancel.className = "btn-edit-cancel";

    btnCancel.textContent = "Cancel";

    const btnSave = document.createElement("button");

    btnSave.type = "button";

    btnSave.className = "btn-edit-save";

    btnSave.textContent = "Save & Submit";

    row.appendChild(btnCancel);

    row.appendChild(btnSave);

    editor.appendChild(ta);

    editor.appendChild(row);

    const col = wrap.querySelector(".msg-col") || wrap.querySelector(".msg-inner");

    bubble.classList.add("hidden");

    col.appendChild(editor);

    ta.focus();

    ta.setSelectionRange(ta.value.length, ta.value.length);

    const cleanup = () => {

      wrap.classList.remove("editing");

      editor.remove();

      bubble.classList.remove("hidden");

      if (actions) actions.classList.remove("hidden");

    };

    btnCancel.onclick = () => cleanup();

    btnSave.onclick = async () => {

      const next = ta.value.trim();

      if (!next) {

        alert("Pesan kosong");

        return;

      }

      btnSave.disabled = true;

      try {

        await editUserAndResend(wrap, next);

      } catch (e) {

        alert(e.message || "Gagal edit");

        btnSave.disabled = false;

      }

    };

  }



  async function deleteFromMessage(mid) {

    if (!currentId || !mid) return;

    const r = await api(

      "/api/conversations/" + encodeURIComponent(currentId) + "/messages/from/" + encodeURIComponent(mid),

      { method: "DELETE" }

    );

    if (!r.ok) throw new Error((await r.text()) || "delete failed");

  }



  async function editUserAndResend(wrap, newText) {

    if (streaming) return;

    if (!wrap) return;

    const mid = wrap.dataset.mid;

    if (!currentId) throw new Error("no conversation");

    if (mid) {

      await deleteFromMessage(mid);

    }

    // Strip this message and everything after from DOM

    let n = wrap;

    while (n) {

      const x = n.nextElementSibling;

      n.remove();

      n = x;

    }

    if (input) {

      input.value = newText;

      autoGrow();

    }

    await send();

  }



  async function regenerateFrom(wrap) {

    if (streaming) return;

    if (!currentId) return;

    // Find previous user message

    let prev = wrap.previousElementSibling;

    while (prev && !prev.classList.contains("user")) prev = prev.previousElementSibling;

    if (!prev) {

      alert("Tidak ada pesan user sebelumnya");

      return;

    }

    const userMid = prev.dataset.mid;

    const userText = prev.dataset.raw || msgPlainText(prev.querySelector(".bubble"));

    // Delete assistant msg and everything after the user message's next (assistant+)

    // Strategy: delete from assistant mid if any; else from first assistant after user

    const aMid = wrap.dataset.mid;

    if (aMid) {

      await deleteFromMessage(aMid);

    } else if (userMid) {

      // delete all after user by deleting from first following node mid

      const next = prev.nextElementSibling;

      if (next && next.dataset.mid) await deleteFromMessage(next.dataset.mid);

    }

    // DOM: remove wrap and after

    let n = wrap;

    while (n) {

      const x = n.nextElementSibling;

      n.remove();

      n = x;

    }

    // Resend same user text without creating a new user message if user still in DB

    // If we only deleted assistant+, user remains - call chat stream only

    await continueAfterUser();

  }



  async function streamAssistant(opts) {

    const model = opts && opts.model;

    const patchModel = !!(opts && opts.patchModel);

    if (!currentId) throw new Error("no conversation");

    if (!model) throw new Error("no model");

    const bubble = appendMsg("assistant", "", true);

    setStreamingBubble(bubble, true);

    let full = "";

    const res = await fetch("/api/chat", {

      method: "POST",

      credentials: "same-origin",

      headers: { "Content-Type": "application/json" },

      body: JSON.stringify({ conversation_id: currentId, model, stream: true }),

    });

    if (res.status === 401) {

      showLogin();

      throw new Error("unauthorized");

    }

    if (!res.ok) {

      const t = await res.text();

      setStreamingBubble(bubble, false);

      bubble.textContent = "Error: " + t;

      return "";

    }

    const ct = (res.headers.get("content-type") || "").toLowerCase();

    if (ct.includes("application/json") && !ct.includes("event-stream")) {

      const t = await res.text();

      try {

        const j = JSON.parse(t);

        const err = j.error?.message || j.error || j.message || t;

        setStreamingBubble(bubble, false);

        bubble.textContent = "Error: " + (typeof err === "string" ? err : JSON.stringify(err));

      } catch {

        setStreamingBubble(bubble, false);

        bubble.textContent = "Error: " + t;

      }

      return "";

    }

    if (!res.body) {

      setStreamingBubble(bubble, false);

      bubble.textContent = "Error: empty response body";

      return "";

    }

    const reader = res.body.getReader();

    const dec = new TextDecoder();

    let buf = "";

    const applyDelta = (delta) => {

      if (!delta) return;

      full += delta;

      appendStreamDelta(bubble, full);

      if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;

    };

    const parseDataLine = (line) => {

      const s = line.trim();

      if (!s.startsWith("data:")) return;

      const payload = s.slice(5).trim();

      if (!payload || payload === "[DONE]") return;

      try {

        const j = JSON.parse(payload);

        const delta =

          j.choices?.[0]?.delta?.content ??

          j.choices?.[0]?.message?.content ??

          "";

        applyDelta(delta);

      } catch {

        /* partial json */

      }

    };

    while (true) {

      const { value, done } = await reader.read();

      if (done) break;

      buf += dec.decode(value, { stream: true });

      const parts = buf.split("\n");

      buf = parts.pop() || "";

      for (const line of parts) parseDataLine(line);

    }

    if (buf.trim()) parseDataLine(buf);

    if (full && !bubble.dataset.hasToken) appendStreamDelta(bubble, full);

    setStreamingBubble(bubble, false);

    if (full) {

      const saved = await api(

        "/api/conversations/" + encodeURIComponent(currentId) + "/messages",

        { method: "POST", body: JSON.stringify({ role: "assistant", content: full }) }

      );

      if (saved.ok) {

        try {

          const jm = await saved.json();

          if (jm.id) {

            const w = bubble.closest(".msg");

            if (w) w.dataset.mid = jm.id;

          }

        } catch {

          /* ignore */

        }

      }

      if (patchModel) {

        await api("/api/conversations/" + encodeURIComponent(currentId), {

          method: "PATCH",

          body: JSON.stringify({ model }),

        });

      }

      await refreshConvs();

      if (patchModel) {

        const c = convs.find((x) => x.id === currentId);

        if (c) setChatTitle(c.title);

      }

    }

    wireActionsAfterStream(bubble, full);

    return full;

  }



  async function continueAfterUser() {

    if (streaming) return;

    const model = modelSel && modelSel.value;

    if (!model) {

      alert("Pilih model dulu");

      return;

    }

    if (!currentId) return;

    streaming = true;

    document.body.classList.add("is-streaming");

    if (btnSend) btnSend.disabled = true;

    try {

      await streamAssistant({ model, patchModel: false });

    } catch (e) {

      if (e.message !== "unauthorized") {

        const last = messagesEl && messagesEl.querySelector(".msg.assistant:last-child .bubble");

        if (last) last.textContent = "Gagal: " + e.message;

      }

    } finally {

      streaming = false;

      document.body.classList.remove("is-streaming");

      syncSendEnabled();

      onSendFinished();

    }

  }



  function displayModelName(m) {

    const raw = (m || "").trim();

    if (!raw) return "brengseek";

    if (/^komboku$/i.test(raw)) return "brengseek";

    return raw;

  }

  



  function syncShellChatClass() {

    const wrap = document.querySelector(".main-wrap");

    if (!wrap || !messagesEl) return;

    const has = !!messagesEl.querySelector(".msg");

    wrap.classList.toggle("has-chat", has);

    wrap.classList.toggle("is-empty", !has);

  }



  function syncEmptyVisibility() {

    if (!emptyEl || !messagesEl) return;

    const has = !!messagesEl.querySelector(".msg");

    emptyEl.classList.toggle("hidden", has);

    if (has) {

      emptyEl.setAttribute("hidden", "");

      emptyEl.style.display = "none";

    } else {

      emptyEl.removeAttribute("hidden");

      emptyEl.style.display = "";

    }

    syncShellChatClass();

  }



  function syncEmptyTitle() {

    const t = $("#empty-title");

    if (t) {

      t.textContent = "brengseek";

      t.style.setProperty("color", "#4D6BFE", "important");

      t.style.setProperty("-webkit-text-fill-color", "#4D6BFE", "important");

      t.style.opacity = "1";

    }

    const av = $("#empty-avatar");

    if (av) {

      let img = av.querySelector("img");

      if (!img) {

        av.innerHTML = "";

        img = document.createElement("img");

        av.appendChild(img);

      }

      img.className = "ds-logo-img";

      img.alt = "";

      const src = "/favicon.svg?v=82";

      if (img.getAttribute("src") !== src) img.src = src;

      img.width = 48;

      img.height = 48;

    }

  }



  async function ensureConv() {

    if (currentId) return currentId;

    const isPriv = privateMode === true;

    const r = await api("/api/conversations", {

      method: "POST",

      body: JSON.stringify({

        title: isPriv ? "Private chat" : "New chat",

        model: modelSel ? modelSel.value : "",

        private: isPriv,

      }),

    });

    if (!r.ok) throw new Error("create conv");

    const c = await r.json();

    currentId = c.id;

    currentIsPrivate = isPriv || !!c.private;

    privateMode = currentIsPrivate;

    if (!currentIsPrivate) {

      try { await refreshConvs(); } catch (e) {}

    }

    setChatTitle(c.title || (currentIsPrivate ? "Private chat" : "New chat"));

    syncPrivateUI();

    return currentId;

  }



  async function send() {

    if (streaming) return;

    if (!input || !modelSel) return;

    const text = input.value.trim();

    const filesSnap = pendingFiles.slice();

    if (!text && !filesSnap.length) return;

    const model = modelSel.value;

    if (!model) {

      alert("Pilih model dulu (Settings -> API endpoint & key)");

      return;

    }

    if (dictationOn) stopDictationRec();

    stopVoiceRec();

    dictBase = "";

    streaming = true;

    document.body.classList.add("is-streaming");

    /* empty hide on send */

    if (emptyEl) {

      emptyEl.classList.add("hidden");

      emptyEl.setAttribute("hidden", "");

      emptyEl.style.display = "none";

    }

    syncShellChatClass();

    if (btnSend) btnSend.disabled = true;

    input.value = "";

    autoGrow();

    try {

      await ensureConv();

      const saveUser = await api(

        "/api/conversations/" + encodeURIComponent(currentId) + "/messages",

        {

          method: "POST",

          body: JSON.stringify({

            role: "user",

            content: text,

            file_ids: filesSnap.map((f) => f.id),

          }),

        }

      );

      if (!saveUser.ok) {

        if (input) input.value = text;

        autoGrow();

        throw new Error("gagal simpan pesan");

      }

      let userMid = "";

      try {

        const uj = await saveUser.json();

        userMid = uj.id || "";

      } catch {

        /* ignore */

      }

      clearPending();

      const attsForUi = filesSnap.map((f) => ({

        id: f.id,

        name: f.name,

        content_type: f.content_type,

        size: f.size,

        url: f.url || "/api/files/" + f.id,

      }));

      appendMsg("user", text, false, attsForUi, userMid);

      await streamAssistant({ model, patchModel: true });

    } catch (e) {

      if (e.message === "unauthorized") return;

      const last = messagesEl && messagesEl.querySelector(".msg.assistant:last-child .bubble");

      if (last && !String(last.textContent || "").startsWith("Error:")) {

        last.textContent = "Gagal: " + e.message;

      } else if (!last) {

        if (input) input.value = text;

        autoGrow();

        if (pendingFiles.length === 0 && filesSnap.length) {

          pendingFiles = filesSnap.slice();

          renderAttachPreview();

        }

      }

    } finally {

      streaming = false;

      document.body.classList.remove("is-streaming");

      syncSendEnabled();

      onSendFinished();

    }

  }



  /* —— Model picker —— */

  const btnModel = $("#btn-model");

  const modelMenu = $("#model-menu");

  const modelChipLabel = $("#model-chip-label");



  function shortModelLabel(id) {

    const s = String(id || "").trim();

    if (!s) return "Model";

    let t = s.replace(/^[^\/]+\//, "");

    if (t.length > 22) t = t.slice(0, 20) + "...";

    return t;

  }



  function closeModelMenu() {

    if (!modelMenu || !btnModel) return;

    modelMenu.classList.add("hidden");

    btnModel.setAttribute("aria-expanded", "false");

  }



  function openModelMenu() {

    if (!modelMenu || !btnModel) return;

    refreshModelMenu();

    modelMenu.classList.remove("hidden");

    btnModel.setAttribute("aria-expanded", "true");

  }



  function refreshModelMenu() {

    if (!modelMenu || !modelSel) return;

    const cur = modelSel.value || "";

    if (modelChipLabel) modelChipLabel.textContent = shortModelLabel(cur) || "Model";

    modelMenu.innerHTML = "";

    const opts = [...modelSel.options].map((o) => o.value).filter(Boolean);

    if (!opts.length) {

      const empty = document.createElement("div");

      empty.className = "mode-item";

      empty.textContent = "No models — set API in Settings";

      modelMenu.appendChild(empty);

      return;

    }

    opts.forEach((id) => {

      const b = document.createElement("button");

      b.type = "button";

      b.className = "mode-item model-item" + (id === cur ? " active" : "");

      b.setAttribute("role", "option");

      b.textContent = id;

      b.title = id;

      b.onclick = () => {

        modelSel.value = id;

        try { localStorage.setItem("litewebui_model", id); } catch (e) {}

        refreshModelMenu();

        closeModelMenu();

        syncEmptyTitle();

      };

      modelMenu.appendChild(b);

    });

  }

  if (btnModel) {

    btnModel.addEventListener("click", (e) => {

      e.preventDefault();

      e.stopPropagation();

      if (modelMenu && !modelMenu.classList.contains("hidden")) closeModelMenu();

      else openModelMenu();

    });

  }

  document.addEventListener("click", (e) => {

    if (!modelMenu || modelMenu.classList.contains("hidden")) return;

    if (btnModel && (btnModel === e.target || btnModel.contains(e.target))) return;

    if (modelMenu.contains(e.target)) return;

    closeModelMenu();

  });



  /* —— Private mode —— */

  const btnPrivate = $("#btn-private");

  const privateHint = $("#private-hint");



  function syncPrivateUI() {

    const on = !!(privateMode || currentIsPrivate);

    document.body.classList.toggle("private-mode", on);

    if (btnPrivate) {

      btnPrivate.classList.toggle("active", on);

      btnPrivate.setAttribute("aria-pressed", on ? "true" : "false");

      btnPrivate.disabled = false;

      btnPrivate.title = on

        ? "Private on — click to leave private mode"

        : "Private chat — not listed in history";

    }

    if (privateHint) privateHint.classList.toggle("hidden", !on);

  }

  if (btnPrivate) {

    btnPrivate.addEventListener("click", () => {

      const on = !!(privateMode || currentIsPrivate);

      if (on) {

        // exit private: clear private conv from view, go public empty

        privateMode = false;

        currentIsPrivate = false;

        currentId = null;

        clearPending();

        if (typeof stopDictationRec === "function" && dictationOn) stopDictationRec();

        if (typeof exitVoiceMode === "function" && voiceModeOn) exitVoiceMode();

        renderMessages([]);

        setChatTitle("Chat");

        syncEmptyVisibility();

        try { refreshConvs(); } catch (e) {}

        try {

          const u = new URL(location.href);

          u.searchParams.delete("c");

          history.replaceState(null, "", u.pathname + u.search);

        } catch (e) {}

        syncPrivateUI();

        if (input) input.focus();

        return;

      }

      privateMode = true;

      syncPrivateUI();

    });

  }



  /* —— Voice: Web Speech + MediaRecorder STT —— */

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  const btnDictation = $("#btn-dictation");

  const btnVoiceMode = $("#btn-voice-mode");

  const btnVoiceExit = $("#btn-voice-exit");

  const voiceOverlay = $("#voice-overlay");

  const voiceStatus = $("#voice-overlay-status");

  const voicePartial = $("#voice-overlay-partial");



  function speechSupported() {

    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);

  }



  function mediaRecSupported() {

    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);

  }



  function sttAnySupported() {

    return speechSupported() || mediaRecSupported();

  }



  function pickRecorderMime() {

    const cands = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus", "audio/ogg"];

    for (let i = 0; i < cands.length; i++) {

      try {

        if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(cands[i])) return cands[i];

      } catch (e) {}

    }

    return "";

  }



  function showMicToast(msg) {

    try {

      let el = document.getElementById("mic-toast");

      if (!el) {

        el = document.createElement("div");

        el.id = "mic-toast";

        el.className = "mic-toast";

        el.setAttribute("role", "status");

        document.body.appendChild(el);

      }

      el.textContent = msg || "";

      el.classList.add("show");

      clearTimeout(el._t);

      el._t = setTimeout(() => el.classList.remove("show"), 4200);

    } catch (e) {}

  }



  function setVoiceStatus(tx) {

    if (voiceStatus) voiceStatus.textContent = tx || "";

  }



  function setVoicePartial(tx) {

    if (voicePartial) voicePartial.textContent = tx || "";

  }



  function stopSpeechSynth() {

    try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (e) {}

  }



  function speakText(text, onEnd) {

    stopSpeechSynth();

    let tx = String(text || "")

      .replace(/```[\s\S]*?```/g, " ")

      .replace(/`[^`]+`/g, " ")

      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")

      .replace(/\[[^\]]*\]\([^)]*\)/g, " ")

      .replace(/[#>*_~]+/g, " ")

      .replace(/\s+/g, " ")

      .trim();

    if (!tx || !window.speechSynthesis) { if (onEnd) onEnd(); return; }

    try {

      const u = new SpeechSynthesisUtterance(tx.slice(0, 1200));

      u.rate = 1.05;

      u.onend = () => { if (onEnd) onEnd(); };

      u.onerror = () => { if (onEnd) onEnd(); };

      window.speechSynthesis.speak(u);

    } catch (e) { if (onEnd) onEnd(); }

  }



  function lastAssistantText() {

    const bubbles = messagesEl ? messagesEl.querySelectorAll(".msg.assistant .bubble") : [];

    if (!bubbles.length) return "";

    const b = bubbles[bubbles.length - 1];

    return (b.innerText || b.textContent || "").trim();

  }



  function stopMediaTracks() {

    if (mediaStream) {

      try { mediaStream.getTracks().forEach((tr) => tr.stop()); } catch (e) {}

      mediaStream = null;

    }

  }



  function stopMediaCapture() {

    try { if (recMedia && recMedia.state !== "inactive") recMedia.stop(); } catch (e) {}

    recMedia = null;

    mediaChunks = [];

    mediaMode = null;

    stopMediaTracks();

  }



  function stopDictationRec() {

    dictationOn = false;

    try { if (recDict) recDict.stop(); } catch (e) {}

    recDict = null;

    if (mediaMode === "dictation") {

      try { if (recMedia && recMedia.state !== "inactive") recMedia.stop(); } catch (e) {}

    }

    syncVoiceButtons();

  }



  function stopVoiceRec() {

    voiceListenArmed = false;

    try { if (recVoice) recVoice.stop(); } catch (e) {}

    recVoice = null;

    if (mediaMode === "voice") {

      try { if (recMedia && recMedia.state !== "inactive") recMedia.stop(); } catch (e) {}

    }

  }



  function handleMicDenied() {

    showMicToast("Izinkan mikrofon di banner browser / pengaturan situs, lalu coba lagi.");

    if (dictationOn) stopDictationRec();

    if (voiceModeOn) exitVoiceMode();

    else {

      stopVoiceRec();

      stopMediaCapture();

      syncVoiceButtons();

    }

  }



  function syncVoiceButtons() {

    const ok = sttAnySupported();

    if (btnDictation) {

      btnDictation.disabled = !ok;

      btnDictation.classList.toggle("active", dictationOn);

      btnDictation.style.display = ok ? "" : "none";

      btnDictation.setAttribute("aria-pressed", dictationOn ? "true" : "false");

    }

    if (btnVoiceMode) {

      btnVoiceMode.disabled = !ok;

      btnVoiceMode.classList.toggle("active", voiceModeOn);

      btnVoiceMode.style.display = ok ? "" : "none";

      btnVoiceMode.setAttribute("aria-pressed", voiceModeOn ? "true" : "false");

    }

    document.body.classList.toggle("dictation-on", dictationOn);

    document.body.classList.toggle("voice-mode-on", voiceModeOn);

    document.documentElement.classList.toggle("no-speech-recognition", !speechSupported());

    document.documentElement.classList.toggle("has-media-stt", mediaRecSupported());

    if (voiceOverlay) {

      voiceOverlay.classList.toggle("hidden", !voiceModeOn);

      voiceOverlay.setAttribute("aria-hidden", voiceModeOn ? "false" : "true");

    }

  }



  async function ensureMicStream() {

    if (mediaStream) return mediaStream;

    mediaStream = await navigator.mediaDevices.getUserMedia({

      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },

    });

    return mediaStream;

  }



  async function transcribeBlob(blob) {

    if (!blob || blob.size < 64) return "";

    const fd = new FormData();

    let ext = "webm";

    const type = blob.type || mediaMime || "audio/webm";

    if (type.indexOf("mp4") >= 0) ext = "mp4";

    else if (type.indexOf("ogg") >= 0) ext = "ogg";

    else if (type.indexOf("mp3") >= 0 || type.indexOf("mpeg") >= 0) ext = "mp3";

    fd.append("file", blob, "speech." + ext);

    fd.append("model", "whisper-1");

    const r = await api("/api/v1/audio/transcriptions", { method: "POST", body: fd });

    if (!r.ok) throw new Error(await r.text().catch(() => "STT failed"));

    const ct = (r.headers.get("content-type") || "").toLowerCase();

    if (ct.indexOf("json") >= 0) {

      const j = await r.json();

      return String(j.text || j.transcript || "").trim();

    }

    return (await r.text()).trim();

  }



  function startMediaRec(mode, onStopped) {

    return ensureMicStream().then((stream) => {

      mediaChunks = [];

      mediaMode = mode;

      mediaMime = pickRecorderMime();

      try {

        recMedia = mediaMime ? new MediaRecorder(stream, { mimeType: mediaMime }) : new MediaRecorder(stream);

      } catch (e) {

        recMedia = new MediaRecorder(stream);

      }

      recMedia.ondataavailable = (ev) => {

        if (ev.data && ev.data.size) mediaChunks.push(ev.data);

      };

      recMedia.onstop = () => {

        const type = mediaMime || (mediaChunks[0] && mediaChunks[0].type) || "audio/webm";

        const blob = new Blob(mediaChunks, { type: type });

        mediaChunks = [];

        if (onStopped) onStopped(blob);

      };

      recMedia.start(250);

    });

  }



  async function startDictation() {

    if (voiceModeOn) exitVoiceMode();

    if (dictationOn) {

      if (!speechSupported() && mediaMode === "dictation" && recMedia && recMedia.state !== "inactive") {

        showMicToast("Memproses suara…");

        try { recMedia.stop(); } catch (e) {}

        dictationOn = false;

        syncVoiceButtons();

        return;

      }

      stopDictationRec();

      return;

    }

    if (speechSupported()) {

      dictBase = input ? input.value : "";

      recDict = new SpeechRecognition();

      recDict.continuous = true;

      recDict.interimResults = true;

      recDict.lang = navigator.language || "en-US";

      recDict.onresult = (ev) => {

        let interim = "", finalBit = "";

        for (let i = ev.resultIndex; i < ev.results.length; i++) {

          const r = ev.results[i];

          if (r.isFinal) finalBit += r[0].transcript;

          else interim += r[0].transcript;

        }

        if (finalBit) dictBase = (dictBase + (dictBase && !/\s$/.test(dictBase) ? " " : "") + finalBit).replace(/\s+/g, " ");

        if (input) {

          input.value = (dictBase + (interim ? " " + interim : "")).replace(/^\s+/, "");

          autoGrow();

          syncSendEnabled();

        }

      };

      recDict.onerror = (ev) => {

        if (ev.error === "not-allowed") { handleMicDenied(); return; }

        stopDictationRec();

      };

      recDict.onend = () => {

        if (dictationOn) {

          try { recDict.start(); } catch (e) { stopDictationRec(); }

        } else syncVoiceButtons();

      };

      dictationOn = true;

      syncVoiceButtons();

      try { recDict.start(); } catch (e) {

        dictationOn = false;

        syncVoiceButtons();

        showMicToast("Tidak bisa mulai dictation.");

      }

      return;

    }

    if (!mediaRecSupported()) {

      showMicToast("Dictation tidak tersedia di browser ini.");

      return;

    }

    dictBase = input ? input.value : "";

    try {

      await startMediaRec("dictation", async (blob) => {

        try {

          showMicToast("Menranskripsi…");

          const text = await transcribeBlob(blob);

          if (text && input) {

            const base = (dictBase || "").trim();

            input.value = (base ? base + " " : "") + text;

            dictBase = input.value;

            autoGrow();

            syncSendEnabled();

          } else showMicToast("Tidak ada teks (cek Whisper di 9router).");

        } catch (err) {

          showMicToast("STT gagal: butuh /v1/audio/transcriptions");

        } finally {

          dictationOn = false;

          stopMediaTracks();

          syncVoiceButtons();

        }

      });

      dictationOn = true;

      syncVoiceButtons();

      showMicToast("Merekam… klik mic lagi untuk selesai.");

    } catch (e) {

      if (e && (e.name === "NotAllowedError" || e.name === "PermissionDeniedError")) handleMicDenied();

      else showMicToast("Mikrofon tidak bisa diakses.");

      dictationOn = false;

      stopMediaCapture();

      syncVoiceButtons();

    }

  }



  function armVoiceListen() {

    if (!voiceModeOn || streaming) return;

    stopVoiceRec();

    stopSpeechSynth();

    setVoiceStatus("Listening…");

    setVoicePartial("");

    if (speechSupported()) {

      recVoice = new SpeechRecognition();

      recVoice.continuous = false;

      recVoice.interimResults = true;

      recVoice.lang = navigator.language || "en-US";

      let finalText = "";

      recVoice.onresult = (ev) => {

        let interim = "";

        finalText = "";

        for (let i = 0; i < ev.results.length; i++) {

          const r = ev.results[i];

          if (r.isFinal) finalText += r[0].transcript;

          else interim += r[0].transcript;

        }

        setVoicePartial(finalText || interim);

      };

      recVoice.onerror = (ev) => {

        if (!voiceModeOn) return;

        if (ev.error === "not-allowed") { handleMicDenied(); return; }

        if (ev.error === "no-speech" || ev.error === "aborted") {

          setTimeout(() => { if (voiceModeOn && !streaming) armVoiceListen(); }, 400);

        }

      };

      recVoice.onend = () => {

        if (!voiceModeOn) return;

        const said = (finalText || "").trim();

        if (said && !streaming) {

          if (input) { input.value = said; autoGrow(); }

          setVoiceStatus("Thinking…");

          setVoicePartial(said);

          send();

        } else if (!streaming) setTimeout(() => { if (voiceModeOn) armVoiceListen(); }, 350);

      };

      try { recVoice.start(); } catch (e) {

        setTimeout(() => { if (voiceModeOn) armVoiceListen(); }, 500);

      }

      return;

    }

    if (!mediaRecSupported()) { setVoiceStatus("STT tidak tersedia"); return; }

    startMediaRec("voice", async (blob) => {

      if (!voiceModeOn) return;

      try {

        setVoiceStatus("Transcribing…");

        const text = await transcribeBlob(blob);

        setVoicePartial(text || "");

        if (text && !streaming) {

          if (input) { input.value = text; autoGrow(); }

          setVoiceStatus("Thinking…");

          send();

        } else if (voiceModeOn && !streaming) {

          setTimeout(() => { if (voiceModeOn) armVoiceListen(); }, 400);

        }

      } catch (err) {

        showMicToast("STT gagal — butuh Whisper di 9router.");

        setTimeout(() => { if (voiceModeOn) armVoiceListen(); }, 800);

      }

    }).then(() => {

      setTimeout(() => {

        if (voiceModeOn && mediaMode === "voice" && recMedia && recMedia.state !== "inactive") {

          try { recMedia.stop(); } catch (e) {}

        }

      }, 6000);

    }).catch((e) => {

      if (e && (e.name === "NotAllowedError" || e.name === "PermissionDeniedError")) handleMicDenied();

      else showMicToast("Mikrofon tidak bisa diakses.");

    });

  }



  function enterVoiceMode() {

    if (!sttAnySupported()) { showMicToast("Voice mode tidak tersedia."); return; }

    if (dictationOn) stopDictationRec();

    if (voiceModeOn) { exitVoiceMode(); return; }

    voiceModeOn = true;

    syncVoiceButtons();

    setVoiceStatus(speechSupported() ? "Voice mode" : "Voice mode (Whisper)");

    armVoiceListen();

  }



  function exitVoiceMode() {

    voiceModeOn = false;

    stopVoiceRec();

    stopSpeechSynth();

    stopMediaCapture();

    setVoicePartial("");

    setVoiceStatus("Voice mode");

    syncVoiceButtons();

  }



  function onSendFinished() {

    if (!voiceModeOn) return;

    const reply = lastAssistantText();

    if (reply && !/^Gagal:|^Error:/i.test(reply)) {

      setVoiceStatus("Speaking…");

      speakText(reply, () => { if (voiceModeOn) armVoiceListen(); });

    } else {

      setTimeout(() => { if (voiceModeOn) armVoiceListen(); }, 400);

    }

    if (!currentIsPrivate) { try { refreshConvs(); } catch (e) {} }

  }

  if (btnDictation) btnDictation.addEventListener("click", (e) => { e.preventDefault(); startDictation(); });

  if (btnVoiceMode) btnVoiceMode.addEventListener("click", (e) => { e.preventDefault(); enterVoiceMode(); });

  if (btnVoiceExit) btnVoiceExit.addEventListener("click", (e) => { e.preventDefault(); exitVoiceMode(); });

  document.addEventListener("keydown", (e) => {

    const tag = (e.target && e.target.tagName) || "";

    const typing = tag === "INPUT" || tag === "TEXTAREA" || (e.target && e.target.isContentEditable);

    if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === "d" || e.key === "D")) {

      if (typing && e.target !== input) return;

      e.preventDefault();

      startDictation();

      return;

    }

    if (e.ctrlKey && e.shiftKey && !e.altKey && (e.key === "O" || e.key === "o")) {

      e.preventDefault();

      enterVoiceMode();

      return;

    }

    if (e.key === "Escape" && voiceModeOn) {

      e.preventDefault();

      exitVoiceMode();

    }

  });



  /* chrome classes for responsive brand */



  function syncChromeClasses() {

    const mobile = isMobileSidebar();

    document.body.classList.toggle("is-mobile", mobile);

    document.body.classList.toggle("is-desktop", !mobile);

    const app = document.getElementById("app");

    document.body.classList.toggle("sidebar-is-collapsed", !!(app && app.classList.contains("sidebar-collapsed")));

    document.body.classList.toggle("sidebar-drawer-open", !!(sidebar && sidebar.classList.contains("open")));

  }

  window.addEventListener("resize", () => { try { syncChromeClasses(); } catch (e) {} });

  syncPrivateUI();

  syncVoiceButtons();

  refreshModelMenu();

  syncChromeClasses();

  syncEmptyTitle();

  syncSendEnabled();

  boot();

})();

