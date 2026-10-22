import { getConnections, saveConnections, type Connection } from '../shared/storage';

export interface SigningRequestData {
  message?: string;
  address?: string;
  addressIndex?: number;
  to?: string;
  amount?: number;
  fee?: number;
  fromAddresses?: string[];
  opReturn?: string;
}

export interface PendingRequest {
  id: string;
  type: 'connect' | 'sign_message' | 'send_transaction';
  origin: string;
  accountId: string;
  data?: SigningRequestData;
  createdAt: number;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

const REQUEST_TIMEOUT = 5 * 60 * 1000; // 5 minutes

export class ConnectionManager {
  private pendingRequests: Map<string, PendingRequest> = new Map();
  // Approval window for each pending request, so closing it rejects the request
  private requestWindows: Map<string, number> = new Map();
  private operationLock: Promise<void> = Promise.resolve();

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
   * Update the extension badge to show pending request count
   */
  private updateBadge(): void {
    const signingRequests = Array.from(this.pendingRequests.values())
      .filter(r => r.type === 'sign_message' || r.type === 'send_transaction');
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
   * Request signature (creates pending request and opens approval window)
   */
  async requestSignature(
    origin: string,
    accountId: string,
    data: { message: string; addressIndex: number }
  ): Promise<{ requestId: string }> {
    const requestId = crypto.randomUUID();

    const request: PendingRequest = {
      id: requestId,
      type: 'sign_message',
      origin,
      accountId,
      data,
      createdAt: Date.now(),
      resolve: () => {},
      reject: () => {},
    };

    this.pendingRequests.set(requestId, request);
    this.updateBadge();

    // Set timeout
    setTimeout(() => {
      if (this.pendingRequests.has(requestId)) {
        this.pendingRequests.delete(requestId);
        this.updateBadge();
      }
    }, REQUEST_TIMEOUT);

    // Open approval window
    await this.openApprovalWindow(requestId, 'sign');

    return { requestId };
  }

  /**
   * Approve a connection request
   */
  async approveConnection(
    requestId: string,
    permissions: string[] = ['sign_message', 'send_transaction']
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
    type: 'sign_message' | 'send_transaction',
    origin: string,
    accountId: string,
    data: SigningRequestData
  ): Promise<unknown> {
    // Verify site is connected and has permission
    const hasPermission = await this.hasPermission(origin, accountId, type);
    if (!hasPermission) {
      throw new Error(`Site does not have ${type} permission`);
    }

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

    const requestId = crypto.randomUUID();

    return new Promise((resolve, reject) => {
      const request: PendingRequest = {
        id: requestId,
        type,
        origin,
        accountId,
        data,
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
    type: 'sign_message' | 'send_transaction';
    origin: string;
    accountId: string;
    data: SigningRequestData | undefined;
    createdAt: number;
  }> {
    return Array.from(this.pendingRequests.values())
      .filter(r => r.type === 'sign_message' || r.type === 'send_transaction')
      .map(r => ({
        id: r.id,
        type: r.type as 'sign_message' | 'send_transaction',
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
  rejectRequest(requestId: string): void {
    const request = this.pendingRequests.get(requestId);
    if (!request) {
      throw new Error('Request not found');
    }
    request.reject(new Error('Request rejected by user'));
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
