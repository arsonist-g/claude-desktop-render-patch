(function () {
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
})();
