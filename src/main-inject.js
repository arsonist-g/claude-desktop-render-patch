/*__CLAUDE_TPR_LOADER_START__*/
;(function () {
  try {
    var electron = require("electron");
    var fs = require("node:fs");
    var path = require("node:path");
    var directory = path.join(process.resourcesPath, "third-party-render");
    var inFlight = new WeakSet();
    var cdpAttached = new WeakSet();
    var read = function (name) {
      return fs.readFileSync(path.join(directory, name), "utf8");
    };
    var shadowHookSource = read("shadow-hook-main-world.js");
    var attachDebugger = function (webContents) {
      if (!webContents || webContents.isDestroyed() || cdpAttached.has(webContents)) {
        return;
      }
      try {
        if (!webContents.debugger.isAttached()) {
          webContents.debugger.attach("1.3");
        }
        webContents.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
          source: shadowHookSource,
        }).catch(function () {});
        cdpAttached.add(webContents);
      } catch (_) {
        // The preload hook remains as a fallback when another debugger owns the view.
      }
    };
    var executeVoid = function (frame, code) {
      return frame.executeJavaScript(code + "\n;void 0;", true);
    };
    var hasRuntime = function (frame) {
      return frame.executeJavaScript("!!window.__claudeThirdPartyRenderInstalled", true);
    };
    var hasMathJax = function (frame) {
      return frame.executeJavaScript("!!(window.MathJax && window.MathJax.typesetPromise)", true);
    };
    var hasMermaid = function (frame) {
      return frame.executeJavaScript("!!window.__claudeThirdPartyMermaidInstalled", true);
    };
    var eligible = function (frame) {
      if (!frame || frame.isDestroyed()) {
        return false;
      }
      var url = String(frame.url || "");
      if (!url || url.indexOf("devtools://") === 0) {
        return false;
      }
      return url === "about:blank" ||
        url.indexOf("claude.ai") >= 0 ||
        url.indexOf("claude.com") >= 0 ||
        url.indexOf("epitaxy") >= 0 ||
        url.indexOf("app://localhost") === 0 ||
        url.indexOf("https://") === 0;
    };
    var injectFrame = function (frame) {
      if (!eligible(frame) || inFlight.has(frame)) {
        return Promise.resolve();
      }
      inFlight.add(frame);
      return hasRuntime(frame).then(function (installed) {
        if (installed) {
          return undefined;
        }
        /* mhchemparser 与 MathJax 无关：宿主自带 MathJax 时也要注入，
           否则化学式展开会因为没有解析器而静默跳过。 */
        return executeVoid(frame, read("mhchemparser-4.2.1.js")).then(function () {
          /* 宿主用 KaTeX 排版数学，但它的实例是打包内部的、没有 mhchem。
             这里带一份我们自己的 KaTeX + mhchem，运行时用它重排 \ce 公式。 */
          return executeVoid(frame, read("katex.min.js"));
        }).then(function () {
          return executeVoid(frame, read("katex-mhchem.min.js"));
        }).then(function () {
          return hasMathJax(frame);
        }).then(function (mathReady) {
          if (mathReady) {
            return undefined;
          }
          return executeVoid(frame, read("mathjax-config.js")).then(function () {
            return executeVoid(frame, read("mathjax-tex-svg-full.js"));
          }).then(function () {
            return executeVoid(frame, read("mathjax-tex-mhchem.js"));
          }).then(function () {
            /* 扩展脚本要在 MathJax 建好 input jax 之前跑才生效，这个时序不稳定。
               这里在 startup 完成后再检查一次：\ce 若仍是未注册宏，就重跑扩展。 */
            var source = JSON.stringify(read("mathjax-tex-mhchem.js"));
            var ensure = "(function(){var M=window.MathJax;if(!M||!M.tex2svg)return false;" +
              "function broken(){try{return String(M.tex2svg('\\\\ce{}').textContent||'').indexOf('ce')===0;}catch(e){return true;}}" +
              "function load(){try{(0,eval)(" + source + ");}catch(e){return false;}return true;}" +
              "if(!broken())return true;" +
              "var wait=(M.startup&&M.startup.promise)?M.startup.promise:Promise.resolve();" +
              "return Promise.resolve(wait).then(function(){if(!broken())return true;load();return !broken();});})()";
            return frame.executeJavaScript(ensure, true).then(function () { return undefined; }, function () { return undefined; });
          });
        }).then(function () {
          return hasMermaid(frame);
        }).then(function (mermaidReady) {
          if (mermaidReady) {
            return undefined;
          }
          return executeVoid(frame, read("mermaid.min.js")).then(function () {
            return executeVoid(frame, "window.__claudeThirdPartyMermaidInstalled=true;");
          });
        }).then(function () {
          return executeVoid(frame, read("runtime.js"));
        });
      }).catch(function (error) {
        console.warn("[third-party-render] frame injection failed", frame.url, error);
      }).then(function () {
        inFlight.delete(frame);
      });
    };
    var framesFor = function (webContents) {
      var main = webContents && webContents.mainFrame;
      var frames = [];
      if (main) {
        if (Array.isArray(main.framesInSubtree)) {
          frames = main.framesInSubtree.slice();
        } else if (Array.isArray(main.frames)) {
          frames = main.frames.slice();
        }
        if (frames.indexOf(main) < 0) {
          frames.unshift(main);
        }
      }
      return frames;
    };
    var injectAllFrames = function (webContents) {
      if (!webContents || webContents.isDestroyed()) {
        return Promise.resolve();
      }
      return Promise.all(framesFor(webContents).map(injectFrame));
    };
    var frameFromEvent = function (processId, routingId) {
      try {
        if (electron.webFrameMain && electron.webFrameMain.fromId) {
          return electron.webFrameMain.fromId(processId, routingId);
        }
      } catch (_) {
        return null;
      }
      return null;
    };
    var attach = function (webContents) {
      if (!webContents || webContents.isDestroyed() || webContents.__claudeThirdPartyRenderAttached) {
        return;
      }
      webContents.__claudeThirdPartyRenderAttached = true;
      webContents.on("dom-ready", function () {
        injectAllFrames(webContents);
      });
      webContents.on("did-finish-load", function () {
        injectAllFrames(webContents);
      });
      webContents.on("did-frame-finish-load", function (_event, _isMainFrame, processId, routingId) {
        var frame = frameFromEvent(processId, routingId);
        if (frame) {
          injectFrame(frame);
        } else {
          injectAllFrames(webContents);
        }
      });
      injectAllFrames(webContents);
      attachDebugger(webContents);
    };
    if (electron.app && electron.app.on) {
      electron.app.on("web-contents-created", function (_event, webContents) {
        attach(webContents);
      });
    }
    if (electron.webContents && electron.webContents.getAllWebContents) {
      electron.webContents.getAllWebContents().forEach(attach);
    }
    attach(b.webContents);
  } catch (error) {
    console.warn("[third-party-render] loader unavailable", error);
  }
})();
/*__CLAUDE_TPR_LOADER_END__*/
