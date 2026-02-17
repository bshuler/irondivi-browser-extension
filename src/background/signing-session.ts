import {
  generateSessionKey,
  encryptWithKey,
  decryptWithKey,
  wrapSessionKey,
  unwrapSessionKey,
  SecureString,
} from '../shared/crypto-utils';
import { storage, alarms } from '../shared/browser-polyfill';
import { getDecryptedSecret, getSettings } from '../shared/storage';
import { Mnemonic } from '../lib/mnemonic';
import { HDKey } from '../lib/hdkey';
import { Signer } from '../lib/signer';
import type { NetworkType } from '../shared/constants';

const SESSION_ALARM_NAME = 'signing-session-timeout';

interface SigningSessionData {
  accountId: string;
  encrypted: string;
  iv: string;
  expiresAt: number;
  wrappedKey?: string;
}

interface RateLimitEntry {
  count: number;
  lockedUntil: number;
}

interface RateLimitState {
  [accountId: string]: RateLimitEntry;
}

const INSTALLATION_ID_KEY = 'installation_id';
const RATE_LIMIT_STATE_KEY = 'rate_limit_state';

export class SigningSession {
  private sessionKey: CryptoKey | null = null;
  private decryptedMnemonic: SecureString | null = null;
  private currentAccountId: string | null = null;
  private failedAttempts: Map<string, RateLimitEntry> = new Map();
  private readonly MAX_ATTEMPTS = 5;
  private readonly LOCKOUT_MS = 5 * 60 * 1000; // 5 minutes
  private installationId: string | null = null;
  private rateLimitInitialized = false;

  /**
   * Returns a stable, random identifier unique to this extension installation.
   * Generated on first use and stored in storage.local.
   * Used as the basis for the session key wrapping key.
   */
  private async getInstallationId(): Promise<string> {
    if (this.installationId) {
      return this.installationId;
    }

    const result = await storage.local.get<{ [INSTALLATION_ID_KEY]: string }>(INSTALLATION_ID_KEY);
    if (result[INSTALLATION_ID_KEY]) {
      this.installationId = result[INSTALLATION_ID_KEY];
      return this.installationId;
    }

    // Generate a new random 32-byte installation ID
    const randomBytes = crypto.getRandomValues(new Uint8Array(32));
    this.installationId = btoa(String.fromCharCode(...randomBytes));
    await storage.local.set({ [INSTALLATION_ID_KEY]: this.installationId });
    return this.installationId;
  }

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

    // Reset if lockout expired
    if (state.count >= this.MAX_ATTEMPTS) {
      this.failedAttempts.delete(accountId);
      await this.saveRateLimitState();
    }
  }

  private async recordFailedAttempt(accountId: string): Promise<void> {
    await this.loadRateLimitState();

    const state = this.failedAttempts.get(accountId) || { count: 0, lockedUntil: 0 };
    state.count++;

    if (state.count >= this.MAX_ATTEMPTS) {
      state.lockedUntil = Date.now() + this.LOCKOUT_MS;
    }

    this.failedAttempts.set(accountId, state);
    await this.saveRateLimitState();
  }

  private async clearFailedAttempts(accountId: string): Promise<void> {
    this.failedAttempts.delete(accountId);
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

      // Generate ephemeral session key
      this.sessionKey = await generateSessionKey();

      // Get timeout setting
      const settings = await getSettings();
      const timeoutMs = settings.authTimeoutMinutes * 60 * 1000;
      const expiresAt = Date.now() + timeoutMs;

      // Encrypt mnemonic with session key for persistence
      const encrypted = await encryptWithKey(mnemonic, this.sessionKey);

      // Wrap the session key so it can survive service worker restarts
      const installationId = await this.getInstallationId();
      const wrappedKey = await wrapSessionKey(
        this.sessionKey,
        installationId
      );

      // Store in session storage
      const sessionData: SigningSessionData = {
        accountId,
        encrypted: encrypted.encrypted,
        iv: encrypted.iv,
        expiresAt,
        wrappedKey,
      };
      await storage.session.set({ signingSession: sessionData });

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
   * Check if there's an active signing session for an account
   */
  async isAuthenticated(accountId?: string): Promise<boolean> {
    // Check in-memory state first
    if (this.decryptedMnemonic && this.currentAccountId) {
      if (!accountId || accountId === this.currentAccountId) {
        return true;
      }
    }

    // Try to restore from session storage
    const restored = await this.restoreSession();
    if (!restored) return false;

    if (accountId && accountId !== this.currentAccountId) {
      return false;
    }

    return true;
  }

  /**
   * Get remaining session time in seconds
   */
  async getSessionTimeRemaining(): Promise<number> {
    const { signingSession } = await storage.session.get<{ signingSession: SigningSessionData }>('signingSession');
    if (!signingSession) return 0;

    const remaining = Math.max(0, signingSession.expiresAt - Date.now());
    return Math.floor(remaining / 1000);
  }

  /**
   * Sign a message with the authenticated account
   */
  async signMessage(
    message: string,
    addressIndex: number,
    network: NetworkType
  ): Promise<string> {
    if (!this.decryptedMnemonic || !this.currentAccountId) {
      // Try to restore session
      const restored = await this.restoreSession();
      if (!restored) {
        throw new Error('Not authenticated - please enter password');
      }
    }

    const seed = await Mnemonic.toSeed(this.decryptedMnemonic!.toString());
    const coinType = network === 'mainnet' ? 301 : 1;
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
    if (!this.decryptedMnemonic) {
      const restored = await this.restoreSession();
      if (!restored) return null;
    }
    return Mnemonic.toSeed(this.decryptedMnemonic!.toString());
  }

  /**
   * Clear the signing session (manual lock)
   */
  async clearSession(): Promise<void> {
    await storage.session.remove('signingSession');
    await alarms.clear(SESSION_ALARM_NAME);

    // Clear memory - wipe sensitive data first
    if (this.decryptedMnemonic) {
      this.decryptedMnemonic.wipe();
    }
    this.sessionKey = null;
    this.decryptedMnemonic = null;
    this.currentAccountId = null;
  }

  /**
   * Handle alarm timeout
   */
  async handleAlarmTimeout(): Promise<void> {
    await this.clearSession();
  }

  /**
   * Try to restore session from storage (called on service worker wake)
   */
  private async restoreSession(): Promise<boolean> {
    const { signingSession } = await storage.session.get<{ signingSession: SigningSessionData }>('signingSession');

    if (!signingSession) {
      return false;
    }

    // Check expiry
    if (Date.now() > signingSession.expiresAt) {
      await this.clearSession();
      return false;
    }

    // If session key was lost (service worker restart), try to restore it
    // from the wrapped key stored alongside the session data
    if (!this.sessionKey) {
      if (!signingSession.wrappedKey) {
        // No wrapped key available (legacy session) - cannot restore
        await this.clearSession();
        return false;
      }
      try {
        const installationId = await this.getInstallationId();
        this.sessionKey = await unwrapSessionKey(
          signingSession.wrappedKey,
          installationId
        );
      } catch (error) {
        // Wrapped key is invalid or identifier changed - clear and re-auth
        await this.clearSession();
        return false;
      }
    }

    try {
      // Decrypt mnemonic with session key
      const decrypted = await decryptWithKey(
        { encrypted: signingSession.encrypted, iv: signingSession.iv },
        this.sessionKey
      );
      this.decryptedMnemonic = new SecureString(decrypted);
      this.currentAccountId = signingSession.accountId;
      return true;
    } catch (error) {
      await this.clearSession();
      return false;
    }
  }
}

// Singleton instance
export const signingSession = new SigningSession();
