/**
 * Account error notification service.
 *
 * Sends notifications (Toast + Telegram) when accounts encounter errors.
 * Implements cooldown to prevent notification spam.
 */

import { createLogger } from "./logger";

const log = createLogger("notification");

/**
 * Notification data for account errors.
 */
export interface AccountErrorNotification {
    /** Account email if available */
    accountEmail?: string;
    /** Account index (0-based) */
    accountIndex: number;
    /** Type of error */
    errorType:
    | "auth-failure"
    | "invalid_grant"
    | "project-error"
    | "api-error"
    | "network-error"
    | "empty-response";
    /** Human-readable error message */
    errorMessage: string;
    /** Request/response payload for debugging (truncated) */
    payload?: string;
    /** Number of accounts still available */
    remainingAccounts: number;
    /** When the error occurred */
    timestamp: Date;
    /** HTTP status code if applicable */
    statusCode?: number;
    /** Model being used */
    model?: string;
}

/**
 * Telegram configuration.
 */
export interface TelegramConfig {
    botToken: string;
    chatId: string;
}

/**
 * Notification configuration.
 */
export interface NotificationConfig {
    /** Whether notifications are enabled */
    enabled: boolean;
    /** Telegram configuration (optional) */
    telegram?: TelegramConfig;
    /** Cooldown in milliseconds between notifications of the same type */
    cooldownMs: number;
    /** Whether quiet mode is enabled (suppresses toasts) */
    quietMode?: boolean;
}

// Cooldown tracking
const notificationCooldowns = new Map<string, number>();
const MAX_COOLDOWN_ENTRIES = 100;

/**
 * Clean up old cooldown entries to prevent memory leaks.
 */
function cleanupCooldowns(cooldownMs: number): void {
    if (notificationCooldowns.size > MAX_COOLDOWN_ENTRIES) {
        const now = Date.now();
        for (const [key, time] of notificationCooldowns) {
            if (now - time > cooldownMs * 2) {
                notificationCooldowns.delete(key);
            }
        }
    }
}

/**
 * Check if a notification should be sent based on cooldown.
 */
function shouldNotify(
    notification: AccountErrorNotification,
    cooldownMs: number
): boolean {
    if (cooldownMs <= 0) return true;

    cleanupCooldowns(cooldownMs);

    // Create unique key: error type + account index
    const key = `${notification.errorType}:${notification.accountIndex}`;
    const lastNotified = notificationCooldowns.get(key) ?? 0;
    const now = Date.now();

    if (now - lastNotified < cooldownMs) {
        log.debug("notification-cooldown", { key, remainingMs: cooldownMs - (now - lastNotified) });
        return false;
    }

    notificationCooldowns.set(key, now);
    return true;
}

/**
 * Format notification for display.
 */
function formatNotificationMessage(notification: AccountErrorNotification): string {
    const accountLabel = notification.accountEmail || `Account #${notification.accountIndex + 1}`;
    const timestamp = notification.timestamp.toISOString();

    let message = `⚠️ Account Error\n`;
    message += `━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    message += `📧 Account: ${accountLabel}\n`;
    message += `❌ Error: ${notification.errorType}\n`;
    message += `💬 Message: ${notification.errorMessage.slice(0, 200)}${notification.errorMessage.length > 200 ? "..." : ""}\n`;

    if (notification.statusCode) {
        message += `📊 Status: ${notification.statusCode}\n`;
    }
    if (notification.model) {
        message += `🤖 Model: ${notification.model}\n`;
    }

    message += `📋 Remaining: ${notification.remainingAccounts} account(s)\n`;
    message += `🕐 Time: ${timestamp}\n`;

    if (notification.payload) {
        const truncatedPayload = notification.payload.slice(0, 500);
        message += `\n📦 Payload:\n\`\`\`\n${truncatedPayload}${notification.payload.length > 500 ? "\n..." : ""}\n\`\`\``;
    }

    return message;
}

/**
 * Format notification for toast (shorter, single line).
 */
function formatToastMessage(notification: AccountErrorNotification): string {
    const accountLabel = notification.accountEmail
        ? notification.accountEmail.split("@")[0]
        : `#${notification.accountIndex + 1}`;

    return `${accountLabel}: ${notification.errorType} - ${notification.remainingAccounts} accounts left`;
}

/**
 * Send notification via Telegram.
 */
export async function sendTelegramMessage(
    config: TelegramConfig,
    notification: AccountErrorNotification
): Promise<boolean> {
    const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;
    const message = formatNotificationMessage(notification);

    try {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                chat_id: config.chatId,
                text: message,
                parse_mode: "Markdown",
                disable_notification: false,
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            log.error("telegram-send-failed", {
                status: response.status,
                error: errorText,
            });
            return false;
        }

        log.debug("telegram-sent", {
            accountIndex: notification.accountIndex,
            errorType: notification.errorType,
        });
        return true;
    } catch (error) {
        log.error("telegram-error", {
            error: error instanceof Error ? error.message : String(error),
        });
        return false;
    }
}

/**
 * Plugin client interface for TUI operations.
 * Uses `body` parameter to match the actual OpenCode plugin client API.
 */
export interface NotificationPluginClient {
    tui: {
        showToast: (options: {
            body: {
                title: string;
                message: string;
                variant: "info" | "warning" | "success" | "error";
                durationMs?: number;
            };
        }) => Promise<unknown>;
    };
}

/**
 * Main notification function. Sends both toast and Telegram if configured.
 */
export async function notifyAccountError(
    client: NotificationPluginClient | null,
    config: NotificationConfig,
    notification: AccountErrorNotification
): Promise<void> {
    if (!config.enabled) {
        log.debug("notifications-disabled");
        return;
    }

    // Check cooldown
    if (!shouldNotify(notification, config.cooldownMs)) {
        return;
    }

    log.info("account-error-notification", {
        accountIndex: notification.accountIndex,
        accountEmail: notification.accountEmail,
        errorType: notification.errorType,
        remainingAccounts: notification.remainingAccounts,
    });

    // Send toast notification (unless quiet mode)
    if (client && !config.quietMode) {
        try {
            const toastMessage = formatToastMessage(notification);
            await client.tui.showToast({
                body: {
                    title: "Account Error",
                    message: toastMessage,
                    variant: notification.remainingAccounts > 0 ? "warning" : "error",
                    durationMs: 5000,
                },
            });
        } catch (error) {
            log.error("toast-error", {
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    // Send Telegram notification
    if (config.telegram?.botToken && config.telegram?.chatId) {
        // Fire and forget - don't block on Telegram
        sendTelegramMessage(config.telegram, notification).catch((error) => {
            log.error("telegram-async-error", {
                error: error instanceof Error ? error.message : String(error),
            });
        });
    }
}

/**
 * Reset all notification cooldowns (for testing).
 */
export function resetNotificationCooldowns(): void {
    notificationCooldowns.clear();
}

/**
 * Get current cooldown state (for testing/debugging).
 */
export function getNotificationCooldownState(): Map<string, number> {
    return new Map(notificationCooldowns);
}
