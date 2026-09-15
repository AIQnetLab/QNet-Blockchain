// Shim for css-tree — replaces the Node.js CSS parsing library that is
// pulled in by react-native-svg's CSS-in-SVG feature (SvgCss/SvgWithCss).
// The wallet app does not use CSS-embedded SVGs, so this is safe to stub.
// Provides minimal stubs so the module loads without runtime errors.
module.exports = {
  parse: function() { return { type: 'StyleSheet', children: { toArray: function() { return []; } } }; },
  walk: function() {},
  generate: function() { return ''; },
  clone: function(node) { return node; },
  find: function() { return null; },
  findAll: function() { return []; },
  List: function() {
    this.head = null;
    this.tail = null;
    this.size = 0;
    this.toArray = function() { return []; };
    this.forEach = function() {};
    this.filter = function() { return new module.exports.List(); };
    this.each = function() {};
  },
};
