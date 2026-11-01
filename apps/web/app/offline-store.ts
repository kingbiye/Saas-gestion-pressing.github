export type OfflineRecord<T> = {
  key: string;
  userKey: string;
  value: T;
};

export type PendingDeposit<T> = {
  key: string;
  userKey: string;
  reference: string;
  payload: Record<string, unknown>;
  deposit: T;
};

const databaseName = "pressing-os-offline";
const databaseVersion = 1;
let databasePromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, databaseVersion);
    request.onupgradeneeded = () => {
      const database = request.result;
      database.createObjectStore("snapshots", { keyPath: "key" });
      const pendingDeposits = database.createObjectStore("pendingDeposits", { keyPath: "key" });
      pendingDeposits.createIndex("userKey", "userKey", { unique: false });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      databasePromise = null;
      reject(request.error ?? new Error("Impossible d’ouvrir le stockage hors ligne."));
    };
    request.onblocked = () => {
      databasePromise = null;
      reject(new Error("Le stockage hors ligne est bloqué par un autre onglet."));
    };
  });
  return databasePromise;
}

async function readRecord<T>(storeName: string, key: string): Promise<T | null> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, "readonly");
    const request = transaction.objectStore(storeName).get(key);
    request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
    request.onerror = () => reject(request.error ?? new Error("Impossible de lire les données hors ligne."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Lecture hors ligne annulée."));
  });
}

async function writeRecord(storeName: string, value: object): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).put(value);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Impossible d’enregistrer les données hors ligne."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Enregistrement hors ligne annulé."));
  });
}

export async function getOfflineSnapshot<T>(userKey: string): Promise<T | null> {
  const record = await readRecord<OfflineRecord<T>>("snapshots", userKey);
  return record?.value ?? null;
}

export async function saveOfflineSnapshot<T>(userKey: string, value: T): Promise<void> {
  await writeRecord("snapshots", { key: userKey, userKey, value });
}

export async function getPendingDeposits<T>(userKey: string): Promise<PendingDeposit<T>[]> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("pendingDeposits", "readonly");
    const request = transaction.objectStore("pendingDeposits").index("userKey").getAll(userKey);
    request.onsuccess = () => resolve(request.result as PendingDeposit<T>[]);
    request.onerror = () => reject(request.error ?? new Error("Impossible de lire les dépôts en attente."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Lecture des dépôts en attente annulée."));
  });
}

export async function savePendingDeposit<T>(
  userKey: string,
  reference: string,
  payload: Record<string, unknown>,
  deposit: T,
): Promise<void> {
  await writeRecord("pendingDeposits", {
    key: `${userKey}:${reference}`,
    userKey,
    reference,
    payload,
    deposit,
  });
}

export async function removePendingDeposit(userKey: string, reference: string): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction("pendingDeposits", "readwrite");
    transaction.objectStore("pendingDeposits").delete(`${userKey}:${reference}`);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Impossible de retirer le dépôt synchronisé."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Retrait du dépôt synchronisé annulé."));
  });
}
