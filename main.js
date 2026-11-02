const { app, BrowserWindow } = require('electron');
const path = require('path');
const express = require('express');
const http = require('http');
const https = require('https');
const proxy = require('express-http-proxy');

// Local Node.js Express Server & Proxy Configuration (Port 45332)
const proxyApp = express();
const PROXY_PORT = process.env.PROXY_PORT || 45332;
// 'https://democracy-unmatched-dairy.ngrok-free.dev'
// 'http://localhost:8889'
const TARGET_BACKEND =  'https://democracy-unmatched-dairy.ngrok-free.dev'; // Default backend target

console.log(`[Electron Node Proxy] Forwarding backend target: ${TARGET_BACKEND}`);

proxyApp.use(express.static(__dirname));

// 1. SSE Stream Route with Crash Propagation & Inactivity Timeout
proxyApp.get('/stream', (req, res) => {
    console.log(`[Electron Node Proxy] Piping live SSE stream -> ${TARGET_BACKEND}/stream`);

    const targetParsed = new URL('/stream', TARGET_BACKEND);
    const client = targetParsed.protocol === 'https:' ? https : http;

    const proxyReq = client.request(targetParsed, {
        method: 'GET',
        headers: {
            ...req.headers,
            'ngrok-skip-browser-warning': 'true', // Bypasses ngrok 6024 splash page
            'User-Agent': 'Electron-SSE-Client',
            host: targetParsed.host
        }
    }, (proxyRes) => {
        // 1. If Auth Failed (401 / 403) -> Forward to browser so it prompts Login!
        if (proxyRes.statusCode === 401 || proxyRes.statusCode === 403) {
            console.log('[Proxy] Auth rejected by server. Forwarding 401 to browser.');
            return res.status(proxyRes.statusCode).end();
        }

        // // 2. If Server Crashed (ngrok 502 / 503) -> Destroy socket so browser auto-retries!
        if (proxyRes.statusCode >= 500 || proxyRes.statusCode === 404) {
            console.log('[Proxy] Server is down. Destroying socket so browser auto-retries.');
            return res.destroy();
        }

        // 3. If 200 OK -> Stream data!
        res.writeHead(proxyRes.statusCode, {
            ...proxyRes.headers,
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no'
        });

        // Pipe chunks in real-time
        proxyRes.pipe(res);

        // When server closes/crashes mid-stream:
        proxyRes.on('close', () => {
            console.log('[Proxy] Server connection closed. Destroying browser socket.');
            res.destroy();
        });

        proxyRes.on('end', () => {
            res.destroy();
        });
    });

    //  INACTIVITY TIMEOUT: If Wi-Fi drops and no data/heartbeat arrives for 4s -> destroy socket!
    proxyReq.setTimeout(4000, () => {
        console.log('[Proxy]  Inactivity timeout reached (4s silence / Wi-Fi drop). Destroying socket to trigger auto-reconnect!');
        proxyReq.destroy();
        res.destroy();
    });

    // If backend server is down during request
    proxyReq.on('error', (err) => {
        console.error('[Proxy] Server unreachable:', err.message);
        res.destroy();
    });

    req.on('close', () => {
        console.log('[Electron Node Proxy] Client closed SSE stream');
        proxyReq.destroy();
    });

    proxyReq.end();
});

// 2. Forward all other API routes (/api/login, /api/refresh)
proxyApp.use('/api', proxy(TARGET_BACKEND, {
    proxyReqPathResolver: (req) => `/api${req.url}`,
    proxyReqOptDecorator: (proxyReqOpts) => {
        proxyReqOpts.headers['ngrok-skip-browser-warning'] = 'true';
        return proxyReqOpts;
    },
    proxyErrorHandler: (err, res, next) => {
        console.error('[Electron Node Proxy] API error:', err.message);
        res.status(502).json({ error: 'Backend server unavailable' });
    }
}));

// Fallback to serve index.html for root path
proxyApp.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

let serverInstance;
function startLocalProxyServer() {
    serverInstance = proxyApp.listen(PROXY_PORT, '127.0.0.1', () => {
        console.log(`====================================================`);
        console.log(`  Electron Local Node Server running on http://127.0.0.1:${PROXY_PORT}`);
        console.log(`  Connected to Backend: ${TARGET_BACKEND}`);
        console.log(`====================================================`);
    });
}

function createWindow() {
    startLocalProxyServer();

    const mainWindow = new BrowserWindow({
        width: 1000,
        height: 750,
        title: 'Cookie-Based SSE Test - Electron App (Port 45332)',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    mainWindow.loadURL(`http://127.0.0.1:${PROXY_PORT}`);
    mainWindow.webContents.openDevTools();
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (serverInstance) serverInstance.close();
    if (process.platform !== 'darwin') app.quit();
});