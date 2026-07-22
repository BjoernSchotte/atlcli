/**
 * React binding for the message catalogue (spec 010 Phase 0).
 *
 * Host-neutral on purpose: the provider takes a resolved {@link Locale} as a
 * prop, so *how* the locale was decided (a stored preference read through the
 * `SettingsStore` port, `navigator.language`, or a value the Forge platform
 * hands the iframe) stays a host concern. Components only ever see `t`.
 */
import React, { createContext, useContext, useMemo } from "react";
import {
  FALLBACK_LOCALE,
  translate,
  type Locale,
  type MessageKey,
  type MessageParams,
} from "./messages.js";

export interface I18n {
  locale: Locale;
  t: (key: MessageKey, params?: MessageParams) => string;
}

const I18nContext = createContext<I18n | null>(null);

export function I18nProvider({
  locale,
  children,
}: {
  locale: Locale;
  children: React.ReactNode;
}): React.JSX.Element {
  const value = useMemo<I18n>(
    () => ({ locale, t: (key, params) => translate(locale, key, params) }),
    [locale]
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/**
 * The active translator.
 *
 * Falls back to the English catalogue when a component is rendered outside a
 * provider (a presentational component pulled into a snapshot test, say)
 * instead of throwing — a missing provider must never be able to blank the
 * panel.
 */
export function useI18n(): I18n {
  const context = useContext(I18nContext);
  return (
    context ?? {
      locale: FALLBACK_LOCALE,
      t: (key, params) => translate(FALLBACK_LOCALE, key, params),
    }
  );
}

/** Shorthand for components that only need the translate function. */
export function useT(): I18n["t"] {
  return useI18n().t;
}
