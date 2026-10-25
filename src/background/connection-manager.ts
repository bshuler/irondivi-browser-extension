import { getConnections, saveConnections, type Connection } from '../shared/storage';
import type { NetworkType } from '../shared/constants';
import type { GameTxSummary, SessionGrant } from '../lib/game-tx';

export interface SigningRequestData {
  message?: string;
  address?: string;
  addressIndex?: number;
  to?: string;
  amount?: number;
  fee?: number;
  fromAddresses?: string[];
  opReturn?: string;
  // The network the request was made on; approval is refused on another
  network?: NetworkType;
  // A Divi Games transaction, as the background parsed it, for the window
  gameTx?: GameTxSummary;
  // A Divi Games session grant, when the message is one
  session?: SessionGrant;
}

export type SigningRequestType = 'sign_message' | 'sign_game_tx' | 'send_transaction';
const SIGNING_TYPES: readonly string[] = ['sign_message', 'sign_game_tx', 'send_transaction'];

export interface PendingRequest {
  id: string;
  type: 'connect' | SigningRequestType;
  origin: string;
  accountId: string;
  data?: SigningRequestData;
  createdAt: number;
  // The site has not had a request of this type approved before
  firstUse?: boolean;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

const REQUEST_TIMEOUT = 5 * 60 * 1000; // 5 minutes

// A site may open at most this many approval windows a minute, so it cannot
// bury the user in windows until one is approved to make them stop
const MAX_REQUESTS_PER_MINUTE = 5;

// All a connection grants. Signing and sending are granted by the first
// approval of each, which needs the password
export const CONNECT_PERMISSIONS = ['view_address'];

export class ConnectionManager {
  private pendingRequests: Map<string, PendingRequest> = new Map();
  // Approval window for each pending request, so closing it rejects the request
  private requestWindows: Map<string, number> = new Map();
  private operationLock: Promise<void> = Promise.resolve();
  // When each site last opened approval windows, for the rate limit
  private requestTimes: Map<string, number[]> = new Map();

  constructor() {
    // Closing an approval window without answering is a rejection
    chrome.windows?.onRemoved?.addListener((windowId: number) => {
      for (const [requestId, id] of this.requestWindows) {
        if (id !== windowId) continue;
        this.requestWindows.delete(requestId);
        this.pendingRequests.get(requestId)?.reject(new Error('Request rejected: approval window closed'));
      }
    });
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const previousLock = this.operationLock;
    let releaseLock!: () => void;
    this.operationLock = new Promise(resolve => { releaseLock = resolve; });

    try {
      await previousLock;
      return await fn();
    } finally {
      releaseLock();
    }
  }

  /**
   * Refuse a new request while the site already has one waiting, or when it
   * has opened too many approval windows in the last minute
   */
  private admit(origin: string): void {
    for (const r of this.pendingRequests.values()) {
      if (r.origin === origin) {
        throw new Error('This site already has a request waiting for your approval');
      }
    }
    const now = Date.now();
    const recent = (this.requestTimes.get(origin) ?? []).filter(t => now - t < 60_000);
    if (recent.length >= MAX_REQUESTS_PER_MINUTE) {
      this.requestTimes.set(origin, recent);
      throw new Error('Too many requests from this site. Try again in a minute.');
    }
    recent.push(now);
    this.requestTimes.set(origin, recent);
  }

  /**
   * Update the extension badge to show pending request count
   */
  private updateBadge(): void {
    const signingRequests = Array.from(this.pendingRequests.values())
      .filter(r => SIGNING_TYPES.includes(r.type));
    const count = signingRequests.length;

    if (count > 0) {
      chrome.action.setBadgeText({ text: String(count) });
      chrome.action.setBadgeBackgroundColor({ color: '#7c3aed' });
    } else {
      chrome.action.setBadgeText({ text: '' });
    }
  }

  /**
   * Open a popup window for approval
   */
  private async openApprovalWindow(requestId: string, type: 'connect' | 'sign'): Promise<void> {
    const width = 400;
    const height = 600;

    // Service workers don't have access to screen object
    // Use chrome.windows.getAll to find a reference window, or use defaults
    let left = 100;
    let top = 100;

    try {
      const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
      if (windows.length > 0) {
        const refWindow = windows[0];
        // Center relative to the first window
        left = Math.round((refWindow.left || 0) + ((refWindow.width || 800) - width) / 2);
        top = Math.round((refWindow.top || 0) + ((refWindow.height || 600) - height) / 2);
      }
    } catch {
      // Use default position if we can't get window info
    }

    const popupUrl = `popup.html?approve=${type}&requestId=${requestId}`;

    try {
      const win = await chrome.windows.create({
        url: popupUrl,
        type: 'popup',
        width,
        height,
        left,
        top,
        focused: true,
      });
      if (win?.id !== undefined && this.pendingRequests.has(requestId)) {
        this.requestWindows.set(requestId, win.id);
      }
    } catch {
      // Popup creation failed - request will timeout
    }
  }

