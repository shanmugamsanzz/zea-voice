# Phase 1 performance baseline

Task 1 adds measurement only. It does not cache, paginate, combine, or otherwise optimize requests, so the collected figures are the pre-optimization baseline for Tasks 2-10.

## What is measured

- **Frontend tab load:** sidebar click until all initial tab API calls finish, plus a 150 ms settling window.
- **API duration:** browser-observed duration for each logical API request.
- **Backend duration:** backend request time returned in `x-response-time-ms` and `Server-Timing`.
- **SQL duration:** total PostgreSQL query time and query count for the request. SQL text, parameters, and returned data are not stored.
- **External-provider duration:** total Plivo request time and call count. Credentials and provider response bodies are not stored.

## Baseline tabs

The browser records these ten Super Admin tabs independently:

1. Dashboard
2. Companies
3. Users
4. Voice Providers
5. Phone Numbers
6. Credits Manager
7. Queue Monitor
8. Call Monitoring
9. Payments
10. Settings

Measurements are retained in browser `localStorage` (maximum 500 API records and 500 tab records). Backend totals are written as structured `API performance` logs, Plivo calls as `External provider performance` logs, and individual SQL timings are available when `LOG_LEVEL=debug`.

## Capture and export

After loading the updated backend and frontend, sign in and open each Super Admin tab once. The baseline is recorded automatically. In the browser console:

```js
console.table(window.__zeaPerformance.summary())
window.__zeaPerformance.download()
```

Use `window.__zeaPerformance.clear()` only when intentionally starting a new baseline run. The downloaded JSON contains the detailed API records and tab totals used for comparison after each later optimization task.
