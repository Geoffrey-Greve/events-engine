/**
 * Main application entry point.
 *
 * State machine:
 *   setup  → (connect + sync) → scanner
 *   scanner → (reset) → setup
 *
 * Offline behaviour:
 *  - Manifest is pre-synced when the app connects and stored in IndexedDB.
 *  - Each QR scan is verified locally (HMAC-SHA256) using the manifest's derived key.
 *  - Scans are queued in IndexedDB and flushed via /batch when the network returns.
 *  - Same-device double-scans are caught locally before hitting the queue.
 */

import type { ManifestAnswer } from '@paddock/shared';
import { fetchManifest, fetchStats, flushBatch } from './api';
import { importVerifyKey, parseDeviceTokenEventId, verifyTicketCode } from './crypto';
import {
  type AppSettings,
  addPendingScan,
  clearSettings,
  getPendingScans,
  loadManifest,
  loadSettings,
  markCheckedInLocally,
  removePendingScans,
  type StoredManifest,
  saveManifest,
  saveSettings,
} from './db';
import { Scanner } from './scanner';

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const screenSetup = $('screen-setup');
const screenScanner = $('screen-scanner');
const setupForm = $<HTMLFormElement>('setup-form');
const serverUrlInput = $<HTMLInputElement>('server-url');
const deviceTokenInput = $<HTMLInputElement>('device-token');
const connectBtn = $<HTMLButtonElement>('connect-btn');
const setupError = $('setup-error');

const eventNameEl = $('event-name');
const statsBadgeEl = $('stats-badge');
const onlineIndicator = $('online-indicator');

const cameraEl = $<HTMLVideoElement>('camera');
const canvasEl = $<HTMLCanvasElement>('qr-canvas');
const scanOverlay = $('scan-result-overlay');
const scanCard = $('scan-result-card');
const scanIcon = $('scan-icon');
const scanName = $('scan-name');
const scanStatusEl = $('scan-status');
const scanAnswersEl = $('scan-answers');

const searchInput = $<HTMLInputElement>('search-input');
const searchResults = $('search-results');
const pendingBadge = $('pending-badge');
const btnSync = $<HTMLButtonElement>('btn-sync');
const btnReset = $<HTMLButtonElement>('btn-reset');

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

let settings: AppSettings | null = null;
let storedManifest: StoredManifest | null = null;
let verifyKey: CryptoKey | null = null;
let scanner: Scanner | null = null;
let scanOverlayTimer: ReturnType<typeof setTimeout> | null = null;
let statsTimer: ReturnType<typeof setInterval> | null = null;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let isFlusing = false;

// ---------------------------------------------------------------------------
// Screen switching
// ---------------------------------------------------------------------------

function showSetup(): void {
  screenSetup.classList.add('active');
  screenScanner.classList.remove('active');
}

function showScanner(): void {
  screenSetup.classList.remove('active');
  screenScanner.classList.add('active');
}

// ---------------------------------------------------------------------------
// Setup flow
// ---------------------------------------------------------------------------

setupForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  setupError.textContent = '';
  connectBtn.disabled = true;
  connectBtn.textContent = 'Syncing…';

  const serverUrl = serverUrlInput.value.trim();
  const deviceToken = deviceTokenInput.value.trim();

  try {
    const eventId = parseDeviceTokenEventId(deviceToken);
    if (!eventId) throw new Error('Could not parse event ID from device token.');

    const manifest = await fetchManifest(serverUrl, deviceToken, eventId);
    const stored: StoredManifest = {
      eventId: manifest.eventId,
      verifyKey: manifest.verifyKey,
      generatedAt: manifest.generatedAt,
      tickets: manifest.tickets,
      localCheckedIn: {},
    };
    await saveManifest(stored);
    await saveSettings({ serverUrl, deviceToken });

    settings = { serverUrl, deviceToken };
    storedManifest = stored;
    verifyKey = await importVerifyKey(stored.verifyKey);

    await enterScannerMode();
  } catch (err) {
    setupError.textContent = String(err instanceof Error ? err.message : err);
  } finally {
    connectBtn.disabled = false;
    connectBtn.textContent = 'Connect & Sync';
  }
});