  /**
   * Check if a site is connected to an account
   */
  async isConnected(origin: string, accountId: string): Promise<boolean> {
    const connections = await getConnections();
    const accountConnections = connections[accountId] || {};
    const connection = accountConnections[origin];
    return connection?.connected === true;
  }

  /**
   * Get connection details for a site
   */
  async getConnection(origin: string, accountId: string): Promise<Connection | null> {
    const connections = await getConnections();
    const accountConnections = connections[accountId] || {};
    return accountConnections[origin] || null;
  }

  /**
   * Request a connection (creates pending request and opens approval window)
   * Returns a Promise that resolves when the user approves/rejects
   * Deduplicates requests - if there's already a pending request for the same origin, reuse it
   */
  async requestConnection(
    origin: string,
    accountId: string
  ): Promise<{ connected: boolean }> {
    // Check for existing pending connection request for this origin
    const existingRequest = Array.from(this.pendingRequests.values()).find(
      r => r.type === 'connect' && r.origin === origin && r.accountId === accountId
    );

    if (existingRequest) {
      // Return a promise that resolves when the existing request resolves
      return new Promise((resolve, reject) => {
        const originalResolve = existingRequest.resolve;
        const originalReject = existingRequest.reject;

        existingRequest.resolve = (value) => {
          originalResolve(value);
          resolve(value as { connected: boolean });
        };
        existingRequest.reject = (error) => {
          originalReject(error);
          reject(error);
        };
      });
    }

    this.admit(origin);
    const requestId = crypto.randomUUID();

    return new Promise((resolve, reject) => {
      const request: PendingRequest = {
        id: requestId,
        type: 'connect',
        origin,
        accountId,
        createdAt: Date.now(),
        resolve: (value) => {
          this.pendingRequests.delete(requestId);
          this.updateBadge();
          resolve(value as { connected: boolean });
        },
        reject: (error) => {
          this.pendingRequests.delete(requestId);
          this.updateBadge();
          reject(error);
        },
      };

      this.pendingRequests.set(requestId, request);
      this.updateBadge();

      // Set timeout
      setTimeout(() => {
        if (this.pendingRequests.has(requestId)) {
          this.pendingRequests.delete(requestId);
          this.updateBadge();
          reject(new Error('Connection request timed out'));
        }
      }, REQUEST_TIMEOUT);

      // Open approval window
      this.openApprovalWindow(requestId, 'connect');
    });
  }

  /**
   * Approve a connection request
   */
  async approveConnection(
    requestId: string,
    permissions: string[] = CONNECT_PERMISSIONS
  ): Promise<void> {
    return this.withLock(async () => {
      const request = this.pendingRequests.get(requestId);
      if (!request || request.type !== 'connect') {
        throw new Error('Connection request not found');
      }

      const connections = await getConnections();
      if (!connections[request.accountId]) {
        connections[request.accountId] = {};
      }

      connections[request.accountId][request.origin] = {
        connected: true,
        connectedAt: Date.now(),
        permissions,
      };

      await saveConnections(connections);

      // Clean up the pending request
      this.pendingRequests.delete(requestId);
      this.updateBadge();

      request.resolve({ connected: true });
    });
  }

  /**
   * Reject a connection request
   */
  async rejectConnection(requestId: string): Promise<void> {
    return this.withLock(async () => {
      const request = this.pendingRequests.get(requestId);
      if (!request) {
        throw new Error('Connection request not found');
      }

      // Clean up the pending request
      this.pendingRequests.delete(requestId);
      this.updateBadge();

      request.reject(new Error('Connection rejected by user'));
    });
  }

  /**
   * Record that the owner approved a request of this type from the site
   */
  async grantPermission(origin: string, accountId: string, permission: string): Promise<void> {
    return this.withLock(async () => {
      const connections = await getConnections();
      const connection = connections[accountId]?.[origin];
      if (!connection?.connected || connection.permissions.includes(permission)) return;
      connection.permissions = [...connection.permissions, permission];
      await saveConnections(connections);
    });
  }

  /**
   * Revoke a site's connection
   */
  async revokeConnection(origin: string, accountId: string): Promise<void> {
    return this.withLock(async () => {
      const connections = await getConnections();

      if (connections[accountId]) {
        delete connections[accountId][origin];
        await saveConnections(connections);
      }
    });
  }

