const express = require("express");
const path = require("path");

const app = express();
const port = process.env.PORT || 8889;

// Lightweight Cookie Parser Middleware
app.use((req, res, next) => {
    req.cookies = {};
    const cookieHeader = req.headers.cookie;
    if (cookieHeader) {
        cookieHeader.split(";").forEach(c => {
            const [k, ...v] = c.split("=");
            if (k) req.cookies[k.trim()] = decodeURIComponent(v.join("=").trim());
        });
    }
    next();
});

app.use(express.json());
app.use(express.static(__dirname));

const ACCESS_TOKEN_LIFETIME = 600 * 1000; // 10 minutes 
const REFRESH_TOKEN_LIFETIME = 24 * 60 * 60 * 1000; // 24 hours

function setCookie(res, name, value, maxAgeMs) {
    const expires = new Date(Date.now() + maxAgeMs).toUTCString();
    res.append("Set-Cookie", `${name}=${encodeURIComponent(value)}; Path=/; Expires=${expires}; HttpOnly; SameSite=Lax`);
}

function clearCookie(res, name) {
    res.append("Set-Cookie", `${name}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; HttpOnly; SameSite=Lax`);
}

app.post("/api/login", (req, res) => {
    const { username, password } = req.body || {};

    if (username !== undefined && password !== undefined) {
        if (!username.trim() || !password.trim()) {
            return res.status(400).json({ error: "Username and password are required" });
        }
    }

    const user = (username && username.trim()) || "admin";
    const accessExpiresAt = Date.now() + ACCESS_TOKEN_LIFETIME;
    const refreshExpiresAt = Date.now() + REFRESH_TOKEN_LIFETIME;

    setCookie(res, "accessToken", String(accessExpiresAt), ACCESS_TOKEN_LIFETIME);
    setCookie(res, "refreshToken", String(refreshExpiresAt), REFRESH_TOKEN_LIFETIME);

    console.log(`[Server] User "${user}" logged in. Token valid until: ${new Date(accessExpiresAt).toLocaleTimeString()}`);
    res.json({ success: true, username: user, accessExpiresAt });
});

app.post("/api/refresh", (req, res) => {
    const refreshToken = req.cookies.refreshToken;
    const refreshExpiry = parseInt(refreshToken, 10);

    if (!refreshToken || isNaN(refreshExpiry) || Date.now() > refreshExpiry) {
        console.log("[Server] Refresh rejected: Refresh token expired or missing");
        return res.status(401).json({ error: "Invalid or expired refresh token" });
    }

    const accessExpiresAt = Date.now() + ACCESS_TOKEN_LIFETIME;
    setCookie(res, "accessToken", String(accessExpiresAt), ACCESS_TOKEN_LIFETIME);
    console.log(`[Server]  Refreshed accessToken. Valid until: ${new Date(accessExpiresAt).toLocaleTimeString()}`);

    res.json({ success: true, accessExpiresAt });
});

app.get("/api/auth-status", (req, res) => {
    const refreshToken = req.cookies.refreshToken;
    const refreshExpiry = parseInt(refreshToken, 10);

    if (refreshToken && !isNaN(refreshExpiry) && Date.now() <= refreshExpiry) {
        const accessToken = req.cookies.accessToken;
        const accessExpiry = parseInt(accessToken, 10);
        return res.json({
            authenticated: true,
            accessExpiresAt: !isNaN(accessExpiry) ? accessExpiry : null
        });
    }
    console.log("[Server] Auth check: 401 Unauthorized");
    res.status(401).json({ authenticated: false });
});

app.post("/api/revoke-session", (req, res) => {
    clearCookie(res, "accessToken");
    clearCookie(res, "refreshToken");
    console.log("[Server]  Session forcefully revoked for testing!");
    res.json({ success: true, message: "Session revoked on server" });
});

app.get("/stream", (req, res) => {
    const accessToken = req.cookies.accessToken;
    const accessExpiry = parseInt(accessToken, 10);

    if (!accessToken || isNaN(accessExpiry)) {
        console.log("[Server] SSE rejected: Missing accessToken cookie");
        return res.status(401).end();
    }

    if (Date.now() > accessExpiry) {
        console.log("[Server] SSE rejected: accessToken expired by clock time");
        return res.status(401).end();
    }

    console.log("[Server] SSE client connected/reconnected via Time-Validated Cookie Auth");

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    // Instruct browser to retry every 2000ms if disconnected
    res.write("retry: 2000\n\n");

    const lastEventIdHeader = req.headers["last-event-id"];
    let currentEventId = lastEventIdHeader ? parseInt(lastEventIdHeader, 10) : 0;

    console.log(`[Server] Resuming stream from Event ID: ${currentEventId}`);

    // Push messages every 1 second
    const interval = setInterval(() => {
        currentEventId++;
        const event = { id: currentEventId, data: `Stream Message #${currentEventId}` };

        res.write(`id: ${event.id}\n`);
        res.write(`data: ${event.data}\n\n`);
        console.log(`[Server]  Sent -> Event #${event.id}: "${event.data}"`);
    }, 1000);

    // Push heartbeat comment every 2 seconds to keep socket active
    const heartbeat = setInterval(() => {
        res.write(": keep-alive\n\n");
    }, 2000);

    req.on("close", () => {
        clearInterval(interval);
        clearInterval(heartbeat);
        console.log("[Server] Client disconnected");
    });
});

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(port, () => {
    console.log("=============================================================");
    console.log(` Stateless Time-Based SSE Server running at http://localhost:${port}`);
    console.log("=============================================================");
});
