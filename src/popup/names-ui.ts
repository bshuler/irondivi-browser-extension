/**
 * Names: look up, register, update and delete Divi Name Service names
 * (divi-name-service SPEC.md §7). Each change is one payment the service
 * builds: the fee to the registry with the record as its memo, from the
 * account's address that pays (and so owns) the name. The owner checks and
 * signs it on the ordinary send confirm screen; once sent, the service is told.
 */

import { state } from './state';
import { chunkAddress } from './recipient-check';
import { showLoading, hideLoading, showToast, showView, hideView } from './ui-state';
import { showSendConfirm } from './send-ui';
import { buildRecord, DVNS_REGISTRY, nameFee, normalizeName, resolveName, type DvnsOp, type DvnsRecord } from '../lib/dvns';
import type { NetworkType } from '../shared/constants';

// The fee an ordinary send of this size pays; the background works out the
// real one and refuses the send if it is short
const SEND_FEE = 0.0001;

interface Looked {
  name: string;
  record: DvnsRecord | null;
}

let looked: Looked | null = null;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function show(id: string, on: boolean): void {
  $(id).classList.toggle('hidden', !on);
}

function network(): NetworkType | null {
  return (state.currentAccount?.network as NetworkType | undefined) ?? null;
}

function ownAddresses(): string[] {
  return state.currentAccount?.addresses.map(a => a.address) ?? [];
}

function fillDiviChoices(selected: string | undefined): void {
  const select = $<HTMLSelectElement>('names-divi');
  select.replaceChildren(...ownAddresses().map((address, i) => {
    const option = document.createElement('option');
    option.value = address;
    option.textContent = `Address ${i + 1}: ${address.slice(0, 8)}...${address.slice(-6)}`;
    return option;
  }));
  if (selected && ownAddresses().includes(selected)) select.value = selected;
}

function showAddress(address: string | undefined): void {
  show('names-result-address-row', address !== undefined);
  $('names-result-address').replaceChildren(...(address ? chunkAddress(address) : []).map(chunk => {
    const span = document.createElement('span');
    span.className = 'address-chunk';
    span.textContent = chunk;
    return span;
  }));
}

function resetResult(): void {
  looked = null;
  show('names-result', false);
  for (const id of ['names-register-btn', 'names-update-btn', 'names-delete-btn', 'names-divi-group', 'names-result-fee-row']) show(id, false);
}

export async function handleNameLookup(): Promise<void> {
  const net = network();
  if (!net) return;
  resetResult();
  const typed = $<HTMLInputElement>('names-input').value;
  const name = normalizeName(typed);
  if (!name) {
    showToast('A name is 3 to 32 letters, digits, - or _ (or tag@name)', 'error');
    return;
  }
  try {
    showLoading('Looking up name...');
    const resolution = await resolveName(name, net);
    $('names-result-name').textContent = name;
    if (resolution.status === 'found') {
      const record = resolution.record;
      looked = { name, record };
      const mine = ownAddresses().includes(record.owner);
      $('names-result-status').textContent = mine ? 'Registered to this wallet' : 'Registered to someone else';
      showAddress(record.divi);
      if (mine) {
        const fee = await nameFee(name, 'update', net);
        $('names-result-fee').textContent = `${fee.fee} DIVI to update or delete`;
        show('names-result-fee-row', true);
        fillDiviChoices(record.divi);
        show('names-divi-group', true);
        show('names-update-btn', true);
        show('names-delete-btn', true);
      }
    } else {
      looked = { name, record: null };
      showAddress(undefined);
      const fee = await nameFee(name, 'register', net);
      if (fee.reserved) {
        $('names-result-status').textContent = 'Reserved; it cannot be registered';
      } else if (fee.available === false) {
        $('names-result-status').textContent = 'Not available (it may be pending)';
      } else {
        $('names-result-status').textContent = 'Available';
        $('names-result-fee').textContent = `${fee.fee} DIVI`;
        show('names-result-fee-row', true);
        fillDiviChoices(ownAddresses()[0]);
        show('names-divi-group', true);
        show('names-register-btn', true);
      }
    }
    show('names-result', true);
  } catch (error: unknown) {
    showToast(error instanceof Error ? error.message : 'The name could not be looked up', 'error');
  } finally {
    hideLoading();
  }
}

/**
 * Build the record's payment and show it to sign. The payer is the address
 * that owns the name (register: the account's first address, which becomes
 * the owner); update keeps the record's other fields, which it would
 * otherwise clear (SPEC §2).
 */
export async function handleNameChange(op: DvnsOp): Promise<void> {
  const net = network();
  if (!net || !looked) return;
  const { name, record } = looked;
  const own = ownAddresses();
  const payer = op === 'register' ? own[0] : record?.owner;
  if (!payer || !own.includes(payer)) {
    showToast('This wallet does not own that name', 'error');
    return;
  }
  const divi = $<HTMLSelectElement>('names-divi').value || payer;
  try {
    showLoading('Preparing...');
    const built = await buildRecord(
      op === 'delete'
        ? { network: net, op, name, payer }
        : { network: net, op, name, payer, divi, fields: op === 'update' ? record?.fields : undefined },
    );
    // The payee is the registry this wallet knows, not one the answer names
    if (built.send.to !== DVNS_REGISTRY[net]) {
      throw new Error('The name service asked for a payment to an address that is not the name registry');
    }
    const amount = Number(built.send.amount);
    const verb = op === 'register' ? 'Register' : op === 'update' ? 'Update' : 'Delete';
    await showSendConfirm({
      to: built.send.to,
      amount,
      amountText: built.send.amount,
      fee: SEND_FEE,
      fromAddresses: [built.send.from],
      memo: built.send.memo,
      dvns: { op, name },
    }, `${verb} the name ${name}; ${built.fee} DIVI goes to the name registry. A record's exact fee is allowed past the percentage limits in Settings`);
    if (built.warnings.length) showToast(built.warnings.join('; '), 'error');
  } catch (error: unknown) {
    showToast(error instanceof Error ? error.message : 'The name service could not prepare that', 'error');
  } finally {
    hideLoading();
  }
}

export function showNamesView(): void {
  resetResult();
  showView($('view-names'));
}

export function setupNamesUIHandlers(): void {
  $('names-btn').addEventListener('click', showNamesView);
  $('names-back-btn').addEventListener('click', hideView);
  $('names-lookup-btn').addEventListener('click', handleNameLookup);
  $('names-input').addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') handleNameLookup();
  });
  $('names-register-btn').addEventListener('click', () => handleNameChange('register'));
  $('names-update-btn').addEventListener('click', () => handleNameChange('update'));
  $('names-delete-btn').addEventListener('click', () => handleNameChange('delete'));
}
