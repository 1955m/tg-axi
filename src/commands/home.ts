import { encode } from "@toon-format/toon";
import { tgRequest, type TgRequestContext } from "../tg.js";
import { renderHelp, renderOutput } from "../toon.js";
import type { TgContext } from "../context.js";

export const HOME_HELP = "";

interface TgBot {
  id?: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}

/**
 * Session digest (no-args dashboard). The SDK prepends `bin:` + `description:`.
 * tg-axi adds: bot username, token-present, default chat, reachable y/n, hints.
 * Never throws: when no token is present, it reports that clearly instead.
 */
export async function homeCommand(_args: string[], ctx: TgContext): Promise<string> {
  const tokenPresent = ctx.token !== undefined;
  let botUsername = "unknown";
  let reachable = false;
  if (tokenPresent) {
    try {
      const apiCtx: TgRequestContext = { token: ctx.token!, chatId: ctx.chatId };
      const me = await tgRequest<TgBot>("getMe", {}, apiCtx);
      botUsername = me.username ?? me.first_name ?? "unknown";
      reachable = true;
    } catch {
      reachable = false;
    }
  }
  return renderOutput([
    encode({
      bot: botUsername,
      token: tokenPresent ? "yes" : "no",
      default_chat: ctx.chatId,
      reachable: reachable ? "yes" : "no",
    }),
    renderHelp(homeHints(ctx, tokenPresent, reachable)),
  ]);
}

function homeHints(ctx: TgContext, tokenPresent: boolean, reachable: boolean): string[] {
  const hints: string[] = [];
  if (!tokenPresent) {
    hints.push("Create ~/.claude/channels/telegram/.env with TELEGRAM_BOT_TOKEN=<token>");
  } else if (!reachable) {
    hints.push("Run `tg-axi status` to diagnose the connection");
  }
  hints.push(`Run \`tg-axi send --stdin --title "<alert>"\` to deliver an alert`);
  hints.push("Run `tg-axi status` for a getMe/getChat health check");
  hints.push(`Target another chat with --chat <id> (default ${ctx.chatId})`);
  return hints;
}
