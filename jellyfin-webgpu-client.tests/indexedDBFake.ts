import { vi } from 'vitest';

// An in-memory IndexedDB with the parts the pass source store uses, since jsdom has none
// Requests complete on microtasks, as a browser completes them after the task that made them

type RequestCallback = (() => void) | null;

/** One object store: its records by key, and the key its next added record takes. */
type FakeStore = {
    nextKey: number
    records: Map<number, unknown>
};

type FakeDatabase = {
    stores: Map<string, FakeStore>
    version: number
};

type TransactionOperation = (stores: Map<string, FakeStore>) => unknown;

class FakeRequest {
    error: DOMException | null = null;
    onerror: RequestCallback = null;
    onsuccess: RequestCallback = null;
    result: unknown = undefined;
}

class FakeOpenRequest extends FakeRequest {
    onupgradeneeded: RequestCallback = null;
}

/** The keys an autoIncrement store gives count up from 1. */
const FIRST_KEY = 1;

/** Copies stores, so a transaction works on its own copy until it commits. */
function copyStores(stores: ReadonlyMap<string, FakeStore>): Map<string, FakeStore> {
    const copies = new Map<string, FakeStore>();
    for (const [ name, store ] of stores) {
        copies.set(name, { nextKey: store.nextKey, records: new Map<number, unknown>(store.records) });
    }
    return copies;
}

function requireStore(stores: ReadonlyMap<string, FakeStore>, name: string): FakeStore {
    const store = stores.get(name);
    if (!store) {
        throw new DOMException(`No object store '${name}'`, 'NotFoundError');
    }
    return store;
}

/** Returns an object store's requests, each queued in its transaction as an operation on the transaction's copy of the stores. */
function createObjectStore(name: string, queue: (operation: TransactionOperation, writes: boolean) => FakeRequest): unknown {
    return {
        add: (value: unknown): FakeRequest => queue((stores: Map<string, FakeStore>): number => {
            const store = requireStore(stores, name);
            const key = store.nextKey;
            store.nextKey += 1;
            store.records.set(key, value);
            return key;
        }, true),
        delete: (key: number): FakeRequest => queue((stores: Map<string, FakeStore>): undefined => {
            requireStore(stores, name).records.delete(key);
            return undefined;
        }, true),
        get: (key: number): FakeRequest => queue((stores: Map<string, FakeStore>): unknown => requireStore(stores, name).records.get(key), false)
    };
}

export type IndexedDBFake = Readonly<{
    /** Forgets every database and any pending failure, keeping open connections usable */
    clear: () => void
    /** Makes every open fail with the error, or succeed again for null */
    failOpen: (error: DOMException | null) => void
    /** Makes the next transaction that writes abort with the error, as a full quota does */
    failNextWrite: (error: DOMException) => void
    /** Stubs the global indexedDB again after a suite unstubs its globals, keeping the databases and open connections */
    install: () => void
    /** Returns a store's records by key, or an empty map when it does not exist */
    readStore: (databaseName: string, storeName: string) => ReadonlyMap<number, unknown>
}>;

/** Installs the fake as the global indexedDB, until the test file unstubs its globals. */
export function installIndexedDBFake(): IndexedDBFake {
    const databases = new Map<string, FakeDatabase>();
    let openFailure: DOMException | null = null;
    let writeFailure: DOMException | null = null;

    const runTransaction = (
        database: FakeDatabase,
        transaction: { error: DOMException | null; onabort: RequestCallback; oncomplete: RequestCallback },
        operations: readonly (readonly [ FakeRequest, TransactionOperation, boolean ])[]
    ): void => {
        const stores = copyStores(database.stores);
        for (const [ request, operation, writes ] of operations) {
            if (writes && writeFailure !== null) {
                request.error = writeFailure;
                transaction.error = writeFailure;
                writeFailure = null;
                request.onerror?.();
                transaction.onabort?.();
                return;
            }
            request.result = operation(stores);
            request.onsuccess?.();
        }
        database.stores = stores;
        transaction.oncomplete?.();
    };

    const createConnection = (database: FakeDatabase): unknown => {
        let closed = false;
        return {
            close: (): void => {
                closed = true;
            },
            createObjectStore: (name: string): void => {
                database.stores.set(name, { nextKey: FIRST_KEY, records: new Map<number, unknown>() });
            },
            onversionchange: null,
            transaction: (storeName: string, mode: IDBTransactionMode): unknown => {
                if (closed) {
                    throw new DOMException('The connection is closed', 'InvalidStateError');
                }
                requireStore(database.stores, storeName);
                const operations: (readonly [ FakeRequest, TransactionOperation, boolean ])[] = [];
                const transaction = { error: null as DOMException | null, onabort: null as RequestCallback, oncomplete: null as RequestCallback };
                const queue = (operation: TransactionOperation, writes: boolean): FakeRequest => {
                    if (writes && mode !== 'readwrite') {
                        throw new DOMException('The transaction is read-only', 'ReadOnlyError');
                    }
                    const request = new FakeRequest();
                    operations.push([ request, operation, writes ]);
                    return request;
                };
                queueMicrotask((): void => {
                    runTransaction(database, transaction, operations);
                });
                return Object.assign(transaction, {
                    objectStore: (name: string): unknown => createObjectStore(name, queue)
                });
            }
        };
    };

    const factory = {
        open: (name: string, version: number): FakeOpenRequest => {
            const request = new FakeOpenRequest();
            queueMicrotask((): void => {
                if (openFailure !== null) {
                    request.error = openFailure;
                    request.onerror?.();
                    return;
                }
                const database = databases.get(name) ?? { stores: new Map<string, FakeStore>(), version: 0 };
                databases.set(name, database);
                request.result = createConnection(database);
                if (database.version < version) {
                    database.version = version;
                    request.onupgradeneeded?.();
                }
                request.onsuccess?.();
            });
            return request;
        }
    };
    vi.stubGlobal('indexedDB', factory);

    return {
        clear: (): void => {
            for (const database of databases.values()) {
                for (const store of database.stores.values()) {
                    store.nextKey = FIRST_KEY;
                    store.records.clear();
                }
            }
            openFailure = null;
            writeFailure = null;
        },
        failNextWrite: (error: DOMException): void => {
            writeFailure = error;
        },
        failOpen: (error: DOMException | null): void => {
            openFailure = error;
        },
        install: (): void => {
            vi.stubGlobal('indexedDB', factory);
        },
        readStore: (databaseName: string, storeName: string): ReadonlyMap<number, unknown> => (
            databases.get(databaseName)?.stores.get(storeName)?.records ?? new Map<number, unknown>()
        )
    };
}
