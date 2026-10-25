/**
 * The banner shown when the background found the wallet's records changed
 * outside it and put their protections back (records-seal.ts)
 */
import { sendMessage } from './message-api';
import { MSG } from '../shared/constants';

export async function showRecordsWarning(): Promise<void> {
  const banner = document.getElementById('records-warning');
  const text = document.getElementById('records-warning-text');
  const dismiss = document.getElementById('records-warning-dismiss');
  if (!banner || !text || !dismiss) return;
  try {
    const { warning } = await sendMessage<{ warning: { at: number; message: string } | null }>(MSG.GET_RECORDS_WARNING);
    if (!warning) {
      banner.classList.add('hidden');
      return;
    }
    text.textContent = `${warning.message} (${new Date(warning.at).toLocaleString()})`;
    banner.classList.remove('hidden');
    dismiss.onclick = async () => {
      banner.classList.add('hidden');
      try {
        await sendMessage(MSG.DISMISS_RECORDS_WARNING);
      } catch {
        // Shown again next time
      }
    };
  } catch {
    // No banner is better than a broken popup
  }
}
