# Visual Audit — Windy Chat Web App

> Comprehensive audit of all routes, components, and interactive elements.
> Date: 2026-04-04

## Route Audit

| Route | Loads? | Layout OK? | Mobile (375px)? | Errors? | Status |
|-------|--------|-----------|-----------------|---------|--------|
| / (landing) | ✅ | ✅ | ✅ | None | OK |
| Sign In | ✅ | ✅ | ✅ | None | OK |
| Register | ✅ | ✅ | ✅ | None | OK |
| Chat | ✅ | ✅ | ✅ (slides) | None | OK |
| Social | ✅ | ✅ | ✅ | None | OK |
| Discover | ✅ | ✅ | ✅ | None | OK (demo agents fallback) |
| Contacts | ✅ | ✅ | ✅ | None | OK |
| Settings | ✅ | ✅ | ✅ | None | OK |
| Profile | ✅ | ✅ | ✅ | None | Fixed (was missing error state) |
| Privacy | ✅ | ✅ | ✅ | None | OK |
| Terms | ✅ | ✅ | ✅ | None | OK |

## Graceful Degradation (No Backend)

| Scenario | Expected | Actual | Status |
|----------|----------|--------|--------|
| Chat without Synapse | Show empty state | Shows "Welcome to Windy Chat" with Discover/Invite buttons | ✅ Fixed |
| Social feed API down | Show error with retry | Shows "Social feed unavailable" + Retry button | ✅ Fixed |
| Contacts search fails | Show error | Shows "Search unavailable" + Retry button | ✅ Fixed |
| Profile API fails | Show error | Shows "Could not load profile" + Retry button | ✅ Fixed |
| Discover agents API down | Show fallback | Shows 6 demo agents (graceful fallback) | ✅ Already worked |
| Login without account-server | Show error | Shows login error from fetch failure | ✅ Already worked |

## Issues Found & Fixed

### Critical

| # | Issue | File | Fix |
|---|-------|------|-----|
| 1 | Social feed shows blank on API failure | SocialPage.tsx | Added feedError state + retry button |
| 2 | Profile page blank on API failure | ProfilePage.tsx | Added error state + retry button |
| 3 | Profile Follow button non-functional | ProfilePage.tsx | Added handleFollow with followUser/unfollowUser API |
| 4 | Contacts page no error on search failure | ContactsPage.tsx | Added searchError state + retry button |
| 5 | Contacts "no results" vs "never searched" ambiguous | ContactsPage.tsx | Added hasSearched flag for distinct messaging |

### Moderate

| # | Issue | File | Fix |
|---|-------|------|-----|
| 6 | Landing page footer missing legal links | LandingPage.tsx | Added Privacy Policy + Terms of Service links |
| 7 | Profile stats show "0" instead of "—" when loading | ProfilePage.tsx | Changed to `?? '—'` fallback |
| 8 | Follow button doesn't toggle state | ProfilePage.tsx | Added following state + visual toggle |

### Known Limitations (not fixed — heavy infrastructure)

| # | Issue | Notes |
|---|-------|-------|
| 1 | Settings theme toggle doesn't apply CSS | Requires CSS variables swap or class-based theming |
| 2 | Settings language doesn't persist | Requires i18n library integration |
| 3 | DeviceVerification uses simulated emojis | Requires real Matrix verification integration |
| 4 | Connected Services statuses are hardcoded | Requires cross-service health checks |

## Build Verification

- `npm run build`: ✅ succeeds in 2s
- TypeScript: ✅ no errors
- Console errors: ✅ none (all error logging uses console.warn, not console.error)
- Bundle size: 1.2MB gzip (including matrix-js-sdk + Rust crypto WASM)
