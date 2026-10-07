// STUB owned by T0.6 (admin sign-in). Signature is fixed; T0.6 replaces the body.
export interface AdminSession {
  email: string; // lowercase, on the ADMIN_EMAILS allowlist
  expiresAt: number; // ms epoch
}

/** Reads and verifies the admin session cookie. Null when absent, invalid or expired. */
export async function getAdminSession(): Promise<AdminSession | null> {
  throw new Error('getAdminSession: not implemented yet (T0.6)');
}
