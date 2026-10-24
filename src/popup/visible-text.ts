/**
 * Text a site asks the user to approve, with the characters that cannot be
 * seen made visible.
 *
 * A message can carry control characters, bidirectional overrides that make
 * the text read differently from what is signed, or zero-width characters
 * that hide a difference between two strings that look the same. Each is
 * shown as a marker such as ⟨U+202E⟩ instead. Newlines and tabs are kept.
 */

// C0 controls except tab and newline, DEL, C1 controls, the bidi marks,
// embeddings, overrides and isolates, zero-width characters, the byte order
// mark, and the line and paragraph separators
const HIDDEN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;

export interface VisibleText {
  text: string;
  hidden: number;
}

export function visibleText(raw: string): VisibleText {
  let hidden = 0;
  const text = raw.replace(HIDDEN, ch => {
    hidden++;
    return `⟨U+${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}⟩`;
  });
  return { text, hidden };
}
