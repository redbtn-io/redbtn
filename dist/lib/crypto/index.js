"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isEncrypted = isEncrypted;
exports.decrypt = decrypt;
exports.decryptHeaders = decryptHeaders;
/**
 * Crypto utilities for AI package
 * Compatible with webapp's encryption format (iv:authTag:ciphertext)
 */
const crypto_1 = require("crypto");
const ALGORITHM = 'aes-256-gcm';
function getEncryptionKey() {
    const keySource = process.env.ENCRYPTION_KEY || process.env.JWT_SECRET;
    if (!keySource)
        return null;
    return (0, crypto_1.createHash)('sha256').update(keySource).digest();
}
function isEncrypted(value) {
    if (!value || !value.includes(':'))
        return false;
    const parts = value.split(':');
    return parts.length === 3;
}
function decrypt(encryptedValue) {
    if (!encryptedValue)
        return '';
    if (!isEncrypted(encryptedValue))
        return encryptedValue;
    const parts = encryptedValue.split(':');
    const [ivBase64, authTagBase64, ciphertext] = parts;
    try {
        const key = getEncryptionKey();
        if (!key) {
            console.warn('[Crypto] No encryption key available, returning value as-is');
            return encryptedValue;
        }
        const iv = Buffer.from(ivBase64, 'base64');
        const authTag = Buffer.from(authTagBase64, 'base64');
        const decipher = (0, crypto_1.createDecipheriv)(ALGORITHM, key, iv);
        decipher.setAuthTag(authTag);
        let decrypted = decipher.update(ciphertext, 'base64', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    }
    catch (_error) {
        console.warn('[Crypto] Failed to decrypt value, returning as-is');
        return encryptedValue;
    }
}
function decryptHeaders(headers) {
    if (!headers)
        return {};
    const decrypted = {};
    for (const [key, value] of Object.entries(headers)) {
        decrypted[key] = isEncrypted(value) ? decrypt(value) : value;
    }
    return decrypted;
}
