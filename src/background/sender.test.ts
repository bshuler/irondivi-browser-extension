import { describe, it, expect } from 'vitest';
import { isExtensionSender } from './sender';

const ID = 'abcdefghijklmnopabcdefghijklmnop';
const BASE = `chrome-extension://${ID}/`;
const check = (s: chrome.runtime.MessageSender) => isExtensionSender(s, ID, BASE);

describe('isExtensionSender', () => {
  it('accepts our own popup page', () => {
    expect(check({ id: ID, url: `${BASE}popup.html` })).toBe(true);
  });

  it('refuses a content script relaying for a web page', () => {
    expect(check({ id: ID, url: 'https://evil.example/', tab: { id: 1 } as chrome.tabs.Tab })).toBe(false);
  });

  it('refuses another extension', () => {
    expect(check({ id: 'other', url: `${BASE}popup.html` })).toBe(false);
  });

  it('refuses a sender with no url', () => {
    expect(check({ id: ID })).toBe(false);
  });

  it('refuses a lookalike prefix', () => {
    expect(check({ id: ID, url: `chrome-extension://${ID}evil/popup.html` })).toBe(false);
  });
});
