const statusEl = document.getElementById("status");
const messagesEl = document.getElementById("messages");
const btnLogin = document.getElementById("btn-login");
const btnRevoke = document.getElementById("btn-revoke");

// Modal elements
const loginModal = document.getElementById("login-modal");
const loginForm = document.getElementById("login-form");
const modalClose = document.getElementById("modal-close");
const btnCancel = document.getElementById("btn-cancel");
const loginError = document.getElementById("login-error");
const usernameInput = document.getElementById("username");
const passwordInput = document.getElementById("password");

const REFRESH_BUFFER = 5 * 1000; // Refresh cookie 5s before 60s expiry

let evtSource = null;
let refreshTimer = null;
let accessExpiresAt = null;

function openLoginModal() {
    if (loginError) {
        loginError.style.display = "none";
        loginError.textContent = "";
    }
    if (loginModal) {
        loginModal.classList.remove("hidden");
    }
    if (usernameInput) {
        usernameInput.focus();
        usernameInput.select();
    }
}

function closeLoginModal() {
    if (loginModal) {
        loginModal.classList.add("hidden");
    }
}

async function refreshAccessToken() {
    console.log("[Background] Proactively refreshing accessToken cookie...");

    try {
        const res = await fetch("/api/refresh", { method: "POST" });

        if (res.status === 401) {
            console.log("[Background] Refresh rejected: Session expired/revoked.");
            handleSessionExpired();
            return;
        }

        if (!res.ok) {
            throw new Error(`Refresh failed with status ${res.status}`);
        }

        const data = await res.json();
        accessExpiresAt = data.accessExpiresAt;
        console.log("[Background] Access token cookie refreshed! Expires at:", new Date(accessExpiresAt).toLocaleTimeString());

        scheduleBackgroundRefresh();
    } catch (err) {
        console.error("[Background] Refresh check error:", err.message);
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(refreshAccessToken, 10000);
    }
}

function scheduleBackgroundRefresh() {
    clearTimeout(refreshTimer);
    if (!accessExpiresAt) return;

    const delay = Math.max(1000, accessExpiresAt - Date.now() - REFRESH_BUFFER);
    console.log(`[Background] Next token refresh scheduled in ${(delay / 1000).toFixed(1)}s`);

    refreshTimer = setTimeout(() => {
        refreshAccessToken();
    }, delay);
}

function handleSessionExpired() {
    clearTimeout(refreshTimer);
    refreshTimer = null;
    accessExpiresAt = null;

    if (evtSource) {
        evtSource.close();
        evtSource = null;
    }

    statusEl.textContent = "Session Expired. Please log in again.";
    statusEl.className = "status closed";

    if (btnLogin) btnLogin.disabled = false;
    if (btnRevoke) btnRevoke.disabled = true;
}

function connectSSE() {
    if (evtSource) return;

    console.log("[SSE] Opening connection with credentials (cookies automatically attached)...");
    evtSource = new EventSource("/stream", { withCredentials: true });

    evtSource.onopen = () => {
        statusEl.textContent = "Connected to Server-Sent Events stream!";
        statusEl.className = "status open";
        console.log("[SSE] Connection OPEN");
        if (btnLogin) btnLogin.disabled = true;
        if (btnRevoke) btnRevoke.disabled = false;
    };

    evtSource.onmessage = (event) => {
        const li = document.createElement("li");
        const eventId = document.createElement("span");

        eventId.className = "event-id";
        eventId.textContent = `[ID: ${event.lastEventId}]`;
        li.append(eventId, ` ${event.data}`);
        messagesEl.appendChild(li);
        messagesEl.scrollTop = messagesEl.scrollHeight;
    };

    evtSource.onerror = () => {
        if (!evtSource) return;

        if (evtSource.readyState === EventSource.CLOSED) {
            // Fatal HTTP Error: Server returned 401 Unauthorized or 403 Forbidden
            console.log("[SSE] Fatal error (readyState = CLOSED). Session expired or rejected by server.");
            handleSessionExpired();
        } else if (evtSource.readyState === EventSource.CONNECTING) {
            console.log("[SSE] Connection lost (readyState = CONNECTING). Browser is auto-reconnecting...");
            statusEl.textContent = "Connection lost. Auto-reconnecting...";
            statusEl.className = "status refreshing";
        }
    };
}

async function submitLogin(e) {
    if (e) e.preventDefault();

    const username = usernameInput ? usernameInput.value.trim() : "admin";
    const password = passwordInput ? passwordInput.value.trim() : "admin";

    if (!username || !password) {
        if (loginError) {
            loginError.textContent = "Please enter both username and password.";
            loginError.style.display = "block";
        }
        return;
    }

    const submitBtn = document.getElementById("btn-submit-login");
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = "Authenticating...";
    }

    try {
        const res = await fetch("/api/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, password })
        });

        if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData.error || "Login failed");
        }

        const data = await res.json();
        accessExpiresAt = data.accessExpiresAt;
        console.log(`[Client] Logged in as ${data.username || username}! Access token expires at:`, new Date(accessExpiresAt).toLocaleTimeString());

        closeLoginModal();

        statusEl.textContent = "Authenticating & connecting stream...";
        statusEl.className = "status refreshing";

        scheduleBackgroundRefresh();

        connectSSE();
    } catch (err) {
        console.error("[Client] Login error:", err);
        if (loginError) {
            loginError.textContent = err.message || "Login failed. Please check server.";
            loginError.style.display = "block";
        }
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = "Sign In & Start Stream";
        }
    }
}

async function simulateSessionRevocation() {
    console.log("[Client] Simulating session revocation on server...");
    await fetch("/api/revoke-session", { method: "POST" });
    console.log("[Client] Session revoked on server. Waiting for refresh rejection or stream error...");
}

// Event Listeners
if (btnLogin) btnLogin.addEventListener("click", openLoginModal);
if (modalClose) modalClose.addEventListener("click", closeLoginModal);
if (btnCancel) btnCancel.addEventListener("click", closeLoginModal);
if (loginModal) {
    loginModal.addEventListener("click", (e) => {
        if (e.target === loginModal) closeLoginModal();
    });
}
if (loginForm) loginForm.addEventListener("submit", submitLogin);
if (btnRevoke) btnRevoke.addEventListener("click", simulateSessionRevocation);

async function initApp() {
    try {
        const res = await fetch("/api/auth-status");
        if (res.ok) {
            const data = await res.json();
            if (data.authenticated) {
                console.log("[Init] Existing session detected, resuming stream...");
                if (data.accessExpiresAt) {
                    accessExpiresAt = data.accessExpiresAt;
                    scheduleBackgroundRefresh();
                } else {
                    refreshAccessToken();
                }
                connectSSE();
                return;
            }
        }
    } catch (err) {
        console.warn("[Init] Auth check failed or offline:", err);
    }

    // Default first-run unauthenticated state
    statusEl.textContent = "Welcome! Please log in to start the SSE stream.";
    statusEl.className = "status idle";
    if (btnLogin) btnLogin.disabled = false;
    if (btnRevoke) btnRevoke.disabled = true;
}

initApp();
