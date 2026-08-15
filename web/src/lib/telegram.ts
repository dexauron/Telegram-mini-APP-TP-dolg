/**
 * Обёртка над Telegram WebApp API.
 *
 * Отдельная библиотека не подключается намеренно: нужен десяток полей, а
 * зависимость пришлось бы обновлять вслед за Telegram.
 */

interface ThemeParams {
  bg_color?: string;
  text_color?: string;
  hint_color?: string;
  link_color?: string;
  button_color?: string;
  button_text_color?: string;
  secondary_bg_color?: string;
  section_bg_color?: string;
  header_bg_color?: string;
  destructive_text_color?: string;
}

interface WebApp {
  initData: string;
  colorScheme: "light" | "dark";
  themeParams: ThemeParams;
  ready(): void;
  expand(): void;
  close(): void;
  openTelegramLink(url: string): void;
  switchInlineQuery?(query: string, chatTypes?: string[]): void;
  HapticFeedback?: {
    impactOccurred(style: "light" | "medium" | "heavy"): void;
    notificationOccurred(type: "error" | "success" | "warning"): void;
  };
  BackButton: { show(): void; hide(): void; onClick(cb: () => void): void; offClick(cb: () => void): void };
  MainButton: {
    setText(text: string): void;
    show(): void;
    hide(): void;
    showProgress(leaveActive?: boolean): void;
    hideProgress(): void;
    onClick(cb: () => void): void;
    offClick(cb: () => void): void;
    enable(): void;
    disable(): void;
  };
  showConfirm(message: string, cb: (ok: boolean) => void): void;
  showAlert(message: string, cb?: () => void): void;
}

declare global {
  interface Window {
    Telegram?: { WebApp: WebApp };
  }
}

export const tg = window.Telegram?.WebApp;

/** Приложение может открываться и в обычном браузере — тогда просто нет Telegram. */
export const isTelegram = Boolean(tg?.initData);

export function initTelegram(): void {
  if (!tg) return;
  tg.ready();
  tg.expand();
  applyTheme(tg.themeParams, tg.colorScheme);
}

/**
 * NFR-021: тема берётся из Telegram, поэтому приложение автоматически совпадает
 * со светлым или тёмным оформлением клиента.
 */
export function applyTheme(theme: ThemeParams, scheme: "light" | "dark"): void {
  const root = document.documentElement;
  const map: Record<string, string | undefined> = {
    "--bg": theme.secondary_bg_color ?? (scheme === "dark" ? "#000000" : "#f2f2f7"),
    "--card": theme.bg_color ?? (scheme === "dark" ? "#1c1c1e" : "#ffffff"),
    "--text": theme.text_color ?? (scheme === "dark" ? "#ffffff" : "#000000"),
    "--hint": theme.hint_color ?? (scheme === "dark" ? "#8e8e93" : "#8e8e93"),
    "--accent": theme.button_color ?? "#007aff",
    "--accent-text": theme.button_text_color ?? "#ffffff",
    "--danger": theme.destructive_text_color ?? "#ff3b30",
  };
  for (const [name, value] of Object.entries(map)) {
    if (value) root.style.setProperty(name, value);
  }
  root.dataset.scheme = scheme;
}

export function haptic(type: "success" | "error" | "warning" = "success"): void {
  tg?.HapticFeedback?.notificationOccurred(type);
}

export function confirm(message: string): Promise<boolean> {
  if (!tg) return Promise.resolve(window.confirm(message));
  return new Promise((resolve) => tg.showConfirm(message, resolve));
}
