;/*__CLAUDE_TPR_SHADOW_HOOK_START__*/
(function () {
  try {
    var electron = require("electron");
    var contextBridge = electron.contextBridge;
    var webFrame = electron.webFrame;
    var install = function () {
      if (window.__claudeThirdPartyShadowHookInstalled) {
        return;
      }
      window.__claudeThirdPartyShadowHookInstalled = true;
      var roots = [];
      window.__claudeThirdPartyShadowRoots = roots;
      var original = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function (init) {
        var root = original.call(this, init);
        roots.push(root);
        return root;
      };
    };
    if (contextBridge && typeof contextBridge.executeInMainWorld === "function") {
      contextBridge.executeInMainWorld({ func: install });
    } else if (webFrame && typeof webFrame.executeJavaScript === "function") {
      webFrame.executeJavaScript("(" + install.toString() + ")()");
    }
  } catch (_) {
    // The runtime still handles open shadow roots if this hook is unavailable.
  }
})();
/*__CLAUDE_TPR_SHADOW_HOOK_END__*/
