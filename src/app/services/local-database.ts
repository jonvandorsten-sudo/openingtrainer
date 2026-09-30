const DB_NAME = 'opening-trainer';
const DB_VERSION = 2;

export type StoreName = 'repertoires' | 'progress' | 'events' | 'settings' | 'players';

const KEY_PATHS: Record<StoreName, string | null> = {
  repertoires: 'id',
  progress: 'repertoireId',
  events: null,
  settings: 'key',
  players: 'id',
};

export interface LocalDatabase {
  readonly persistent: boolean;
  getAll<T>(store: StoreName): Promise<T[]>;
  put(store: StoreName, value: unknown): Promise<void>;
  add(store: StoreName, value: unknown): Promise<void>;
  delete(store: StoreName, key: string): Promise<void>;
  replaceAll(data: Partial<Record<StoreName, unknown[]>>): Promise<void>;
}

export async function openLocalDatabase(): Promise<LocalDatabase> {
  try {
    return await IndexedDbDatabase.open();
  } catch (error) {
    console.warn('IndexedDB unavailable, data is kept for this visit only', error);
    return new MemoryDatabase();
  }
}

class IndexedDbDatabase implements LocalDatabase {
  readonly persistent = true;

  private constructor(private readonly db: IDBDatabase) {}

  static open(): Promise<IndexedDbDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        for (const [name, keyPath] of Object.entries(KEY_PATHS)) {
          if (!request.result.objectStoreNames.contains(name)) {
            request.result.createObjectStore(name, keyPath ? { keyPath } : { autoIncrement: true });
          }
        }
      };
      request.onsuccess = () => resolve(new IndexedDbDatabase(request.result));
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('IndexedDB blocked'));
    });
  }

  getAll<T>(store: StoreName): Promise<T[]> {
    return this.run(store, 'readonly', (s) => s.getAll()) as Promise<T[]>;
  }

  async put(store: StoreName, value: unknown): Promise<void> {
    await this.run(store, 'readwrite', (s) => s.put(value));
  }

  async add(store: StoreName, value: unknown): Promise<void> {
    await this.run(store, 'readwrite', (s) => s.add(value));
  }

  async delete(store: StoreName, key: string): Promise<void> {
    await this.run(store, 'readwrite', (s) => s.delete(key));
  }

  replaceAll(data: Partial<Record<StoreName, unknown[]>>): Promise<void> {
    const names = Object.keys(KEY_PATHS) as StoreName[];
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(names, 'readwrite');
      for (const name of names) {
        const store = transaction.objectStore(name);
        store.clear();
        for (const value of data[name] ?? []) {
          store.put(value);
        }
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  private run(store: StoreName, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const request = action(this.db.transaction(store, mode).objectStore(store));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
}

class MemoryDatabase implements LocalDatabase {
  readonly persistent = false;
  private readonly stores = new Map<StoreName, Map<unknown, unknown>>();
  private nextId = 1;

  async getAll<T>(store: StoreName): Promise<T[]> {
    return [...this.store(store).values()] as T[];
  }

  async put(store: StoreName, value: unknown): Promise<void> {
    this.store(store).set(this.keyOf(store, value), value);
  }

  async add(store: StoreName, value: unknown): Promise<void> {
    await this.put(store, value);
  }

  async delete(store: StoreName, key: string): Promise<void> {
    this.store(store).delete(key);
  }

  async replaceAll(data: Partial<Record<StoreName, unknown[]>>): Promise<void> {
    this.stores.clear();
    for (const [name, values] of Object.entries(data) as [StoreName, unknown[]][]) {
      for (const value of values) {
        await this.put(name, value);
      }
    }
  }

  private store(name: StoreName): Map<unknown, unknown> {
    let store = this.stores.get(name);
    if (!store) {
      store = new Map();
      this.stores.set(name, store);
    }
    return store;
  }

  private keyOf(store: StoreName, value: unknown): unknown {
    const keyPath = KEY_PATHS[store];
    return keyPath ? (value as Record<string, unknown>)[keyPath] : this.nextId++;
  }
}
