// STUB owned by T0.6 (OAuth 2.1 server). Signature is fixed; T0.6 replaces the body.
export interface BearerIdentity {
  subject: string; // admin email the token was issued to
  clientId: string; // DCR client id
}

/** Verifies `Authorization: Bearer <access token>` against the store. Null when missing, unknown, expired or revoked. */
export async function verifyBearer(req: Request): Promise<BearerIdentity | null> {
  void req;
  throw new Error('verifyBearer: not implemented yet (T0.6)');
}
