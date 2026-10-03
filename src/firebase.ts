/**
 * Firebase Client Integration for Cash Book Pro
 */
import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  type User
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  getDoc,
  getDocFromServer,
  setDoc,
  deleteDoc,
  collection,
  onSnapshot,
  writeBatch
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export async function testConnection(): Promise<boolean> {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.warn("Client is offline, working with cached data.");
    } else {
      console.warn("Firebase connection notice:", error);
    }
    return false;
  }
}

export interface AccountDoc {
  id: string;
  userId: string;
  name: string;
  icon: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface EntryDoc {
  id: string;
  userId: string;
  accountId: string;
  type: 'in' | 'out';
  amount: number;
  details?: string;
  date: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface TrashDoc {
  id: string;
  userId: string;
  itemType: 'entry' | 'account';
  deletedAt: string;
  data?: any;
}

export interface UserProfileDoc {
  userId: string;
  email: string;
  displayName?: string;
  photoURL?: string;
  theme?: string;
  activeAccountId?: string;
  createdAt?: string;
  updatedAt?: string;
}

export async function saveUserProfile(profile: UserProfileDoc): Promise<void> {
  const path = `users/${profile.userId}`;
  try {
    await setDoc(doc(db, 'users', profile.userId), {
      ...profile,
      updatedAt: new Date().toISOString()
    }, { merge: true });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function saveAccount(account: AccountDoc): Promise<void> {
  const path = `users/${account.userId}/accounts/${account.id}`;
  try {
    await setDoc(doc(db, 'users', account.userId, 'accounts', account.id), {
      ...account,
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function removeAccount(userId: string, accountId: string): Promise<void> {
  const path = `users/${userId}/accounts/${accountId}`;
  try {
    await deleteDoc(doc(db, 'users', userId, 'accounts', accountId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function saveEntry(entry: EntryDoc): Promise<void> {
  const path = `users/${entry.userId}/entries/${entry.id}`;
  try {
    await setDoc(doc(db, 'users', entry.userId, 'entries', entry.id), {
      ...entry,
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function removeEntry(userId: string, entryId: string): Promise<void> {
  const path = `users/${userId}/entries/${entryId}`;
  try {
    await deleteDoc(doc(db, 'users', userId, 'entries', entryId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function saveTrash(item: TrashDoc): Promise<void> {
  const path = `users/${item.userId}/trash/${item.id}`;
  try {
    await setDoc(doc(db, 'users', item.userId, 'trash', item.id), item);
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function removeTrash(userId: string, trashId: string): Promise<void> {
  const path = `users/${userId}/trash/${trashId}`;
  try {
    await deleteDoc(doc(db, 'users', userId, 'trash', trashId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function purgeAllTrash(userId: string, trashIds: string[]): Promise<void> {
  const path = `users/${userId}/trash`;
  try {
    const batch = writeBatch(db);
    trashIds.forEach(id => {
      batch.delete(doc(db, 'users', userId, 'trash', id));
    });
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export function subscribeToAccounts(
  userId: string,
  onUpdate: (accounts: AccountDoc[]) => void,
  onError?: (err: any) => void
) {
  const path = `users/${userId}/accounts`;
  return onSnapshot(
    collection(db, 'users', userId, 'accounts'),
    (snap) => {
      const list: AccountDoc[] = [];
      snap.forEach(docSnap => list.push(docSnap.data() as AccountDoc));
      onUpdate(list);
    },
    (error) => {
      if (onError) onError(error);
      handleFirestoreError(error, OperationType.GET, path);
    }
  );
}

export function subscribeToEntries(
  userId: string,
  onUpdate: (entries: EntryDoc[]) => void,
  onError?: (err: any) => void
) {
  const path = `users/${userId}/entries`;
  return onSnapshot(
    collection(db, 'users', userId, 'entries'),
    (snap) => {
      const list: EntryDoc[] = [];
      snap.forEach(docSnap => list.push(docSnap.data() as EntryDoc));
      onUpdate(list);
    },
    (error) => {
      if (onError) onError(error);
      handleFirestoreError(error, OperationType.GET, path);
    }
  );
}

export function subscribeToTrash(
  userId: string,
  onUpdate: (trash: TrashDoc[]) => void,
  onError?: (err: any) => void
) {
  const path = `users/${userId}/trash`;
  return onSnapshot(
    collection(db, 'users', userId, 'trash'),
    (snap) => {
      const list: TrashDoc[] = [];
      snap.forEach(docSnap => list.push(docSnap.data() as TrashDoc));
      onUpdate(list);
    },
    (error) => {
      if (onError) onError(error);
      handleFirestoreError(error, OperationType.GET, path);
    }
  );
}
