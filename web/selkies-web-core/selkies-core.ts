/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Entry point of the web client: names the tab after the web root's manifest,
 * picks the streaming transport, and starts it.
 *
 * The transport is `window.__SELKIES_STREAMING_MODE__` when the page injects
 * one, else the `stream_mode` the last session persisted, else WebSockets. A
 * dashboard switches it by posting a `{type: "mode", mode}` window message; the
 * choice is persisted and the page reloads two seconds later, since the two
 * cores are not built for an in-place hand-off. A host page that sets
 * `window.__SELKIES_DEFER_INITIALIZATION` starts the client itself through
 * `window.selkiesCoreInitialize()`; otherwise the client starts on load.
 *
 * Persisted settings live in localStorage under the `getStorageAppName()`
 * namespace (origin plus pathname, never the query: a per-session `?token=`
 * must not mint a namespace per connect and exhaust the origin's quota). This
 * entry point and the transports import the storage migration before reading
 * saved settings.
 * @module
 */

import { getPrefixedKey, safeSetItem } from "./lib/storage-migration.ts";
import { titleFromManifest } from "./lib/page-title.ts";
import webrtc from "./selkies-wr-core.ts";
import websockets from "./selkies-ws-core.ts";

/** The core a started transport exposes; only the WebRTC core needs `initialize`. */
interface StreamingCore {
    initialize?: () => void;
}

declare global {
    /** The page-injected runtime switches of the entry point. */
    interface Window {
        __SELKIES_STREAMING_MODE__?: string;
        __SELKIES_DEFER_INITIALIZATION?: boolean;
        selkiesCoreInitialize?: () => void;
    }
}

const STREAM_MODE_WEBRTC = "webrtc";
const STREAM_MODE_WEBSOCKETS = "websockets";

let mode: StreamingCore | null | void = null;

/**
 * Resolves the transport to start: the injected runtime mode, else the last
 * session's persisted mode, else WebSockets.
 * @returns `"webrtc"` or `"websockets"`.
 */
function determineStreamingMode(): string {
    const runtimeMode = (typeof window !== 'undefined' && window.__SELKIES_STREAMING_MODE__) ? window.__SELKIES_STREAMING_MODE__ : undefined;
    const lastSessionMode = localStorage.getItem(getPrefixedKey('stream_mode'));
    const finalMode = runtimeMode ? runtimeMode : (lastSessionMode ? lastSessionMode : STREAM_MODE_WEBSOCKETS);
    console.log(`Streaming mode determined to be: ${finalMode}`);
    return finalMode;
}

/**
 * Persists a dashboard's `{type: "mode", mode}` request and reloads the page.
 *
 * Only the two real transports are persisted: anything else would make every
 * following load throw until localStorage was repaired by hand. The reload
 * waits two seconds so the server has switched modes before it lands.
 * @param event Same-origin window message.
 */
function handleMessage(event: MessageEvent<{ type?: string; mode?: string }>): void {
    if (event.origin !== window.location.origin) return;
    const message = event.data;
    if (message.mode !== undefined && message.type === "mode") {
        if (![STREAM_MODE_WEBRTC, STREAM_MODE_WEBSOCKETS].includes(message.mode)) return;
        console.log(`Switching streaming mode to: ${message.mode}`);
        safeSetItem(getPrefixedKey('stream_mode'), message.mode);

        setTimeout(() => {
            window.location.reload();
        }, 2000)
    }
}

/**
 * Persists the mode and starts the matching core.
 * @param newMode `"webrtc"` or `"websockets"`.
 * @throws On any other mode.
 */
function switchStreamingMode(newMode: string): void {
    safeSetItem(getPrefixedKey('stream_mode'), newMode);
    switch (newMode) {
        case STREAM_MODE_WEBRTC:
            mode = webrtc();
            (mode as StreamingCore).initialize!();
            break;
        case STREAM_MODE_WEBSOCKETS:
            mode = websockets();
            break;
        default:
            throw new Error(`Invalid client mode: ${newMode} received, aborting`);
    }
}

if (typeof window !== 'undefined') {
    window.addEventListener("message", handleMessage)
    window.selkiesCoreInitialize = function(): void {
        titleFromManifest();
        const streamingMode = determineStreamingMode();
        switchStreamingMode(streamingMode);
    };
}

if (typeof window !== 'undefined' && !window.__SELKIES_DEFER_INITIALIZATION) {
    window.selkiesCoreInitialize!();
}
