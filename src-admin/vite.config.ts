import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
    plugins: [react()],
    // The tab is served from /adapter/python/, not from the server root.
    base: './',
    build: {
        target: 'chrome89',
        // One big chunk by design. React, MUI and gui-components are bundled rather than shared
        // with admin through module federation (which is what ioBroker.javascript does): the tab
        // is an iframe, so a self-contained bundle always works, while federation is an
        // optimisation that cannot be verified without a running admin. Splitting the dialogs out
        // would not help -- DialogSelectID comes from the same package as GenericApp, so the
        // ObjectBrowser is in the main chunk either way.
        chunkSizeWarningLimit: 2000,
        // Straight into the folder that ships in the npm package. `emptyOutDir` must stay off:
        // admin/ also holds jsonConfig.json and the icon, which are sources, not build output.
        outDir: '../admin',
        emptyOutDir: false,
        rollupOptions: {
            input: { tab: fileURLToPath(new URL('tab.html', import.meta.url)) },
        },
    },
    server: {
        port: 3000,
        // `npm start` serves the tab from vite while the data comes from a real ioBroker.
        proxy: {
            '/_socket': 'http://localhost:8081',
            '/lib': 'http://localhost:8081',
            '/adapter': 'http://localhost:8081',
            '/files': 'http://localhost:8081',
            '/socket.io': { target: 'http://localhost:8081', ws: true },
        },
    },
});