// ---------------------------------------------------------------------------
// Scanner mode
// ---------------------------------------------------------------------------

async function enterScannerMode(): Promise<void> {
  showScanner();

  if (storedManifest) {
    eventNameEl.textContent = `Event ${storedManifest.eventId}`;
  }

  updatePendingBadge();

  scanner = new Scanner({
    video: cameraEl,
    canvas: canvasEl,
    onCode: handleScan,
  });

  try {
    await scanner.start();
  } catch {
    showScanResult('fail', '⚠️', 'Camera unavailable', 'Grant camera permission and reload');
  }

  // Periodically refresh stats and flush pending queue.
  if (settings && storedManifest) {
    void refreshStats();
    statsTimer = setInterval(() => {
      void refreshStats();
    }, 30_000);
    flushTimer = setInterval(() => {
      void flushPending();
    }, 5_000);
  }

  // Flush immediately on reconnect.
  window.addEventListener('online', () => {
    void flushPending();
  });
}

// ---------------------------------------------------------------------------
// QR scan processing
// ---------------------------------------------------------------------------

async function handleScan(code: string): Promise<void> {
  if (!storedManifest || !verifyKey || !settings) return;

  const now = new Date().toISOString();

  // 1. Verify signature offline.
  const payload = await verifyTicketCode(code, verifyKey);
  if (!payload) {
    showScanResult('fail', '✗', 'Invalid QR code', 'Signature failed');
    return;
  }

  // 2. Check event scope.
  if (payload.eid !== storedManifest.eventId) {
    showScanResult('fail', '✗', 'Wrong event', 'This ticket is for a different event');
    return;
  }

  // 3. Check local manifest for status (same-device dedup).
  const ticket = storedManifest.tickets.find((t) => t.code === code);
  const localCheckedInAt = storedManifest.localCheckedIn[code];

  // A validly-signed code that isn't in the manifest is NOT admissible. The manifest only
  // carries issued/checked_in tickets, so a missing entry means the ticket was
  // cancelled/voided (or belongs to a different roster) — a valid signature alone must not
  // admit it. Reject as not-found rather than recording a local check-in.
  if (!ticket) {
    showScanResult('fail', '✗', `Ticket ${payload.tid}`, 'Not on the guest list');
    return;
  }

  if (localCheckedInAt) {
    showScanResult('warn', '↩', ticket.name, 'Already checked in', ticket.answers);
    return;
  }

  if (ticket.status === 'checked_in') {
    showScanResult('warn', '↩', ticket.name, 'Already checked in', ticket.answers);
    return;
  }

  if (ticket.status === 'cancelled' || ticket.status === 'voided') {
    showScanResult('fail', '✗', ticket.name, 'Ticket cancelled');
    return;
  }

  // 4. Mark locally and enqueue for server flush.
  const name = ticket.name;
  const answers = ticket.answers;
  await markCheckedInLocally(storedManifest.eventId, code, now);
  // Update in-memory manifest reference.
  ticket.status = 'checked_in';
  ticket.checkedInAt = now;
  storedManifest.localCheckedIn[code] = now;

  await addPendingScan({ id: crypto.randomUUID(), code, scannedAt: now });
  updatePendingBadge();

  showScanResult('ok', '✓', name, 'Checked in', answers);

  // Try immediate flush if online.
  if (navigator.onLine) void flushPending();
}

// ---------------------------------------------------------------------------
// Result overlay
// ---------------------------------------------------------------------------

type ResultTone = 'ok' | 'warn' | 'fail';

