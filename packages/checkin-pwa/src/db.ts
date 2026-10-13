/**
 * IndexedDB persistence layer for the check-in PWA.
 *
 * Three stores:
 *   settings    — serverUrl, deviceToken (survives page reload)
 *   manifest    — per-event ticket list + verifyKey (offline verify source)
 *   pending     — scan queue flushed to /batch on reconnect
 */

import { type ManifestEntry, normaliseManifestTickets } from '@paddock/shared';

const DB_NAME = 'paddock-checkin';
const DB_VERSION = 1;

const SETTINGS_STORE = 'settings';
const MANIFEST_STORE = 'manifest';
const PENDING_STORE = 'pending';

export interface AppSettings {
  serverUrl: string;
  deviceToken: string;
}

export interface StoredManifest {
  eventId: string;
  verifyKey: string;
  generatedAt: string;
  tickets: ManifestEntry[];
  /** Local set of codes the device has marked checked-in this session. */
  localCheckedIn: Record<string, string>; // code → checkedInAt ISO string
}

export interface PendingScan {
  id: string;
  code: string;
  scannedAt: string;
}

// ---------------------------------------------------------------------------
// Open / upgrade
// ---------------------------------------------------------------------------

let _db: IDBDatabase | null = null;

function openDb(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
        db.createObjectStore(SETTINGS_STORE);
      }
      if (!db.objectStoreNames.contains(MANIFEST_STORE)) {
        db.createObjectStore(MANIFEST_STORE);
      }
      if (!db.objectStoreNames.contains(PENDING_STORE)) {
        db.createObjectStore(PENDING_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = (e) => {
      _db = (e.target as IDBOpenDBRequest).result;
      resolve(_db);
    };
    req.onerror = () => reject(req.error);
  });
}

function tx(
  db: IDBDatabase,
  stores: string | string[],
  mode: IDBTransactionMode = 'readonly',
): IDBTransaction {
  return db.transaction(stores, mode);
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function saveSettings(settings: AppSettings): Promise<void> {
  const db = await openDb();
  const t = tx(db, SETTINGS_STORE, 'readwrite');
  const store = t.objectStore(SETTINGS_STORE);
  await promisify(store.put(settings.serverUrl, 'serverUrl'));
  await promisify(store.put(settings.deviceToken, 'deviceToken'));
}

export async function loadSettings(): Promise<AppSettings | null> {
  const db = await openDb();
  const t = tx(db, SETTINGS_STORE);
  const store = t.objectStore(SETTINGS_STORE);
  const [serverUrl, deviceToken] = await Promise.all([
    promisify(store.get('serverUrl')),
    promisify(store.get('deviceToken')),
  ]);
  if (typeof serverUrl !== 'string' || typeof deviceToken !== 'string') return null;
  return { serverUrl, deviceToken };
}

export async function clearSettings(): Promise<void> {
  const db = await openDb();
  const t = tx(db, SETTINGS_STORE, 'readwrite');
  await promisify(t.objectStore(SETTINGS_STORE).clear());
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export async function saveManifest(manifest: StoredManifest): Promise<void> {
  const db = await openDb();
  const t = tx(db, MANIFEST_STORE, 'readwrite');
  await promisify(t.objectStore(MANIFEST_STORE).put(manifest, manifest.eventId));
}

export async function loadManifest(eventId: string): Promise<StoredManifest | null> {
  const db = await openDb();
  const t = tx(db, MANIFEST_STORE);
  const result = await promisify<StoredManifest | undefined>(
    t.objectStore(MANIFEST_STORE).get(eventId),
  );
  if (!result) return null;
  // A record stored before Ref 74d carries no `answers` on its tickets, and boot() enters
  // scanner mode on whatever is cached: the re-sync that would replace it is skipped
  // outright when the device is offline and swallowed when it fails. So this is the last
  // point before a pre-74d record becomes the manifest the door reads all day.
  return { ...result, tickets: normaliseManifestTickets(result.tickets) };
}

export async function markCheckedInLocally(
  eventId: string,
  code: string,
  checkedInAt: string,
): Promise<void> {
  const db = await openDb();
  const t = tx(db, MANIFEST_STORE, 'readwrite');
  const store = t.objectStore(MANIFEST_STORE);
  const manifest = await promisify<StoredManifest | undefined>(store.get(eventId));
  if (!manifest) return;
  manifest.localCheckedIn[code] = checkedInAt;
  // Also update the ticket entry in the local manifest list.
  const ticket = manifest.tickets.find((tk) => tk.code === code);
  if (ticket) {
    ticket.status = 'checked_in';
    ticket.checkedInAt = checkedInAt;
  }
  await promisify(store.put(manifest, eventId));
}

// ---------------------------------------------------------------------------
// Pending scan queue
// ---------------------------------------------------------------------------

export async function addPendingScan(scan: PendingScan): Promise<void> {
  const db = await openDb();
  const t = tx(db, PENDING_STORE, 'readwrite');
  await promisify(t.objectStore(PENDING_STORE).put(scan));
}

export async function getPendingScans(): Promise<PendingScan[]> {
  const db = await openDb();
  const t = tx(db, PENDING_STORE);
  return promisify(t.objectStore(PENDING_STORE).getAll());
}

export async function removePendingScans(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await openDb();
  const t = tx(db, PENDING_STORE, 'readwrite');
  const store = t.objectStore(PENDING_STORE);
  await Promise.all(ids.map((id) => promisify(store.delete(id))));
}
