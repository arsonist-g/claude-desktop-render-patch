/*
 * Claude Desktop third-party rendering runtime.
 *
 * The script is injected into the claude.ai main view after Mermaid and
 * MathJax have been loaded. It upgrades code blocks and message text without
 * depending on the remote application's React component tree.
 */
(function () {
  "use strict";

  var VERSION = "1.0.0";
  var MARKER = "__claudeThirdPartyRenderInstalled";
  var LOG_PREFIX = "[third-party-render]";

  if (window[MARKER] === VERSION) {
    return;
  }

  var mermaid = window.mermaid;
  var mathJax = window.MathJax;
  var nextId = 0;
  var scanScheduled = false;
  var pendingRoots = new Set();
  var mathQueue = Promise.resolve();
  var mermaidQueue = Promise.resolve();
  var textState = new WeakMap();
  var blockState = new WeakSet();
  var wrappedMermaid = new WeakMap();
  var mermaidTimers = new WeakMap();
  var knownRoots = new Set();
  var lastMutationAt = Date.now();
  var IDLE_DELAY = 380;
  var observedRoots = new WeakSet();

  var MERMAID_SELECTOR = [
    "pre > code.language-mermaid",
    "pre > code.lang-mermaid",
    "pre > code.mermaid",
    "pre.language-mermaid",
    "code.language-mermaid",
    "pre.mermaid",
    "div.mermaid",
    "[class*=\"language-mermaid\"]",
    "[class*=\"lang-mermaid\"]",
    "[data-language=\"mermaid\"]"
  ].join(",");

  var MATH_CODE_RE = /(?:^|[\s_-])(?:language|lang)?[-_]?(math|latex|tex|katex|mathjax|mathml|mml)(?:$|[\s_-])/i;
  var STRONG_MATH_RE = /(?<!\\)\\\(|(?<!\\)\\\[|(?<!\\)\$\$|\\begin\{[a-zA-Z*]+\}/;
  var INLINE_DOLLAR_RE = /(?<!\\)\$(?![\s$])[^$\n]*?(?<![\s\\])(?<!\\)\$(?![\d$])/;
  var MATH_TEXT_RE = /(?<!\\)\$\$([\s\S]*?)(?<!\\)\$\$|(?<!\\)\\\[([\s\S]*?)(?<!\\)\\\]|(?<!\\)\\\(([\s\S]*?)(?<!\\)\\\)|(?<!\\)\$(?![\s$])((?:\\.|[^$\\\n])+?)(?<![\s\\])(?<!\\)\$(?![\d$])|(\\begin\{[a-zA-Z*]+\}[\s\S]*?\\end\{[a-zA-Z*]+\})/g;
  var MERMAID_START_RE = /^(?:---[\s\S]*?---\s*)?(?:%%\{[\s\S]*?%%\}\s*)*(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|gantt|pie|mindmap|timeline|quadrantChart|requirementDiagram|C4Context|C4Container|C4Component|C4Dynamic|C4Deployment|gitGraph|sankey-beta|xychart-beta|block-beta|packet-beta|architecture-beta|radar-beta|treemap-beta|journey)\b/i;

  function log(message, error) {
    try {
      if (error) {
        console.warn(LOG_PREFIX + " " + message, error);
      } else {
        console.info(LOG_PREFIX + " " + message);
      }
    } catch (_) {
      /* console may be unavailable in unusual frames */
    }
  }

  function parentElementOf(element) {
    if (!element) return null;
    if (element.parentElement) return element.parentElement;
    var root = element.getRootNode && element.getRootNode();
    return root && root.host ? root.host : null;
  }

  var STYLE_TEXT = [
      ".tpr-rendered{margin:.75rem 0;position:relative;z-index:3;max-width:100%;overflow:hidden}",
      ".tpr-rendered[hidden]{display:none!important}",
      ".tpr-toolbar{position:relative;z-index:2147483000;display:flex;align-items:center;gap:.5rem;padding:.5rem .65rem;border-bottom:1px solid color-mix(in srgb,currentColor 14%,transparent);background:light-dark(#f7f7f5,#1b1b1b);color:inherit;font-size:12px;line-height:1.2}",
      ".tpr-title{font-size:13px;font-weight:500}",
      ".tpr-badge{font:11px/1.2 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:color-mix(in srgb,currentColor 72%,transparent);border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:.35rem;padding:.15rem .35rem}",
      ".tpr-actions{margin-left:auto;display:flex;align-items:center;gap:.2rem}",
      ".tpr-action{appearance:none;border:0;background:transparent;color:inherit;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;width:1.6rem;height:1.6rem;padding:0;font:15px/1 system-ui,sans-serif;border-radius:.35rem}",
      ".tpr-action:hover{background:color-mix(in srgb,currentColor 12%,transparent)}",
      ".tpr-toolbar button{appearance:none;border:0;background:transparent;color:inherit;cursor:pointer;font:inherit;padding:.1rem .25rem;border-radius:.25rem}",
      ".tpr-toolbar button:hover{background:color-mix(in srgb,currentColor 12%,transparent)}",
      ".tpr-content{width:100%;max-width:100%;box-sizing:border-box;max-height:min(100%,80vh);overflow:clip;position:relative}",
      ".tpr-content[data-pannable='true']{cursor:grab}",
      ".tpr-content.tpr-dragging{cursor:grabbing!important;user-select:none}",
      ".tpr-content.tpr-dragging *{user-select:none!important}",
      ".tpr-modal-content[data-pannable='true']{cursor:grab}",
      ".tpr-modal-content.tpr-dragging{cursor:grabbing!important;user-select:none}",
      ".tpr-content > svg,.tpr-mermaid svg{display:block;max-width:none;height:auto;margin:0 auto}",
      ".tpr-rendered[data-overflow='true'] .tpr-content::after{content:'';position:absolute;left:0;right:0;bottom:0;height:4rem;pointer-events:none;background:linear-gradient(transparent,light-dark(rgba(255,255,255,.96),rgba(21,21,21,.96)))}",
      ".tpr-content svg,.tpr-modal-content svg{will-change:transform}",
      ".tpr-expand{display:inline-flex;align-items:center;justify-content:center}",
      
      ".tpr-modal{position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;padding:2rem;background:rgba(0,0,0,.72)}",
      ".tpr-modal[hidden]{display:none}",
      ".tpr-modal-panel{position:relative;display:flex;flex-direction:column;width:100%;max-width:94vw;max-height:94vh;overflow:clip;border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:.75rem;background:light-dark(#fff,#151515);color:light-dark(#111,#eee);box-shadow:0 24px 80px rgba(0,0,0,.5)}",
      ".tpr-modal-close{position:absolute;top:.5rem;right:.55rem;z-index:2147483001;display:inline-flex;align-items:center;justify-content:center;width:1.6rem;height:1.6rem;border:0;border-radius:999px;background:color-mix(in srgb,currentColor 10%,transparent);color:inherit;cursor:pointer;font:15px/1 system-ui,sans-serif;padding:0}",
      ".tpr-modal-close:hover{background:color-mix(in srgb,currentColor 20%,transparent)}",
      ".tpr-modal-panel > .tpr-toolbar{padding-right:2.7rem}",
      ".tpr-modal-content{box-sizing:border-box;flex:1;min-height:0;padding:1rem;overflow:clip;display:flex;align-items:center;justify-content:center}",
      ".tpr-modal-content > svg{max-width:none;height:auto}",
      ".tpr-math{overflow-x:auto;overflow-y:hidden;padding:.15rem 0}",
      ".tpr-math mjx-container{max-width:100%;overflow-x:auto;overflow-y:hidden}",
      ".tpr-math[data-display='true']{text-align:center}",
      ".tpr-error{white-space:pre-wrap;word-break:break-word;color:#b42318;background:color-mix(in srgb,#b42318 10%,transparent);border:1px solid color-mix(in srgb,#b42318 30%,transparent);border-radius:.4rem;padding:.5rem .65rem;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}",
      ".tpr-source-hidden{display:none!important}",
      ".tpr-host-hidden{display:none!important;pointer-events:none!important}",
      /* 宿主代码块外壳里的悬浮工具条（Copy code 的可点击层）：用 :has 只在被我们接管的代码块里生效，
         纯 CSS 命中意味着宿主重渲染重建节点时也会立刻被隐藏，不会一闪一闪。 */
      "[class*='epitaxy-codeblock']:has(.tpr-rendered) [class*='pointer-events-auto'],",
      "[class*='epitaxy-codeblock']:has(.tpr-rendered) [class*='pointer-events-none'][class*='absolute']{display:none!important;pointer-events:none!important}",
      ".tpr-mathml{overflow-x:auto;text-align:center}"
    ].join("");

  function installStyles(root) {
    var scope = root || document;
    if (scope.getElementById && scope.getElementById("tpr-styles")) {
      return;
    }
    var style = document.createElement("style");
    style.id = "tpr-styles";
    style.textContent = STYLE_TEXT;
    (scope.head || scope.documentElement || scope).appendChild(style);
  }

  function isDarkMode() {
    var body = document.body;
    var root = document.documentElement;
    var attr = ((root && (root.getAttribute("data-mode") || root.getAttribute("data-theme"))) || "").toLowerCase();
    if (attr.indexOf("dark") >= 0) {
      return true;
    }
    if (root && root.classList && (root.classList.contains("dark") || root.classList.contains("darkTheme"))) {
      return true;
    }
    if (!body || !window.getComputedStyle) {
      return false;
    }
    var background = window.getComputedStyle(body).backgroundColor || "";
    var match = background.match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
    if (!match) {
      return false;
    }
    var r = Number(match[1]);
    var g = Number(match[2]);
    var b = Number(match[3]);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) < 128;
  }

  function mermaidConfig() {
    return {
      startOnLoad: false,
      securityLevel: "strict",
      theme: isDarkMode() ? "dark" : "default",
      deterministicIds: true,
      deterministicIDSeed: "claude-third-party-render",
      fontFamily: "inherit",
      flowchart: { htmlLabels: false, useMaxWidth: false },
      sequence: { useMaxWidth: false },
      gantt: { useMaxWidth: false },
      journey: { useMaxWidth: false },
      class: { useMaxWidth: false },
      state: { useMaxWidth: false },
      er: { useMaxWidth: false },
      pie: { useMaxWidth: false },
      quadrantChart: { useMaxWidth: false },
      requirement: { useMaxWidth: false },
      mindmap: { useMaxWidth: false },
      timeline: { useMaxWidth: false },
      gitGraph: { useMaxWidth: false },
      sankey: { useMaxWidth: false },
      xychart: { useMaxWidth: false },
      block: { useMaxWidth: false },
      packet: { useMaxWidth: false },
      architecture: { useMaxWidth: false },
      radar: { useMaxWidth: false },
      treemap: { useMaxWidth: false }
    };
  }

  function initializeMermaid() {
    if (!mermaid || typeof mermaid.initialize !== "function") {
      return false;
    }
    try {
      mermaid.initialize(mermaidConfig());
      return true;
    } catch (error) {
      log("Mermaid initialization failed", error);
      return false;
    }
  }

  function languageOf(element) {
    var current = element;
    var depth = 0;
    while (current && current.getAttribute && depth < 4) {
      var dataLanguage = current.getAttribute("data-language") || current.getAttribute("data-lang") || "";
      if (dataLanguage) {
        return String(dataLanguage).toLowerCase();
      }
      var className = typeof current.className === "string" ? current.className : current.getAttribute("class") || "";
      var match = className.match(/(?:language|lang)[-_]([a-z0-9_-]+)/i);
      if (match) {
        return match[1].toLowerCase();
      }
      current = parentElementOf(current);
      depth += 1;
    }
    return "";
  }

  function isBlockedNode(node) {
    var element = node && (node.nodeType === 1 ? node : node.parentElement);
    while (element) {
      if (element.matches) {
        if (element.matches("script,noscript,style,textarea,pre,code,math,mjx-container,.tpr-rendered,.tpr-toolbar,.tpr-ignore,mathjax_ignore")) {
          return true;
        }
      }
      element = parentElementOf(element);
    }
    return false;
  }

  function isVisible(element) {
    if (!element || !element.isConnected || !window.getComputedStyle) {
      return false;
    }
    var style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  }

  function messageLike(element) {
    var selectors = [
      "[data-testid*='message']",
      "[data-testid*='conversation']",
      "[data-testid*='chat']",
      "[class*='font-claude']",
      "[class*='message']",
      "[class*='markdown']",
      "[class*='prose']"
    ];
    var current = element;
    var depth = 0;
    while (current && current !== document.body && depth < 12) {
      if (current.matches && current.matches(selectors.join(","))) {
        return true;
      }
      current = parentElementOf(current);
      depth += 1;
    }
    return false;
  }

  /* mhchem 的 MathJax 扩展依赖包注册，注册时机在真实页面里不稳定。
     改为在排版之前用标准的 mhchemParser 把 \\ce{} / \\pu{} 展开成普通 TeX，
     不依赖任何包注册，结果稳定。 */
  function replaceChemCommand(text, name) {
    var parser = window.mhchemParser;
    if (!parser || typeof parser.toTex !== "function") {
      return text;
    }
    var needle = "\\" + name;
    var out = "";
    var i = 0;
    while (i < text.length) {
      var idx = text.indexOf(needle, i);
      if (idx < 0) {
        out += text.slice(i);
        break;
      }
      var after = idx + needle.length;
      while (text[after] === " ") {
        after += 1;
      }
      if (text[after] !== "{") {
        out += text.slice(i, after);
        i = after;
        continue;
      }
      var depth = 0;
      var end = -1;
      for (var j = after; j < text.length; j += 1) {
        if (text[j] === "\\") {
          j += 1;
          continue;
        }
        if (text[j] === "{") {
          depth += 1;
        } else if (text[j] === "}") {
          depth -= 1;
          if (depth === 0) {
            end = j;
            break;
          }
        }
      }
      if (end < 0) {
        out += text.slice(i);
        break;
      }
      var body = text.slice(after + 1, end);
      var tex = null;
      try {
        tex = parser.toTex(body, name);
      } catch (_) {
        tex = null;
      }
      out += text.slice(i, idx) + (tex != null ? tex : text.slice(idx, end + 1));
      i = end + 1;
    }
    return out;
  }

  var loggedMissingParser = false;

  function expandChemistry(text) {
    if (!text || text.indexOf("\\ce") < 0 && text.indexOf("\\pu") < 0) {
      return text;
    }
    if (!window.mhchemParser && !loggedMissingParser) {
      loggedMissingParser = true;
      log("mhchemParser is unavailable; chemistry left as-is");
    }
    return replaceChemCommand(replaceChemCommand(text, "ce"), "pu");
  }

  /* 只在数学跨度内展开，避免把正文里的字面 "\ce{...}" 弄乱 */
  var MATH_SPAN_RE = /\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$\$[\s\S]*?\$\$/g;

  function expandChemistryInMath(text) {
    if (!text || (text.indexOf("\\ce") < 0 && text.indexOf("\\pu") < 0)) {
      return text;
    }
    return text.replace(MATH_SPAN_RE, function (span) {
      return expandChemistry(span);
    });
  }

  function transformMathText(value) {
    var changed = false;
    var result = value.replace(MATH_TEXT_RE, function (match, displayDollar, displayBracket, inlineParen, inlineDollar, environment) {
      changed = true;
      if (displayDollar != null) {
        return "\\[" + displayDollar + "\\]";
      }
      if (displayBracket != null) {
        return match;
      }
      if (inlineParen != null) {
        return match;
      }
      if (inlineDollar != null) {
        return "\\(" + inlineDollar + "\\)";
      }
      if (environment != null) {
        return "\\[" + environment + "\\]";
      }
      return match;
    });
    return { text: expandChemistryInMath(result), changed: changed };
  }

  function mathContainerFor(node) {
    var element = node && node.parentElement;
    var fallback = element;
    while (element && element !== document.body) {
      if (element.matches && element.matches("p,li,blockquote,td,th,section,article,div")) {
        return element;
      }
      fallback = element;
      element = parentElementOf(element);
    }
    return fallback || document.body;
  }

  var mhchemSource = "/*__MH CHEM_SOURCE__*/";
  var mhchemPromise = null;

  /* 直接把 mhchem 扩展源码在页面里求值一次：不依赖 loader 的网络/组件机制，
     也不依赖注入顺序。eval 失败只会影响 \ce，其余公式照常。 */
  function registerMhchem() {
    if (mhchemSource.indexOf("MhchemConfiguration") < 0) {
      return false;
    }
    try {
      (0, eval)(mhchemSource);
      return true;
    } catch (error) {
      log("mhchem registration failed", error);
      return false;
    }
  }

  /* 判断 mhchem 是否已经注册到 MathJax 内部：这是唯一可靠的信号，
     tex2svg 的文本输出在不同构建下不可比。 */
  function mhchemRegistered(current) {
    var registry = current && current._ && current._.input && current._.input.tex && current._.input.tex.mhchem;
    return !!(registry && registry.MhchemConfiguration);
  }

  var mhchemEnsured = false;

  function ensureMhchemNow() {
    var current = window.MathJax;
    if (!current || typeof current.typesetPromise !== "function") {
      return false;
    }
    if (mhchemEnsured && mhchemRegistered(current)) {
      return true;
    }
    mhchemEnsured = true;
    var registered = mhchemRegistered(current);
    if (!registered) {
      registerMhchem();
      registered = mhchemRegistered(current);
      var packages = current.config && current.config.tex && current.config.tex.packages;
      if (Array.isArray(packages) && packages.indexOf("mhchem") < 0) {
        packages.push("mhchem");
      }
      /* 扩展是注册到 MathJax._ 的；输入 jax 若已建好，必须重建才会带上这个包 */
      rebuildInputJax(current);
    }
    return registered;
  }

  /* mhchem 的扩展代码已经随包注入；这里显式 load 一次把它注册进宏表。
     带超时：即使加载失败也只影响 \ce，绝不阻塞其他公式。 */
  function queueMath(roots) {
    if (!roots || roots.length === 0) {
      return;
    }
    var unique = [];
    var seen = new Set();
    roots.forEach(function (root) {
      if (root && root.isConnected && !seen.has(root)) {
        seen.add(root);
        unique.push(root);
      }
    });
    if (unique.length === 0) {
      return;
    }
    mathQueue = mathQueue.then(function () {
      var current = window.MathJax;
      if (!current) {
        return undefined;
      }
      var startup = current.startup && current.startup.promise ? current.startup.promise : Promise.resolve();
      return Promise.resolve(startup).then(function () {
        current = window.MathJax;
        if (!current || typeof current.typesetPromise !== "function") {
          return undefined;
        }
        ensureMhchemNow();
        return current.typesetPromise(unique);
      });
    }).then(function () {
      setTimeout(refreshOverflowStates, 0);
    }).catch(function (error) {
      log("MathJax typesetting failed", error);
    });
  }

  function clearMermaidArtifacts(id) {
    [id, "d" + id].forEach(function (candidate) {
      var node = document.getElementById(candidate);
      if (node && node.parentNode && node !== document.body && !node.closest(".tpr-content")) {
        node.parentNode.removeChild(node);
      }
    });
  }

  function parseMermaid(source) {
    if (!mermaid || typeof mermaid.parse !== "function") {
      return Promise.resolve(true);
    }
    return Promise.resolve()
      .then(function () { return mermaid.parse(source, { suppressErrors: true }); })
      .then(function (ok) { return ok !== false; }, function () { return false; });
  }

  function queueMermaid(wrapper, source) {
    if (!mermaid || typeof mermaid.render !== "function") {
      showMermaidError(wrapper, "Mermaid 未加载");
      return;
    }
    mermaidQueue = mermaidQueue.then(function () {
      var id = "tpr-mermaid-" + (++nextId);
      return parseMermaid(source).then(function (ok) {
        if (!ok) {
          return { tprIncomplete: true, id: id };
        }
        return Promise.resolve(mermaid.render(id, source));
      }).then(function (result) {
        if (result && result.tprIncomplete) {
          clearMermaidArtifacts(result.id);
          var attempts = (wrapper.__tprMermaidAttempts || 0) + 1;
          wrapper.__tprMermaidAttempts = attempts;
          if (attempts <= 8 && wrapper.isConnected) {
            setTimeout(function () {
              if (wrapper.isConnected) queueMermaid(wrapper, wrapper.dataset.source || source);
            }, 400 + attempts * 120);
            return;
          }
          throw new Error("源码不完整或语法错误");
        }
        wrapper.__tprMermaidAttempts = 0;
        var svg = result && result.svg ? result.svg : String(result || "");
        var content = wrapper.querySelector(".tpr-content");
        if (!content) {
          return;
        }
        content.innerHTML = svg;
        var rendered = content.querySelector("svg");
        if (rendered) {
          var declared = parseFloat(rendered.style.maxWidth);
          rendered.dataset.tprNaturalWidth = String(declared > 0 && isFinite(declared) ? declared : (rendered.getBoundingClientRect().width || 0));
        }
        content.dataset.tprRendered = "1";
        delete content.dataset.tprLoading;
        content.classList.remove("tpr-loading");
        requestAnimationFrame(function () { updateOverflowState(wrapper); });
        if (result && typeof result.bindFunctions === "function") {
          try {
            result.bindFunctions(content);
          } catch (error) {
            log("Mermaid bindFunctions failed", error);
          }
        }
      });
    }).catch(function (error) {
      clearMermaidArtifacts("tpr-mermaid-" + nextId);
      showMermaidError(wrapper, error && error.message ? error.message : String(error));
    });
  }

  function showMermaidError(wrapper, message) {
    if (!wrapper || !wrapper.isConnected) {
      return;
    }
    var content = wrapper.querySelector(".tpr-content");
    if (content) {
      content.innerHTML = "";
      delete content.dataset.tprLoading;
      var error = document.createElement("div");
      error.className = "tpr-error";
      error.textContent = "Mermaid 渲染失败：" + message;
      content.appendChild(error);
    }
    var sourceNode = wrapper.__tprSourceNode;
    if (sourceNode && sourceNode.isConnected) {
      sourceNode.classList.remove("tpr-source-hidden");
      sourceNode.style.display = "";
    }
  }

  /* 宿主会在 mousedown 后重排 DOM，mouseup 落不到同一个按钮上，click 不会产生；
     有时候还有别的元素盖在按钮上，真实命中目标根本不是按钮。所以动作分两步：
     1) 在 document 捕获阶段按坐标匹配我们自己的按钮，命中就直接执行；
     2) 按钮自身的 pointerdown / click 作为兜底。 */
  var actionButtons = [];

  /* 一次物理点击会先来 pointerdown、后面再补一个 click。两个入口都要工作，
     但只能执行一次，否则复制按钮的 ✓ 会把 "✓" 当成原图标存下来，永远变不回去。 */
  function runAction(entry, event) {
    entry.suppressClickUntil = Date.now() + 700;
    entry.handler(event);
  }

  function registerAction(button, handler) {
    var entry = { button: button, handler: handler, suppressClickUntil: 0 };
    actionButtons.push(entry);
    if (actionButtons.length > 120) {
      actionButtons = actionButtons.filter(function (item) { return item.button.isConnected; });
    }
    button.__tprActionEntry = entry;
    button.addEventListener("pointerdown", function (event) {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      runAction(entry, event);
    }, true);
    button.addEventListener("click", function (event) {
      if (Date.now() < entry.suppressClickUntil) {
        return;
      }
      runAction(entry, event);
    });
  }

  function installActionRouter() {
    if (document.__tprActionRouterInstalled) {
      return;
    }
    document.__tprActionRouterInstalled = true;
    document.addEventListener("pointerdown", function (event) {
      if (event.button !== 0) {
        return;
      }
      var x = event.clientX;
      var y = event.clientY;
      for (var i = 0; i < actionButtons.length; i += 1) {
        var entry = actionButtons[i];
        var button = entry.button;
        if (!button.isConnected) {
          continue;
        }
        var rect = button.getBoundingClientRect();
        if (!rect.width || !rect.height) {
          continue;
        }
        if (x >= rect.left - 2 && x <= rect.right + 2 && y >= rect.top - 2 && y <= rect.bottom + 2) {
          event.preventDefault();
          event.stopPropagation();
          runAction(entry, event);
          return;
        }
      }
    }, true);
  }

  function makeAction(icon, title, handler) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "tpr-action";
    button.textContent = icon;
    button.title = title;
    button.setAttribute("aria-label", title);
    registerAction(button, handler);
    return button;
  }

  function copyToClipboard(text, button) {
    var restore = button.textContent;
    var done = function () {
      button.textContent = "✓";
      setTimeout(function () { button.textContent = restore; }, 1200);
    };
    var fallback = function () {
      var area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      try {
        document.execCommand("copy");
      } catch (_) {
        /* 某些环境下没有剪贴板权限，仍然给用户一个明确的完成反馈 */
      }
      area.remove();
      done();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(fallback);
    } else {
      fallback();
    }
  }

  function surfaceFor(wrapper) {
    var modal = document.getElementById("tpr-modal");
    if (modal && !modal.hidden && modal.__tprWrapper === wrapper) {
      return {
        host: modal,
        content: modal.querySelector(".tpr-modal-content"),
        box: modal.querySelector(".tpr-modal-panel"),
        baseKey: "tprModalBaseWidth",
        zoomKey: "tprModalZoom",
        modal: true
      };
    }
    var content = wrapper && wrapper.querySelector(".tpr-content");
    return { host: wrapper, content: content, box: content, baseKey: "tprBaseWidth", zoomKey: "tprZoom", modal: false };
  }

  /* 预览框的尺寸在首次渲染后固定下来，缩放只改变框内的图，不改变框本身。
     宽度向上以容器为上限、向下以图的自然宽度为准：小图不再被硬拉到容器宽度，
     否则竖长的小图会被放大到超过视口高度，逼得用户滚动。 */
  function stabilizePreview(content) {
    if (!content || content.dataset.tprFixed === "1") return;
    var target = panTargetOf(content);
    if (!target) return;
    var rect = target.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    var column = Math.round(content.clientWidth || 0) || 460;
    var natural = Number(target.dataset.tprNaturalWidth || 0) || rect.width || column;
    var naturalRatio = rect.width ? rect.height / rect.width : 1;
    var viewportHeight = window.innerHeight || 800;
    var layout = Math.round(Math.max(120, Math.min(column, natural)));
    /* 高度上限按视口，而不是按图宽：窄而小、但稍高的图不该被卡在图宽那么矮的框里。
       只有图自身真的高于本卡片允许的高度时才需要拖动查看。 */
    var limit = Math.max(160, Math.round(viewportHeight * 0.72));
    var scaledHeight = layout * naturalRatio;
    content.style.maxHeight = limit + "px";
    content.style.height = Math.max(120, Math.min(limit, Math.round(scaledHeight))) + "px";
    content.__tprLayoutWidth = layout;
    content.__tprScale = Number(content.__tprScale || 1);
    target.style.maxWidth = "none";
    target.style.width = layout + "px";
    content.dataset.tprFixed = "1";
  }

  function applyZoom(wrapper, delta) {
    var surface = surfaceFor(wrapper);
    var content = surface.content;
    var svg = content && content.querySelector("svg");
    if (!svg) return;
    if (!content.__tprLayoutWidth) {
      var layout = Math.round(svg.getBoundingClientRect().width / (content.__tprScale || 1));
      if (!layout) return;
      content.__tprLayoutWidth = layout;
      svg.style.maxWidth = "none";
      svg.style.width = layout + "px";
    }
    var zoom = Number(surface.host.dataset[surface.zoomKey] || "1");
    zoom = Math.max(0.25, Math.min(4, zoom + delta));
    surface.host.dataset[surface.zoomKey] = String(zoom);
    content.__tprScale = zoom;
    var panState = panStateOf(content);
    applyPanOffset(content, svg, panState.x, panState.y);
    settlePan(content, surface.box, svg);
    if (surface.modal) syncPanState(content, surface.box);
    else updateOverflowState(wrapper);
  }

  function cardOf(toolbar) {
    var insideCard = toolbar && toolbar.closest ? toolbar.closest(".tpr-rendered") : null;
    if (insideCard) return insideCard;
    var modal = document.getElementById("tpr-modal");
    return modal && modal.__tprWrapper ? modal.__tprWrapper : null;
  }

  function createToolbar(sourceNode, label, kind) {
    var toolbar = document.createElement("div");
    toolbar.className = "tpr-toolbar";
    if (kind === "mermaid") {
      var title = document.createElement("span");
      title.className = "tpr-title";
      title.textContent = "Diagram";
      var badge = document.createElement("span");
      badge.className = "tpr-badge";
      badge.textContent = "mermaid";
      var actions = document.createElement("div");
      actions.className = "tpr-actions";
      var copy = makeAction("⧉", "复制 Mermaid 源码", function () {
        var wrapper = cardOf(toolbar);
        copyToClipboard(wrapper ? wrapper.dataset.source || "" : "", copy);
      });
      var zoomOut = makeAction("−", "缩小", function () {
        applyZoom(cardOf(toolbar), -0.05);
      });
      var zoomIn = makeAction("＋", "放大", function () {
        applyZoom(cardOf(toolbar), 0.05);
      });
      var expand = makeAction("⤢", "查看完整图", function () {
        openFullView(cardOf(toolbar));
      });
      expand.classList.add("tpr-expand");
      zoomOut.classList.add("tpr-zoom");
      zoomIn.classList.add("tpr-zoom");
      actions.appendChild(copy);
      actions.appendChild(zoomOut);
      actions.appendChild(zoomIn);
      actions.appendChild(expand);
      toolbar.appendChild(title);
      toolbar.appendChild(badge);
      toolbar.appendChild(actions);
      return toolbar;
    }
    var labelNode = document.createElement("span");
    labelNode.textContent = label;
    var toggle = document.createElement("button");
    toggle.type = "button";
    toggle.textContent = "源码";
    var toggleHandler = function () {
      if (!sourceNode || !sourceNode.isConnected) return;
      var hidden = sourceNode.classList.toggle("tpr-source-hidden");
      sourceNode.style.display = hidden ? "none" : "";
      toggle.textContent = hidden ? "源码" : "收起源码";
    };
    registerAction(toggle, toggleHandler);
    var expand = makeAction("⤢", "查看完整图", function () {
      openFullView(cardOf(toolbar));
    });
    expand.classList.add("tpr-expand");
    expand.hidden = true;
    toolbar.appendChild(labelNode);
    toolbar.appendChild(toggle);
    toolbar.appendChild(expand);
    return toolbar;
  }
  function hideSource(sourceNode) {
    sourceNode.classList.add("tpr-source-hidden");
    sourceNode.style.display = "none";
    sourceNode.setAttribute("aria-hidden", "true");
  }

  /* 宿主自己在代码块右上角画了一个 "Copy code"，位置正好压在我们的操作条上，
     既挡视觉也挡点击。我们已经提供了复制按钮，把宿主那个藏掉。 */
  var HOST_COPY_LABEL = /copy|复制/i;
  var HOST_COPY_TEXT = /copy\s*code|复制/i;
  var HOST_COPY_TEXT_MAX = 24;

  /* 命中的往往只是按钮里的文字节点/子元素，真正要藏的是它那个可点击的祖先 */
  function copyControlRoot(node) {
    if (!node) {
      return null;
    }
    /* 宿主代码块右侧那层可点击工具条：pointer-events-auto + sticky/absolute 的定位层。
       只藏里面的按钮会留下这层壳，就是"字没了但还能点"的来源。 */
    var strip = node.closest ? node.closest('[class*="pointer-events-auto"][class*="sticky"], [class*="pointer-events-auto"][class*="absolute"]') : null;
    if (strip) {
      return strip;
    }
    var root = node.closest ? node.closest("button, [role='button'], a, [onclick], [tabindex]") : null;
    if (root) {
      return root;
    }
    /* 宿主的复制控件有时就是一个裸 div/span 壳（文字在子元素里，自己没角色）。
       往上包几层：只包"几乎同尺寸、且内容还是同一句复制文案"的紧壳，
       否则会误伤真正的容器。 */
    var current = node;
    var parent = node.parentElement;
    var depth = 0;
    while (parent && depth < 3) {
      var parentRect = parent.getBoundingClientRect();
      var currentRect = current.getBoundingClientRect();
      var tight = parentRect.width <= currentRect.width + 20 && parentRect.height <= currentRect.height + 20;
      var text = (parent.textContent || "").trim();
      if (!tight || text.length === 0 || text.length > 24 || !HOST_COPY_TEXT.test(text)) {
        break;
      }
      if (parent === document.body || parent === document.documentElement) {
        break;
      }
      current = parent;
      parent = parent.parentElement;
      depth += 1;
    }
    return current;
  }

  function hideCopyControl(node) {
    var root = copyControlRoot(node);
    if (!root || (root.closest && root.closest(".tpr-rendered, #tpr-modal, .tpr-modal-panel"))) {
      return false;
    }
    root.classList.add("tpr-host-hidden");
    var button = node.closest ? node.closest("button, [role='button'], a") : null;
    if (button && button !== root) {
      button.classList.add("tpr-host-hidden");
    }
    return true;
  }

  function isCopyControl(node) {
    if (!node || node.nodeType !== 1) {
      return false;
    }
    if (node.closest && node.closest(".tpr-rendered, #tpr-modal, .tpr-modal-panel")) {
      return false;
    }
    var aria = (node.getAttribute("aria-label") || node.getAttribute("title") || "").trim();
    if (HOST_COPY_LABEL.test(aria)) {
      return true;
    }
    var text = (node.textContent || "").trim();
    return text.length > 0 && text.length <= HOST_COPY_TEXT_MAX && HOST_COPY_TEXT.test(text);
  }

  /* 宿主有时把 "Copy code" 放到 body 上的悬浮层里，容器观察器看不到。
     只隐藏"贴着我们自己卡片"的那种，别的地方的复制按钮不动。 */
  function isNearOurCard(node) {
    var rect = node.getBoundingClientRect();
    if (!rect.width && !rect.height) {
      return false;
    }
    var wrappers = [];
    knownRoots.forEach(function (root) {
      if (root && root.querySelectorAll) {
        Array.prototype.push.apply(wrappers, root.querySelectorAll(".tpr-rendered"));
      }
    });
    for (var i = 0; i < wrappers.length; i += 1) {
      var card = wrappers[i].getBoundingClientRect();
      if (rect.right >= card.left - 60 && rect.left <= card.right + 60 &&
          rect.bottom >= card.top - 80 && rect.top <= card.bottom + 80) {
        return true;
      }
    }
    return false;
  }

  function wrapperList() {
    var out = [];
    knownRoots.forEach(function (root) {
      if (root && root.querySelectorAll) {
        Array.prototype.push.apply(out, root.querySelectorAll(".tpr-rendered"));
      }
    });
    return out;
  }

  /* 宿主自己的代码块悬浮工具条（Copy 按钮的点击层）会压在我们操作条上。
     过去这里是"只要命中测试落在我们工具栏上、又不是我们的元素就一律隐藏"，
     结果把浮在卡片上方的对话框、左上角按钮这类真正的应用 UI 一起藏掉了。
     现在只隐藏两类东西，其余一律不碰。
     另外隐藏只通过内联样式落地，不再往应用节点上加可被观察/复用的类。 */

  var OURS = ".tpr-rendered, #tpr-modal, .tpr-modal-panel";

  function isOurElement(node) {
    return !!(node && node.closest && node.closest(OURS));
  }

  /* 对话框、菜单、导航、侧栏、顶部按钮簇等应用级 UI：无论压在哪张卡片上都绝不隐藏。 */
  function isAppChrome(node) {
    if (!node || node.nodeType !== 1) {
      return false;
    }
    var tag = node.tagName;
    if (tag === "HTML" || tag === "BODY" || tag === "NAV" || tag === "HEADER" ||
        tag === "ASIDE" || tag === "DIALOG" || tag === "FORM") {
      return true;
    }
    if (node.matches && node.matches(
      "[role='dialog'],[role='alertdialog'],[aria-modal='true'],[role='menu'],[role='menubar']," +
      "[role='menuitem'],[role='navigation'],[role='banner'],[role='toolbar'],[role='tablist'],[role='tab']")) {
      return true;
    }
    var style = window.getComputedStyle ? window.getComputedStyle(node) : null;
    if (style && style.position === "fixed") {
      return true;
    }
    return false;
  }

  /* 覆盖层通常是宿主为代码块单独加的悬浮/粘性壳。工具条本身是宽而扁的一条，
     这里要求命中的元素在两个方向上都足够小，避免把整块面板/容器当成覆盖层。 */
  function isCodeBlockOverlayShape(node, band) {
    if (!node || !node.getBoundingClientRect || !band) {
      return false;
    }
    var rect = node.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return false;
    }
    if (rect.width > 520 || rect.height > band.height + 40) {
      return false;
    }
    return true;
  }

  /* 不带文案、只负责接住点击的透明工具条壳：这是宿主 Copy 层的常见形态。 */
  function isCopyControlShell(node) {
    if (!node || node.nodeType !== 1 || !node.className || typeof node.className !== "string") {
      return false;
    }
    if (node.className.indexOf("pointer-events-auto") < 0) {
      return false;
    }
    if (node.className.indexOf("absolute") < 0 && node.className.indexOf("sticky") < 0) {
      return false;
    }
    if (node.querySelector && node.querySelector("button, [role='button'], a, [tabindex]")) {
      return false;
    }
    var text = (node.textContent || "").trim();
    if (text.length > 0 && !HOST_COPY_TEXT.test(text)) {
      return false;
    }
    var rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.width <= 200 && rect.height <= 64;
  }

  /* 命中点就在工具条带上，因此"压住操作条"已经由命中测试本身保证；
     只有确实是我们想清理的复制控件/工具条壳才允许下沉。 */
  function shouldHideCardOverlay(node, band) {
    if (!node || node.nodeType !== 1 || isOurElement(node) || isAppChrome(node)) {
      return false;
    }
    if (!isCodeBlockOverlayShape(node, band)) {
      return false;
    }
    if (isCopyControl(node)) {
      return true;
    }
    return isCopyControlShell(node);
  }

  /* 隐藏只落到内联样式上，并且记下改前的值，方便 restore / 自检时还回去。 */
  function markHostHidden(node, reason) {
    if (!node || node.nodeType !== 1) {
      return false;
    }
    if (node.getAttribute("data-tpr-overlay")) {
      return true;
    }
    node.setAttribute("data-tpr-overlay", reason || node.tagName);
    node.__tprHiddenDisplay = node.style.display;
    node.__tprHiddenPriority = node.style.getPropertyPriority("display");
    node.style.setProperty("display", "none", "important");
    node.style.setProperty("pointer-events", "none", "important");
    return true;
  }

  function sweepCardOverlays() {
    wrapperList().forEach(function (wrapper) {
      var toolbar = wrapper.querySelector(".tpr-toolbar");
      if (!toolbar || !toolbar.isConnected) {
        return;
      }
      var band = toolbar.getBoundingClientRect();
      if (!band.width || !band.height) {
        return;
      }
      var root = wrapper.getRootNode();
      var host = root && root.host ? root.host : null;
      var steps = 8;
      for (var i = 1; i <= steps; i += 1) {
        var x = band.left + (band.width * i) / (steps + 1);
        var y = band.top + band.height / 2;
        /* document 级命中测试才是权威：能跨 shadow 边界看到谁是真正的顶层 */
        var top = document.elementFromPoint(x, y);
        if (top && (top === host || (host && host.contains(top)))) {
          /* 命中的是卡片所在的 shadow 宿主，进 shadow 树里再看一眼 */
          var inner = root && root.elementFromPoint ? root.elementFromPoint(x, y) : null;
          if (isOurElement(inner) || !inner) {
            continue;
          }
          top = inner;
        }
        if (!top || isOurElement(top)) {
          continue;
        }
        /* 只动"压在工具栏上、又不是我们祖先"的元素；祖先一律不碰 */
        if (toolbar.contains(top) || (host && top.contains(host)) || top.contains(wrapper)) {
          continue;
        }
        if (!shouldHideCardOverlay(top, band)) {
          continue;
        }
        markHostHidden(top, "overlay|" + top.tagName + "|" +
          (typeof top.className === "string" ? top.className.slice(0, 60) : ""));
      }
    });
  }

  function hideStrayCopyControls(root) {
    if (!root || root.nodeType !== 1) {
      return;
    }
    var nodes = [root];
    if (root.querySelectorAll) {
      Array.prototype.push.apply(nodes, root.querySelectorAll("button, [role='button'], a, div, span, [aria-label], [title], [data-testid]"));
    }
    nodes.forEach(function (node) {
      if (!isCopyControl(node)) {
        return;
      }
      var root = copyControlRoot(node);
      if (root && isNearOurCard(root)) {
        hideCopyControl(node);
      }
    });
  }

  function hideHostControls(sourceNode, wrapper) {
    var scope = sourceNode && sourceNode.parentElement;
    var depth = 0;
    while (scope && depth < 6) {
      if (wrapper && wrapper.isConnected && !scope.contains(wrapper)) {
        break;
      }
      var nodes = scope.querySelectorAll("button, [role='button'], a, div, span, [aria-label], [title], [data-testid]");
      Array.prototype.slice.call(nodes).forEach(function (node) {
        if (!isCopyControl(node)) {
          return;
        }
        var root = copyControlRoot(node);
        if (root && isNearOurCard(root)) {
          hideCopyControl(node);
        }
      });
      scope = scope.parentElement;
      depth += 1;
    }
  }

  /* 宿主的 "Copy code" 是随 hover / 重渲染后加的，光在包卡片时藏一次不够，
     容器上挂个观察器，新加进来就立刻藏掉。 */
  function guardHostControls(sourceNode, wrapper) {
    var scope = sourceNode && sourceNode.parentElement;
    if (!scope || scope.__tprHostGuard) {
      return;
    }
    scope.__tprHostGuard = true;
    new MutationObserver(function () {
      hideHostControls(sourceNode, wrapper);
    }).observe(scope, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["aria-label", "title", "data-testid"]
    });
  }

  function makeWrapper(sourceNode, className, label) {
    var wrapper = document.createElement("div");
    wrapper.className = "tpr-rendered " + className;
    wrapper.__tprSourceNode = sourceNode;
    wrapper.appendChild(createToolbar(sourceNode, label, className.indexOf("mermaid") >= 0 ? "mermaid" : "math"));
    var content = document.createElement("div");
    content.className = "tpr-content";
    installPanHandlers(content, content);
    wrapper.appendChild(content);
    sourceNode.insertAdjacentElement("afterend", wrapper);
    hideSource(sourceNode);
    hideHostControls(sourceNode, wrapper);
    guardHostControls(sourceNode, wrapper);
    return wrapper;
  }

  function sourceFromCodeElement(sourceNode) {
    var code = sourceNode && sourceNode.tagName === "CODE"
      ? sourceNode
      : sourceNode && sourceNode.querySelector && sourceNode.querySelector("code[data-code], code");
    if (code) {
      var content = code.querySelector(":scope > [data-content]") || code.querySelector("[data-content]");
      if (content) {
        var lines = Array.prototype.slice.call(content.querySelectorAll("[data-line][data-line-index]"));
        if (lines.length > 0) {
          lines.sort(function (a, b) {
            return Number(a.getAttribute("data-line-index")) - Number(b.getAttribute("data-line-index"));
          });
          return lines.map(function (line) {
            return line.innerText || line.textContent || "";
          }).join("\n").trim();
        }
      }
    }
    return String(code ? (code.innerText || code.textContent || "") : (sourceNode && (sourceNode.innerText || sourceNode.textContent)) || "").trim();
  }

  /*__TPR_PAN_MATH_START__*/
  function clampPanValue(value, min, max) {
    if (value < min) return min;
    if (value > max) return max;
    return value;
  }

  function computePanBounds(box, viewport, natural) {
    var bounds = { minX: 0, maxX: 0, minY: 0, maxY: 0, overflowX: false, overflowY: false };
    if (!box || !viewport || !natural) {
      return bounds;
    }
    if (natural.width > viewport.width + 1) {
      bounds.overflowX = true;
      bounds.minX = Math.min(0, box.right - (natural.left + natural.width));
      bounds.maxX = Math.max(0, box.left - natural.left);
    }
    if (natural.height > viewport.height + 1) {
      bounds.overflowY = true;
      bounds.minY = Math.min(0, box.bottom - (natural.top + natural.height));
      bounds.maxY = Math.max(0, box.top - natural.top);
    }
    return bounds;
  }
  /*__TPR_PAN_MATH_END__*/

  function panTargetOf(element) {
    if (!element || !element.querySelector) {
      return null;
    }
    return element.querySelector("svg") || element.querySelector("mjx-container") || element.firstElementChild || null;
  }

  function panStateOf(element) {
    if (!element.__tprPan) {
      element.__tprPan = { x: 0, y: 0 };
    }
    return element.__tprPan;
  }

  function applyPanOffset(element, target, x, y) {
    var state = panStateOf(element);
    state.x = x;
    state.y = y;
    var scale = Number(element.__tprScale || 1);
    var transform = "";
    if (x || y || scale !== 1) {
      transform = "translate(" + x + "px," + y + "px)" + (scale !== 1 ? " scale(" + scale + ")" : "");
      target.style.transformOrigin = "top left";
    }
    target.style.transform = transform;
  }

  function resetPan(element) {
    if (!element) return;
    var target = panTargetOf(element);
    var state = panStateOf(element);
    state.x = 0;
    state.y = 0;
    if (target) {
      applyPanOffset(element, target, 0, 0);
    }
  }

  /* 判断元素是否溢出的可见区：全屏里是 modal-content 本身，卡片里就是内容盒。
     面板比内容盒多出工具栏和内边距，拿它当可见区会把可用高度算大。 */
  function panViewportOf(element, fallback) {
    if (element && element.closest && element.closest(".tpr-modal-content")) {
      return element;
    }
    return fallback;
  }

  function measurePan(element, viewport, target) {
    var state = panStateOf(element);
    var box = viewport.getBoundingClientRect();
    var rect = target.getBoundingClientRect();
    return computePanBounds(
      { left: box.left, top: box.top, right: box.right, bottom: box.bottom },
      { width: viewport.clientWidth, height: viewport.clientHeight },
      { left: rect.left - state.x, top: rect.top - state.y, width: rect.width, height: rect.height }
    );
  }

  function settlePan(element, viewport, target) {
    var state = panStateOf(element);
    var bounds = measurePan(element, panViewportOf(element, viewport), target);
    applyPanOffset(
      element,
      target,
      clampPanValue(state.x, bounds.minX, bounds.maxX),
      clampPanValue(state.y, bounds.minY, bounds.maxY)
    );
    return bounds;
  }

  function isPanBlockedTarget(node) {
    while (node && node.nodeType === 1) {
      if (node.closest && node.closest("button, a, input, textarea, select, .tpr-toolbar, .tpr-action")) {
        return true;
      }
      node = parentElementOf(node);
    }
    return false;
  }

  function wrapperOfSurface(element) {
    var modal = document.getElementById("tpr-modal");
    if (modal && !modal.hidden && modal.contains(element)) {
      return modal.__tprWrapper || null;
    }
    return element && element.closest ? element.closest(".tpr-rendered") : null;
  }

  function installPanHandlers(element, viewport) {
    if (!element || element.__tprPanInstalled) {
      return;
    }
    element.__tprPanInstalled = true;
    var box = viewport || element;

    element.addEventListener("mousedown", function (event) {
      if (event.button !== 0 || event.defaultPrevented || isPanBlockedTarget(event.target)) {
        return;
      }
      var target = panTargetOf(element);
      if (!target) {
        return;
      }
      /* 全屏里真正的可见区是 modal-content，面板还包着工具栏和它的内边距；
         用面板测量会把可用高度算大，导致明明溢出却判定不能拖动。 */
      var panViewport = panViewportOf(element, box);
      var bounds = measurePan(element, panViewport, target);
      if (!bounds.overflowX && !bounds.overflowY) {
        return;
      }
      var state = panStateOf(element);
      var startX = event.clientX;
      var startY = event.clientY;
      var startPanX = state.x;
      var startPanY = state.y;
      event.preventDefault();
      element.classList.add("tpr-dragging");
      var move = function (moveEvent) {
        applyPanOffset(
          element,
          target,
          clampPanValue(startPanX + (moveEvent.clientX - startX), bounds.minX, bounds.maxX),
          clampPanValue(startPanY + (moveEvent.clientY - startY), bounds.minY, bounds.maxY)
        );
        moveEvent.preventDefault();
      };
      var stop = function () {
        element.classList.remove("tpr-dragging");
        document.removeEventListener("mousemove", move, true);
        document.removeEventListener("mouseup", stop, true);
      };
      document.addEventListener("mousemove", move, true);
      document.addEventListener("mouseup", stop, true);
    }, true);

    element.addEventListener("wheel", function (event) {
      var target = panTargetOf(element);
      if (!target) {
        return;
      }
      /* 全屏里 ctrl + 滚轮缩放：方向按滚轮上下走 */
      if (event.ctrlKey || event.metaKey) {
        var zoomWrapper = wrapperOfSurface(element);
        var wheelUnit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? (box.clientHeight || 400) : 1;
        var wheelDelta = (event.deltaY || 0) * wheelUnit;
        if (zoomWrapper && target.tagName && target.tagName.toLowerCase() === "svg" && Math.abs(wheelDelta) > 0.5) {
          /* 一个鼠标刻度(约 120)= 0.1；触控板的小 delta 按比例变成细连续缩放 */
          var step = (-wheelDelta / 120) * 0.1;
          step = Math.max(-0.1, Math.min(0.1, step));
          applyZoom(zoomWrapper, step);
          event.preventDefault();
          return;
        }
      }
      var wheelViewport = panViewportOf(element, box);
      var bounds = measurePan(element, wheelViewport, target);
      if (!bounds.overflowX && !bounds.overflowY) {
        return;
      }
      var state = panStateOf(element);
      var unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? (wheelViewport.clientHeight || 400) : 1;
      var deltaX = (event.deltaX || 0) * unit;
      var deltaY = (event.deltaY || 0) * unit;
      if (event.shiftKey && !deltaX) {
        deltaX = deltaY;
        deltaY = 0;
      }
      var nextX = clampPanValue(state.x - deltaX, bounds.minX, bounds.maxX);
      var nextY = clampPanValue(state.y - deltaY, bounds.minY, bounds.maxY);
      if (nextX === state.x && nextY === state.y) {
        return;
      }
      applyPanOffset(element, target, nextX, nextY);
      event.preventDefault();
    }, { passive: false });
  }

  function syncPanState(element, viewport) {
    var target = panTargetOf(element);
    if (!target) {
      element.dataset.pannable = "false";
      return false;
    }
    var bounds = measurePan(element, panViewportOf(element, viewport), target);
    var overflow = bounds.overflowX || bounds.overflowY;
    element.dataset.pannable = overflow ? "true" : "false";
    return overflow;
  }

  function updateOverflowState(wrapper) {
    var content = wrapper && wrapper.querySelector(".tpr-content");
    var expand = wrapper && wrapper.querySelector(".tpr-expand");
    if (!content || !expand) return;
    sweepCardOverlays();
    stabilizePreview(content);
    var overflow = syncPanState(content, content);
    wrapper.dataset.overflow = overflow ? "true" : "false";
    expand.hidden = wrapper.classList.contains("tpr-mermaid") ? false : !overflow;
  }

  function refreshOverflowStates() {
    knownRoots.forEach(function (root) {
      Array.prototype.slice.call(root.querySelectorAll(".tpr-rendered")).forEach(updateOverflowState);
    });
  }

  /* 全屏按"能放下就尽量放大"来排：小图在大窗口里被放大到放得下的最大尺寸，
     横图也不至于只有自然尺寸的一小块。只在超过限度时才缩。 */
  function fitFullView(modal, modalContent, panel) {
    var svg = modalContent && modalContent.querySelector("svg");
    if (!svg || !panel) return;
    var natural = Number(svg.dataset.tprNaturalWidth || 0) || Number(svg.dataset.tprBaseWidth || 0) || svg.getBoundingClientRect().width;
    if (!natural) return;
    var ratio = 1;
    var viewBox = svg.viewBox && svg.viewBox.baseVal;
    var rect = svg.getBoundingClientRect();
    if (viewBox && viewBox.width) ratio = viewBox.height / viewBox.width;
    else if (rect.width) ratio = rect.height / rect.width;
    /* 以内容盒的可用空间为准，而不是面板尺寸：面板里还有工具栏和内边距，
       用面板高度会把图算大一点点，导致全屏里反而出现滚动。 */
    var availableWidth = Math.max(160, (modalContent.clientWidth || panel.clientWidth) - 8);
    var availableHeight = Math.max(160, (modalContent.clientHeight || panel.clientHeight) - 8);
    var fit = Math.min(availableWidth / natural, availableHeight / (natural * ratio));
    fit = Math.max(0.15, Math.min(fit, 6));
    var layout = Math.max(1, Math.round(natural * fit));
    svg.dataset.tprModalBaseWidth = String(natural);
    modalContent.__tprLayoutWidth = layout;
    modalContent.__tprScale = 1;
    modal.dataset.tprModalZoom = "1";
    svg.style.maxWidth = "none";
    svg.style.width = layout + "px";
    svg.style.transform = "";
    resetPan(modalContent);
    syncPanState(modalContent, modalContent);
  }

  function openFullView(wrapper) {
    var modal = document.getElementById("tpr-modal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "tpr-modal";
      modal.className = "tpr-modal";
      modal.hidden = true;
      modal.innerHTML = "<div class='tpr-modal-panel'><button type='button' class='tpr-modal-close' aria-label='关闭'>×</button><div class='tpr-modal-content'></div></div>";
      modal.addEventListener("click", function (event) {
        if (event.target === modal) closeFullView();
      });
      modal.querySelector(".tpr-modal-close").addEventListener("click", closeFullView);
      document.addEventListener("keydown", function (event) {
        if (event.key === "Escape") closeFullView();
      });
      document.body.appendChild(modal);
    }
    var content = wrapper.querySelector(".tpr-content");
    var modalContent = modal.querySelector(".tpr-modal-content");
    if (!content || !modalContent) return;
    resetPan(content);
    resetPan(modalContent);
    modalContent.textContent = "";
    while (content.firstChild) {
      modalContent.appendChild(content.firstChild);
    }
    var panel = modal.querySelector(".tpr-modal-panel");
    installPanHandlers(modalContent, modalContent);
    /* 全屏用视口尺寸，不再被卡片宽度限制，否则小卡片里的图在全屏里还是很小 */
    var frameWidth = Math.max(280, Math.min(Math.round((window.innerWidth || 1200) * 0.94), 1600));
    var frameHeight = Math.max(240, Math.round((window.innerHeight || 800) * 0.92));
    panel.style.width = frameWidth + "px";
    panel.style.height = frameHeight + "px";
    panel.style.maxWidth = "94vw";
    panel.style.maxHeight = "94vh";
    var cardToolbar = wrapper.querySelector(".tpr-toolbar");
    if (cardToolbar) {
      var expandAction = cardToolbar.querySelector(".tpr-expand");
      if (expandAction) expandAction.style.display = "none";
      panel.insertBefore(cardToolbar, modalContent);
    }
    delete modal.dataset.tprModalZoom;
    modal.__tprWrapper = wrapper;
    modal.hidden = false;
    requestAnimationFrame(function () {
      fitFullView(modal, modalContent, panel);
    });
  }

  function closeFullView() {
    var modal = document.getElementById("tpr-modal");
    if (!modal || modal.hidden) return;
    var wrapper = modal.__tprWrapper;
    var modalContent = modal.querySelector(".tpr-modal-content");
    var modalToolbar = modal.querySelector(".tpr-modal-panel > .tpr-toolbar");
    if (modalToolbar && wrapper && wrapper.isConnected) {
      var expandBack = modalToolbar.querySelector(".tpr-expand");
      if (expandBack) expandBack.style.display = "";
      var home = wrapper.querySelector(".tpr-content");
      if (home) wrapper.insertBefore(modalToolbar, home);
    }
    if (wrapper && wrapper.isConnected && modalContent) {
      resetPan(modalContent);
      var content = wrapper.querySelector(".tpr-content");
      while (modalContent.firstChild) {
        content.appendChild(modalContent.firstChild);
      }
      resetPan(content);
      var cardSvg = content.querySelector("svg");
      if (cardSvg) {
        if (content.__tprLayoutWidth) {
          cardSvg.style.maxWidth = "none";
          cardSvg.style.width = content.__tprLayoutWidth + "px";
        }
        content.__tprScale = Number(wrapper.dataset.tprZoom || "1");
        applyPanOffset(content, cardSvg, 0, 0);
      }
      updateOverflowState(wrapper);
    }
    modal.__tprWrapper = null;
    modal.hidden = true;
  }

  function scanMermaid(root) {
    if (!root || !root.querySelectorAll) {
      return;
    }
    var candidates = [];
    if (root.matches && root.matches("pre,code,.mermaid,[class*=\"language-mermaid\"],[class*=\"lang-mermaid\"],[data-language=\"mermaid\"]")) {
      candidates.push(root);
    }
    Array.prototype.push.apply(candidates, root.querySelectorAll("pre,code,.mermaid,[class*=\"language-mermaid\"],[class*=\"lang-mermaid\"],[data-language=\"mermaid\"]"));
    var seenSources = new Set();
    candidates.forEach(function (candidate) {
      if (candidate.closest && candidate.closest(".tpr-rendered")) {
        return;
      }
      var sourceNode = candidate.tagName === "PRE" || candidate.tagName === "DIV"
        ? candidate
        : (candidate.closest && candidate.closest("pre")) || candidate;
      var owner = sourceNode.parentElement && sourceNode.parentElement.closest
        ? sourceNode.parentElement.closest(".language-mermaid,.lang-mermaid,.mermaid,[data-language=\"mermaid\"]")
        : null;
      if (owner) {
        sourceNode = owner;
      }
      if (!sourceNode || seenSources.has(sourceNode)) {
        return;
      }
      seenSources.add(sourceNode);
      var code = sourceNode.tagName === "CODE" ? sourceNode : sourceNode.querySelector && sourceNode.querySelector("code");
      var source = sourceFromCodeElement(sourceNode);
      if (!source) {
        return;
      }
      var language = languageOf(sourceNode) || languageOf(code) || languageOf(sourceNode.parentElement);
      var classText = [
        sourceNode.className,
        code && code.className,
        sourceNode.parentElement && sourceNode.parentElement.className,
        sourceNode.getAttribute && sourceNode.getAttribute("data-language")
      ].filter(Boolean).join(" ");
      if (language !== "mermaid" && !/\bmermaid\b/i.test(classText) && !MERMAID_START_RE.test(source)) {
        return;
      }
      var previous = mermaidTimers.get(sourceNode);
      if (previous && previous.source === source && previous.wrapper && previous.wrapper.isConnected) {
        return;
      }
      var wrapper = previous && previous.wrapper && previous.wrapper.isConnected
        ? previous.wrapper
        : makeWrapper(sourceNode, "tpr-mermaid", "Mermaid");
      var content = wrapper.querySelector(".tpr-content");
      wrapper.dataset.tprMermaid = "1";
      wrapper.dataset.source = source;
      if (content && content.dataset.tprRendered !== "1" && content.dataset.tprLoading !== "1") {
        content.dataset.tprLoading = "1";
        content.textContent = "Mermaid 渲染中…";
      }
      mermaidTimers.set(sourceNode, { wrapper: wrapper, source: source });
      queueMermaid(wrapper, source);
    });
  }

  function codeBlockInfo(pre, code) {
    var language = languageOf(code) || languageOf(pre);
    var text = sourceFromCodeElement(pre);
    if (!text) {
      return null;
    }
    if (language === "mathml" || language === "mml" || /^<math[\s>]/i.test(text)) {
      return { kind: "mathml", text: text };
    }
    if (MATH_CODE_RE.test(language) || /^(\$\$|\\\[|\\begin\{)/.test(text)) {
      return { kind: "tex", text: text };
    }
    return null;
  }

  function stripDisplayDelimiters(text) {
    var value = text.trim();
    if (value.startsWith("$$") && value.endsWith("$$")) {
      return value.slice(2, -2).trim();
    }
    if (value.startsWith("\\[") && value.endsWith("\\]")) {
      return value.slice(2, -2).trim();
    }
    return value;
  }

  function sanitizeMathML(text) {
    var parser = new DOMParser();
    var parsed = parser.parseFromString(text, "application/xml");
    if (parsed.querySelector("parsererror") || !parsed.documentElement || parsed.documentElement.localName !== "math") {
      return null;
    }
    var allowed = /^(?:math|maction|maligngroup|malignmark|menclose|merror|mfenced|mfrac|mglyph|mi|mlabeledtr|mlongdiv|mmultiscripts|mn|mo|mover|mpadded|mphantom|mroot|mrow|ms|mscarries|mscarry|msgroup|msline|mspace|msqrt|msrow|mstack|mstyle|msub|msubsup|msup|mtable|mtd|mtext|mtr|munder|munderover|semantics|annotation|annotation-xml)$/i;
    var forbidden = /^(?:on|href$|src$|style$|class$|id$|xlink:href$)/i;
    function clean(source, target) {
      Array.prototype.slice.call(source.attributes || []).forEach(function (attribute) {
        if (!forbidden.test(attribute.name)) {
          try {
            target.setAttribute(attribute.name, attribute.value);
          } catch (_) {
            /* ignore invalid XML attribute names */
          }
        }
      });
      Array.prototype.slice.call(source.childNodes || []).forEach(function (child) {
        if (child.nodeType === 3) {
          target.appendChild(document.createTextNode(child.nodeValue));
          return;
        }
        if (child.nodeType === 1) {
          if (allowed.test(child.localName)) {
            var next = document.createElementNS("http://www.w3.org/1998/Math/MathML", child.localName);
            clean(child, next);
            target.appendChild(next);
          } else {
            clean(child, target);
          }
        }
      });
    }
    var root = document.createElementNS("http://www.w3.org/1998/Math/MathML", "math");
    clean(parsed.documentElement, root);
    return root;
  }

  function scanMathBlocks(root) {
    if (!root || !root.querySelectorAll) {
      return;
    }
    var blocks = [];
    if (root.matches && root.matches("pre")) {
      blocks.push(root);
    }
    Array.prototype.push.apply(blocks, root.querySelectorAll("pre"));
    var mathRoots = [];
    blocks.forEach(function (pre) {
      var code = pre.querySelector("code");
      var key = pre;
      if (blockState.has(key)) {
        return;
      }
      var info = codeBlockInfo(pre, code);
      if (!info) {
        return;
      }
      blockState.add(key);
      if (info.kind === "mathml") {
        var mathml = sanitizeMathML(info.text);
        if (!mathml) {
          return;
        }
        var mathmlWrapper = makeWrapper(pre, "tpr-math tpr-mathml", "MathML");
        mathmlWrapper.dataset.display = "true";
        mathmlWrapper.querySelector(".tpr-content").appendChild(mathml);
        return;
      }
      var wrapper = makeWrapper(pre, "tpr-math", "Math");
      wrapper.dataset.display = "true";
      var content = wrapper.querySelector(".tpr-content");
      content.textContent = expandChemistry("\\[" + stripDisplayDelimiters(info.text) + "\\]");
      mathRoots.push(content);
    });
    queueMath(mathRoots);
  }

  function scanTextMath(root) {
    if (!root) {
      return;
    }
    var roots = [];
    if (root.nodeType === 3) {
      roots.push(root);
    } else if (root.nodeType === 1 || root.nodeType === 9 || root.nodeType === 11) {
      /* 9 = Document, 11 = DocumentFragment: 之前只认元素和文本，
         从 document 根发起的扫描整段被跳过，行内数学因此一直漏掉。 */
      if (root.nodeType === 1 && !isVisible(root)) {
        return;
      }
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: function (node) {
          if (isBlockedNode(node)) {
            return NodeFilter.FILTER_REJECT;
          }
          var value = node.nodeValue || "";
          if (!STRONG_MATH_RE.test(value) && !INLINE_DOLLAR_RE.test(value)) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      var current;
      while ((current = walker.nextNode())) {
        roots.push(current);
      }
    }
    var containers = [];
    roots.forEach(function (node) {
      var value = node.nodeValue || "";
      if (textState.get(node) === value) {
        return;
      }
      var strong = STRONG_MATH_RE.test(value);
      var dollar = INLINE_DOLLAR_RE.test(value);
      var transformed = null;
      if (!strong && !dollar) {
        return;
      }
      if (!strong && !messageLike(node.parentElement)) {
        return;
      }
      transformed = transformMathText(value);
      if (!transformed.changed) {
        return;
      }
      textState.set(node, transformed.text);
      node.nodeValue = transformed.text;
      containers.push(mathContainerFor(node));
    });
    queueMath(containers);
  }

  /* 整段就是一条公式、但被宿主拆成多个文本节点的情况：
     按段落合并后的文本判断，匹配上就把整段交给 MathJax。 */
  var BLOCK_MATH_WHOLE = /^\$\$([\s\S]+?)\$\$$/;
  var BLOCK_MATH_BRACKET = /^\\\[([\s\S]+?)\\\]$/;

  function scanBlockMath(root) {
    var scope = root && root.nodeType === 3 ? root.parentElement : root;
    if (!scope || !scope.querySelectorAll) {
      return;
    }
    var blocks = [];
    if (scope.matches && scope.matches("p,li,blockquote,td,th,div,section,article")) {
      blocks.push(scope);
    }
    Array.prototype.push.apply(blocks, scope.querySelectorAll("p,li,blockquote,td,th"));
    blocks.forEach(function (block) {
      if (!block || block.dataset.tprBlockMath === "1" || !isVisible(block) || isBlockedNode(block)) {
        return;
      }
      if (block.querySelector(".tpr-rendered, mjx-container, pre, code")) {
        return;
      }
      var text = (block.textContent || "").trim();
      if (text.length < 6 || text.length > 4000) {
        return;
      }
      var match = BLOCK_MATH_WHOLE.exec(text) || BLOCK_MATH_BRACKET.exec(text);
      if (!match) {
        return;
      }
      block.dataset.tprBlockMath = "1";
      textState.set(block, null);
      block.textContent = expandChemistry("\\[" + match[1].trim() + "\\]");
      queueMath([block]);
    });
  }

  function cleanupOrphanedWrappers(root) {
    var scope = root || document;
    Array.prototype.slice.call(scope.querySelectorAll(".tpr-rendered")).forEach(function (wrapper) {
      var source = wrapper.__tprSourceNode;
      if (source && !source.isConnected) {
        wrapper.remove();
      }
    });
  }

  function rerenderMermaid() {
    initializeMermaid();
    Array.prototype.slice.call(document.querySelectorAll("[data-tpr-mermaid='1']")).forEach(function (wrapper) {
      var source = wrapper.dataset.source || "";
      var content = wrapper.querySelector(".tpr-content");
      if (!source || !content) {
        return;
      }
      content.innerHTML = "";
      content.classList.add("tpr-loading");
      queueMermaid(wrapper, source);
    });
  }

  function scanRoot(root) {
    if (!root || !root.isConnected) {
      return;
    }
    cleanupOrphanedWrappers(root);
    scanMermaid(root);
    scanMathBlocks(root);
    scanBlockMath(root);
    scanTextMath(root);
  }

  function scheduleScan(root) {
    if (root && (root.nodeType === 1 || root.nodeType === 3)) {
      pendingRoots.add(root);
    }
    if (scanScheduled) {
      return;
    }
    scanScheduled = true;
    var requestedAt = Date.now();
    var run = function () {
      var idleFor = Date.now() - lastMutationAt;
      var waited = Date.now() - requestedAt;
      /* 宿主一直在动时不能无限等下去：最多推迟 MAX_DEFER 就照常扫一遍 */
      if (idleFor < IDLE_DELAY && waited < 1500) {
        setTimeout(run, Math.min(400, IDLE_DELAY - idleFor + 40));
        return;
      }
      scanScheduled = false;
      var roots = Array.prototype.slice.call(pendingRoots);
      pendingRoots.clear();
      roots = roots.filter(function (candidate) {
        if (!candidate || !candidate.isConnected) {
          return false;
        }
        return !roots.some(function (other) {
          return other !== candidate && other.nodeType === 1 && other.contains && other.contains(candidate);
        });
      });
      if (roots.length === 0) {
        knownRoots.forEach(function (root) {
          scanRoot(root);
        });
      } else {
        roots.forEach(scanRoot);
      }
    };
    setTimeout(run, 180);
  }

  /* 可见的数学其实是宿主自己的 MathJax 排的，它没有 mhchem。
     所以在 DOM 一变、宿主还没排版之前，同步把 \\ce{} / \\pu{} 展开成普通 TeX。 */
  function expandChemistryInNode(node) {
    if (!node || !window.mhchemParser) {
      return;
    }
    var textNodes = [];
    if (node.nodeType === 3) {
      textNodes.push(node);
    } else if (node.nodeType === 1 && node.querySelectorAll) {
      if (node.classList && node.classList.contains("tpr-rendered")) {
        return;
      }
      var walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
        acceptNode: function (textNode) {
          var value = textNode.nodeValue || "";
          if (value.indexOf("\\ce") < 0 && value.indexOf("\\pu") < 0) {
            return NodeFilter.FILTER_REJECT;
          }
          var parent = textNode.parentElement;
          if (parent && parent.closest && parent.closest("pre, code, .tpr-rendered, script, style")) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      var current;
      while ((current = walker.nextNode())) {
        textNodes.push(current);
      }
    }
    textNodes.forEach(function (textNode) {
      var value = textNode.nodeValue || "";
      var expanded = expandChemistryInMath(value);
      if (expanded !== value) {
        textNode.nodeValue = expanded;
      }
    });
  }

  /* 宿主的 MathJax 会在自己的渲染流程里同步排版，我们的 DOM 观察来不及。
     直接包一层它的排版入口：排之前先把 \\ce{} / \\pu{} 展开成普通 TeX。
     这样不依赖包注册、也不依赖 DOM 时序。 */
  function installMathJaxInterception() {
    var current = window.MathJax;
    if (!current || current.__tprIntercepted) {
      return false;
    }
    var expandIn = function (target) {
      if (!target || !window.mhchemParser) {
        return;
      }
      var nodes = [];
      if (target.nodeType === 3) {
        nodes.push(target);
      } else if (target.nodeType === 1 && target.querySelectorAll) {
        var walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT, {
          acceptNode: function (textNode) {
            var value = textNode.nodeValue || "";
            if (value.indexOf("\\ce") < 0 && value.indexOf("\\pu") < 0) {
              return NodeFilter.FILTER_REJECT;
            }
            var parent = textNode.parentElement;
            if (parent && parent.closest && parent.closest("pre, code, .tpr-rendered, script, style, mjx-container")) {
              return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
          }
        });
        var node;
        while ((node = walker.nextNode())) {
          nodes.push(node);
        }
      }
      nodes.forEach(function (textNode) {
        var value = textNode.nodeValue || "";
        var expanded = expandChemistryInMath(value);
        if (expanded !== value) {
          textNode.nodeValue = expanded;
        }
      });
    };
    var prepare = function (args) {
      if (!args) {
        return;
      }
      Array.prototype.slice.call(args).forEach(function (item) {
        if (typeof item === "string") {
          return;
        }
        if (item && item.nodeType) {
          expandIn(item);
        } else if (item && item.length !== undefined && typeof item !== "string") {
          Array.prototype.slice.call(item).forEach(function (entry) {
            if (entry && entry.nodeType) {
              expandIn(entry);
            }
          });
        }
      });
    };
    ["typesetPromise", "typeset", "tex2svg"].forEach(function (name) {
      var original = current[name];
      if (typeof original !== "function") {
        return;
      }
      current[name] = function () {
        if (name !== "tex2svg") {
          prepare(arguments);
        }
        return original.apply(this, arguments);
      };
    });
    current.__tprIntercepted = true;
    return true;
  }

  /* 宿主的 KaTeX 没有 mhchem，\ce{} 会被当成未知宏排成红字或残句。
     KaTeX 的输出里保留了原始 TeX（annotation），据此用我们自己的
     KaTeX + mhchem 重新排版这些公式。 */
  function rerenderChromeMath(root) {
    if (!window.katex || typeof window.katex.render !== "function") {
      return 0;
    }
    var nodes = [];
    if (root && root.nodeType === 1) {
      if (root.matches && root.matches(".katex")) {
        nodes.push(root);
      }
      if (root.querySelectorAll) {
        Array.prototype.push.apply(nodes, root.querySelectorAll(".katex"));
      }
    }
    var count = 0;
    nodes.forEach(function (node) {
      if (!node.isConnected || node.dataset.tprChem === "1") {
        return;
      }
      /* 我们重排出来的 KaTeX 内部还有 .katex，不能再处理一次，否则会无限循环 */
      if (node.closest && node.closest('[data-tpr-chem="1"]')) {
        return;
      }
      var annotation = node.querySelector('annotation[encoding="application/x-tex"]');
      if (!annotation) {
        return;
      }
      var tex = annotation.textContent || "";
      if (tex.indexOf("\\ce") < 0 && tex.indexOf("\\pu") < 0) {
        return;
      }
      var displayNode = node.closest ? node.closest(".katex-display") : null;
      var target = displayNode || node;
      var host = document.createElement(displayNode ? "div" : "span");
      host.className = displayNode ? "katex-display tpr-chem" : "tpr-chem";
      host.dataset.tprChem = "1";
      try {
        window.katex.render(tex, host, { throwOnError: false, displayMode: !!displayNode });
      } catch (error) {
        log("katex chemistry re-render failed", error);
        return;
      }
      target.replaceWith(host);
      count += 1;
    });
    return count;
  }

  function rerenderAllChromeMath() {
    var total = 0;
    knownRoots.forEach(function (root) {
      total += rerenderChromeMath(root === document ? document.body : root);
    });
    return total;
  }

  function onMutations(mutations) {
    lastMutationAt = Date.now();
    mutations.forEach(function (mutation) {
      if (mutation.type === "childList") {
        Array.prototype.slice.call(mutation.addedNodes || []).forEach(function (node) {
          expandChemistryInNode(node);
          rerenderChromeMath(node);
        });
      }
      if (mutation.type === "childList") {
        Array.prototype.slice.call(mutation.addedNodes || []).forEach(function (node) {
          if (node.nodeType === 1) {
            pendingRoots.add(node);
          } else if (node.nodeType === 3 && node.parentElement) {
            pendingRoots.add(node.parentElement);
          }
        });
      } else if (mutation.type === "characterData" && mutation.target.parentElement) {
        pendingRoots.add(mutation.target.parentElement);
      }
    });
    scheduleScan(null);
  }

  /* 宿主自己的文档比视口高几像素（实测 5px），滚轮停在侧边栏这种非滚动区时
     会把这几个像素的溢出滚上去，整个界面跟着动一下。这点溢出没有任何内容，
     小于阈值就直接钉回 0。 */
  function installStrayCopyGuard() {
    if (document.__tprStrayCopyGuard || !document.body) {
      return;
    }
    document.__tprStrayCopyGuard = true;
    new MutationObserver(function (mutations) {
      mutations.forEach(function (mutation) {
        Array.prototype.slice.call(mutation.addedNodes || []).forEach(function (node) {
          hideStrayCopyControls(node);
        });
      });
    }).observe(document.body, { childList: true, subtree: true });
  }

  function installMicroScrollGuard() {
    if (document.__tprMicroScrollGuard) {
      return;
    }
    document.__tprMicroScrollGuard = true;
    var PIN_LIMIT = 8;
    var pin = function () {
      var root = document.scrollingElement;
      if (!root || root.scrollTop === 0) {
        return;
      }
      if (root.scrollHeight - root.clientHeight <= PIN_LIMIT) {
        root.scrollTop = 0;
      }
    };
    document.addEventListener("scroll", pin, true);
    window.addEventListener("wheel", function () { setTimeout(pin, 0); }, { passive: true, capture: true });
  }

  installStyles();
  installActionRouter();
  installMathJaxInterception();
  installStrayCopyGuard();
  installMicroScrollGuard();
  var mermaidReady = initializeMermaid();
  var mathReady = !!(mathJax && typeof mathJax.typesetPromise === "function");

  if (!mathReady) {
    log("MathJax is unavailable");
  }
  if (!mermaidReady) {
    log("Mermaid is unavailable");
  }

  function observeRoot(root) {
    if (!root || observedRoots.has(root)) return;
    observedRoots.add(root);
    knownRoots.add(root);
    if (root !== document) installStyles(root);
    new MutationObserver(onMutations).observe(root, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  function discoverShadowRoots(root) {
    var scope = root || document;
    observeRoot(scope);
    if (window.__claudeThirdPartyShadowRoots) {
      Array.prototype.slice.call(window.__claudeThirdPartyShadowRoots).forEach(function (shadowRoot) {
        if (shadowRoot && !observedRoots.has(shadowRoot)) {
          observeRoot(shadowRoot);
          scheduleScan(shadowRoot);
          discoverShadowRoots(shadowRoot);
        }
      });
    }
    if (!scope.querySelectorAll) return;
    Array.prototype.slice.call(scope.querySelectorAll("*")).forEach(function (element) {
      if (element.shadowRoot) {
        if (!observedRoots.has(element.shadowRoot)) {
          observeRoot(element.shadowRoot);
          scheduleScan(element.shadowRoot);
        }
        discoverShadowRoots(element.shadowRoot);
      }
    });
  }

  observeRoot(document);
  discoverShadowRoots(document);
  setInterval(function () {
    discoverShadowRoots(document);
    installMathJaxInterception();
    rerenderAllChromeMath();
  }, 1500);

  /* 悬浮层是 hover 时才冒出来的，单独用更快的节奏扫工具栏那一条带 */
  setInterval(function () {
    sweepCardOverlays();
  }, 700);

  var themeObserver = new MutationObserver(function () {
    rerenderMermaid();
  });
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-mode", "data-theme"]
  });

  window.addEventListener("resize", function () {
    setTimeout(function () {
      var modal = document.getElementById("tpr-modal");
      if (modal && !modal.hidden) {
        fitFullView(modal, modal.querySelector(".tpr-modal-content"), modal.querySelector(".tpr-modal-panel"));
        return;
      }
      refreshOverflowStates();
    }, 100);
  });

  if (window.matchMedia) {
    try {
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", rerenderMermaid);
    } catch (_) {
      /* older Electron versions use addListener */
      try {
        window.matchMedia("(prefers-color-scheme: dark)").addListener(rerenderMermaid);
      } catch (_ignore) {
        /* no-op */
      }
    }
  }

  window[MARKER] = VERSION;
  window.__claudeThirdPartyRender = {
    version: VERSION,
    computePanBounds: computePanBounds,
    report: function () {
      var roots = [document];
      Array.prototype.slice.call(window.__claudeThirdPartyShadowRoots || []).forEach(function (r) { if (r && r.querySelectorAll) roots.push(r); });
      Array.prototype.slice.call(document.querySelectorAll("*")).forEach(function (n) { if (n.shadowRoot) roots.push(n.shadowRoot); });
      var count = function (sel) {
        var total = 0;
        roots.forEach(function (r) { total += r.querySelectorAll(sel).length; });
        return total;
      };
      return {
        cards: count(".tpr-rendered"),
        mermaid: count(".tpr-rendered.tpr-mermaid"),
        mjx: count("mjx-container"),
        katex: count(".katex"),
        parser: typeof window.mhchemParser,
        mathjax: !!(window.MathJax && window.MathJax.tex2svg),
        intercepted: !!(window.MathJax && window.MathJax.__tprIntercepted),
        ceLeft: (document.body ? document.body.textContent.split("\\ce").length - 1 : -1),
        title: document.title,
        href: String(location.href).slice(0, 46),
        bodyLen: document.body ? document.body.textContent.length : -1,
        hasDiagramWord: !!(document.body && document.body.textContent.indexOf("Diagram") >= 0),
        hasSample: !!(document.body && document.body.textContent.indexOf("Mermaid") >= 0),
        frames: window.frames ? window.frames.length : -1,
        katexVersion: (window.katex && window.katex.version) || null,
        hasKatexGlobal: !!window.katex,
        katexMhchem: !!(window.katex && window.katex.__mhchemLoaded)
      };
    },
    ensureMhchemNow: function () { return ensureMhchemNow(); },
    rerenderChem: function () { return rerenderAllChromeMath(); },
    rescan: function () {
      scheduleScan(document.body || document.documentElement);
    },
    rerenderMermaid: rerenderMermaid
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
          installStrayCopyGuard();
      discoverShadowRoots(document);
      scheduleScan(document.body || document.documentElement);
    }, { once: true });
  } else {
    discoverShadowRoots(document);
    scheduleScan(document.body || document.documentElement);
  }

})();