function showScanResult(
  tone: ResultTone,
  icon: string,
  name: string,
  status: string,
  answers: ManifestAnswer[] = [],
): void {
  scanCard.className = '';
  scanCard.classList.add(tone);
  scanIcon.textContent = icon;
  scanName.textContent = name;
  scanStatusEl.textContent = status;

  // Built as nodes, never innerHTML: an answer is attendee-typed free text.
  scanAnswersEl.replaceChildren();
  for (const answer of answers) {
    const line = document.createElement('div');
    line.className = 'scan-answer';
    const label = document.createElement('span');
    label.className = 'scan-answer-label';
    label.textContent = `${answer.label}: `;
    const value = document.createElement('span');
    value.className = 'scan-answer-value';
    value.textContent = answer.value;
    line.appendChild(label);
    line.appendChild(value);
    scanAnswersEl.appendChild(line);
  }

  scanOverlay.classList.add('visible');

  if (scanOverlayTimer) clearTimeout(scanOverlayTimer);
  scanOverlayTimer = setTimeout(() => {
    scanOverlay.classList.remove('visible');
  }, 2000);
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

async function refreshStats(): Promise<void> {
  if (!settings || !storedManifest) return;
  try {
    const stats = await fetchStats(
      settings.serverUrl,
      settings.deviceToken,
      storedManifest.eventId,
    );
    statsBadgeEl.textContent = `${stats.attended} / ${stats.registered}`;
  } catch {
    // Network may be unavailable — silent failure, cron is the backstop.
  }
}

// ---------------------------------------------------------------------------
// Pending queue flush
// ---------------------------------------------------------------------------

async function flushPending(): Promise<void> {
  if (isFlusing || !navigator.onLine || !settings) return;
  const pending = await getPendingScans();
  if (pending.length === 0) return;

  isFlusing = true;
  try {
    const response = await flushBatch(
      settings.serverUrl,
      settings.deviceToken,
      pending.map(({ code, scannedAt }) => ({ code, scannedAt })),
    );
    // Remove scans the server processed (ok or already_checked_in — both terminal).
    const processedIds = pending
      .filter((_, i) => {
        const r = response.results[i];
        return r && (r.ok || r.status === 'already_checked_in');
      })
      .map((s) => s.id);
    await removePendingScans(processedIds);
    updatePendingBadge();
    // Refresh stats after a successful flush.
    void refreshStats();
  } catch {
    // Will retry on next tick.
  } finally {
    isFlusing = false;
  }
}

// ---------------------------------------------------------------------------
// Manual search
// ---------------------------------------------------------------------------

searchInput.addEventListener('input', () => {
  const q = searchInput.value.trim().toLowerCase();
  searchResults.innerHTML = '';
  if (!q || !storedManifest) return;

  const matches = storedManifest.tickets
    .filter((t) => t.name.toLowerCase().includes(q))
    .slice(0, 8);

  for (const ticket of matches) {
    const row = document.createElement('div');
    row.className = 'search-row';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'search-row-name';
    nameSpan.textContent = ticket.name;

    const statusSpan = document.createElement('span');
    statusSpan.className = `search-row-status ${ticket.status}`;
    statusSpan.textContent = ticket.status === 'checked_in' ? '✓ In' : 'Issued';

    row.appendChild(nameSpan);
    // Labels only here - the row is a chooser, and the values belong on the scan card
    // where there is room to read them. textContent, never innerHTML.
    if (ticket.answers.length > 0) {
      const answersSpan = document.createElement('span');
      answersSpan.className = 'search-row-answers';
      answersSpan.textContent = ticket.answers.map((a) => a.label).join(', ');
      row.appendChild(answersSpan);
    }
    row.appendChild(statusSpan);

    if (ticket.status !== 'checked_in') {
      row.addEventListener('click', () => {
        searchInput.value = '';
        searchResults.innerHTML = '';
        void handleScan(ticket.code);
      });
    }

    searchResults.appendChild(row);
  }
});

// Close search results when clicking outside.
document.addEventListener('click', (e) => {
  if (!searchResults.contains(e.target as Node) && e.target !== searchInput) {
    searchResults.innerHTML = '';
  }
});

// ---------------------------------------------------------------------------
// Sync button (re-fetch manifest)
// ---------------------------------------------------------------------------

btnSync.addEventListener('click', async () => {
  if (!settings || !storedManifest) return;
  btnSync.disabled = true;
  btnSync.textContent = 'Syncing…';
  try {
    const manifest = await fetchManifest(
      settings.serverUrl,
      settings.deviceToken,
      storedManifest.eventId,
    );
    // Merge localCheckedIn so we don't lose device-only marks.
    const newStored: StoredManifest = {
      eventId: manifest.eventId,
      verifyKey: manifest.verifyKey,
      generatedAt: manifest.generatedAt,
      tickets: manifest.tickets,
      localCheckedIn: storedManifest.localCheckedIn,
    };
    await saveManifest(newStored);
    storedManifest = newStored;
    verifyKey = await importVerifyKey(newStored.verifyKey);
    // Flush any pending scans now that we're online.
    await flushPending();
    await refreshStats();
  } catch (err) {
    alert(`Sync failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    btnSync.disabled = false;
    btnSync.textContent = '↻ Sync';
  }
});

// ---------------------------------------------------------------------------
// Reset (return to setup)
// ---------------------------------------------------------------------------

btnReset.addEventListener('click', async () => {
  if (!confirm('Reset device? You will need to reconnect.')) return;
  scanner?.stop();
  scanner = null;
  if (statsTimer) clearInterval(statsTimer);
  if (flushTimer) clearInterval(flushTimer);
  statsTimer = null;
  flushTimer = null;
  await clearSettings();
  settings = null;
  storedManifest = null;
  verifyKey = null;
  serverUrlInput.value = '';
  deviceTokenInput.value = '';
  setupError.textContent = '';
  showSetup();
});

// ---------------------------------------------------------------------------
// Online/offline indicator
// ---------------------------------------------------------------------------

function updateOnlineIndicator(): void {
  onlineIndicator.classList.toggle('online', navigator.onLine);
  onlineIndicator.title = navigator.onLine ? 'Online' : 'Offline';
}

window.addEventListener('online', updateOnlineIndicator);
window.addEventListener('offline', updateOnlineIndicator);
updateOnlineIndicator();

// ---------------------------------------------------------------------------
// Pending scan badge
// ---------------------------------------------------------------------------

async function updatePendingBadge(): Promise<void> {
  const pending = await getPendingScans();
  if (pending.length === 0) {
    pendingBadge.textContent = '';
  } else {
    pendingBadge.textContent = `${pending.length} scan${pending.length === 1 ? '' : 's'} pending sync`;
  }
}

// ---------------------------------------------------------------------------
// Boot: restore persisted session if available
// ---------------------------------------------------------------------------

async function boot(): Promise<void> {
  const saved = await loadSettings();
  if (!saved) {
    showSetup();
    return;
  }

  const eventId = parseDeviceTokenEventId(saved.deviceToken);
  if (!eventId) {
    showSetup();
    return;
  }

  const manifest = await loadManifest(eventId);
  if (!manifest) {
    serverUrlInput.value = saved.serverUrl;
    deviceTokenInput.value = saved.deviceToken;
    showSetup();
    return;
  }

  settings = saved;
  storedManifest = manifest;

  try {
    verifyKey = await importVerifyKey(manifest.verifyKey);
  } catch {
    showSetup();
    return;
  }

  await enterScannerMode();

  // Attempt background re-sync on boot if online.
  if (navigator.onLine) {
    fetchManifest(saved.serverUrl, saved.deviceToken, eventId)
      .then(async (fresh) => {
        const updated: StoredManifest = {
          ...fresh,
          localCheckedIn: manifest.localCheckedIn,
        };
        await saveManifest(updated);
        storedManifest = updated;
        verifyKey = await importVerifyKey(updated.verifyKey);
        await flushPending();
        await refreshStats();
      })
      .catch(() => {
        /* silent — offline boot is fine */
      });
  }
}

void boot();
