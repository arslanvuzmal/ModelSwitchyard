import { decryptSecret, sha256 } from '@/lib/encryption/crypto';
import { prisma } from '@/lib/database/client';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Encryption key rotation system.
 *
 * Supports multiple key versions for gradual rotation without
 * invalidating existing encrypted credentials.
 */

export interface KeyVersion {
  version: number;
  keyHash: string; // SHA-256 of the key for identification
  createdAt: Date;
  isActive: boolean;
}

/**
 * Current active encryption key version.
 * In production, this should come from a KMS or secret manager.
 */
const CURRENT_KEY_VERSION = 2;
const KEY_VERSION_PREFIX = 'v';

/**
 * Encrypts a secret with the current key version.
 * Format: v{version}:{ciphertext}
 */
export function encryptSecretWithVersion(
  plaintext: string,
  version: number = CURRENT_KEY_VERSION,
): string {
  if (plaintext.length === 0) {
    throw new Error('Cannot encrypt an empty value.');
  }

  // Use the version-specific encryption key
  const versionedKey = getEncryptionKeyForVersion(version);
  const ciphertext = encryptSecretWithKey(plaintext, versionedKey);

  return `${KEY_VERSION_PREFIX}${version}:${ciphertext}`;
}

/**
 * Decrypts a secret, automatically detecting the key version.
 * Format: v{version}:{ciphertext}
 */
export function decryptSecretWithVersion(payload: string): string {
  const parts = payload.split(':');
  if (parts.length < 2 || !parts[0]) {
    throw new Error('Malformed ciphertext: expected version:data');
  }

  const versionPart = parts[0];
  const ciphertext = parts.slice(1).join(':');

  if (!versionPart.startsWith(KEY_VERSION_PREFIX)) {
    // Legacy format (no version prefix) - use current key
    return decryptSecret(payload);
  }

  const version = parseInt(versionPart.slice(1), 10);
  if (isNaN(version)) {
    throw new Error(`Invalid key version in ciphertext: ${versionPart}`);
  }

  const versionedKey = getEncryptionKeyForVersion(version);
  return decryptSecretWithKey(ciphertext, versionedKey);
}

/**
 * Gets the encryption key for a specific version.
 * In production, this would fetch from a KMS.
 */
function getEncryptionKeyForVersion(version: number): Buffer {
  const envKey = `ENCRYPTION_KEY_V${version}`;
  const raw = process.env[envKey] ?? process.env.ENCRYPTION_KEY;

  if (!raw) {
    throw new Error(
      `Encryption key for version ${version} not found. Set ${envKey} or ENCRYPTION_KEY.`,
    );
  }

  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(
      `Encryption key for version ${version} must decode to exactly 32 bytes.`,
    );
  }

  return key;
}

/**
 * Encrypts with a specific key buffer.
 */
function encryptSecretWithKey(plaintext: string, key: Buffer): string {
  const ALGORITHM = 'aes-256-gcm';
  const IV_LENGTH = 12;

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  return [
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

/**
 * Decrypts with a specific key buffer.
 */
function decryptSecretWithKey(payload: string, key: Buffer): string {
  const ALGORITHM = 'aes-256-gcm';

  const parts = payload.split(':');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new Error('Malformed ciphertext: expected iv:tag:data');
  }

  const [ivPart, tagPart, dataPart] = parts as [string, string, string];

  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivPart, 'base64'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64'));

  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * Re-encrypts all credentials in a workspace from old version to new version.
 * Should be run as a background job during key rotation.
 */
export async function rotateEncryptionKeys(
  workspaceId: string,
  fromVersion: number,
  toVersion: number,
): Promise<{ rotated: number; failed: number }> {
  let rotated = 0;
  let failed = 0;

  const connections = await prisma.providerConnection.findMany({
    where: {
      workspaceId,
      credentialCiphertext: { not: null },
    },
  });

  for (const connection of connections) {
    try {
      // Decrypt with old version
      const plaintext = decryptSecretWithVersion(connection.credentialCiphertext!);

      // Encrypt with new version
      const newCiphertext = encryptSecretWithVersion(plaintext, toVersion);

      // Update
      await prisma.providerConnection.update({
        where: { id: connection.id },
        data: { credentialCiphertext: newCiphertext },
      });

      rotated++;
    } catch (error) {
      console.error(
        `Failed to rotate credential for connection ${connection.id}:`,
        error,
      );
      failed++;
    }
  }

  // Log audit event
  await prisma.auditLog.create({
    data: {
      workspaceId,
      actorLabel: 'system',
      action: 'encryption.key.rotation',
      resourceType: 'provider_connection',
      newState: { fromVersion, toVersion, rotated, failed },
    },
  });

  return { rotated, failed };
}

/**
 * Gets the current key version info for display.
 */
export function getKeyVersionInfo(): KeyVersion[] {
  const versions: KeyVersion[] = [];

  for (let v = 1; v <= CURRENT_KEY_VERSION; v++) {
    const envKey = `ENCRYPTION_KEY_V${v}`;
    const raw = process.env[envKey] ?? (v === 1 ? process.env.ENCRYPTION_KEY : undefined);

    if (raw) {
      versions.push({
        version: v,
        keyHash: sha256(raw).slice(0, 16),
        createdAt: new Date(), // Would be stored in DB in production
        isActive: v === CURRENT_KEY_VERSION,
      });
    }
  }

  return versions;
}

/**
 * Validates that all required encryption keys are configured.
 */
export function validateEncryptionKeys(): { valid: boolean; missing: string[] } {
  const missing: string[] = [];

  for (let v = 1; v <= CURRENT_KEY_VERSION; v++) {
    const envKey = `ENCRYPTION_KEY_V${v}`;
    const raw = process.env[envKey] ?? (v === 1 ? process.env.ENCRYPTION_KEY : undefined);

    if (!raw) {
      missing.push(envKey);
    } else {
      const key = Buffer.from(raw, 'base64');
      if (key.length !== 32) {
        missing.push(`${envKey} (invalid length: ${key.length} bytes)`);
      }
    }
  }

  return { valid: missing.length === 0, missing };
}
