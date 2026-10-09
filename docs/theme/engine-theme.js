// Loads the engine book's scripts, shared rather than copied
// NOTE: URLs resolve from this script's built copy in docs/book/theme/, so three levels up is the plugin root
(function () {
    'use strict';

    const ENGINE_SCRIPTS = [ '../../../jellyfin-webgpu-client/vendor/webgpu-player/docs/theme/diagrams.js' ];
    for (const scriptPath of ENGINE_SCRIPTS) {
        const script = document.createElement('script');
        script.src = new URL(scriptPath, document.currentScript.src).href;
        document.currentScript.after(script);
    }
})();
