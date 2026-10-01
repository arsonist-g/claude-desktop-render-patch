/*
 * MathJax 3 full TeX build configuration.
 * Loaded before the bundled tex-svg-full.js component.
 */
window.MathJax = {
  loader: {
    load: ["[tex]/mhchem"]
  },
  tex: {
    packages: { "[+]": ["mhchem"] },
    inlineMath: [["\\(", "\\)"]],
    displayMath: [["\\[", "\\]"]],
    processEscapes: true,
    processEnvironments: true
  },
  options: {
    enableMenu: false,
    enableAssistiveMml: true,
    ignoreHtmlClass: "tpr-ignore|mathjax_ignore",
    processHtmlClass: "tpr-math",
    skipHtmlTags: [
      "script", "noscript", "style", "textarea", "pre", "code", "math",
      "select", "option", "mjx-container"
    ]
  },
  startup: {
    typeset: false
  }
};
