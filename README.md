# NEXT-RA — Release V8

This package contains the NEXT-RA web client and its Supabase Edge Function source files.

## Local preview (Windows)
1. Extract the ZIP.
2. Open the inner `NEXT-RA-Website-v8-Release` folder.
3. Double-click `START-NEXT-RA.bat`.
4. Keep the PowerShell window open while using the local site.

## Publish
The project includes `netlify.toml` and is structured for a static Netlify deploy. The publish directory is the project root (`.`). Upload the **contents of this folder** to the existing Netlify site or connect this folder through a Git repository. A live Netlify deployment has not been performed by this package.

## Supabase project
- Project ref: `lasrylhmiaxiucvlmpuk`
- Supabase Auth uses email + password and email confirmation.
- Super Admin is assigned to the first verified owner account.
- Admin endpoints require a verified MFA session (AAL2).

## Operational safety state
- On-chain deposits: disabled.
- On-chain withdrawals: disabled.
- Network integrations: disabled.
- Trading pairs: configured but inactive.
- Swap execution: preview only; no orders or balances are changed.
- Investment plans: none enabled; no rates or return promises are configured.
- KYC files: private bucket; document reviews require the protected admin workflow.

This is a secured early platform release, not yet a live custodial exchange. Do not accept customer deposits or enable real trading/investment operations until custody, settlement, signing, compliance, monitoring, reconciliation and end-to-end controls have been built and independently tested.

## Secrets
Only the Supabase publishable key is embedded in the browser client. Never place a Supabase service-role or secret key in this folder or in frontend code.
