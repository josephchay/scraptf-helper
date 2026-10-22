// Manual trade journal with FIFO profit (design brief §5.9). Each row is one
// item and stores the key price that applied when it was logged. A matched
// buy/sell pair is netted in keys and metal separately and the difference is
// valued at the sell row's key price, so a flip bought and sold for the same
// number of keys makes 0 whatever keys did in between, and later key price
// moves do not rewrite past profit.
//
// 0.8 (J1): the rules moved to src/shared/journal.ts, so the service, the
// dashboard and the browser mock book with one function (closed ledger, fees,
// write-offs included). This module only re-exports them for the service's
// callers (domain/index.ts, holdings.ts, rpcHandlers.ts and the tests).

export { journalOrder, journalSummary, journalValue } from '../../shared/journal';
