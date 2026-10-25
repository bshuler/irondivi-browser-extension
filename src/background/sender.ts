/**
 * Who may call popup-only operations.
 *
 * Messages from popup/extension pages have sender.id === our extension ID. Content scripts
 * share that id and relay any method a web page names, so also require the sender to be one
 * of our own pages.
 */
export function isExtensionSender(
  sender: chrome.runtime.MessageSender,
  runtimeId: string = chrome.runtime.id,
  baseUrl: string = chrome.runtime.getURL(''),
): boolean {
  return sender.id === runtimeId &&
    typeof sender.url === 'string' &&
    sender.url.startsWith(baseUrl);
}
