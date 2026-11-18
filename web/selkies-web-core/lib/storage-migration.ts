/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/** Migrates stored preferences before either transport reads them. */

import { getStorageAppName } from "./util.ts";

/** Origin plus pathname, the string the legacy key prefix was derived from. */
const urlForKey: string = window.location.origin + window.location.pathname;
export const storageAppName = getStorageAppName();
export const getPrefixedKey = (key: string): string => `${storageAppName}_${key}`;
/** Writes a key, degrading a full or unavailable store to a warning. */
export const safeSetItem = (key: string, value: string): void => {
    try {
        localStorage.setItem(key, value);
    } catch (e) {
        console.warn(`Selkies: could not persist '${key}' to localStorage:`, e);
    }
};

/**
 * Migrates settings from the legacy key prefix and prunes token-scoped keys.
 *
 * Query-less legacy keys are copied to the current prefix once, and only when
 * no key under the current prefix exists yet, so settings saved since are
 * never clobbered; a flag key makes the copy run at most once. Token-scoped
 * keys (legacy prefix plus a literal `?`) are removed on every load, which is
 * cheap and frees quota before any write (`removeItem` never hits the quota).
 */
(function migrateStorageKeys(): void {
    try {
        if (typeof localStorage === 'undefined') return;
        // The legacy sanitizer kept a-z and 0x2E-0x5F literal.
        let oldAppName = '';
        for (let i = 0; i < urlForKey.length; i++) {
            const c = urlForKey.charCodeAt(i);
            oldAppName += ((c >= 0x2E && c <= 0x5F) || (c >= 0x61 && c <= 0x7A)) ? urlForKey[i] : '_';
        }
        const tokenPrefix = oldAppName + '?';
        const staleKeys: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith(tokenPrefix)) staleKeys.push(k);
        }
        staleKeys.forEach((k) => localStorage.removeItem(k));
        if (staleKeys.length) {
            console.log(`Selkies: removed ${staleKeys.length} stale token-scoped localStorage keys.`);
        }
        if (oldAppName === storageAppName) return;
        const migratedFlagKey = `${storageAppName}_storage_key_migrated`;
        if (localStorage.getItem(migratedFlagKey) !== null) return;

        const oldPrefix = `${oldAppName}_`;
        const newPrefix = `${storageAppName}_`;

        // Snapshot first: the loop below mutates localStorage.
        const allKeys: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k !== null) allKeys.push(k);
        }
        const hasNew = allKeys.some((k) => k.startsWith(newPrefix));
        const oldKeys = allKeys.filter((k) => k.startsWith(oldPrefix));
        if (!hasNew && oldKeys.length > 0) {
            for (const oldKey of oldKeys) {
                const suffix = oldKey.slice(oldPrefix.length);
                const newKey = newPrefix + suffix;
                if (localStorage.getItem(newKey) === null) {
                    const val = localStorage.getItem(oldKey);
                    if (val !== null) safeSetItem(newKey, val);
                }
            }
            console.log(`Migrated ${oldKeys.length} setting(s) from old storage prefix "${oldPrefix}" to "${newPrefix}".`);
        }
        safeSetItem(migratedFlagKey, '1');
    } catch (e) {
        console.warn('Storage key migration skipped due to error:', e);
    }
})();

/**
 * Clears legacy manual resolution picks once per browser profile and path.
 * The existing migration marker also preserves explicit picks made after
 * the packaged web client's migration.
 */
function restoreWindowFit(): void {
    try {
        const marker = getPrefixedKey('fit_window_reset_20261117');
        if (localStorage.getItem(marker) !== null) return;
        for (const key of ['manual_resolution', 'manual_width', 'manual_height']) {
            localStorage.removeItem(getPrefixedKey(key));
            localStorage.removeItem(getPrefixedKey(`${key}_pick`));
        }
        localStorage.setItem(marker, '1');
    } catch {
        // Storage can be unavailable to embedded browser sessions.
    }
}

restoreWindowFit();
