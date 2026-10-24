import { SecureString } from '../shared/crypto-utils';
import { storage, alarms } from '../shared/browser-polyfill';
import { getDecryptedSecret, getSettings } from '../shared/storage';
import { Mnemonic } from '../lib/mnemonic';
import { HDKey } from '../lib/hdkey';
import { Signer } from '../lib/signer';
import { NETWORKS, type NetworkType } from '../shared/constants';

const SESSION_ALARM_NAME = 'signing-session-timeout';

interface RateLimitEntry {
  count: number;
  lockedUntil: number;
  lockoutTier: number; // Track which lockout duration tier we're on (0-3)
}

interface RateLimitState {
  [accountId: string]: RateLimitEntry;
}

// Earlier versions kept the unlocked phrase in session storage, wrapped with a
// key derived from this id; both are removed on the next unlock
const LEGACY_INSTALLATION_ID_KEY = 'installation_id';
const LEGACY_SESSION_KEY = 'signingSession';
const RATE_LIMIT_STATE_KEY = 'rate_limit_state';

/**
 * The unlocked phrase is held only in this service worker's memory, never in
 * any storage area. When the browser stops the worker (Chrome does so after
 * about 30 seconds without events) the session ends and the owner unlocks again.
 */
export class SigningSession {
  private decryptedMnemonic: SecureString | null = null;
  private currentAccountId: string | null = null;
  private expiresAt = 0;
  private failedAttempts: Map<string, RateLimitEntry> = new Map();
  private readonly MAX_ATTEMPTS = 5;
  // Exponential backoff lockout durations (5 min, 15 min, 1 hour, 24 hours)
  private readonly LOCKOUT_DURATIONS_MS = [
    5 * 60 * 1000,      // 5 minutes
    15 * 60 * 1000,     // 15 minutes
    60 * 60 * 1000,     // 1 hour
    24 * 60 * 60 * 1000 // 24 hours
  ];
  private rateLimitInitialized = false;

  /**
   * Load rate limit state from session storage
   */
  private async loadRateLimitState(): Promise<void> {
    if (this.rateLimitInitialized) return;

    try {
      const result = await storage.session.get<{ [RATE_LIMIT_STATE_KEY]: RateLimitState }>(RATE_LIMIT_STATE_KEY);
      const state = result[RATE_LIMIT_STATE_KEY];

      if (state) {
        const now = Date.now();
        // Load entries, cleaning up expired lockouts
        for (const [accountId, entry] of Object.entries(state)) {
          // Keep if still locked or has recent failures
          if (entry.lockedUntil > now || entry.count < this.MAX_ATTEMPTS) {
            this.failedAttempts.set(accountId, entry);
          }
        }
      }
    } catch {
      // Ignore errors, start with empty state
    }

    this.rateLimitInitialized = true;
  }

  /**
   * Persist rate limit state to session storage
   */
  private async saveRateLimitState(): Promise<void> {
    const state: RateLimitState = {};
    for (const [accountId, entry] of this.failedAttempts) {
      state[accountId] = entry;
    }
    await storage.session.set({ [RATE_LIMIT_STATE_KEY]: state });
  }

  private async checkRateLimit(accountId: string): Promise<void> {
    await this.loadRateLimitState();

    const state = this.failedAttempts.get(accountId);
    if (!state) return;

    if (Date.now() < state.lockedUntil) {
      const remainingSeconds = Math.ceil((state.lockedUntil - Date.now()) / 1000);
      throw new Error(`Account locked. Try again in ${remainingSeconds} seconds.`);
    }

    // Reset attempt count if lockout expired (but keep tier for escalation)
    if (state.count >= this.MAX_ATTEMPTS) {
      state.count = 0;
      this.failedAttempts.set(accountId, state);
      await this.saveRateLimitState();
    }
  }

  private async recordFailedAttempt(accountId: string): Promise<void> {
    await this.loadRateLimitState();

    const state = this.failedAttempts.get(accountId) || { count: 0, lockedUntil: 0, lockoutTier: 0 };
    state.count++;

    if (state.count >= this.MAX_ATTEMPTS) {
      // Get lockout duration based on current tier (exponential backoff)
      const lockoutDuration = this.LOCKOUT_DURATIONS_MS[
        Math.min(state.lockoutTier, this.LOCKOUT_DURATIONS_MS.length - 1)
      ];
      state.lockedUntil = Date.now() + lockoutDuration;
      // Increment tier for next lockout (caps at max tier)
      state.lockoutTier = Math.min(state.lockoutTier + 1, this.LOCKOUT_DURATIONS_MS.length - 1);
    }

    this.failedAttempts.set(accountId, state);
    await this.saveRateLimitState();
  }

  private async clearFailedAttempts(accountId: string): Promise<void> {
    // On successful auth, reset count but keep tier for 24 hours
    const state = this.failedAttempts.get(accountId);
    if (state && state.lockoutTier > 0) {
      // Keep tier active for 24 hours after successful auth to prevent abuse
      state.count = 0;
      state.lockedUntil = 0;
      this.failedAttempts.set(accountId, state);
    } else {
      this.failedAttempts.delete(accountId);
    }
    await this.saveRateLimitState();
  }

  /**
   * Authenticate with password to start a signing session
   */
  async authenticate(accountId: string, password: string): Promise<boolean> {
    try {
      await this.checkRateLimit(accountId);

      // Decrypt the account's mnemonic
      const mnemonic = await getDecryptedSecret(accountId, password);
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

      await this.clearFailedAttempts(accountId);
      return true;
    } catch (error) {
      // Re-throw rate limit errors so the caller can surface the message
      if (error instanceof Error && error.message.startsWith('Account locked')) {
        throw error;
      }
      // Password incorrect or other error
      console.error('Authentication failed');
      await this.recordFailedAttempt(accountId);
      return false;
    }
  }

  /**
   * Check an account's password without starting a signing session. Wrong
   * passwords count towards the same lockout as authenticate().
   */
  async verifyPassword(accountId: string, password: string): Promise<boolean> {
    await this.checkRateLimit(accountId);
    try {
      const mnemonic = new SecureString(await getDecryptedSecret(accountId, password));
      mnemonic.wipe();
    } catch {
      await this.recordFailedAttempt(accountId);
      return false;
    }
    await this.clearFailedAttempts(accountId);
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
    network: NetworkType
  ): Promise<string> {
    if (!this.live()) {
      throw new Error('Not authenticated - please enter password');
    }

    const seed = await Mnemonic.toSeed(this.decryptedMnemonic!.toString());
    const coinType = NETWORKS[network].coinType;
    const path = `m/44'/${coinType}'/0'/0/${addressIndex}`;

    const hdkey = await HDKey.fromMasterSeed(seed);
    const derived = await hdkey.derive(path);

    if (!derived.privateKey || !derived.publicKey) {
      throw new Error('Failed to derive keys for signing');
    }
    return Signer.signMessage(message, derived.privateKey, derived.publicKey);
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
