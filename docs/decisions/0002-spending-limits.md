# ADR 0002: One spending-limits switch, the same in every IronDivi wallet

Date: 2026-10-28. Decided by Bert.

## Ruling

> "it is ok for the wallet to have guardrails, but the user is in control, if
> they want to spend their entire wallet now, they can. You need a setting in
> all wallets to turn this on and off."

Picked from four options: **one switch, on for new wallets.**

## The rule (extension, web wallet, Telegram wallet)

1. Settings has one switch, **Spending limits**, with two numbers under it:
   - **Per send:** up to N% of the balance (default 10).
   - **Per day:** up to N% of the balance across all sends in 24 hours, fees
     included (default 25).
   The balance is the highest balance the wallet has seen in the last 7 days,
   so draining the wallet in steps does not shrink the limit.
2. **New wallets start with the switch on.**
3. **Turning it off asks for the password once.** After that any amount can be
   sent, including the whole wallet (MAX). Every send still asks for the
   password as before.
4. **Turning it on, or lowering a number, needs no password.** Raising a
   number needs the password.
5. When off, the numbers are hidden and the switch says so in words ("Off: any
   amount can be sent"). An empty box must never show a faded default, which
   reads as "still on" (the bug the 2026-10-28 screenshots showed).
6. A refused send says which limit, the most that can be sent now, and where
   to change it: "Over your spending limit: 10% of your balance per send (up
   to 200 DIVI now). Settings → Spending limits."
7. **Name fees:** paying the name registry exactly a record's fee from the
   wallet's own Names screen skips the percentage limits, still counts toward
   the day's total, and still needs the password. A site asking for the same
   payment is held to the limits.

The extension keeps its optional fixed caps in DIVI (per send, per day; 0 =
none) under the same switch: off turns them off too. The other wallets do not
have them.

## Existing extension wallets

Settings saved before this change map to the switch as: on if any limit was
above 0, off if all four were 0. The percentages carry over.

## Where it lives

- Extension: `src/shared/storage.ts` (`transactionLimits.enabled`),
  `src/background/service-worker.ts` (enforcement), popup Settings → Security.
- Web wallet: `divi-infrastructure/divi-wallet`.
- Telegram wallet: `divi-infrastructure/services/telegram-wallet-app`.
