// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { parseOptions, rewriteLocation, startDevServer } from '../../jellyfin-webgpu-client/scripts/dev';

describe('development CLI', () => {
    it('accepts a server BaseUrl and local port', () => {
        const options = parseOptions(['--server', 'https://example.com/jellyfin/', '--port', '5174']);
        expect(options.serverURL?.href).toBe('https://example.com/jellyfin');
        expect(options.port).toBe(5174);
        expect(options.noBuild).toBe(false);
    });

    it('shows help without requiring a server', () => {
        expect(parseOptions(['--help'])).toEqual({ help: true });
    });

    it('uses environment configuration and lets CLI flags override it', () => {
        vi.stubEnv('JELLYFIN_SERVER_URL', 'https://env.example/jellyfin');
        vi.stubEnv('JELLYFIN_DEV_PORT', '5180');
        try {
            expect(parseOptions([]).serverURL?.href).toBe('https://env.example/jellyfin');
            expect(parseOptions([]).port).toBe(5180);
            const options = parseOptions(['--server', 'https://cli.example', '--port', '5190']);
            expect(options.serverURL?.origin).toBe('https://cli.example');
            expect(options.port).toBe(5190);
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it.each([
        [],
        ['--server', 'ftp://example.com'],
        ['--server', 'https://user:password@example.com'],
        ['--server', 'https://example.com?api_key=secret'],
        ['--server', 'https://example.com/#login'],
        ['--server', 'https://example.com/jellyfin/web/index.html'],
        ['--server', 'https://example.com', '--port', '0'],
        ['--server', 'https://example.com', '--port', '65536'],
        ['--server', 'https://example.com', '--port', '1.5'],
        ['--server', 'https://example.com', '--port', 'abc'],
        ['--server', 'https://example.com', '--no-build', '--rebuild-web'],
        ['--server', 'https://example.com', '--unknown']
    ])('rejects invalid arguments %j', (...args) => {
        expect(() => parseOptions(args)).toThrow();
    });
});

describe('upstream redirects', () => {
    const upstream = new URL('https://example.com/jellyfin');

    it('maps absolute and root-relative upstream URLs to the local origin', () => {
        expect(rewriteLocation('https://example.com/jellyfin/Videos/1?token=test', upstream)).toBe('/Videos/1?token=test');
        expect(rewriteLocation('/jellyfin/web/index.html#!/home', upstream)).toBe('/web/index.html#!/home');
        expect(rewriteLocation('/jellyfin', upstream)).toBe('/');
    });

    it('preserves relative URLs and redirects to other origins or paths', () => {
        expect(rewriteLocation('next?token=test', upstream)).toBe('next?token=test');
        expect(rewriteLocation('https://other.example/video', upstream)).toBe('https://other.example/video');
        expect(rewriteLocation('/jellyfin-other/path', upstream)).toBe('/jellyfin-other/path');
    });
});

describe.each(['', '/jellyfin'])('local dev server (upstream BaseUrl %j)', base => {
    const upstream = createServer(async (request, response) => {
        let body = '';
        request.setEncoding('utf8');
        for await (const chunk of request) {
            body += chunk;
        }
        const requestPath = request.url?.split('?')[0];
        if (requestPath === `${base}/redirect`) {
            response.writeHead(302, { Location: `${base}/Videos/1?token=test` }).end();
        } else if (requestPath === `${base}/Videos/1`) {
            expect(request.headers.range).toBe('bytes=2-5');
            response.writeHead(206, {
                'Content-Type': 'video/mp4',
                'Content-Range': 'bytes 2-5/8',
                'Accept-Ranges': 'bytes',
                'Content-Length': '4'
            }).end('2345');
        } else {
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({
                url: request.url,
                method: request.method,
                authorization: request.headers.authorization,
                body
            }));
        }
    });
    let directory: string;
    let webDirectory: string;
    let addonDirectory: string;
    let local: Awaited<ReturnType<typeof startDevServer>>;
    let origin: string;

    beforeAll(async () => {
        upstream.on('upgrade', (request, socket) => {
            // SHA-1 is required by the WebSocket handshake, not used for authentication.
            // eslint-disable-next-line sonarjs/hashing
            const accept = createHash('sha1')
                .update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
                .digest('base64');
            socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
                + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
            const payload = new TextEncoder().encode(request.url || '');
            socket.write(new Uint8Array([0x81, payload.length, ...payload]));
            socket.on('data', () => socket.end(Buffer.from([0x88, 0])));
        });
        await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
        const upstreamAddress = upstream.address();
        if (!upstreamAddress || typeof upstreamAddress === 'string') {
            throw new Error('Expected an upstream TCP listener.');
        }
        directory = mkdtempSync(path.join(tmpdir(), 'webgpu-dev-test-'));
        webDirectory = path.join(directory, 'web');
        addonDirectory = path.join(directory, 'addon');
        mkdirSync(webDirectory);
        mkdirSync(path.join(addonDirectory, 'libraries'), { recursive: true });
        writeFileSync(path.join(webDirectory, 'index.html'), '<html><head></head><body>Local Jellyfin</body></html>');
        writeFileSync(path.join(webDirectory, 'config.json'), JSON.stringify({
            plugins: ['htmlVideoPlayer/plugin', 'WebGPUPlayer'],
            servers: ['https://wrong.example'],
            multiserver: true,
            themes: [{ id: 'dark' }]
        }));
        writeFileSync(path.join(webDirectory, 'main.js'), 'window.localWebBuild = true;');
        writeFileSync(path.join(webDirectory, 'node_modules.@scope.package.bundle.js'), 'window.scopedChunk = true;');
        writeFileSync(path.join(addonDirectory, 'addon-manifest.json'), '{"entry":"plugin.abc.js"}');
        writeFileSync(path.join(addonDirectory, 'plugin.abc.js'), 'export default function Player() {}');
        writeFileSync(path.join(addonDirectory, 'libraries', 'decoder.wasm'), new Uint8Array([0, 97, 115, 109]));
        writeFileSync(path.join(addonDirectory, 'libraries', 'worker.js'), 'self.onmessage = () => {};');
        local = await startDevServer({
            serverURL: new URL(`http://127.0.0.1:${upstreamAddress.port}${base}`),
            port: 0,
            webDirectory,
            addonDirectory
        });
        const localAddress = local.httpServer.address();
        if (!localAddress || typeof localAddress === 'string') {
            throw new Error('Expected a local TCP listener.');
        }
        expect(localAddress.address).toBe('127.0.0.1');
        origin = `http://127.0.0.1:${localAddress.port}`;
    });

    afterAll(async () => {
        if (local && 'closeAllConnections' in local.httpServer) {
            local.httpServer.closeAllConnections();
        }
        if (local) {
            await new Promise<void>((resolve, reject) => local.httpServer.close(error => error ? reject(error) : resolve()));
        }
        upstream.closeAllConnections();
        await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
        if (directory) {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it('redirects the root to the local web client', async () => {
        const response = await fetch(origin, { redirect: 'manual' });
        expect(response.status).toBe(302);
        expect(response.headers.get('location')).toBe('/web/');
    });

    it('serves local HTML and registers the window plugin before the host starts', async () => {
        const response = await fetch(`${origin}/web/index.html?cache=1`);
        const html = await response.text();
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(html).toContain('Local Jellyfin');
        expect(html).toContain('data-webgpu-player-bootstrap');
        expect(html).toContain('window.WebGPUPlayerConfig');
        expect(html).toContain('window.WebGPUPlayer = function');
        expect(html).toContain('import("/web/WebGPUPlayer/assets/plugin.abc.js")');
        expect(html.indexOf('window.WebGPUPlayerConfig')).toBeLessThan(html.indexOf('</head>'));
        expect(await (await fetch(`${origin}/web/main.js`)).text()).toBe('window.localWebBuild = true;');
    });

    it('preserves web settings while selecting the proxy and deduplicating the player', async () => {
        const response = await fetch(`${origin}/web/config.json`);
        expect(await response.json()).toEqual({
            plugins: ['htmlVideoPlayer/plugin', 'WebGPUPlayer'],
            servers: [],
            multiserver: false,
            themes: [{ id: 'dark' }]
        });
    });

    it('serves scoped chunks encoded by the Jellyfin Web HTML webpack plugin', async () => {
        const response = await fetch(`${origin}/web/node_modules.%40scope.package.bundle.js?build=123`);
        expect(response.status).toBe(200);
        expect(await response.text()).toBe('window.scopedChunk = true;');
    });

    it('serves the current bundle, workers and WebAssembly with the correct MIME types', async () => {
        const bundle = await fetch(`${origin}/web/WebGPUPlayer/assets/plugin.abc.js`);
        expect(await bundle.text()).toContain('export default function Player');
        expect(bundle.headers.get('content-type')).toMatch(/javascript/);
        const worker = await fetch(`${origin}/web/WebGPUPlayer/assets/libraries/worker.js`);
        expect(worker.status).toBe(200);
        expect(worker.headers.get('content-type')).toMatch(/javascript/);
        const wasm = await fetch(`${origin}/web/WebGPUPlayer/assets/libraries/decoder.wasm`);
        expect(wasm.headers.get('content-type')).toBe('application/wasm');
        expect(new Uint8Array(await wasm.arrayBuffer())).toEqual(new Uint8Array([0, 97, 115, 109]));
    });

    it('loads a rebuilt manifest on refresh without restarting', async () => {
        writeFileSync(path.join(addonDirectory, 'plugin.def.js'), 'export default function UpdatedPlayer() {}');
        writeFileSync(path.join(addonDirectory, 'addon-manifest.json'), '{"entry":"plugin.def.js"}');
        try {
            expect(await (await fetch(`${origin}/web/`)).text()).toContain('plugin.def.js');
        } finally {
            writeFileSync(path.join(addonDirectory, 'addon-manifest.json'), '{"entry":"plugin.abc.js"}');
        }
    });

    it('forwards API paths, query strings, authentication and request bodies', async () => {
        const response = await fetch(`${origin}/Users/AuthenticateByName?x=1`, {
            method: 'POST',
            headers: { Authorization: 'MediaBrowser Token="test-token"', 'Content-Type': 'application/json' },
            body: '{"Username":"test"}'
        });
        expect(await response.json()).toEqual({
            url: `${base}/Users/AuthenticateByName?x=1`,
            method: 'POST',
            authorization: 'MediaBrowser Token="test-token"',
            body: '{"Username":"test"}'
        });
    });

    it('streams media ranges and rewrites upstream redirects', async () => {
        const redirect = await fetch(`${origin}/redirect`, { redirect: 'manual' });
        expect(redirect.headers.get('location')).toBe('/Videos/1?token=test');
        const media = await fetch(`${origin}/Videos/1?token=test`, { headers: { Range: 'bytes=2-5' } });
        expect(media.status).toBe(206);
        expect(media.headers.get('content-range')).toBe('bytes 2-5/8');
        expect(media.headers.get('accept-ranges')).toBe('bytes');
        expect(await media.text()).toBe('2345');
    });

    it('proxies live WebSocket connections including the BaseUrl and query', async () => {
        const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/socket?api_key=test`);
        try {
            const message = await new Promise<string>((resolve, reject) => {
                socket.onmessage = event => resolve(String(event.data));
                socket.onerror = () => reject(new Error('WebSocket proxy failed.'));
            });
            expect(message).toBe(`${base}/socket?api_key=test`);
        } finally {
            await new Promise<void>(resolve => {
                socket.onclose = () => resolve();
                socket.close();
            });
        }
    });

    it('disables service-worker caching and supports HEAD requests', async () => {
        const worker = await fetch(`${origin}/web/serviceworker.js`);
        expect(worker.headers.get('content-type')).toMatch(/javascript/);
        expect(await worker.text()).toContain('self.registration.unregister()');
        const head = await fetch(`${origin}/web/index.html`, { method: 'HEAD' });
        expect(head.status).toBe(200);
        expect(await head.text()).toBe('');
    });

    it('fails explicitly rather than serving HTML for a broken add-on build', async () => {
        const manifest = path.join(addonDirectory, 'addon-manifest.json');
        const original = readFileSync(manifest, 'utf8');
        writeFileSync(manifest, '{"entry":"../outside.js"}');
        try {
            const response = await fetch(`${origin}/web/`);
            expect(response.status).toBe(500);
            expect(await response.text()).toContain('no valid built entry');
        } finally {
            writeFileSync(manifest, original);
        }
    });
});
