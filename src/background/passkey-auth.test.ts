import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, TEST_MNEMONIC, TEST_PASSWORD, type Harness } from '../test-support/harness';
import { b64url } from '../shared/crypto-utils';
import { Mnemonic } from '../lib/mnemonic';
import { deriveAddresses } from '../lib/derivation';

vi.setConfig({ testTimeout: 60000 });

function randomB64Url(len = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(len)));
}

async function foreignTestnetAddress(): Promise<string> {
  const seed = await Mnemonic.toSeed(TEST_MNEMONIC, 'recipient-wallet');
  const [a] = await deriveAddresses(seed, 'testnet', 0, 1);
  return a.address;
}

let h: Harness;
let account: any;
let accountId: string;

beforeEach(async () => {
  vi.resetModules();
  h = await createHarness();
  account = await h.setupWallet();
  accountId = account.id;
});

async function enrolTestPasskey(label = 'Touch ID') {
  const credId = randomB64Url(24);
  const prfSalt = randomB64Url(32);
  const prfOutput = randomB64Url(32);

  const started = await h.popup('START_PASSKEY_ENROL', {
    accountId,
    password: TEST_PASSWORD,
    label,
  });
  expect(started.success).toBe(true);
  expect(started.data.token).toBeTruthy();

  const info = await h.popup('GET_PASSKEY_ENROL_INFO', { token: started.data.token });
  expect(info.success).toBe(true);
  expect(info.data.accountId).toBe(accountId);
  expect(info.data.label).toBe(label);

  const finished = await h.popup('FINISH_PASSKEY_ENROL', {
    token: started.data.token,
    credentialId: credId,
    prfSalt,
    prfOutput,
    label,
  });
  expect(finished.success).toBe(true);

  return {
    slotId: finished.data.slot.id as string,
    credentialId: credId,
    prfSalt,
    prfOutput,
    passkeyAuth: { credentialId: credId, prfOutput },
  };
}