  /**
   * Get all connected sites for an account
   */
  async getConnectedSites(accountId: string): Promise<Array<{ origin: string; connection: Connection }>> {
    const connections = await getConnections();
    const accountConnections = connections[accountId] || {};

    return Object.entries(accountConnections)
      .filter(([_, conn]) => conn.connected)
      .map(([origin, connection]) => ({ origin, connection }));
  }

  /**
   * Check if a site has a specific permission
   */
  async hasPermission(origin: string, accountId: string, permission: string): Promise<boolean> {
    const connection = await this.getConnection(origin, accountId);
    if (!connection || !connection.connected) return false;
    return connection.permissions.includes(permission);
  }

  /**
   * Create a signing request (message or transaction)
   * Opens approval window and returns a promise that resolves when approved
   * Deduplicates requests - if there's already a pending request with the same message, reuse it
   */
  async createSigningRequest(
    type: SigningRequestType,
    origin: string,
    accountId: string,
    data: SigningRequestData
  ): Promise<unknown> {
    // A connected site may ask; the owner's approval, with the password, is
    // what lets it sign or send
    if (!(await this.isConnected(origin, accountId))) {
      throw new Error('Site is not connected');
    }
    const firstUse = !(await this.hasPermission(origin, accountId, type));

    // Check for existing pending request with same parameters (deduplication)
    const existingRequest = Array.from(this.pendingRequests.values()).find(
      r => r.type === type &&
           r.origin === origin &&
           r.accountId === accountId &&
           JSON.stringify(r.data) === JSON.stringify(data)
    );

    if (existingRequest) {
      // Return a promise that resolves when the existing request resolves
      return new Promise((resolve, reject) => {
        const originalResolve = existingRequest.resolve;
        const originalReject = existingRequest.reject;

        existingRequest.resolve = (value) => {
          originalResolve(value);
          resolve(value);
        };
        existingRequest.reject = (error) => {
          originalReject(error);
          reject(error);
        };
      });
    }

    this.admit(origin);
    const requestId = crypto.randomUUID();

    return new Promise((resolve, reject) => {
      const request: PendingRequest = {
        id: requestId,
        type,
        origin,
        accountId,
        data,
        firstUse,
        createdAt: Date.now(),
        resolve: (value) => {
          this.pendingRequests.delete(requestId);
          this.updateBadge();
          resolve(value);
        },
        reject: (error) => {
          this.pendingRequests.delete(requestId);
          this.updateBadge();
          reject(error);
        },
      };

      this.pendingRequests.set(requestId, request);
      this.updateBadge();

      // Set timeout
      setTimeout(() => {
        if (this.pendingRequests.has(requestId)) {
          this.pendingRequests.delete(requestId);
          this.updateBadge();
          reject(new Error('Request timed out'));
        }
      }, REQUEST_TIMEOUT);

      // Open approval window
      this.openApprovalWindow(requestId, 'sign');
    });
  }

  /**
   * Get pending signing requests (for popup UI)
   */
  getPendingSigningRequests(): Array<{
    id: string;
    type: SigningRequestType;
    origin: string;
    accountId: string;
    data: SigningRequestData | undefined;
    createdAt: number;
  }> {
    return Array.from(this.pendingRequests.values())
      .filter(r => SIGNING_TYPES.includes(r.type))
      .map(r => ({
        id: r.id,
        type: r.type as SigningRequestType,
        origin: r.origin,
        accountId: r.accountId,
        data: r.data,
        createdAt: r.createdAt,
      }));
  }

  /**
   * Get a pending request by ID
   */
  getPendingRequest(requestId: string): PendingRequest | undefined {
    return this.pendingRequests.get(requestId);
  }

  /**
   * Get all pending requests
   */
  getAllPendingRequests(): PendingRequest[] {
    return Array.from(this.pendingRequests.values());
  }

  /**
   * Approve a signing request
   */
  approveRequest(requestId: string, result: unknown): void {
    const request = this.pendingRequests.get(requestId);
    if (!request) {
      throw new Error('Request not found');
    }
    request.resolve(result);
    this.updateBadge();
  }

  /**
   * Reject a signing request
   */
  rejectRequest(requestId: string, reason = 'Request rejected by user'): void {
    const request = this.pendingRequests.get(requestId);
    if (!request) {
      throw new Error('Request not found');
    }
    request.reject(new Error(reason));
    this.updateBadge();
  }

  /**
   * Clear all pending requests (called on lock)
   */
  clearAllRequests(): void {
    for (const request of this.pendingRequests.values()) {
      request.reject(new Error('Wallet locked'));
    }
    this.pendingRequests.clear();
    this.updateBadge();
  }
}

// Singleton instance
export const connectionManager = new ConnectionManager();
