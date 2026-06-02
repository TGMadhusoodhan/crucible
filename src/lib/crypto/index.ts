import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12   // 96-bit IV — recommended for GCM
const TAG_BYTES = 16  // 128-bit auth tag

function getKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY
  if (!hex) throw new Error('ENCRYPTION_KEY is not set')
  const key = Buffer.from(hex.trim(), 'hex')
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes (64 hex chars)')
  return key
}

/**
 * Encrypts plaintext with AES-256-GCM.
 * Returns "ivHex:authTagHex:ciphertextHex" — safe to store in DB.
 */
export function encrypt(plaintext: string): string {
  const key = getKey()
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES })

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`
}

/**
 * Decrypts a value produced by encrypt().
 * Throws if the auth tag is invalid (tampered data).
 */
export function decrypt(stored: string): string {
  const parts = stored.split(':')
  if (parts.length !== 3) throw new Error('Invalid encrypted format')

  const [ivHex, tagHex, ciphertextHex] = parts
  const key = getKey()
  const iv = Buffer.from(ivHex, 'hex')
  const authTag = Buffer.from(tagHex, 'hex')
  const ciphertext = Buffer.from(ciphertextHex, 'hex')

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES })
  decipher.setAuthTag(authTag)

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}
