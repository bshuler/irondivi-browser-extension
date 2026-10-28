/**
 * Why the wallet refused a site's payment request, for the owner only.
 *
 * A site that asks for a payment the wallet cannot make is told just that
 * (EXT-5): the balance, the limits and the coins are not the site's to know.
 * The owner is told the real reason in the popup banner, so a payment that
 * fails on a site is not a mystery. Kept in session storage, which content
 * scripts cannot read, and gone when the browser closes.
 */
import { storage } from '../shared/browser-polyfill';

const NOTICE_KEY = 'paymentNotice';
const MAX_REASON = 300;

function siteName(origin: string): string {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
}

/** Record why a site's payment request was refused, replacing any earlier one */
export async function notePaymentRefused(origin: string, amount: unknown, reason: string): Promise<void> {
  const what = typeof amount === 'number' && Number.isFinite(amount) ? `${amount} DIVI`
    : typeof amount === 'string' && /^\d+(\.\d+)?$/.test(amount) ? `${amount} DIVI`
    : 'an amount';
  const why = reason.slice(0, MAX_REASON).trim();
  let message = `${siteName(origin)} asked this wallet to pay ${what} and was told it cannot: ${why}${/[.!?]$/.test(why) ? '' : '.'}`;
  if (/limit|% of balance/i.test(reason) && !/Settings → Spending limits/.test(reason)) {
    message += ' You can change the limits in Settings, Spending limits.';
  }
  await storage.session.set({ [NOTICE_KEY]: { message, at: Date.now() } });
}

export async function getPaymentNotice(): Promise<string | null> {
  const got = (await storage.session.get<Record<string, { message?: unknown }>>(NOTICE_KEY))[NOTICE_KEY];
  return typeof got?.message === 'string' ? got.message : null;
}

export async function dismissPaymentNotice(): Promise<void> {
  await storage.session.remove(NOTICE_KEY);
}