describe('Background Passkey Enrolment, Unlock, Rate-Limit & Action Auth', () => {
  it('enforces password verification and single-use enrolment tokens', async () => {
    const badPw = await h.popup('START_PASSKEY_ENROL', {
      accountId,
      password: 'wrong-password',
      label: 'Bad',
    });
    expect(badPw.success).toBe(false);
    expect(badPw.error).toMatch(/invalid password/i);

    const pk = await enrolTestPasskey('Hardware Key');

    // Replaying the consumed enrolment token is rejected
    const started2 = await h.popup('START_PASSKEY_ENROL', {
      accountId,
      password: TEST_PASSWORD,
      label: 'Second',
    });
    const finishOnce = await h.popup('FINISH_PASSKEY_ENROL', {
      token: started2.data.token,
      credentialId: randomB64Url(24),
      prfSalt: randomB64Url(32),
      prfOutput: randomB64Url(32),
    });
    expect(finishOnce.success).toBe(true);

    const replay = await h.popup('FINISH_PASSKEY_ENROL', {
      token: started2.data.token,
      credentialId: randomB64Url(24),
      prfSalt: randomB64Url(32),
      prfOutput: randomB64Url(32),
    });
    expect(replay.success).toBe(false);
    expect(replay.error).toMatch(/expired/i);

    // Cancelling an enrolment token invalidates it immediately
    const started3 = await h.popup('START_PASSKEY_ENROL', {
      accountId,
      password: TEST_PASSWORD,
    });
    await h.popup('CANCEL_PASSKEY_ENROL', { token: started3.data.token });
    const afterCancel = await h.popup('GET_PASSKEY_ENROL_INFO', { token: started3.data.token });
    expect(afterCancel.success).toBe(false);

    const slots = await h.popup('GET_PASSKEY_SLOTS', { accountId });
    expect(slots.success).toBe(true);
    expect(slots.data.slots).toHaveLength(2);
    expect(slots.data.slots[0].credentialId).toBe(pk.credentialId);
  });

  it('locks the wallet via LOCK_WALLET and unlocks via UNLOCK_WALLET_PASSKEY', async () => {
    const pk = await enrolTestPasskey();

    const lockRes = await h.popup('LOCK_WALLET');
    expect(lockRes.success).toBe(true);
    expect(await h.isAuthenticated(accountId)).toBe(false);

    const statusLocked = await h.popup('GET_SESSION_STATUS', { accountId });
    expect(statusLocked.data).toMatchObject({
      uiLocked: true,
      authenticated: false,
      hasPasskeys: true,
      passkeyCount: 1,
    });

    const unlockRes = await h.popup('UNLOCK_WALLET_PASSKEY', {
      accountId,
      passkeyAuth: pk.passkeyAuth,
    });
    expect(unlockRes.success).toBe(true);
    expect(await h.isAuthenticated(accountId)).toBe(true);

    const statusUnlocked = await h.popup('GET_SESSION_STATUS', { accountId });
    expect(statusUnlocked.data).toMatchObject({
      uiLocked: false,
      authenticated: true,
      hasPasskeys: true,
    });
  });

  it('shares unlock-limit.ts lockout state across wrong passwords and bad PRF outputs', async () => {
    const pk = await enrolTestPasskey();
    const wrongPrf = randomB64Url(32);

    // 3 wrong passwords + 2 bad passkey PRF outputs = 5 failed attempts -> lockout
    for (let i = 0; i < 3; i++) {
      const r = await h.popup('AUTHENTICATE', { accountId, password: 'bad-password' });
      expect(r.success).toBe(false);
    }
    for (let i = 0; i < 2; i++) {
      const r = await h.popup('UNLOCK_WALLET_PASSKEY', {
        accountId,
        passkeyAuth: { credentialId: pk.credentialId, prfOutput: wrongPrf },
      });
      expect(r.success).toBe(false);
    }

    // Both valid password and valid passkey are refused while locked out
    const blockedPasskey = await h.popup('UNLOCK_WALLET_PASSKEY', {
      accountId,
      passkeyAuth: pk.passkeyAuth,
    });
    expect(blockedPasskey.success).toBe(false);
    expect(blockedPasskey.error).toMatch(/Account locked/);

    const blockedPassword = await h.popup('AUTHENTICATE', {
      accountId,
      password: TEST_PASSWORD,
    });
    expect(blockedPassword.success).toBe(false);
    expect(blockedPassword.error).toMatch(/Account locked/);
  });

  it('authorizes popup sign, send, staged passkey send, loose settings, address gen, export, dApp approval, and removal with passkeyAuth', async () => {
    const pk = await enrolTestPasskey('Primary Key');
    h.fund(account.addresses[0].address, 500_00000000);
    h.fund(account.addresses[0].address, 500_00000000);
    const recipient = await foreignTestnetAddress();

    // 1. SIGN_MESSAGE with passkeyAuth
    const sig = await h.popup('SIGN_MESSAGE', {
      accountId,
      passkeyAuth: pk.passkeyAuth,
      message: 'Passkey signed message',
      addressIndex: 0,
    });
    expect(sig.success).toBe(true);
    expect(sig.data.signature).toBeTruthy();

    // 2. Direct SEND_TRANSACTION with passkeyAuth
    const send1 = await h.popup('SEND_TRANSACTION', {
      passkeyAuth: pk.passkeyAuth,
      to: recipient,
      amount: '10',
      fee: 0.0001,
    });
    expect(send1.success).toBe(true);
    expect(send1.data.txid).toBeTruthy();
    expect(h.broadcasts).toHaveLength(1);

    // 3. Staged passkey send (toolbar popup blur-safe flow)
    const staged = await h.popup('STAGE_PASSKEY_SEND', {
      accountId,
      to: recipient,
      amount: '5',
      fee: 0.0001,
    });
    expect(staged.success).toBe(true);
    const stagedInfo = await h.popup('GET_STAGED_PASSKEY_SEND', { token: staged.data.token });
    expect(stagedInfo.success).toBe(true);
    expect(stagedInfo.data.summary.amount).toBe('5');

    const sentStaged = await h.popup('EXECUTE_STAGED_PASSKEY_SEND', {
      token: staged.data.token,
      passkeyAuth: pk.passkeyAuth,
    });
    expect(sentStaged.success).toBe(true);
    expect(h.broadcasts).toHaveLength(2);

    // 4. Loosening settings (disabling spending limits) with passkeyAuth
    const loose = await h.popup('UPDATE_SETTINGS', {
      passkeyAuth: pk.passkeyAuth,
      transactionLimits: {
        enabled: false,
        maxAmountPercent: 0,
        maxAmountAbsolute: 0,
        dailyLimitPercent: 0,
        dailyLimitAbsolute: 0,
      },
    });
    expect(loose.success).toBe(true);
    expect(loose.data.transactionLimits.enabled).toBe(false);

    // 5. GENERATE_NEW_ADDRESS & EXPORT_MNEMONIC with passkeyAuth
    const genAddr = await h.popup('GENERATE_NEW_ADDRESS', {
      accountId,
      passkeyAuth: pk.passkeyAuth,
    });
    expect(genAddr.success).toBe(true);
    expect(genAddr.data.address.index).toBe(1);

    const exported = await h.popup('EXPORT_MNEMONIC', {
      accountId,
      passkeyAuth: pk.passkeyAuth,
    });
    expect(exported.success).toBe(true);
    expect(exported.data.mnemonic).toBe(TEST_MNEMONIC);

    // 6. dApp signing request approved with passkeyAuth
    await h.connectPage();
    const dappSign = h.fromTab('SIGN_MESSAGE', { message: 'dApp challenge' });
    const req = await h.waitForPending('sign_message');
    const pending = await h.approvalWindow('GET_PENDING_SIGNING_REQUESTS');
    expect(pending.data.requests.find((r: any) => r.id === req.id).hasPasskeys).toBe(true);

    const approved = await h.approvalWindow('APPROVE_SIGNING_REQUEST', {
      requestId: req.id,
      passkeyAuth: pk.passkeyAuth,
    });
    expect(approved.success).toBe(true);
    expect((await dappSign).success).toBe(true);

    // 7. Remove passkey slot -> password still unlocks
    const removed = await h.popup('REMOVE_PASSKEY_SLOT', {
      accountId,
      slotId: pk.slotId,
      passkeyAuth: pk.passkeyAuth,
    });
    expect(removed.success).toBe(true);
    expect(removed.data.slots).toHaveLength(0);
    expect((await h.popup('AUTHENTICATE', { accountId, password: TEST_PASSWORD })).success).toBe(true);
  });

  it('verifies records-seal integrity and recovers tampered settings on passkey unlock', async () => {
    const pk = await enrolTestPasskey();

    // Simulate external local-storage tampering while worker is stopped
    delete h.storage.records_seal;
    h.storage.settings = {
      ...h.storage.settings,
      authTimeoutMinutes: 60,
      securityPhrase: 'planted-by-attacker',
    };
    for (const k of Object.keys(h.sessionStorage)) delete h.sessionStorage[k];
    await h.restartWorker();

    const unlock = await h.popup('UNLOCK_WALLET_PASSKEY', {
      accountId,
      passkeyAuth: pk.passkeyAuth,
    });
    expect(unlock.success).toBe(true);

    const settings = (await h.popup('GET_SETTINGS')).data.settings;
    expect(settings.securityPhrase).not.toBe('planted-by-attacker');
    const warning = await h.popup('GET_RECORDS_WARNING');
    expect(warning.data.warning).toBeTruthy();
  });

  it('rejects every passkey and lock message from content scripts / web pages', async () => {
    const pk = await enrolTestPasskey();
    await h.connectPage();

    const popupOnlyTypes = [
      'GET_PASSKEY_SLOTS',
      'START_PASSKEY_ENROL',
      'GET_PASSKEY_ENROL_INFO',
      'FINISH_PASSKEY_ENROL',
      'CANCEL_PASSKEY_ENROL',
      'REMOVE_PASSKEY_SLOT',
      'UNLOCK_WALLET_PASSKEY',
      'LOCK_WALLET',
      'GET_SESSION_STATUS',
      'STAGE_PASSKEY_SEND',
      'GET_STAGED_PASSKEY_SEND',
      'EXECUTE_STAGED_PASSKEY_SEND',
      'PASSKEY_CEREMONY_DONE',
    ];

    for (const type of popupOnlyTypes) {
      const res = await h.fromTab(type, { accountId, passkeyAuth: pk.passkeyAuth });
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/Unauthorized sender/);
    }

    // A dApp passing passkeyAuth to SEND_TRANSACTION is refused with 4200 UNSUPPORTED
    const dappSendWithPasskey = await h.fromTab('SEND_TRANSACTION', {
      to: account.addresses[0].address,
      amount: '1',
      passkeyAuth: pk.passkeyAuth,
    });
    expect(dappSendWithPasskey.success).toBe(false);
    expect(dappSendWithPasskey.error).toMatch(/Unsupported option: passkeyAuth/);
  });
});
