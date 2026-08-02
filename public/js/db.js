// Minimal promise-based key/value store on top of IndexedDB.
// Used to cache the notes dataset locally so the app works offline and
// loads instantly, independent of the Nextcloud round trip.
const NKDB = (() => {
  const DB_NAME = 'notekeep';
  const STORE = 'kv';
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    // If opening fails, don't poison future calls forever — let the next
    // get/set attempt try again from scratch (phones occasionally hiccup
    // on IndexedDB open, e.g. right after install or under storage pressure).
    dbPromise.catch(() => { dbPromise = null; });
    return dbPromise;
  }

  async function get(key) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function set(key, value) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }

  return { get, set };
})();
