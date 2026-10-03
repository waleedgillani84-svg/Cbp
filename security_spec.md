# Security Specification: Cash Book Pro

## 1. Data Invariants
1. **User Isolation**: A user can only read, write, or list data under their own `/users/{userId}` path where `request.auth.uid == userId`.
2. **Identity Integrity**: For any created or updated account, entry, or trash item, `incoming().userId == request.auth.uid`.
3. **No Blanket Access**: No anonymous or unauthenticated read/write access. All list queries must explicitly evaluate `userId == request.auth.uid`.
4. **Relational Hierarchy**: Subcollections `/users/{userId}/accounts`, `/users/{userId}/entries`, `/users/{userId}/trash` inherit ownership from the path variable `userId` and match `request.auth.uid`.
5. **Type & Bounds Constraints**:
   - `amount` must be a positive number (> 0) and <= 1,000,000,000.
   - `name` in account must be a non-empty string with size <= 100.
   - `details` in entry must be string with size <= 250.
   - `type` in entry must be either 'in' or 'out'.
   - ID strings must conform to `isValidId` (`^[a-zA-Z0-9_\-]+$`, size <= 64).

## 2. The Dirty Dozen Payloads
1. **Payload 1 (Impersonation)**: Create user profile with `userId: "otherUser123"` when `auth.uid == "userA"`. Expected: `PERMISSION_DENIED`.
2. **Payload 2 (Cross-User Read)**: Read `/users/victimUser/entries/entry1` as `attackerUser`. Expected: `PERMISSION_DENIED`.
3. **Payload 3 (Cross-User List)**: Query `/users/victimUser/entries` as `attackerUser`. Expected: `PERMISSION_DENIED`.
4. **Payload 4 (Orphan Entry)**: Entry with `userId` omitted or set to null. Expected: `PERMISSION_DENIED`.
5. **Payload 5 (Negative Amount)**: Entry with `amount: -500`. Expected: `PERMISSION_DENIED`.
6. **Payload 6 (String Poisoning in Amount)**: Entry with `amount: "Five Thousand"`. Expected: `PERMISSION_DENIED`.
7. **Payload 7 (Invalid Transaction Type)**: Entry with `type: "transfer"` (only "in" and "out" allowed). Expected: `PERMISSION_DENIED`.
8. **Payload 8 (Oversized Details Attack)**: Entry with `details` string length 5,000 characters (> 250). Expected: `PERMISSION_DENIED`.
9. **Payload 9 (ID Injection Attack)**: Document ID containing path traversal characters like `../../hack`. Expected: `PERMISSION_DENIED`.
10. **Payload 10 (Ghost Field Injection)**: Account creation with hidden field `{ "isAdmin": true, "vip": true }`. Expected: `PERMISSION_DENIED`.
11. **Payload 11 (Unauthenticated Probe)**: Read or write to `/users/anyUser` with `request.auth == null`. Expected: `PERMISSION_DENIED`.
12. **Payload 12 (Cross-Tenant Account Hijack)**: Moving an entry from user A into user B's account. Expected: `PERMISSION_DENIED`.

## 3. Test Runner
Refer to `firestore.rules.test.ts` for unit test coverage.
