# Shalom Adonai Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Apply the approved Shalom Adonai navy, ivory, gold, and leaf palette and add persistent light/dark theme switching.

**Architecture:** Centralize surface, text, border, action, status, and navigation colors in CSS custom properties with light and dark values. A small React theme context persists the chosen mode in local storage; the document receives its initial theme before app rendering, and one accessible toggle is shared between sign-in and authenticated layouts.

**Tech Stack:** React, TypeScript, Vite, CSS custom properties, browser localStorage.

**Spec:** `docs/superpowers/specs/2026-10-30-shalom-theme-design.md`

## Global Constraints

- Do not add dependencies.
- Keep public registration disabled; this task concerns visual theme only.
- Store theme preference in the local browser only.
- Do not add or run automated tests.
- Preserve keyboard focus, readable contrast, and `prefers-reduced-motion` behavior.

## Review Focus

- Light-only literals must not leave white surfaces or unreadable text in dark mode; inspect all CSS color declarations after tokenization.
- Gold must remain legible on both light and dark surfaces; primary gold buttons use navy text.
- Theme must remain consistent between sign-in and authenticated layouts and across reloads.
- Keyboard focus and the toggle's accessible name must be clear in both modes.
- Theme switching must not animate layout or ignore reduced-motion preference.

### Task 1: Palette Tokens and Theme-Aware Styles

**Files:**
- Modify: `apps/web/src/index.css`
- Modify: `apps/web/src/App.css`

**Interfaces:**
- Produces semantic tokens consumed by all existing component styles, including `--canvas`, `--paper`, `--ink`, `--muted`, `--line`, `--accent`, `--action`, `--sidebar-*`, and semantic success/warning/danger tokens.

- [x] Define light defaults using the approved palette: navy `#0B1D38`, deep navy `#07172D`, surface navy `#102844`, ivory `#F5F1E8`, paper `#FFFCF6`, gold `#CBA14A`, leaf `#68864A`.
- [x] Define dark values under `:root[data-theme='dark']`, including `color-scheme: dark`, text, surfaces, borders, focus, status colors, and shadow.
- [x] Replace fixed light-only color literals throughout `App.css` with semantic tokens; retain explicit semantic colors only where a status or icon requires them.
- [x] Add brief color/surface transitions and rely on the existing reduced-motion media rule to make them immediate when requested.

### Task 2: Persistent Theme State and Accessible Toggle

**Files:**
- Create: `apps/web/src/theme/ThemeProvider.tsx`
- Create: `apps/web/src/components/ThemeToggle.tsx`
- Modify: `apps/web/src/main.tsx`
- Modify: `apps/web/index.html`
- Modify: `apps/web/src/components/AppShell.tsx`
- Modify: `apps/web/src/pages/SignInPage.tsx`
- Modify: `apps/web/src/components/Icon.tsx`
- Modify: `apps/web/src/App.css`

**Interfaces:**
- `ThemeProvider` exposes `theme: 'light' | 'dark'` and `toggleTheme(): void` through React context.
- `ThemeToggle` renders a button with an action-oriented accessible name and the matching sun/moon icon.

- [x] Initialize the root `data-theme` from `localStorage` before app rendering; use light when no valid saved preference exists.
- [x] Persist only `'light'` or `'dark'` under a Shalom-specific storage key and update document `color-scheme`/theme-color metadata.
- [x] Add sun and moon icon paths to the existing `Icon` component.
- [x] Place the toggle in the authenticated top bar beside account actions and in the sign-in header.
- [x] Style visible hover and keyboard focus states without changing the dashboard's layout hierarchy.

### Task 3: Review the Rendered Theme States

**Files:**
- Review: `apps/web/src/index.css`, `apps/web/src/App.css`, `apps/web/src/theme/ThemeProvider.tsx`, `apps/web/src/components/ThemeToggle.tsx`, and integration points.

- [x] Review the rendered dashboard in both themes at desktop size; review sign-in/recovery integration and responsive/mobile styles in code.
- [x] Confirm theme persistence by reloading after each selection; verify keyboard focus and reduced-motion styling in code.
- [x] Record limitation: mobile layout was reviewed in code but not separately simulated; no automated tests were run.
