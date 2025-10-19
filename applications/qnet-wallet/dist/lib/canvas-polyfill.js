// Simple polyfill for canvas.draw - production safe version
// Only patches HTMLCanvasElement prototype, nothing else

(function() {
    'use strict';
    
    // Only add draw method to HTMLCanvasElement if it doesn't exist
    // This is safe for production as it only extends the Canvas API
    if (typeof HTMLCanvasElement !== 'undefined' && !HTMLCanvasElement.prototype.draw) {
        HTMLCanvasElement.prototype.draw = function() {
            // Empty stub function to prevent errors
            // Some QR libraries expect this non-standard method
            return this;
        };
    }
})();
