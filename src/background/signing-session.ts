import { SecureString, secureWipe } from '../shared/crypto-utils';
import { storage, alarms } from '../shared/browser-polyfill';
import { getSettings } from '../shared/storage';
import { isLockedError, unlockSecret } from './unlock-limit';
import { Mnemonic } from '../lib/mnemonic';
import { HDKey } from '../lib/hdkey';
import { Signer } from '../lib/signer';
import { NETWORKS, type NetworkType } from '../shared/constants';

const SESSION_ALARM_NAME = 'signing-session-timeout';

// Earlier versions kept the unlocked phrase in session storage, wrapped with a
// key derived from this id; both are removed on the next unlock
const LEGACY_INSTALLATION_ID_KEY = 'installation_id';
const LEGACY_SESSION_KEY = 'signingSession';

/**
 * The unlocked phrase is held only in this service worker's memory, never in
 * any storage area. When the browser stops the worker (Chrome does so after
 * about 30 seconds without events) the session ends and the owner unlocks again.
 */
export class SigningSession {
  private decryptedMnemonic: SecureString | null = null;
  private currentAccountId: string | null = null;
  private expiresAt = 0;
  /**
   * Authenticate with password to start a signing session
   */
  async authenticate(accountId: string, password: string): Promise<boolean> {
    let mnemonic: string;
    try {
      mnemonic = await unlockSecret(accountId, password);
    } catch (error) {
      // Re-throw rate limit errors so the caller can surface the message
      if (isLockedError(error)) throw error;
      console.error('Authentication failed');
      return false;
    }

    this.decryptedMnemonic = new SecureString(mnemonic);
    this.currentAccountId = accountId;

    const settings = await getSettings();
    this.expiresAt = Date.now() + settings.authTimeoutMinutes * 60 * 1000;
    await storage.session.remove(LEGACY_SESSION_KEY);
    await storage.local.remove(LEGACY_INSTALLATION_ID_KEY);

    // Set alarm for auto-clear
    alarms.create(SESSION_ALARM_NAME, {
      delayInMinutes: settings.authTimeoutMinutes
    });
    return true;
  }

  /**
   * Check an account's password without starting a signing session. Wrong
   * passwords count towards the same lockout as authenticate().
   */
  async verifyPassword(accountId: string, password: string): Promise<boolean> {
    try {
      new SecureString(await unlockSecret(accountId, password)).wipe();
    } catch (error) {
      if (isLockedError(error)) throw error;
      return false;
    }
    return true;
  }

  /**
   * Whether the phrase is in memory and the session has not run out. The alarm
   * also ends the session, but alarms fire late, so every use checks the time.
   */
  private live(): boolean {
    if (!this.decryptedMnemonic || !this.currentAccountId) return false;
    if (Date.now() >= this.expiresAt) {
      void this.clearSession();
      return false;
    }
    return true;
  }

  /**
   * Check if there's an active signing session for an account
   */
  async isAuthenticated(accountId?: string): Promise<boolean> {
    if (!this.live()) return false;
    return !accountId || accountId === this.currentAccountId;
  }

  /**
   * Get remaining session time in seconds
   */
  async getSessionTimeRemaining(): Promise<number> {
    if (!this.live()) return 0;
    return Math.floor((this.expiresAt - Date.now()) / 1000);
  }

  /**
   * Sign a message with the authenticated account
   */
  async signMessage(
    message: string,
    addressIndex: number,
    network: NetworkType,
    accountId: string
  ): Promise<string> {
    if (!this.live()) {
      throw new Error('Not authenticated - please enter password');
    }
    // Only the account the session was opened for signs: a request for one
    // account must never be signed with another's key
    if (accountId !== this.currentAccountId) {
      throw new Error('Not authenticated for this account - please enter password');
    }

    const seed = await Mnemonic.toSeed(this.decryptedMnemonic!.toString());
    const coinType = NETWORKS[network].coinType;
    const path = `m/44'/${coinType}'/0'/0/${addressIndex}`;

    let hdkey: HDKey | undefined;
    let derived: HDKey | undefined;
    try {
      hdkey = await HDKey.fromMasterSeed(seed);
      derived = await hdkey.derive(path);

      if (!derived.privateKey || !derived.publicKey) {
        throw new Error('Failed to derive keys for signing');
      }
      return await Signer.signMessage(message, derived.privateKey, derived.publicKey);
    } finally {
      secureWipe(seed);
      derived?.wipe();
      hdkey?.wipe();
    }
  }

  /**
   * Get the current account's seed (for address derivation during signing)
   */
  async getSeed(): Promise<Uint8Array | null> {
    if (!this.live()) return null;
    return Mnemonic.toSeed(this.decryptedMnemonic!.toString());
  }

  /**
   * Clear the signing session (manual lock)
   */
  async clearSession(): Promise<void> {
    // Clear memory first - wipe sensitive data - so nothing can use it while
    // the awaits below run
    if (this.decryptedMnemonic) {
      this.decryptedMnemonic.wipe();
    }
    this.decryptedMnemonic = null;
    this.currentAccountId = null;
    this.expiresAt = 0;
    await alarms.clear(SESSION_ALARM_NAME);
  }

  /**
   * Handle alarm timeout
   */
  async handleAlarmTimeout(): Promise<void> {
    await this.clearSession();
  }
}

// Singleton instance
export const signingSession = new SigningSession();
